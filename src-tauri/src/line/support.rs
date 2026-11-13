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
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

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

/// The whole bundle as one string. Shared by both copy and mail so the two
/// buttons can never disagree about what the diagnostics are.
fn build(app: &AppHandle, state: &LineState) -> LineResult<String> {
    let root = data_dir(app)?;
    let dir = root.join(logger::DIR);
    let (provider_id, config_url) = match state.active_config() {
        Ok((url, config)) => (Some(config.provider.id), Some(url)),
        Err(_) => (None, None),
    };
    let user = state.session_info().ok().flatten().map(|info| info.username);
    let instances = instance_ids(&root);
    let lines = read_tail(&dir);
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
    Ok(diagnostics::render(&summary, &lines))
}

/// Newest log file first, up to the bundle's cap. Reading the whole file is
/// bounded by the daily rotation, but a single day of a tight loop could still
/// be large, so the read stops at a fixed budget and keeps the tail.
fn read_tail(dir: &std::path::Path) -> Vec<String> {
    const BUDGET: usize = 512 * 1024;
    let mut lines: Vec<String> = Vec::new();
    for path in logger::log_files(dir) {
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let start = bytes.len().saturating_sub(BUDGET);
        let slice = &bytes[start..];
        // Start on a char boundary; a split UTF-8 sequence would make the tail
        // unreadable for the very tools meant to read it.
        let offset = slice
            .iter()
            .position(|byte| byte & 0xC0 != 0x80)
            .unwrap_or(0);
        if let Ok(text) = std::str::from_utf8(&slice[offset..]) {
            // A partial first line from the slice is dropped by taking the tail
            // of the file rather than the head.
            lines.extend(text.lines().map(str::to_owned));
            // One file is enough for the tail; older days only fill a gap.
            if lines.len() >= diagnostics::MAX_LINES {
                break;
            }
        }
    }
    diagnostics::tail(lines)
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
/// rather than opening an empty draft. The body is the same bundle
/// «Скопировать диагностику» produces.
#[tauri::command]
pub async fn open_mail_draft(
    app: AppHandle,
    state: State<'_, LineState>,
    address: String,
) -> LineResult<()> {
    let bundle = build(&app, &state)?;
    let subject = format!("Line Launcher — диагностика {}", app_version());
    let url = diagnostics::mailto(Some(&address), &subject, &bundle)
        .ok_or_else(|| LineError::input("Не указан адрес почты поддержки."))?;
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
