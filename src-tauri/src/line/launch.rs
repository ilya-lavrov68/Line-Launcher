//! Verified-manifest Java launch with a one-shot private ticket channel.
//! Provider access tokens and launch tickets never appear in JVM arguments,
//! WebView DTOs, events or logs.
use super::error::{ErrorCode, LineError, LineResult};
use super::install::current_receipt;
use super::ipc::PrivateChannel;
use super::java;
use super::launch_manifest::read_optional;
use super::state::LineState;
use super::storage::{is_real_dir, is_real_file, server_dir, InstallLock};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

pub const GAME_EVENT: &str = "line://game-status";

#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub java: PathBuf,
    pub game_dir: PathBuf,
    pub classpath: Vec<PathBuf>,
    pub main_class: String,
    pub username: String,
    pub minecraft_version: String,
    pub asset_index: Option<String>,
    pub assets_dir: Option<PathBuf>,
    pub natives_dir: Option<PathBuf>,
    /// Non-secret rendezvous identifier for the private IPC channel.
    pub session_channel_id: String,
    pub total_memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStatus {
    pub server_id: String,
    /// Monotonic process-wide counter. The WebView ignores older revisions.
    pub revision: u64,
    pub phase: GamePhase,
    pub sha256: Option<String>,
    pub started_at: Option<u64>,
    pub exit_code: Option<i32>,
    /// Non-sensitive explanation for a failed/stopped game. Never a raw OS error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GamePhase {
    Idle,
    Starting,
    Running,
    Exited,
    Failed,
}

pub fn optimal_heap_mb(total_memory_bytes: u64) -> u32 {
    let mib = total_memory_bytes / (1024 * 1024);
    (mib / 2).clamp(1024, 8192) as u32
}

pub fn build_java_command(spec: &LaunchSpec) -> LineResult<Vec<String>> {
    if !spec.java.is_absolute()
        || !spec.game_dir.is_absolute()
        || spec.classpath.is_empty()
        || spec.classpath.iter().any(|p| !p.is_absolute())
        || spec.main_class.is_empty()
        || spec.main_class.len() > 256
        || !spec
            .main_class
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'$'))
        || spec.main_class.starts_with('.')
        || spec.main_class.contains("..")
        || spec.username.is_empty()
        || spec.username.len() > 64
        || spec.username.chars().any(char::is_control)
        || spec.minecraft_version.is_empty()
        || spec.minecraft_version.len() > 64
        || spec.minecraft_version.chars().any(char::is_control)
        || !super::config::validate_slug(&spec.session_channel_id)
        || spec
            .asset_index
            .as_deref()
            .is_some_and(|v| !super::config::validate_slug(v))
        || spec.assets_dir.as_ref().is_some_and(|p| !p.is_absolute())
        || spec.natives_dir.as_ref().is_some_and(|p| !p.is_absolute())
        || spec.asset_index.is_some() != spec.assets_dir.is_some()
    {
        return Err(LineError::input("Некорректные параметры запуска Java."));
    }
    let separator = if cfg!(windows) { ";" } else { ":" };
    // A separator inside one path would silently become multiple classpath entries.
    if spec
        .classpath
        .iter()
        .any(|path| path.to_string_lossy().contains(separator))
    {
        return Err(LineError::input("Некорректный classpath."));
    }
    let classpath = spec
        .classpath
        .iter()
        .map(|p| p.to_string_lossy())
        .collect::<Vec<_>>()
        .join(separator);
    if classpath.contains(['\n', '\r', '\0']) {
        return Err(LineError::input("Некорректный classpath."));
    }
    let heap = optimal_heap_mb(spec.total_memory_bytes);
    let mut args = vec![
        spec.java.to_string_lossy().into_owned(),
        format!("-Xmx{heap}M"),
        format!("-Xms{heap}M"),
        "-XX:+UseG1GC".into(),
        "-XX:+ParallelRefProcEnabled".into(),
        "-XX:MaxGCPauseMillis=200".into(),
        "-XX:+DisableExplicitGC".into(),
        "-XX:G1NewSizePercent=30".into(),
        "-XX:G1MaxNewSizePercent=40".into(),
        "-XX:G1HeapRegionSize=8M".into(),
        "-XX:G1ReservePercent=20".into(),
        "-XX:G1HeapWastePercent=5".into(),
        "-XX:G1MixedGCCountTarget=4".into(),
        "-XX:InitiatingHeapOccupancyPercent=15".into(),
        "-XX:SurvivorRatio=32".into(),
        "-XX:+PerfDisableSharedMem".into(),
        "-XX:MaxTenuringThreshold=1".into(),
        format!("-DlineLauncher.sessionChannel={}", spec.session_channel_id),
    ];
    if let Some(natives) = &spec.natives_dir {
        args.push(format!("-Djava.library.path={}", natives.to_string_lossy()));
    }
    args.extend([
        "-cp".into(),
        classpath,
        spec.main_class.clone(),
        "--gameDir".into(),
        spec.game_dir.to_string_lossy().into_owned(),
        "--username".into(),
        spec.username.clone(),
        "--version".into(),
        spec.minecraft_version.clone(),
    ]);
    if let (Some(index), Some(assets)) = (&spec.asset_index, &spec.assets_dir) {
        args.extend([
            "--assetIndex".into(),
            index.clone(),
            "--assetsDir".into(),
            assets.to_string_lossy().into_owned(),
        ]);
    }
    if args.iter().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        lower.starts_with("-javaagent:")
            || lower.starts_with("-agentlib:")
            || lower.contains("sessiontoken=")
            || lower.contains("accesstoken=")
            || lower.contains("bearer ")
    }) {
        return Err(LineError::input(
            "Небезопасные параметры запуска запрещены.",
        ));
    }
    Ok(args)
}

