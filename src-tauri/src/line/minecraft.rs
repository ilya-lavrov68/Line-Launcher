//! Minecraft profiles installed and launched through `mc-launcher-core`.
//!
//! Additive mode: the ticket channel, the private IPC and the demo keep working
//! untouched. `mc_play` does reuse the provider's verified ZIP pipeline — it
//! reads `servers/<id>/releases/<sha>/` through `install`/`integrity` and never
//! writes there. The playable copy lives in `<app-data>/minecraft/<instance>/`,
//! with the live `.minecraft` in its `game/` subdirectory.
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
use super::install::{self, InstallPhase, InstallProgress, ProgressSink};
use super::integrity;
use super::java;
use super::launch::{optimal_heap_mb, player_uuid, validate_heap, GamePhase};
use super::minecraft_core::{
    accepts_explicit_java, apply_heap, ensure_server_join, has_quick_play_token,
    reject_dangerous_args, remove_automatic_joins, validate_instance_id, validate_loader,
    validate_server_address, validate_test_mode, validate_version_id, LoaderChoice,
};
use super::pack::{self, DetectedInstance};
use super::settings::{self, LauncherSettings};
use super::state::{epoch_millis, LineState};
use super::storage::{create_private_dir, server_dir};
use super::LAUNCHER_VERSION;
// Imported from the prelude, but not as a glob: the crate also exports a
// one-parameter `Result` alias that would shadow `std::result::Result` here.
use mc_launcher_core::core::version::{ArgumentValue, StringOrVec, VersionJson};
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
use uuid::Uuid;

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
    /// The client joins this server straight away; there is no menu step.
    pub server_address: String,
}

/// What the «Играть» button calls: verify-or-download the profile, then join.
/// Re-running an install skips every file whose checksum still matches, so an
/// unchanged profile costs a metadata pass instead of a re-download.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McPlayRequest {
    /// Everything else defaults to what the provider published for this server.
    pub server_id: String,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub minecraft_version: Option<String>,
    #[serde(default)]
    pub loader: Option<McLoaderRequest>,
    #[serde(default)]
    pub server_address: Option<String>,
    #[serde(default)]
    pub test_mode: bool,
    #[serde(default)]
    pub prepare_only: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_total: Option<u64>,
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

/// The live game directory. It is a plain `.minecraft`: the pack's mods, config
/// and (when present) versions/libraries/assets are copied here, and the crate
/// fills in whatever the archive did not carry. The Java runtime is kept one
/// level up so it is never mistaken for pack content.
fn game_root(app: &AppHandle, instance_id: &str) -> LineResult<PathBuf> {
    let dir = instance_root(app, instance_id)?.join("game");
    create_private_dir(&dir)?;
    Ok(dir)
}

fn total_memory() -> u64 {
    use sysinfo::System;
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory()
}

/// Report only a small allowlist of public service names. Reqwest URLs may
/// contain access tokens, signed paths, queries, custom hosts or usernames.
fn minecraft_service(host: Option<&str>) -> &'static str {
    match host {
        Some("maven.neoforged.net") => "NeoForge (maven.neoforged.net)",
        Some("maven.minecraftforge.net") => "Forge (maven.minecraftforge.net)",
        Some("meta.fabricmc.net") | Some("maven.fabricmc.net") => "Fabric",
        Some("meta.quiltmc.org") | Some("maven.quiltmc.org") => "Quilt",
        Some("piston-meta.mojang.com")
        | Some("launchermeta.mojang.com")
        | Some("piston-data.mojang.com")
        | Some("resources.download.minecraft.net")
        | Some("libraries.minecraft.net")
        | Some("assets.minecraft.net") => "Mojang / Minecraft",
        _ => "сервер загрузки Minecraft",
    }
}

fn minecraft_network_error(
    host: Option<&str>,
    status: Option<u16>,
    timeout: bool,
    connect: bool,
) -> LineError {
    let service = minecraft_service(host);
    let message = if let Some(code) = status {
        match code {
            404 | 410 => format!("{service}: файл или версия не найдены (HTTP {code}). Проверьте версию загрузчика и сообщите разработчику лаунчера."),
            401 | 403 => format!("{service}: доступ к файлу отклонён (HTTP {code}). Проверьте доступность сервера и настройки сети."),
            429 => format!("{service}: слишком много запросов (HTTP {code}). Подождите и повторите."),
            500..=599 => format!("{service}: временная ошибка сервера (HTTP {code}). Попробуйте позже."),
            _ => format!("{service}: сервер отклонил запрос (HTTP {code})."),
        }
    } else if timeout {
        format!("{service}: истекло время ожидания. Проверьте сеть и попробуйте снова.")
    } else if connect {
        format!("Не удалось подключиться: {service}. Проверьте интернет, proxy и VPN.")
    } else {
        format!("Не удалось скачать файлы: {service}. Проверьте подключение и попробуйте снова.")
    };
    let code = if status.is_some() {
        ErrorCode::HttpStatus
    } else {
        ErrorCode::Network
    };
    let retryable = !matches!(status, Some(401 | 403 | 404 | 410));
    let mut result = LineError::new(code, message, retryable);
    result.http_status = status;
    result
}

