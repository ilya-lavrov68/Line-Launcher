//! The three Settings buttons: open the folder, copy the bundle, mail it.
//!
//! All of them are one-liners over [`super::logger`] and
//! [`super::diagnostics`]; the value of the module is that the *policy* lives in
//! one place: what a bundle contains, which address it goes to, and what is
//! allowed to be launched as an external program.

use super::diagnostics::{self, Summary};
use super::error::{LineError, LineResult};
use super::logger::{self, Area, Field};
use super::state::LineState;
use super::storage::{is_real_dir, is_real_file};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// Keep the complete `mailto:` URL below common shell/protocol-handler limits.
/// Larger full reports remain available through «Скопировать диагностику».
const MAX_MAILTO_URL_BYTES: usize = 6 * 1024;

/// `launcher_logs/`, created if this is the first run. The folder is what the
/// player opens when asked «пришлите логи».
fn logs_dir(app: &AppHandle) -> LineResult<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let dir = root.join(logger::DIR);
    fs::create_dir_all(&dir).map_err(|e| LineError::io(&e))?;
    Ok(dir)
}

fn data_dir(app: &AppHandle) -> LineResult<PathBuf> {
    app.path().app_data_dir().map_err(|_| LineError::storage())
}

/// Instance ids present on disk. Read the folder names, not the config: a build
/// that is installed but no longer listed is exactly the sort of thing a
/// support report needs to show.
fn instance_ids(root: &std::path::Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("instances")) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids
}

/// The whole bundle as one string. Copy always returns the complete report;
/// mail uses the same report when it fits the safe URL size.
fn build(app: &AppHandle, state: &LineState) -> LineResult<String> {
    let root = data_dir(app)?;
    let (provider_id, config_url) = match state.active_config() {
        Ok((url, config)) => (Some(config.provider.id), Some(url)),
        Err(_) => (None, None),
    };
    let user = state
        .session_info()
        .ok()
        .flatten()
        .map(|info| info.username);
    let instances = instance_ids(&root);
    let lines = read_logs(&root);
    let summary = Summary {
        launcher_version: super::LAUNCHER_VERSION,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        data_dir: &root,
        provider_id: provider_id.as_deref(),
        config_url: config_url.as_deref(),
        session_user: user.as_deref(),
        instances: &instances,
    };
    let mut bundle = diagnostics::render(&summary, &lines);
    // A machine that resets under load leaves its evidence in the System log,
    // not in anything the launcher writes. Appending it here means the one
    // button a player is asked to press already answers the question a support
    // volunteer would otherwise have to ask twice.
    if let Some(section) = super::hardware::section() {
        bundle.push_str("\n-- неожиданные перезагрузки --\n");
        bundle.push_str(&section);
    }
    Ok(bundle)
}

/// Collect all retained launcher records plus the latest `launch.log` for each
/// real Minecraft instance. Launcher files are emitted oldest-first so the
/// combined report reads chronologically. The game logs are opened only after
/// checking each path component is a real directory/file, never a symlink or
/// Windows reparse point.
fn read_logs(root: &Path) -> Vec<String> {
    let mut lines = Vec::new();
    let mut launcher_files = logger::log_files(&root.join(logger::DIR));
    launcher_files.reverse();
    for path in launcher_files {
        if !is_real_file(&path) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("launcher log");
        lines.push(format!("--- launcher log: {name} ---"));
        append_log_lines(&path, &mut lines);
    }

    let minecraft_root = root.join("minecraft");
    if !is_real_dir(&minecraft_root) {
        return lines;
    }
    let Ok(entries) = fs::read_dir(&minecraft_root) else {
        return lines;
    };
    let mut instances: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !is_real_dir(&path) {
                return None;
            }
            Some((entry.file_name().to_string_lossy().into_owned(), path))
        })
        .collect();
    instances.sort_by(|a, b| a.0.cmp(&b.0));

    for (id, instance_dir) in instances {
        // Current instances launch from `game/`; legacy launch paths wrote to
        // the instance root. Include both when present so either path has logs.
        for (kind, logs_dir) in [
            ("game/logs", instance_dir.join("game").join("logs")),
            ("logs", instance_dir.join("logs")),
        ] {
            let launch_log = logs_dir.join("launch.log");
            if !is_real_dir(&logs_dir) || !is_real_file(&launch_log) {
                continue;
            }
            lines.push(format!(
                "--- Minecraft {kind}/launch.log, instance={} ---",
                logger::scrub(&id)
            ));
            append_log_lines(&launch_log, &mut lines);
        }
    }
    lines
}

fn append_log_lines(path: &Path, lines: &mut Vec<String>) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let Ok(read) = reader.read_until(b'\n', &mut bytes) else {
            break;
        };
        if read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&bytes);
        lines.push(line.trim_end_matches(['\r', '\n']).to_owned());
    }
}

#[tauri::command]
pub async fn open_logs_folder(app: AppHandle) -> LineResult<String> {
    let dir = logs_dir(&app)?;
    open_in_file_manager(&dir)?;
    logger::info(
        Area::Settings,
        "logs folder opened",
        &[Field::text("dir", dir.display().to_string())],
    );
    Ok(dir.display().to_string())
}