pub fn verified_game_dir(base: &Path, sha256: &str) -> LineResult<PathBuf> {
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(LineError::input("Некорректный идентификатор релиза."));
    }
    let releases = base.join("releases");
    let dir = releases.join(sha256);
    if !is_real_dir(&releases) || !is_real_dir(&dir) || !is_real_file(&dir.join(".line-complete")) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Сборка не установлена полностью.",
            false,
        ));
    }
    Ok(dir)
}

#[derive(Serialize)]
struct TicketRequest<'a> {
    server_id: &'a str,
    sha256: &'a str,
    channel_id: &'a str,
    username: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketResponse {
    ticket: String,
    expires_in: u64,
}

async fn issue_ticket(
    state: &LineState,
    endpoint: &str,
    token: &str,
    request: &TicketRequest<'_>,
) -> LineResult<(Zeroizing<String>, u64)> {
    let url = super::config::validate_https(endpoint)?;
    let mut response = super::http::post_bearer_json(&state.http, &url, token, request)
        .await
        .map_err(|error| match error.http_status {
            Some(401 | 403) => LineError::new(
                ErrorCode::AuthRequired,
                "Сессия провайдера отклонена при выдаче launch ticket. Войдите повторно.",
                false,
            ),
            _ => error,
        })?;
    let bytes = Zeroizing::new(super::http::read_limited(&mut response, 16 * 1024).await?);
    parse_ticket_response(&bytes)
}

fn parse_ticket_response(bytes: &[u8]) -> LineResult<(Zeroizing<String>, u64)> {
    let parsed: TicketResponse = serde_json::from_slice(bytes).map_err(|_| {
        LineError::new(
            ErrorCode::Internal,
            "API провайдера не соответствует контракту launch ticket.",
            false,
        )
    })?;
    let ticket = Zeroizing::new(parsed.ticket);
    if ticket.is_empty()
        || ticket.len() > 8192
        || ticket.chars().any(char::is_control)
        || !(1..=120).contains(&parsed.expires_in)
    {
        return Err(LineError::new(
            ErrorCode::Internal,
            "API провайдера вернул некорректный launch ticket.",
            false,
        ));
    }
    Ok((ticket, parsed.expires_in))
}

