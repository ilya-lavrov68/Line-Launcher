//! Minecraft profiles installed and launched through `mc-launcher-core`.
//!
//! Additive mode: provider ZIP packs, the private ticket channel and the demo
//! keep working untouched. Nothing here reads or writes their directories —
//! profiles live under `<app-data>/minecraft/<instance>/`.
//!
//! # Threading
//!
//! `mc-launcher-core` is synchronous and uses `reqwest::blocking`. Every call
//! into it therefore runs on `tokio::task::spawn_blocking`; calling it directly
//! from an async worker panics with "cannot block the current thread from within
//! a runtime". The child process itself is a `tokio::process::Command`, so the
//! existing stop/monitor behaviour is preserved.
//!
//! # Identity
//!
//! `Account::Offline` carries the signed-in provider account's nickname and the
//! launcher's stable per-account UUID (not `Account::offline`, which would mint
//! a random UUID on every launch and orphan world player data). An offline
//! account has an empty access token: servers running `online-mode=true` reject
//! it. That check happens on the server and is deliberately not defeated here.
use super::error::{ErrorCode, LineError, LineResult};
use super::java;
use super::launch::{optimal_heap_mb, player_uuid, validate_heap, GamePhase};
use super::minecraft_core::{
    apply_heap, reject_dangerous_args, validate_instance_id, validate_loader, validate_version_id,
    LoaderChoice,
};
use super::settings::{self, LauncherSettings};
use super::state::{epoch_millis, LineState};
use super::storage::create_private_dir;
use super::LAUNCHER_VERSION;
// Imported from the prelude, but not as a glob: the crate also exports a
// one-parameter `Result` alias that would shadow `std::result::Result` here.
use mc_launcher_core::core::version::VersionJson;
use mc_launcher_core::prelude::{
    Account, CompatibilityPolicy, InstallRequest, JavaInstallPolicy, LaunchCommand, LaunchOptions,
    Launcher, LoaderSpec, LoaderVersion, ProgressEvent,
};
use mc_launcher_core::progress::InstallStage;
use mc_launcher_core::runtime;
use mc_launcher_core::types::CallbackDict;
use mc_launcher_core::LauncherError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const MC_INSTALL_EVENT: &str = "line://mc-install-progress";
pub const MC_GAME_EVENT: &str = "line://mc-game-status";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McLoaderRequest {
    pub kind: String,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McInstallRequest {
    pub instance_id: String,
    pub minecraft_version: String,
    #[serde(default)]
    pub loader: Option<McLoaderRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McInstalled {
    pub instance_id: String,
    /// Profile id to launch; with a loader this differs from the input version.
    pub version_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McLaunchRequest {
    pub instance_id: String,
    pub version_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McInstallProgress {
    pub instance_id: String,
    pub stage: String,
    pub label: String,
    pub received_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McGameStatus {
    pub instance_id: String,
    pub version_id: String,
    pub phase: GamePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

struct Running {
    stop: Arc<AtomicBool>,
    version_id: String,
    started_at: u64,
}

#[derive(Default)]
struct Inner {
    running: HashMap<String, Running>,
    installing: HashSet<String>,
    starting: HashSet<String>,
}

/// Separate from `LineState`: provider builds are keyed by server id and carry a
/// release sha256, which a Mojang profile does not have.
#[derive(Default)]
pub struct MinecraftState {
    inner: Mutex<Inner>,
}

impl MinecraftState {
    fn lock(&self) -> LineResult<MutexGuard<'_, Inner>> {
        self.inner.lock().map_err(|_| {
            LineError::new(
                ErrorCode::Internal,
                "Состояние Minecraft повреждено. Перезапустите лаунчер.",
                false,
            )
        })
    }
}

fn busy() -> LineError {
    LineError::new(
        ErrorCode::Busy,
        "Экземпляр занят: дождитесь окончания установки или остановки игры.",
        false,
    )
}

fn instance_root(app: &AppHandle, instance_id: &str) -> LineResult<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let dir = root.join("minecraft").join(instance_id);
    create_private_dir(&dir)?;
    Ok(dir)
}

fn total_memory() -> u64 {
    use sysinfo::System;
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory()
}

/// Actionable, non-sensitive translation. Raw crate errors can carry URLs and
/// local paths, so they are never serialized to the WebView verbatim.
fn mc_error(error: LauncherError) -> LineError {
    match error {
        LauncherError::Network { .. } => LineError::new(
            ErrorCode::Network,
            "Не удалось скачать файлы Minecraft. Проверьте интернет, proxy и VPN.",
            true,
        ),
        LauncherError::Io { source } => LineError::io(&source),
        LauncherError::ChecksumMismatch { .. } => LineError::new(
            ErrorCode::Integrity,
            "Скачанный файл не прошёл проверку контрольной суммы. Повторите установку.",
            true,
        ),
        LauncherError::UnsafePath { .. } => LineError::new(
            ErrorCode::UnsafeArchive,
            "Метаданные версии содержат небезопасный путь. Установка отклонена.",
            false,
        ),
        LauncherError::InvalidVersionId { .. } => LineError::input(
            "Такой версии нет в официальном манифесте Mojang. Проверьте номер версии.",
        ),
        LauncherError::LoaderVersionNotFound { .. } => {
            LineError::input("Версия загрузчика модов не найдена. Укажите другую версию.")
        }
        LauncherError::InstallerFailed { loader, .. } => LineError::new(
            ErrorCode::Internal,
            format!("Установщик {loader:?} завершился с ошибкой. Проверьте Java и повторите."),
            true,
        ),
        LauncherError::UnsupportedPlatform { .. } => LineError::new(
            ErrorCode::UnsupportedVersion,
            "Эта версия не поддерживается на вашей операционной системе.",
            false,
        ),
        LauncherError::Zip { .. } => LineError::new(
            ErrorCode::UnsafeArchive,
            "Не удалось распаковать файлы версии.",
            false,
        ),
        LauncherError::Json { .. }
        | LauncherError::MissingField { .. }
        | LauncherError::InvalidMavenCoordinate { .. } => LineError::new(
            ErrorCode::Integrity,
            "Метаданные версии повреждены или не поддерживаются.",
            false,
        ),
        LauncherError::Other { .. } => LineError::new(
            ErrorCode::Internal,
            "Не удалось подготовить Minecraft. Повторите установку.",
            true,
        ),
    }
}

fn join_error() -> LineError {
    LineError::new(
        ErrorCode::Internal,
        "Задача установки завершилась аварийно. Повторите попытку.",
        true,
    )
}

fn loader_spec(choice: LoaderChoice, version: Option<String>) -> LoaderSpec {
    let version = match version {
        Some(exact) => LoaderVersion::Exact(exact),
        None => LoaderVersion::LatestStable,
    };
    match choice {
        LoaderChoice::Fabric => LoaderSpec::Fabric { version },
        LoaderChoice::Quilt => LoaderSpec::Quilt { version },
        LoaderChoice::Forge => LoaderSpec::Forge { version },
        LoaderChoice::NeoForge => LoaderSpec::NeoForge { version },
    }
}

fn stage_name(stage: &InstallStage) -> &'static str {
    match stage {
        InstallStage::ResolveVersion => "resolve",
        InstallStage::DownloadLibraries => "libraries",
        InstallStage::DownloadAssets => "assets",
        InstallStage::InstallRuntime => "runtime",
        InstallStage::ExtractNatives => "natives",
        InstallStage::LoaderInstall => "loader",
        InstallStage::Verify => "verify",
    }
}

fn progress_dto(instance_id: &str, event: &ProgressEvent, finished: bool) -> McInstallProgress {
    let (stage, label, received, total) = match event {
        ProgressEvent::StageStarted { stage } => (stage_name(stage), String::new(), 0, None),
        ProgressEvent::TaskStarted { label, .. } => ("download", label.clone(), 0, None),
        ProgressEvent::TaskSkipped { label, .. } => ("cached", label.clone(), 0, None),
        ProgressEvent::TaskFinished { label } => ("task", label.clone(), 0, None),
        ProgressEvent::BytesReceived {
            label,
            received,
            total,
        } => ("download", label.clone(), *received, *total),
    };
    McInstallProgress {
        instance_id: instance_id.to_string(),
        stage: stage.to_string(),
        label,
        received_bytes: received,
        total_bytes: total,
        finished,
    }
}

/// Installs a vanilla or loader-backed profile from the official Mojang/loader
/// endpoints. Blocking work stays off the async runtime.
#[tauri::command]
pub async fn mc_install(
    app: AppHandle,
    state: State<'_, MinecraftState>,
    request: McInstallRequest,
) -> LineResult<McInstalled> {
    let instance_id = validate_instance_id(&request.instance_id)?;
    let version = validate_version_id(&request.minecraft_version)?;
    let loader = match &request.loader {
        Some(loader) => {
            let (choice, exact) = validate_loader(&loader.kind, loader.version.as_deref())?;
            Some(loader_spec(choice, exact))
        }
        None => None,
    };
    {
        let mut inner = state.lock()?;
        if inner.running.contains_key(&instance_id) || inner.starting.contains(&instance_id) {
            return Err(busy());
        }
        if !inner.installing.insert(instance_id.clone()) {
            return Err(busy());
        }
    }

    let dir = instance_root(&app, &instance_id)?;
    let emit_app = app.clone();
    let emit_instance = instance_id.clone();
    let installed = tokio::task::spawn_blocking(move || -> LineResult<String> {
        let launcher = Launcher::new(dir);
        let request = InstallRequest {
            minecraft_version: version,
            loader,
            // The facade does not bundle Java; the runtime is resolved below
            // through `LaunchOptions::java_executable`.
            java: JavaInstallPolicy::Auto,
        };
        let mut reporter = move |event: ProgressEvent| {
            let _ = emit_app.emit(
                MC_INSTALL_EVENT,
                progress_dto(&emit_instance, &event, false),
            );
        };
        let result = launcher
            .install_with_progress(request, &mut reporter)
            .map_err(mc_error)?;
        Ok(result.version_id)
    })
    .await
    .map_err(|_| join_error())
    .and_then(|result| result);

    if let Ok(mut inner) = state.lock() {
        inner.installing.remove(&instance_id);
    }
    let version_id = installed?;
    let _ = app.emit(
        MC_INSTALL_EVENT,
        McInstallProgress {
            instance_id: instance_id.clone(),
            stage: "completed".to_string(),
            label: version_id.clone(),
            received_bytes: 0,
            total_bytes: None,
            finished: true,
        },
    );
    Ok(McInstalled {
        instance_id,
        version_id,
    })
}

/// Profiles already present on disk, newest directory order is not implied.
#[tauri::command]
pub async fn mc_list_installed(app: AppHandle, instance_id: String) -> LineResult<Vec<String>> {
    let instance_id = validate_instance_id(&instance_id)?;
    let dir = instance_root(&app, &instance_id)?.join("versions");
    let mut found = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(found),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() && path.join(format!("{name}.json")).is_file() {
            if let Ok(id) = validate_version_id(name) {
                found.push(id);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// Picks a runtime the game actually accepts: the player's verified choice,
/// then local discovery, then Mojang's own JRE for that version.
async fn resolve_java(
    dir: &Path,
    component: Option<String>,
    required_major: u16,
    preferences: &LauncherSettings,
) -> LineResult<PathBuf> {
    if let Some(requested) = &preferences.java_path {
        if let Ok(runtime) = java::inspect_path(requested).await {
            if runtime.major == required_major {
                return Ok(runtime.path);
            }
        }
    }
    if let Ok(runtime) = java::discover(required_major).await {
        return Ok(runtime.path);
    }
    let Some(component) = component else {
        return Err(LineError::new(
            ErrorCode::JavaRequired,
            format!(
                "Нужна Java {required_major}. Установите её или укажите путь к java.exe в настройках."
            ),
            false,
        ));
    };
    if let Some(path) = runtime::get_executable_path(&component, dir) {
        return Ok(java::inspect_path(&path.to_string_lossy()).await?.path);
    }
    let owned_dir = dir.to_path_buf();
    let owned_component = component.clone();
    tokio::task::spawn_blocking(move || -> LineResult<()> {
        runtime::install_jvm_runtime(&owned_component, &owned_dir, &CallbackDict::default())
            .map_err(|_| {
                LineError::new(
                    ErrorCode::Network,
                    "Не удалось скачать Java от Mojang. Проверьте интернет или выберите свою Java в настройках.",
                    true,
                )
            })
    })
    .await
    .map_err(|_| join_error())??;
    let path = runtime::get_executable_path(&component, dir).ok_or_else(|| {
        LineError::new(
            ErrorCode::JavaRequired,
            "Java скачана, но исполняемый файл не найден. Выберите Java вручную в настройках.",
            false,
        )
    })?;
    let probed = java::inspect_path(&path.to_string_lossy()).await?;
    if probed.major != required_major {
        return Err(LineError::new(
            ErrorCode::JavaRequired,
            format!(
                "Скачана Java {}, а версии нужна Java {required_major}.",
                probed.major
            ),
            false,
        ));
    }
    Ok(probed.path)
}

fn emit_status(app: &AppHandle, status: McGameStatus) -> McGameStatus {
    let _ = app.emit(MC_GAME_EVENT, status.clone());
    status
}

/// Builds the command with the crate and spawns it as a monitored Tokio child.
#[tauri::command]
pub async fn mc_launch(
    app: AppHandle,
    line: State<'_, LineState>,
    state: State<'_, MinecraftState>,
    request: McLaunchRequest,
) -> LineResult<McGameStatus> {
    let instance_id = validate_instance_id(&request.instance_id)?;
    let version_id = validate_version_id(&request.version_id)?;
    // One account per project: the nickname and the stable UUID come from it.
    let session = line.session()?;
    let username = session.username.clone();
    let uuid = player_uuid(&username);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut inner = state.lock()?;
        if inner.installing.contains(&instance_id)
            || inner.running.contains_key(&instance_id)
            || !inner.starting.insert(instance_id.clone())
        {
            return Err(busy());
        }
    }

    let started = start_game(
        &app,
        &state,
        &instance_id,
        &version_id,
        &username,
        &uuid,
        stop,
    )
    .await;
    if let Ok(mut inner) = state.lock() {
        inner.starting.remove(&instance_id);
        if started.is_err() {
            inner.running.remove(&instance_id);
        }
    }
    match started {
        Ok(status) => Ok(status),
        Err(error) => {
            emit_status(
                &app,
                McGameStatus {
                    instance_id,
                    version_id,
                    phase: GamePhase::Failed,
                    started_at: None,
                    exit_code: None,
                    message: Some(error.message.clone()),
                },
            );
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn start_game(
    app: &AppHandle,
    state: &MinecraftState,
    instance_id: &str,
    version_id: &str,
    username: &str,
    uuid: &str,
    stop: Arc<AtomicBool>,
) -> LineResult<McGameStatus> {
    let dir = instance_root(app, instance_id)?;
    let game_dir = dir.join("game");
    create_private_dir(&game_dir)?;
    emit_status(
        app,
        McGameStatus {
            instance_id: instance_id.to_string(),
            version_id: version_id.to_string(),
            phase: GamePhase::Starting,
            started_at: None,
            exit_code: None,
            message: Some("Подготовка Minecraft…".to_string()),
        },
    );

    let load_dir = dir.clone();
    let load_id = version_id.to_string();
    let (version, component, required_major) =
        tokio::task::spawn_blocking(move || -> LineResult<(VersionJson, Option<String>, u16)> {
            let launcher = Launcher::new(load_dir);
            let version = launcher.load_version(&load_id).map_err(mc_error)?;
            let (component, major) = match &version.java_version {
                Some(java) => (Some(java.component.clone()), java.major_version),
                None => (None, 8),
            };
            let major = u16::try_from(major).unwrap_or(8).clamp(8, 26);
            Ok((version, component, major))
        })
        .await
        .map_err(|_| join_error())??;

    let total = total_memory();
    let preferences = settings::load(app, total);
    let heap_mb = match preferences.heap_mb {
        Some(requested) => validate_heap(requested, total)?,
        None => optimal_heap_mb(total),
    };
    let java_path = resolve_java(&dir, component, required_major, &preferences).await?;

    let build_dir = dir.clone();
    let account_name = username.to_string();
    let account_uuid = uuid.to_string();
    let window = (preferences.window_width, preferences.window_height);
    let command = tokio::task::spawn_blocking(move || -> LineResult<LaunchCommand> {
        let launcher = Launcher::new(build_dir);
        let options = LaunchOptions {
            account: Account::Offline {
                username: account_name,
                uuid: account_uuid,
            },
            java_executable: Some(java_path),
            game_directory: Some(game_dir),
            natives_directory: None,
            launcher_name: "Line Launcher".to_string(),
            launcher_version: LAUNCHER_VERSION.to_string(),
            custom_resolution: Some(window),
            demo: false,
            server: None,
            disable_multiplayer: false,
            disable_chat: false,
            compatibility: CompatibilityPolicy::Auto,
        };
        let command = launcher
            .build_launch_command_from_version(&version, options)
            .map_err(mc_error)?;
        let mut args = command.args;
        reject_dangerous_args(&args)?;
        apply_heap(&mut args, heap_mb);
        Ok(LaunchCommand { args, ..command })
    })
    .await
    .map_err(|_| join_error())??;

    let logs = dir.join("logs");
    create_private_dir(&logs)?;
    let log = std::fs::File::create(logs.join("launch.log")).map_err(|e| LineError::io(&e))?;
    let log_copy = log.try_clone().map_err(|e| LineError::io(&e))?;
    let mut child_command = tokio::process::Command::new(&command.executable);
    child_command
        .args(&command.args)
        .envs(command.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .current_dir(&command.working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_copy))
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        child_command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = child_command.spawn().map_err(|_| {
        LineError::new(
            ErrorCode::JavaRequired,
            "Не удалось запустить Java. Проверьте выбранный рантайм в настройках.",
            false,
        )
    })?;

    let started_at = epoch_millis();
    {
        let mut inner = state.lock()?;
        inner.running.insert(
            instance_id.to_string(),
            Running {
                stop: stop.clone(),
                version_id: version_id.to_string(),
                started_at,
            },
        );
    }
    let status = emit_status(
        app,
        McGameStatus {
            instance_id: instance_id.to_string(),
            version_id: version_id.to_string(),
            phase: GamePhase::Running,
            started_at: Some(started_at),
            exit_code: None,
            message: None,
        },
    );

    let monitor_app = app.clone();
    let monitor_instance = instance_id.to_string();
    let monitor_version = version_id.to_string();
    tauri::async_runtime::spawn(async move {
        let exit = loop {
            if stop.load(Ordering::Acquire) {
                let _ = child.kill().await;
                break None;
            }
            tokio::select! {
                result = child.wait() => break result.ok().and_then(|status| status.code()),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        };
        let state = monitor_app.state::<MinecraftState>();
        if let Ok(mut inner) = state.lock() {
            inner.running.remove(&monitor_instance);
        }
        let (phase, message) = match exit {
            Some(0) => (GamePhase::Exited, None),
            Some(code) => (
                GamePhase::Failed,
                Some(format!(
                    "Игра завершилась с кодом {code}. Подробности в logs/launch.log."
                )),
            ),
            None => (GamePhase::Exited, Some("Игра остановлена.".to_string())),
        };
        emit_status(
            &monitor_app,
            McGameStatus {
                instance_id: monitor_instance,
                version_id: monitor_version,
                phase,
                started_at: Some(started_at),
                exit_code: exit,
                message,
            },
        );
    });
    Ok(status)
}

#[tauri::command]
pub async fn mc_stop(state: State<'_, MinecraftState>, instance_id: String) -> LineResult<bool> {
    let instance_id = validate_instance_id(&instance_id)?;
    let inner = state.lock()?;
    match inner.running.get(&instance_id) {
        Some(running) => {
            running.stop.store(true, Ordering::Release);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn mc_status(
    state: State<'_, MinecraftState>,
    instance_id: String,
) -> LineResult<McGameStatus> {
    let instance_id = validate_instance_id(&instance_id)?;
    let inner = state.lock()?;
    Ok(match inner.running.get(&instance_id) {
        Some(running) => McGameStatus {
            instance_id,
            version_id: running.version_id.clone(),
            phase: GamePhase::Running,
            started_at: Some(running.started_at),
            exit_code: None,
            message: None,
        },
        None => McGameStatus {
            instance_id,
            version_id: String::new(),
            phase: GamePhase::Idle,
            started_at: None,
            exit_code: None,
            message: None,
        },
    })
}