#[tauri::command]
pub async fn copy_diagnostics(app: AppHandle, state: State<'_, LineState>) -> LineResult<String> {
    let bundle = build(&app, &state)?;
    logger::info(
        Area::Settings,
        "diagnostics copied",
        &[Field::num("bytes", bundle.len() as u64)],
    );
    Ok(bundle)
}

/// Open a draft in the player's mail client.
///
/// The address is *not* taken from the provider config here: the caller passes
/// the one the build was configured with, and an empty address is rejected
/// rather than opening an empty draft. Small reports use the complete bundle;
/// if all retained logs exceed the safe `mailto:` size, the draft explains how
/// to paste the full report copied with «Скопировать диагностику».
#[tauri::command]
pub async fn open_mail_draft(
    app: AppHandle,
    state: State<'_, LineState>,
    address: String,
) -> LineResult<()> {
    let bundle = build(&app, &state)?;
    let subject = format!("Line Launcher — диагностика {}", app_version());
    let full_url = diagnostics::mailto(Some(&address), &subject, &bundle)
        .ok_or_else(|| LineError::input("Не указан адрес почты поддержки."))?;
    let url = if full_url.len() <= MAX_MAILTO_URL_BYTES {
        full_url
    } else {
        let hint = format!(
            "Полная диагностика содержит {} байт и слишком велика для ссылки почтового клиента. Нажмите «Скопировать диагностику» и вставьте полный текст в это письмо или приложите launcher_logs и logs/launch.log.",
            bundle.len()
        );
        diagnostics::mailto(Some(&address), &subject, &hint)
            .ok_or_else(|| LineError::input("Не указан адрес почты поддержки."))?
    };
    logger::info(
        Area::Settings,
        "mail draft opened",
        &[Field::num("body_bytes", bundle.len() as u64)],
    );
    open_url(&url)
}

fn app_version() -> &'static str {
    super::LAUNCHER_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_launcher_file_and_game_launch_log() {
        let root = tempfile::tempdir().unwrap();
        let launcher = root.path().join(logger::DIR);
        fs::create_dir_all(&launcher).unwrap();
        for day in 1..=9 {
            fs::write(
                launcher.join(format!("launcher-2026-11-{day:02}.log")),
                format!("launcher record {day}\n"),
            )
            .unwrap();
        }
        let long_log = launcher.join("launcher-2026-11-09.log");
        let many_lines = (0..600)
            .map(|line| format!("detail {line}\n"))
            .collect::<String>();
        fs::write(&long_log, format!("launcher record 9\n{many_lines}")).unwrap();
        let game_logs = root.path().join("minecraft/demo/game/logs");
        fs::create_dir_all(&game_logs).unwrap();
        fs::write(
            game_logs.join("launch.log"),
            "Minecraft started\naccessToken=do-not-include-this-secret\n",
        )
        .unwrap();
        let legacy_logs = root.path().join("minecraft/demo/logs");
        fs::create_dir_all(&legacy_logs).unwrap();
        fs::write(legacy_logs.join("launch.log"), "legacy launch output\n").unwrap();

        let lines = read_logs(root.path());
        assert!(lines.iter().any(|line| line == "launcher record 1"));
        assert!(lines.iter().any(|line| line == "launcher record 9"));
        assert!(lines.iter().any(|line| line == "detail 599"));
        assert!(lines.iter().any(|line| line == "Minecraft started"));
        assert!(lines.iter().any(|line| line == "legacy launch output"));
        let secret = lines
            .iter()
            .find(|line| line.contains("accessToken"))
            .expect("raw game log is collected for sanitizer");
        assert_eq!(diagnostics::sanitize_line(secret), "[строка скрыта: возможные учётные данные]");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_game_logs() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside.log");
        fs::write(&outside, "secret external file").unwrap();
        let game_logs = root.path().join("minecraft/demo/game/logs");
        fs::create_dir_all(&game_logs).unwrap();
        symlink(&outside, game_logs.join("launch.log")).unwrap();
        assert!(read_logs(root.path()).is_empty());
    }
}

/// Hand a file manager the folder. The argument is a path this module built
/// from Tauri's app-data directory, never from user input, so there is no shell
/// string to inject into.
fn open_in_file_manager(dir: &std::path::Path) -> LineResult<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(dir)
            // No console window: the launcher is a GUI app and a flashing black
            // box for a file manager open reads as a crash.
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| LineError::io(&e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| LineError::io(&e))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| LineError::io(&e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(LineError::input(
        "Открытие папки не поддерживается на этой системе.",
    ))
}

/// Open a `mailto:` URL with the system handler.
///
/// The URL is built by [`diagnostics::mailto`] from an address the *build*
/// configured and a bundle this module rendered — both percent-encoded — so the
/// only thing reaching the command line is a string with no spaces, no quotes
/// and no shell metacharacters. `Command::new` is used with a separate argument
/// rather than a shell string for the same reason.
fn open_url(url: &str) -> LineResult<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // `cmd /C start` is the documented way to reach the default handler for
        // a protocol URL. The empty argument after `start` is the window title,
        // which is what stops a quoted URL being taken as one.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| LineError::io(&e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| LineError::io(&e))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| LineError::io(&e))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(LineError::input(
        "Открытие почтового клиента не поддерживается на этой системе.",
    ))
}