async fn wait_stop(stop: &AtomicBool) {
    while !stop.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn cancelled() -> LineError {
    LineError::new(ErrorCode::Cancelled, "Запуск отменён.", false)
}

/// Stamp, remember and emit. Every status transition goes through this helper.
fn publish(app: &AppHandle, state: &LineState, status: GameStatus) -> GameStatus {
    let status = state.publish_game_status(status);
    let _ = app.emit(GAME_EVENT, status.clone());
    status
}

fn total_memory() -> u64 {
    use sysinfo::System;
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory()
}

#[tauri::command]
pub async fn launch_game(
    server_id: String,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<GameStatus> {
    let (_, config) = state.fresh_config()?;
    let server = config.server(&server_id)?.clone();
    let session = state.session(&server_id)?;
    let ticket_url = server
        .auth
        .launch_ticket_url
        .as_deref()
        .ok_or_else(|| LineError::input("Провайдер не настроил запуск для этого сервера."))?;
    let exchange_url =
        server.auth.session_exchange_url.as_deref().ok_or_else(|| {
            LineError::input("Провайдер не настроил обмен сессии для этого сервера.")
        })?;
    super::config::validate_https(exchange_url)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server_id)?;
    let stop = state.begin_launch(&server_id)?;
    publish(
        &app,
        &state,
        GameStatus {
            server_id: server_id.clone(),
            revision: 0,
            phase: GamePhase::Starting,
            sha256: None,
            started_at: None,
            exit_code: None,
            message: None,
        },
    );
    let result = async {
        // Hold the same cross-process lock used by install/rollback/prune for
        // the whole game lifetime. Another launcher process cannot delete a live release.
        let io_base = base.clone();
        let io_server = server_id.clone();
        // The blocking task keeps the lease only until it finishes; dropping the
        // handle on cancellation releases it, so "Отменить запуск" stays responsive
        // even while another process holds the lock.
        let io = tauri::async_runtime::spawn_blocking(move || {
            let lock = InstallLock::acquire(&io_base)?;
            let receipt = current_receipt(&io_base, &io_server).ok_or_else(|| {
                LineError::new(ErrorCode::Integrity, "Сначала установите сборку.", false)
            })?;
            let game_dir = verified_game_dir(&io_base, &receipt.sha256)?;
            let resolved = read_optional(&game_dir)?.ok_or_else(|| {
                LineError::input("В сборке нет манифеста запуска line-launch.json.")
            })?;
            Ok::<_, LineError>((lock, receipt, game_dir, resolved))
        });
        let (lock, receipt, game_dir, resolved) = tokio::select! {
            result = io => result.map_err(|_| LineError::storage())??,
            _ = wait_stop(&stop) => return Err(cancelled()),
        };
        if stop.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let runtime = tokio::select! {
            result = java::discover(resolved.manifest.java_major) => result?,
            _ = wait_stop(&stop) => return Err(cancelled()),
        };
        if stop.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        // Bind before spawn: a fast mod must never hit connect-before-bind.
        let channel = PrivateChannel::create()?;
        // Bind the secret guard and the request body outside the future: a
        // temporary here would be dropped while the select! still borrows it.
        let token = session.secret_token();
        let request = TicketRequest {
            server_id: &server_id,
            sha256: &receipt.sha256,
            channel_id: &channel.id,
            username: &session.username,
        };
        let (ticket, expires_in) = tokio::select! {
            result = issue_ticket(&state, ticket_url, &token, &request) => result?,
            _ = wait_stop(&stop) => return Err(cancelled()),
        };
        if stop.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let spec = LaunchSpec {
            java: runtime.path,
            game_dir: game_dir.clone(),
            classpath: resolved.classpath,
            main_class: resolved.manifest.main_class,
            username: session.username.clone(),
            minecraft_version: resolved.manifest.minecraft_version,
            asset_index: resolved.manifest.asset_index,
            assets_dir: resolved.assets_dir,
            natives_dir: resolved.natives_dir,
            session_channel_id: channel.id.clone(),
            total_memory_bytes: total_memory(),
        };
        let args = build_java_command(&spec)?;
        let mut command = tokio::process::Command::new(&args[0]);
        command
            .args(&args[1..])
            .current_dir(&game_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|_| {
            LineError::new(ErrorCode::Internal, "Не удалось запустить Java.", false)
        })?;
        let pid = child.id().ok_or_else(|| {
            LineError::new(
                ErrorCode::Internal,
                "Процесс Java завершился до запуска.",
                false,
            )
        })?;
        // No await between spawn and registration: the starting reservation and
        // stop flag transfer atomically into the running state.
        let game = state.register_running(&server_id, &receipt.sha256, stop.clone())?;
        let started_at = game.started_at;
        let status = publish(
            &app,
            &state,
            GameStatus {
                server_id: server_id.clone(),
                revision: 0,
                phase: GamePhase::Running,
                sha256: Some(receipt.sha256.clone()),
                started_at: Some(started_at),
                exit_code: None,
                message: None,
            },
        );
        let monitor_app = app.clone();
        let monitor_server = server_id.clone();
        let monitor_sha = receipt.sha256.clone();
        let exchange_url = exchange_url.to_owned();
        let username = session.username.clone();
        let monitor_stop = stop.clone();
        tauri::async_runtime::spawn(async move {
            let _lock = lock;
            let ipc_server = monitor_server.clone();
            let ipc_sha = monitor_sha.clone();
            let mut ipc_task = tauri::async_runtime::spawn(async move {
                channel
                    .serve_once(
                        pid,
                        ticket,
                        &exchange_url,
                        &ipc_server,
                        &ipc_sha,
                        &username,
                        expires_in,
                    )
                    .await
            });
            let mut ipc_failure: Option<LineError> = None;
            let mut ipc_done = false;
            let mut stopped = false;
            let exit = loop {
                if monitor_stop.load(Ordering::Acquire) {
                    stopped = true;
                    let _ = child.kill().await;
                    ipc_task.abort();
                    break None;
                }
                if ipc_done {
                    tokio::select! {
                        result = child.wait() => break result.ok().and_then(|status| status.code()),
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                    }
                } else {
                    tokio::select! {
                        result = &mut ipc_task => {
                            ipc_done = true;
                            match result {
                                Ok(Ok(())) => {}
                                Ok(Err(error)) => {
                                    ipc_failure = Some(error);
                                    let _ = child.kill().await;
                                }
                                Err(_) => {
                                    ipc_failure = Some(LineError::new(
                                        ErrorCode::Internal,
                                        "Задача приватного канала завершилась аварийно.",
                                        false,
                                    ));
                                    let _ = child.kill().await;
                                }
                            }
                        }
                        result = child.wait() => {
                            let code = result.ok().and_then(|status| status.code());
                            if !ipc_done {
                                // The mod may have received the ticket and exited in the
                                // same scheduler tick. Give the IPC task a brief grace
                                // period before declaring a missing-ticket failure.
                                match tokio::time::timeout(Duration::from_millis(500), &mut ipc_task).await {
                                    Ok(Ok(Ok(()))) => {}
                                    Ok(Ok(Err(error))) => ipc_failure = Some(error),
                                    _ => ipc_failure = Some(LineError::new(
                                        ErrorCode::AuthRequired,
                                        "Игра завершилась до получения launch ticket. Проверьте мод авторизации провайдера.",
                                        false,
                                    )),
                                }
                                ipc_task.abort();
                            }
                            break code;
                        }
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                    }
                }
            };
            // The process is gone; release the filesystem lease before admitting
            // a new install/rollback in this or another launcher process.
            drop(_lock);
            let monitor_state = monitor_app.state::<LineState>();
            monitor_state.finish_game(&monitor_server);
            let (phase, message) = if stopped {
                (GamePhase::Exited, Some("Игра остановлена пользователем.".to_owned()))
            } else if let Some(error) = ipc_failure {
                (GamePhase::Failed, Some(error.message))
            } else if let Some(code) = exit.filter(|&code| code != 0) {
                (GamePhase::Failed, Some(format!("Игра завершилась с кодом {code}.")))
            } else if exit.is_none() {
                (GamePhase::Failed, Some("Игра завершилась аварийно.".to_owned()))
            } else {
                (GamePhase::Exited, None)
            };
            publish(
                &monitor_app,
                &monitor_state,
                GameStatus {
                    server_id: monitor_server,
                    revision: 0,
                    phase,
                    sha256: Some(monitor_sha),
                    started_at: Some(started_at),
                    exit_code: exit,
                    message,
                },
            );
        });
        Ok(status)
    }
    .await;
    state.finish_launch(&server_id);
    if let Err(error) = &result {
        publish(
            &app,
            &state,
            GameStatus {
                server_id: server_id.clone(),
                revision: 0,
                phase: GamePhase::Failed,
                sha256: None,
                started_at: None,
                exit_code: None,
                message: Some(error.message.clone()),
            },
        );
    }
    result
}

#[tauri::command]
pub async fn stop_game(server_id: String, state: State<'_, LineState>) -> LineResult<bool> {
    state.stop_game(&server_id)
}

#[tauri::command]
pub async fn get_game_status(
    server_id: String,
    state: State<'_, LineState>,
) -> LineResult<GameStatus> {
    // Returns the last published transition (including exited/failed), never a
    // synthesized phase that could undo a terminal event in the UI.
    state.game_status(&server_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> LaunchSpec {
        LaunchSpec {
            java: "/usr/bin/java".into(),
            game_dir: "/game".into(),
            classpath: vec!["/game/client.jar".into()],
            main_class: "net.minecraft.client.main.Main".into(),
            username: "Player_1".into(),
            minecraft_version: "1.21.1".into(),
            asset_index: None,
            assets_dir: None,
            natives_dir: None,
            session_channel_id: "launch-channel-1".into(),
            total_memory_bytes: 16 * 1024 * 1024 * 1024,
        }
    }

    #[test]
    fn command_contains_channel_not_secret_and_automatic_heap() {
        let args = build_java_command(&spec()).unwrap();
        assert!(args.contains(&"-Xmx8192M".to_owned()));
        let game_dir = args.iter().position(|a| a == "--gameDir").unwrap();
        assert_eq!(args[game_dir + 1], "/game");
        assert!(args
            .iter()
            .any(|a| a == "-DlineLauncher.sessionChannel=launch-channel-1"));
        assert!(!args
            .iter()
            .any(|a| a.to_ascii_lowercase().contains("accesstoken=")));
    }

    #[test]
    fn rejects_agent_injection_and_small_host_memory_is_bounded() {
        assert_eq!(optimal_heap_mb(0), 1024);
        assert_eq!(optimal_heap_mb(4 * 1024 * 1024 * 1024), 2048);
        let mut s = spec();
        s.session_channel_id = "-javaagent:evil".into();
        assert!(build_java_command(&s).is_err());
    }

    #[test]
    fn ticket_response_is_strict_and_short_lived() {
        let (ticket, ttl) =
            parse_ticket_response(br#"{"ticket":"one-shot","expires_in":60}"#).unwrap();
        assert_eq!(&*ticket, "one-shot");
        assert_eq!(ttl, 60);
        for bytes in [
            &br#"{"ticket":"","expires_in":60}"#[..],
            &br#"{"ticket":"x","expires_in":0}"#[..],
            &br#"{"ticket":"x","expires_in":121}"#[..],
            &br#"{"ticket":"x\ny","expires_in":60}"#[..],
            &br#"{"ticket":"x","expires_in":60,"extra":true}"#[..],
            &br#"{"ticket":1,"expires_in":60}"#[..],
        ] {
            assert!(parse_ticket_response(bytes).is_err());
        }
    }
}