/// Actionable, non-sensitive translation. Raw crate errors can carry URLs and
/// local paths, so they are never serialized to the WebView verbatim.
fn mc_error(error: LauncherError) -> LineError {
    match error {
        LauncherError::Network { source } => minecraft_network_error(
            source.url().and_then(|url| url.host_str()),
            source.status().map(|status| status.as_u16()),
            source.is_timeout(),
            source.is_connect(),
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
            format!("Установщик {loader:?} завершился с ошибкой. Причину нужно проверить в выводе установщика."),
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

/// Every game-argument token the profile advertises, including rule-gated ones
/// (they are not emitted, but they do tell us what the client understands).
fn game_argument_tokens(version: &VersionJson) -> Vec<String> {
    let mut tokens = Vec::new();
    for argument in &version.arguments.game {
        match argument {
            ArgumentValue::String(text) => tokens.push(text.clone()),
            ArgumentValue::Ruled { value, .. } => match value {
                StringOrVec::String(text) => tokens.push(text.clone()),
                StringOrVec::Vec(list) => tokens.extend(list.iter().cloned()),
            },
        }
    }
    if let Some(legacy) = &version.minecraft_arguments {
        tokens.extend(legacy.split_whitespace().map(str::to_string));
    }
    tokens
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
        files_done: None,
        files_total: None,
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
    let loader = parse_loader(request.loader.as_ref())?;
    install_profile(&app, &state, instance_id, version, loader).await
}

fn parse_loader(loader: Option<&McLoaderRequest>) -> LineResult<Option<LoaderSpec>> {
    match loader {
        Some(loader) => {
            let (choice, exact) = validate_loader(&loader.kind, loader.version.as_deref())?;
            Ok(Some(loader_spec(choice, exact)))
        }
        None => Ok(None),
    }
}

// NeoForge 47.x was published as net.neoforged:forge with the Minecraft
// version in the artifact version. Later NeoForge releases use :neoforge.
fn legacy_neoforge_version(
    minecraft: &str,
    loader: &Option<LoaderSpec>,
) -> LineResult<Option<String>> {
    if minecraft != "1.20.1" {
        return Ok(None);
    }
    match loader {
        Some(LoaderSpec::NeoForge {
            version: LoaderVersion::Exact(version),
        }) => {
            let version = version.strip_prefix("1.20.1-").unwrap_or(version);
            if !version.starts_with("47.")
                || !version.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                || version.contains("..")
                || version.ends_with('.')
            {
                return Err(LineError::input(
                    "Для NeoForge на Minecraft 1.20.1 укажите версию 47.x.",
                ));
            }
            Ok(Some(version.to_string()))
        }
        Some(LoaderSpec::NeoForge { .. }) => Err(LineError::input(
            "Для NeoForge на Minecraft 1.20.1 укажите точную версию 47.x.",
        )),
        _ => Ok(None),
    }
}

/// Retry only transient installer failures. The core skips an existing file
/// without a checksum, so an interrupted download must be removed *before*
/// retrying; otherwise a partial jar would be mistaken for a complete one.
fn retryable_installer_error(error: &LauncherError) -> bool {
    match error {
        LauncherError::Network { source } => {
            if LineError::network(source).code == ErrorCode::TlsUntrusted {
                return false;
            }
            source.is_timeout()
                || source.is_connect()
                || source
                    .status()
                    .is_some_and(|s| s.as_u16() == 429 || s.is_server_error())
        }
        LauncherError::Io { source } => matches!(
            source.kind(),
            std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

fn download_installer_with_retry(
    path: &Path,
    mut download: impl FnMut() -> Result<(), LauncherError>,
    mut wait: impl FnMut(Duration),
    mut retrying: impl FnMut(u32),
) -> LineResult<()> {
    const ATTEMPTS: u32 = 3;
    for attempt in 1..=ATTEMPTS {
        match download() {
            Ok(()) => return Ok(()),
            Err(error) => {
                // Fail rather than retry if an incomplete file cannot be removed.
                if let Err(io) = std::fs::remove_file(path) {
                    if io.kind() != std::io::ErrorKind::NotFound {
                        return Err(LineError::io(&io));
                    }
                }
                if attempt == ATTEMPTS || !retryable_installer_error(&error) {
                    return Err(mc_error(error));
                }
                retrying(attempt + 1);
                wait(Duration::from_millis(u64::from(attempt) * 750));
            }
        }
    }
    unreachable!("the retry loop always returns")
}

/// Forge-family client installers expect a launcher profile even when this
/// independent launcher uses its own profile database. Never replace an existing
/// profile: it may have been supplied by the user or another launcher.
fn ensure_installer_profile(dir: &Path) -> LineResult<()> {
    use std::io::Write;
    let path = dir.join("launcher_profiles.json");
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            if let Err(error) = file.write_all(b"{\"profiles\":{}}\n") {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(LineError::io(&error));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(LineError::io(&error)),
    }
}

async fn install_legacy_neoforge(
    app: &AppHandle,
    dir: PathBuf,
    version: String,
    app_emit: AppHandle,
    instance: String,
) -> LineResult<String> {
    let vanilla_dir = dir.clone();
    let emit = app_emit.clone();
    let emit_instance = instance.clone();
    tokio::task::spawn_blocking(move || {
        let mut report = move |event: ProgressEvent| {
            let _ = emit.emit(
                MC_INSTALL_EVENT,
                progress_dto(&emit_instance, &event, false),
            );
        };
        Launcher::new(vanilla_dir)
            .install_with_progress(InstallRequest::vanilla("1.20.1"), &mut report)
            .map_err(mc_error)?;
        Ok::<(), LineError>(())
    })
    .await
    .map_err(|_| join_error())??;
    let preferences = settings::load(app, total_memory());
    // The shared runtime belongs beside game/, not inside the pack's files.
    let runtime_dir = dir.parent().ok_or_else(LineError::storage)?;
    let java = resolve_java(
        runtime_dir,
        Some("java-runtime-gamma".to_string()),
        JavaRequirement {
            major: 17,
            allow_newer_explicit: false,
        },
        &preferences,
        app,
        &instance,
    )
    .await?;
    tokio::task::spawn_blocking(move || -> LineResult<String> {
        use mc_launcher_core::net::download::{execute_plan, DownloadPlan, DownloadTask};
        use mc_launcher_core::install::loader::{run_loader_installer, InstallerInvocation};
        use mc_launcher_core::loader::LoaderKind;
        use std::io::Read;
        let temp = tempfile::tempdir().map_err(|e| LineError::io(&e))?;
        let installer = temp.path().join("installer.jar");
        let artifact = format!("1.20.1-{version}");
        let url = format!("https://maven.neoforged.net/releases/net/neoforged/forge/{artifact}/forge-{artifact}-installer.jar");
        let retry_app = app_emit.clone();
        let retry_instance = instance.clone();
        let mut report = move |event: ProgressEvent| { let _ = app_emit.emit(MC_INSTALL_EVENT, progress_dto(&instance, &event, false)); };
        let plan = DownloadPlan { tasks: vec![DownloadTask { url, destination: installer.clone(), checksum: None, label: "NeoForge installer".to_string() }] };
        download_installer_with_retry(&installer, || execute_plan(&plan, &mut report), std::thread::sleep, |attempt| {
            emit_mc_progress(&retry_app, &retry_instance, "loader", &format!("NeoForge: повторная попытка {attempt} из 3"), 0, None, false);
        })?;
        // Read the profile id from the installer rather than assuming Forge's ID convention.
        let file = std::fs::File::open(&installer).map_err(|e| LineError::io(&e))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|_| LineError::new(ErrorCode::Integrity, "Установщик NeoForge повреждён.", false))?;
        let entry = archive.by_name("version.json").map_err(|_| LineError::new(ErrorCode::Integrity, "В установщике NeoForge нет профиля версии.", false))?;
        if entry.size() > 4 * 1024 * 1024 { return Err(LineError::new(ErrorCode::Integrity, "Профиль NeoForge слишком большой.", false)); }
        let mut json = String::new();
        entry.take(4 * 1024 * 1024 + 1).read_to_string(&mut json).map_err(|e| LineError::io(&e))?;
        let profile: serde_json::Value = serde_json::from_str(&json).map_err(|_| LineError::new(ErrorCode::Integrity, "Некорректный профиль установщика NeoForge.", false))?;
        let id = profile.get("id").and_then(|v| v.as_str()).ok_or_else(|| LineError::new(ErrorCode::Integrity, "В профиле установщика NeoForge нет идентификатора.", false))?;
        let id = validate_version_id(id)?;
        drop(archive);
        ensure_installer_profile(&dir)?;
        run_loader_installer(&InstallerInvocation { loader: LoaderKind::NeoForge, java_executable: java, installer_path: installer, minecraft_dir: dir.clone() }).map_err(mc_error)?;
        let launcher = Launcher::new(&dir);
        let merged = launcher.load_version(&id).map_err(mc_error)?;
        mc_launcher_core::install::client::install_version_files(&merged, &dir, &mut report).map_err(mc_error)?;
        Ok(id)
    }).await.map_err(|_| join_error())?
}

/// Idempotent: the crate skips files whose checksum already matches, so this is
/// both "download" and "verify what is on disk".
async fn install_profile(
    app: &AppHandle,
    state: &MinecraftState,
    instance_id: String,
    version: String,
    loader: Option<LoaderSpec>,
) -> LineResult<McInstalled> {
    let dir = game_root(app, &instance_id)?;
    {
        let mut inner = state.lock()?;
        if inner.running.contains_key(&instance_id) || inner.starting.contains(&instance_id) {
            return Err(busy());
        }
        if !inner.installing.insert(instance_id.clone()) {
            return Err(busy());
        }
    }

    let legacy = legacy_neoforge_version(&version, &loader);
    let emit_app = app.clone();
    let emit_instance = instance_id.clone();
    let installed = match legacy {
        Err(error) => Err(error),
        Ok(Some(legacy_version)) => {
            install_legacy_neoforge(app, dir, legacy_version, emit_app, emit_instance).await
        }
        Ok(None) => tokio::task::spawn_blocking(move || -> LineResult<String> {
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
        .and_then(|result| result),
    };

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
            files_done: None,
            files_total: None,
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
    let dir = game_root(&app, &instance_id)?.join("versions");
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

/// Runtime installation returns a boxed error, which may contain URLs, local
/// paths or tokens. Classify known types only; never expose raw error text.
fn java_install_error(
    error: &(dyn std::error::Error + 'static),
    required_major: u16,
    selected_major: Option<u16>,
) -> LineError {
    let selected = match selected_major {
        Some(major) if major != required_major => {
            format!("Выбрана Java {major}, но для этой сборки нужна Java {required_major}. ")
        }
        _ => format!("Для этой сборки нужна Java {required_major}. "),
    };
    let mut current = Some(error);
    let mut detail = "Не удалось автоматически установить Java от Mojang.".to_string();
    let mut status = None;
    let mut code = ErrorCode::JavaRequired;
    while let Some(cause) = current {
        if let Some(network) = cause.downcast_ref::<reqwest::Error>() {
            status = network.status().map(|s| s.as_u16());
            detail = if let Some(http) = status {
                code = ErrorCode::HttpStatus;
                format!("Ошибка загрузки Java от Mojang (HTTP {http}).")
            } else if network.is_timeout() {
                code = ErrorCode::Network;
                "Истекло время ожидания при загрузке Java от Mojang.".into()
            } else if network.is_connect() {
                code = ErrorCode::Network;
                "Не удалось подключиться при загрузке Java от Mojang.".into()
            } else if network.is_decode() {
                "Не удалось прочитать ответ сервера Java; причина неизвестна.".into()
            } else {
                code = ErrorCode::Network;
                "Ошибка загрузки Java от Mojang; причина неизвестна.".into()
            };
            break;
        }
        if cause.downcast_ref::<std::io::Error>().is_some() {
            code = ErrorCode::Storage;
            detail =
                "Не удалось прочитать или записать файлы Java. Проверьте место и права доступа."
                    .into();
            break;
        }
        current = cause.source();
    }
    let mut result = LineError::new(
        code,
        format!("{selected}{detail} Установите Java {required_major} и выберите её в настройках."),
        true,
    );
    result.http_status = status;
    result
}

struct JavaRequirement {
    major: u16,
    allow_newer_explicit: bool,
}

/// Uses a verified explicit choice at or above the declared minimum, then
/// discovers the exact requested major, then downloads a matching runtime.
/// A newer explicit JVM is the player's override, not a compatibility promise.
async fn resolve_java(
    dir: &Path,
    component: Option<String>,
    requirement: JavaRequirement,
    preferences: &LauncherSettings,
    app: &AppHandle,
    instance_id: &str,
) -> LineResult<PathBuf> {
    let JavaRequirement {
        major: required_major,
        allow_newer_explicit,
    } = requirement;
    let mut selected_major = None;
    if let Some(requested) = &preferences.java_path {
        if let Ok(runtime) = java::inspect_path(requested).await {
            if runtime.major == required_major
                || (allow_newer_explicit && accepts_explicit_java(required_major, runtime.major))
            {
                if runtime.major > required_major {
                    use super::logger::{self, Area, Field};
                    logger::info(
                        Area::Launch,
                        "using newer explicitly selected Java",
                        &[
                            Field::num("required_major", u64::from(required_major)),
                            Field::num("selected_major", u64::from(runtime.major)),
                        ],
                    );
                }
                return Ok(runtime.path);
            }
            selected_major = Some(runtime.major);
        }
    }
    if let Ok(runtime) = java::discover(required_major).await {
        return Ok(runtime.path);
    }
    // Prefer a verified private JRE on Windows x64, including versions whose
    // Mojang manifest has no runtime component. No administrator rights or
    // system Java changes are needed.
    if cfg!(all(target_os = "windows", target_arch = "x86_64"))
        && matches!(required_major, 8 | 17 | 21 | 25)
    {
        return super::java_auto::install_windows_x64(dir, required_major, |done, total| {
            emit_mc_progress(
                app,
                instance_id,
                "runtime",
                "Установка Java",
                done,
                total,
                false,
            );
        })
        .await;
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
        if let Ok(existing) = java::inspect_path(&path.to_string_lossy()).await {
            if existing.major == required_major {
                return Ok(existing.path);
            }
        }
    }
    let owned_dir = dir.to_path_buf();
    let owned_component = component.clone();
    tokio::task::spawn_blocking(move || -> LineResult<()> {
        runtime::install_jvm_runtime(&owned_component, &owned_dir, &CallbackDict::default())
            .map_err(|error| java_install_error(error.as_ref(), required_major, selected_major))
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
    let (host, port) = validate_server_address(&request.server_address)?;
    launch_profile(
        &app,
        &line,
        &state,
        instance_id,
        version_id,
        host,
        port,
        false,
    )
    .await
}

/// Diagnostic timing deliberately contains no URL, path, user or raw error.
fn log_preparation_stage(stage: &'static str, started: std::time::Instant, success: bool) {
    use super::logger::{self, Area, Field};
    logger::info(
        Area::Install,
        "minecraft preparation stage",
        &[
            Field::text("stage", stage),
            Field::num(
                "elapsed_ms",
                started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            ),
            Field::flag("success", success),
        ],
    );
}

/// «Играть»: read `pack.json`, download the instance ZIP or confirm the copy on
/// disk is still the published revision, copy it into the live game directory,
/// fetch only what the archive lacks, then join the server without a menu step.
#[tauri::command]
pub async fn mc_play(
    app: AppHandle,
    line: State<'_, LineState>,
    state: State<'_, MinecraftState>,
    request: McPlayRequest,
) -> LineResult<McGameStatus> {
    let (_, config) = line.fresh_config()?;
    config.validate(LAUNCHER_VERSION)?;
    let server = config.server(&request.server_id)?.clone();
    validate_test_mode(
        request.test_mode,
        server.test_mode_enabled,
        server.launch_mode == super::config::LaunchMode::Minecraft,
    )?;
    let instance_id = validate_instance_id(request.instance_id.as_deref().unwrap_or(&server.id))?;
    let address = request
        .server_address
        .clone()
        .or_else(|| server.server_address.clone())
        .ok_or_else(|| {
            LineError::input(
                "Провайдер не указал адрес сервера: добавьте server_address в config.json.",
            )
        })?;
    let (host, port) = validate_server_address(&address)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server.id)?;

    // 1. What is published right now. The pinned distribution is the fallback
    //    for providers that do not host a pack.json.
    let effective = if server.source.is_some() {
        server.clone()
    } else {
        pack::effective_server(&line.http, &server, &base).await?
    };
    emit_mc_progress(
        &app,
        &instance_id,
        "resolve",
        "Проверка сборки на сервере…",
        0,
        None,
        false,
    );

    // 2. Download or verify. `download_and_extract` returns the existing receipt
    //    untouched when its sha256 already matches, so an unchanged pack costs
    //    one small JSON request, not a re-download.
    // Test mode and normal play both use the same source validation and cache.
    let pack_started = std::time::Instant::now();
    let receipt = {
        let operation_id = Uuid::new_v4().to_string();
        let cancel = line.begin_install(&server.id, &operation_id)?;
        let sink_app = app.clone();
        let sink_instance = instance_id.clone();
        let sink = ProgressSink::new(move |progress: InstallProgress| {
            let _ = sink_app.emit(install::PROGRESS_EVENT, &progress);
            let (stage, label) = match progress.phase {
                InstallPhase::Downloading => ("download", "Скачивание сборки"),
                InstallPhase::Verifying => ("verify", "Проверка архива"),
                InstallPhase::Extracting => ("extract", "Распаковка сборки"),
                InstallPhase::Committing => ("commit", "Применение сборки"),
                InstallPhase::Completed => ("completed", "Сборка готова"),
                InstallPhase::Cancelled => ("task", "Отменено"),
                InstallPhase::Failed => ("task", "Ошибка установки"),
            };
            let total = (progress.total_bytes > 0).then_some(progress.total_bytes);
            let _ = sink_app.emit(
                MC_INSTALL_EVENT,
                McInstallProgress {
                    instance_id: sink_instance.clone(),
                    stage: if progress.files_total.is_some()
                        && matches!(progress.phase, InstallPhase::Downloading)
                    {
                        "source-files"
                    } else {
                        stage
                    }
                    .to_string(),
                    label: label.to_string(),
                    received_bytes: progress.received_bytes,
                    total_bytes: total,
                    finished: false,
                    files_done: progress.files_done,
                    files_total: progress.files_total,
                },
            );
        });
        let installed = install::download_and_extract(
            &line.http,
            &effective,
            &base,
            &operation_id,
            cancel,
            &sink,
        )
        .await;
        line.finish_install(&server.id, &operation_id);
        log_preparation_stage("pack", pack_started, installed.is_ok());
        installed?
    };
    if receipt.already_installed {
        emit_mc_progress(
            &app,
            &instance_id,
            "cached",
            "Сборка не изменилась",
            0,
            None,
            false,
        );
    }

    emit_mc_progress(
        &app,
        &instance_id,
        "verify",
        "Проверка файлов сборки…",
        0,
        None,
        false,
    );
    // 3. Read the instance and bring the live game directory up to date. Both
    //    steps touch thousands of files, so they stay off the async workers.
    let hint = request
        .minecraft_version
        .clone()
        .or_else(|| server.minecraft_version.clone());
    let release_base = base.clone();
    let sha256 = receipt.sha256.clone();
    let instance_dir = instance_root(&app, &instance_id)?;
    let inspect_instance = instance_id.clone();
    let inspect_app = app.clone();
    let verify_started = std::time::Instant::now();
    let audit_live_assets = request.prepare_only;
    let detected_result = tokio::task::spawn_blocking(move || -> LineResult<DetectedInstance> {
        let release = pack::release_dir(&release_base, &sha256)?;
        let index = integrity::read_index(&release)?;
        let report = integrity::scan(&release)?;
        if !report.is_clean() {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Сборка изменилась после установки. Повторите установку перед запуском.",
                false,
            ));
        }
        let mut detected = pack::inspect(&release, &index, hint.as_deref())?;
        emit_mc_progress(
            &inspect_app,
            &inspect_instance,
            "verify",
            "Проверка файлов экземпляра…",
            0,
            None,
            false,
        );
        pack::sync_game_dir(&release, &detected, &instance_dir, &sha256)?;
        // A release can be intact while its live mod copy was replaced.
        // Never follow a planted mods directory or file symlink.
        let game = instance_dir.join("game");
        let mods = game.join("mods");
        if mods.exists() && !super::storage::is_real_dir(&mods) {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Папка mods не является обычным каталогом.",
                false,
            ));
        }
        for entry in &index.files {
            let Some(relative) = entry.path.strip_prefix(detected.prefix.as_str()) else {
                continue;
            };
            let Some(_name) = relative.strip_prefix("mods/") else {
                continue;
            };
            let target = pack::checked_game_path(&game, relative, false)?;
            if !super::storage::is_real_file(&target) {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    format!("Файл {relative} отсутствует или заменён ссылкой."),
                    false,
                ));
            }
            let (actual, size) = integrity::hash_file(&target)?;
            if actual != entry.sha256 || size != entry.size {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    format!("Файл {relative} изменён. Восстановите сборку."),
                    false,
                ));
            }
        }
        if audit_live_assets && detected.asset_inventory.is_some() {
            if let Some(id) = &detected.asset_index_id {
                emit_mc_progress(
                    &inspect_app,
                    &inspect_instance,
                    "verify",
                    "Проверка хешей ресурсов экземпляра…",
                    0,
                    None,
                    false,
                );
                let bytes = pack::read_release_asset_index(&release, &detected.prefix, id)?;
                detected.live_assets = Some(super::asset_inventory::inspect_live(
                    &bytes,
                    &game,
                    |path| mc_launcher_core::io::hash::sha1_file(path).map_err(mc_error),
                )?);
            }
        }
        Ok(detected)
    })
    .await
    .map_err(|_| join_error())
    .and_then(|result| result);
    log_preparation_stage("verify_and_sync", verify_started, detected_result.is_ok());
    let detected: DetectedInstance = detected_result?;
    if let Some(inventory) = detected.asset_inventory {
        use super::logger::{self, Area, Field};
        logger::info(
            Area::Install,
            "release asset inventory (sizes only)",
            &[
                Field::num("objects", inventory.unique_objects),
                Field::num("present_by_size", inventory.present_by_size),
                Field::num("missing", inventory.missing),
                Field::num("wrong_size", inventory.wrong_size),
                Field::num("missing_bytes", inventory.missing_bytes),
            ],
        );
    }

    if let Some(inventory) = detected.live_assets {
        use super::logger::{self, Area, Field};
        logger::info(
            Area::Install,
            "live asset inventory (SHA-1)",
            &[
                Field::num("objects", inventory.unique_objects),
                Field::num("matched_sha1", inventory.matched_sha1),
                Field::num("missing", inventory.missing),
                Field::num("wrong_size", inventory.wrong_size),
                Field::num("wrong_hash", inventory.wrong_hash),
                Field::num("needed_bytes", inventory.needed_bytes),
            ],
        );
    }

    // Check the directory actually used by Minecraft, not the archive server's
    // separate game/ directory. Never start Java when a keyword was found.
    let instance_dir = instance_root(&app, &instance_id)?;
    let scan_started = std::time::Instant::now();
    let scan_result = super::launch::scan_packs(&instance_dir, &server, &detected.files);
    log_preparation_stage(
        "pack_safety",
        scan_started,
        scan_result
            .as_ref()
            .is_ok_and(|scan| scan.blocked.is_none()),
    );
    let scan = scan_result?;
    if let Some(message) = scan.blocked {
        return Err(LineError::new(ErrorCode::Integrity, message, false));
    }

    // 4. Fill only the gaps. A loader found inside the instance is used as is;
    //    one requested by the provider is installed only when none is there.
    let requested_loader = parse_loader(request.loader.as_ref())?;
    let mut launch_version = detected.version_id.clone();
    // A generated profile identifies the requested loader, but contains no real
    // loader libraries; install it from the official host before launching.
    let loader = if detected.generated_profile {
        requested_loader.or_else(|| {
            detected.loader.clone().map(|(kind, version)| {
                loader_spec(
                    kind,
                    if version.is_empty() {
                        None
                    } else {
                        Some(version)
                    },
                )
            })
        })
    } else if detected.loader.is_none() {
        requested_loader
    } else {
        None
    };
    if !detected.missing.is_empty() || loader.is_some() || detected.generated_profile {
        let loader_started = std::time::Instant::now();
        let filled_result = install_profile(
            &app,
            &state,
            instance_id.clone(),
            detected.minecraft_version.clone(),
            loader,
        )
        .await;
        log_preparation_stage(
            "minecraft_and_loader",
            loader_started,
            filled_result.is_ok(),
        );
        let filled = filled_result?;
        if detected.generated_profile || detected.loader.is_none() {
            launch_version = filled.version_id;
        }
    }

    if request.prepare_only {
        emit_mc_progress(
            &app,
            &instance_id,
            "completed",
            "Сборка подготовлена",
            0,
            None,
            true,
        );
        return Ok(McGameStatus {
            instance_id,
            version_id: launch_version,
            phase: GamePhase::Idle,
            started_at: None,
            exit_code: None,
            message: None,
        });
    }

    // 5. Straight into the server.
    launch_profile(
        &app,
        &line,
        &state,
        instance_id,
        launch_version,
        host,
        port,
        request.test_mode,
    )
    .await
}

fn emit_mc_progress(
    app: &AppHandle,
    instance_id: &str,
    stage: &str,
    label: &str,
    received_bytes: u64,
    total_bytes: Option<u64>,
    finished: bool,
) {
    let _ = app.emit(
        MC_INSTALL_EVENT,
        McInstallProgress {
            instance_id: instance_id.to_string(),
            stage: stage.to_string(),
            label: label.to_string(),
            received_bytes,
            total_bytes,
            finished,
            files_done: None,
            files_total: None,
        },
    );
}

#[allow(clippy::too_many_arguments)]
async fn launch_profile(
    app: &AppHandle,
    line: &LineState,
    state: &MinecraftState,
    instance_id: String,
    version_id: String,
    host: String,
    port: u16,
    test_mode: bool,
) -> LineResult<McGameStatus> {
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
        app,
        state,
        &instance_id,
        &version_id,
        &username,
        &uuid,
        &host,
        port,
        test_mode,
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
                app,
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
    host: &str,
    port: u16,
    test_mode: bool,
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

    let load_dir = game_dir.clone();
    let load_id = version_id.to_string();
    let (version, component, required_major, quick_play) = tokio::task::spawn_blocking(
        move || -> LineResult<(VersionJson, Option<String>, u16, bool)> {
            let launcher = Launcher::new(load_dir);
            let version = launcher.load_version(&load_id).map_err(mc_error)?;
            let (component, major) = match &version.java_version {
                Some(java) => (Some(java.component.clone()), java.major_version),
                None => (None, 8),
            };
            let major = u16::try_from(major).unwrap_or(8).clamp(8, 26);
            // `load_version` already merged inheritsFrom, so a loader profile
            // reports the vanilla client's Quick Play support.
            let quick_play = has_quick_play_token(&game_argument_tokens(&version));
            Ok((version, component, major, quick_play))
        },
    )
    .await
    .map_err(|_| join_error())??;

    let total = total_memory();
    let preferences = settings::load(app, total);
    let heap_mb = match preferences.heap_mb {
        Some(requested) => validate_heap(requested, total)?,
        None => optimal_heap_mb(total),
    };
    let java_path = resolve_java(
        &dir,
        component,
        JavaRequirement {
            major: required_major,
            allow_newer_explicit: true,
        },
        &preferences,
        app,
        instance_id,
    )
    .await?;

    let build_dir = game_dir.clone();
    let account_name = username.to_string();
    let account_uuid = uuid.to_string();
    let window = (preferences.window_width, preferences.window_height);
    let join_host = host.to_string();
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
            // The crate emits the pre-1.20 `--server`/`--port` pair here, which
            // modern clients ignore. The join args are appended below instead.
            server: None,
            // Multiplayer is the whole point of this launcher: never disable it.
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
        if test_mode {
            remove_automatic_joins(&mut args);
        } else {
            ensure_server_join(&mut args, quick_play, &join_host, port);
        }
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

#[cfg(test)]
mod network_diagnostics_tests {
    use super::*;

    #[tokio::test]
    async fn http_failure_is_mapped_without_exposing_url_or_query() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let source = reqwest::get(format!("http://{addr}/private-path?token=secret"))
            .await
            .unwrap()
            .error_for_status()
            .unwrap_err();
        server.await.unwrap();
        let java_error = java_install_error(&source, 17, Some(25));
        assert_eq!(java_error.http_status, Some(404));
        assert!(java_error.message.contains("Java 17"));
        assert!(java_error.message.contains("Java 25"));
        assert!(!java_error.message.contains("secret"));
        assert!(!java_error.message.contains("private-path"));
        let network = LauncherError::Network { source };
        assert!(
            !retryable_installer_error(&network),
            "404 must not be retried"
        );
        let error = mc_error(network);
        assert_eq!(error.http_status, Some(404));
        assert!(error.message.contains("HTTP 404"));
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains("private-path"));
        assert!(!error.message.contains(&addr.to_string()));
    }

    #[test]
    fn installer_profile_is_created_without_overwriting_existing_data() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("launcher_profiles.json");
        ensure_installer_profile(temp.path()).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(json["profiles"].is_object());
        std::fs::write(&path, b"existing profile").unwrap();
        ensure_installer_profile(temp.path()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"existing profile");
        assert!(ensure_installer_profile(&temp.path().join("missing")).is_err());
    }

    #[test]
    fn retry_removes_partial_installer_and_does_not_retry_disk_errors() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("installer.jar");
        let mut calls = 0;
        let mut retries = Vec::new();
        download_installer_with_retry(
            &path,
            || {
                calls += 1;
                assert!(!path.exists(), "an incomplete jar must not be reused");
                std::fs::write(&path, b"partial").unwrap();
                if calls < 3 {
                    Err(LauncherError::Io {
                        source: std::io::Error::new(std::io::ErrorKind::TimedOut, "private"),
                    })
                } else {
                    Ok(())
                }
            },
            |_| {},
            |n| retries.push(n),
        )
        .unwrap();
        assert_eq!(calls, 3);
        assert_eq!(retries, vec![2, 3]);
        std::fs::remove_file(&path).unwrap();
        calls = 0;
        let result = download_installer_with_retry(
            &path,
            || {
                calls += 1;
                std::fs::write(&path, b"partial").unwrap();
                Err(LauncherError::Io {
                    source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "private"),
                })
            },
            |_| panic!("disk errors must not be retried"),
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
        assert!(!path.exists());
    }

    #[test]
    fn repeated_timeout_stops_after_three_attempts_and_cleans_partial_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("installer.jar");
        let mut attempts = 0;
        let result = download_installer_with_retry(
            &path,
            || {
                attempts += 1;
                std::fs::write(&path, b"incomplete").unwrap();
                Err(LauncherError::Io {
                    source: std::io::Error::new(std::io::ErrorKind::TimedOut, "secret"),
                })
            },
            |_| {},
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(attempts, 3);
        assert!(!path.exists());
    }

    #[test]
    fn legacy_neoforge_coordinates_are_selected_only_for_1201() {
        let exact = |v: &str| {
            Some(LoaderSpec::NeoForge {
                version: LoaderVersion::Exact(v.to_string()),
            })
        };
        assert_eq!(
            legacy_neoforge_version("1.20.1", &exact("47.1.106"))
                .unwrap()
                .as_deref(),
            Some("47.1.106")
        );
        assert_eq!(
            legacy_neoforge_version("1.20.1", &exact("1.20.1-47.1.106"))
                .unwrap()
                .as_deref(),
            Some("47.1.106")
        );
        assert!(legacy_neoforge_version("1.20.1", &exact("47.1/evil")).is_err());
        assert!(legacy_neoforge_version(
            "1.20.1",
            &Some(LoaderSpec::NeoForge {
                version: LoaderVersion::LatestStable
            })
        )
        .is_err());
        assert_eq!(
            legacy_neoforge_version("1.21.1", &exact("21.1.65")).unwrap(),
            None
        );
    }

    #[test]
    fn java_install_error_explains_version_without_leaking_details() {
        let unknown = std::io::Error::other("secret-path-and-token");
        let error = java_install_error(&unknown, 17, Some(25));
        assert!(error.message.contains("Java 25"));
        assert!(error.message.contains("Java 17"));
        assert!(!error.message.contains("secret-path-and-token"));
        assert_eq!(error.code, ErrorCode::Storage);
        let unknown = std::fmt::Error;
        let error = java_install_error(&unknown, 17, None);
        assert!(error.message.contains("Java 17"));
        assert!(!error.message.contains("Java 25"));
        assert_eq!(error.code, ErrorCode::JavaRequired);
    }

    #[test]
    fn minecraft_network_diagnostics_reveal_only_fixed_safe_details() {
        let missing = minecraft_network_error(Some("maven.neoforged.net"), Some(404), false, false);
        assert_eq!(missing.code, ErrorCode::HttpStatus);
        assert_eq!(missing.http_status, Some(404));
        assert!(!missing.retryable);
        assert!(missing.message.contains("NeoForge"));
        assert!(missing.message.contains("HTTP 404"));
        let unknown =
            minecraft_network_error(Some("private.example.test"), Some(403), false, false);
        assert!(!unknown.message.contains("private.example.test"));
        assert!(unknown.message.contains("HTTP 403"));
        let timeout = minecraft_network_error(None, None, true, false);
        assert_eq!(timeout.code, ErrorCode::Network);
        assert!(timeout.message.contains("время ожидания"));
        let connect = minecraft_network_error(Some("libraries.minecraft.net"), None, false, true);
        assert!(connect.message.contains("Mojang"));
        assert!(connect.retryable);
    }
}
