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
use super::storage::{create_private_dir, server_dir, InstallLock};
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
    #[serde(default)]
    pub approve_zip_repair: Option<super::zip_repair::ZipRepairPlan>,
    #[serde(default)]
    pub approve_java_download: Option<super::java_consent::JavaDownloadPlan>,
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
    preparing: HashSet<String>,
}

/// Separate from `LineState`: provider builds are keyed by server id and carry a
/// release sha256, which a Mojang profile does not have.
#[derive(Default)]
pub struct MinecraftState {
    inner: Arc<Mutex<Inner>>,
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

    fn begin_preparation(&self, instance_id: &str) -> LineResult<Arc<PreparationGuard>> {
        let mut inner = self.lock()?;
        if inner.preparing.contains(instance_id)
            || inner.installing.contains(instance_id)
            || inner.starting.contains(instance_id)
            || inner.running.contains_key(instance_id)
        {
            return Err(busy());
        }
        inner.preparing.insert(instance_id.to_string());
        Ok(Arc::new(PreparationGuard {
            inner: Arc::clone(&self.inner),
            instance_id: instance_id.to_string(),
        }))
    }

    fn begin_install(
        &self,
        instance_id: &str,
        within_preparation: bool,
    ) -> LineResult<Arc<OperationGuard>> {
        let mut inner = self.lock()?;
        if inner.running.contains_key(instance_id)
            || inner.starting.contains(instance_id)
            || inner.installing.contains(instance_id)
            || (inner.preparing.contains(instance_id) && !within_preparation)
        {
            return Err(busy());
        }
        inner.installing.insert(instance_id.to_string());
        Ok(Arc::new(OperationGuard {
            inner: Arc::clone(&self.inner),
            instance_id: instance_id.to_string(),
            kind: OperationKind::Install,
        }))
    }

    fn begin_start(
        &self,
        instance_id: &str,
        within_preparation: bool,
    ) -> LineResult<Arc<OperationGuard>> {
        let mut inner = self.lock()?;
        if inner.installing.contains(instance_id)
            || inner.running.contains_key(instance_id)
            || inner.starting.contains(instance_id)
            || (inner.preparing.contains(instance_id) && !within_preparation)
        {
            return Err(busy());
        }
        inner.starting.insert(instance_id.to_string());
        Ok(Arc::new(OperationGuard {
            inner: Arc::clone(&self.inner),
            instance_id: instance_id.to_string(),
            kind: OperationKind::Start,
        }))
    }
}

/// Held from before pack resolution and sync until the whole play/prepare call
/// returns, including every error and the confirmation-required return.
struct PreparationGuard {
    inner: Arc<Mutex<Inner>>,
    instance_id: String,
}

impl Drop for PreparationGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.preparing.remove(&self.instance_id);
        }
    }
}

#[derive(Clone, Copy)]
enum OperationKind {
    Install,
    Start,
}

/// A claim is released only when both the async owner and all detached workers finish.
struct OperationGuard {
    inner: Arc<Mutex<Inner>>,
    instance_id: String,
    kind: OperationKind,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            match self.kind {
                OperationKind::Install => {
                    inner.installing.remove(&self.instance_id);
                }
                OperationKind::Start => {
                    inner.starting.remove(&self.instance_id);
                }
            }
        }
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

fn acquire_instance_lease(app: &AppHandle, instance_id: &str) -> LineResult<Arc<InstallLock>> {
    let instance = instance_root(app, instance_id)?;
    Ok(Arc::new(InstallLock::acquire(&instance)?))
}

/// Combines the in-process claim and the cooperating-process file lock.
struct InstanceOperation {
    _claim: Arc<OperationGuard>,
    lease: Arc<InstallLock>,
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
    install_profile(&app, &state, instance_id, version, loader, None, None).await
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

/// Construct the loader installer process directly, without a shell. The Java
/// process stays console-free on Windows; its stdout/stderr are redirected by
/// the caller. GUI windows created independently by a third party are not covered.
fn loader_installer_command(java: &Path, installer: &Path, game: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(java);
    command
        .arg("-jar")
        .arg(installer)
        .arg("--installClient")
        .arg(game);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

/// Keep diagnostics in the instance rather than opening a console or leaking
/// installer output into UI errors. Caller holds the instance operation lock.
fn run_quiet_loader_installer(java: &Path, installer: &Path, game: &Path) -> LineResult<()> {
    let log_path = pack::checked_game_path(game, "logs/line-loader-install.log", true)?;
    match std::fs::symlink_metadata(&log_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(LineError::io(&error)),
        Ok(_) if !super::storage::is_real_file(&log_path) => {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Файл журнала установщика не является обычным файлом.",
                false,
            ))
        }
        Ok(_) => {}
    }
    let log = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| LineError::io(&e))?;
    let stderr = log.try_clone().map_err(|e| LineError::io(&e))?;
    let status = loader_installer_command(java, installer, game)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .status()
        .map_err(|_| {
            LineError::new(
                ErrorCode::JavaRequired,
                "Не удалось запустить установщик загрузчика с выбранной Java.",
                true,
            )
        })?;
    if !status.success() {
        return Err(LineError::new(ErrorCode::Internal, "Установка загрузчика завершилась ошибкой. Подробности в game/logs/line-loader-install.log.", true));
    }
    Ok(())
}

async fn install_legacy_neoforge(
    app: &AppHandle,
    dir: PathBuf,
    version: String,
    app_emit: AppHandle,
    instance: String,
    claim: Arc<InstanceOperation>,
    java_consent: Option<&super::java_consent::JavaConsent>,
) -> LineResult<String> {
    let vanilla_dir = dir.clone();
    let emit = app_emit.clone();
    let emit_instance = instance.clone();
    let worker_claim = Arc::clone(&claim);
    tokio::task::spawn_blocking(move || {
        let _worker_claim = worker_claim;
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
        &claim,
        java_consent,
        "loader",
    )
    .await?;
    let worker_claim = Arc::clone(&claim);
    tokio::task::spawn_blocking(move || -> LineResult<String> {
        let _worker_claim = worker_claim;
        use mc_launcher_core::net::download::{execute_plan, DownloadPlan, DownloadTask};
        use std::io::Read;
        let temp = tempfile::tempdir().map_err(|e| LineError::io(&e))?;
        let installer = temp.path().join("installer.jar");
        let artifact = format!("1.20.1-{version}");
        let url = format!("https://maven.neoforged.net/releases/net/neoforged/forge/{artifact}/forge-{artifact}-installer.jar");
        let retry_app = app_emit.clone();
        let retry_instance = instance.clone();
        let progress_app = app_emit.clone();
        let progress_instance = instance.clone();
        let mut report = move |event: ProgressEvent| { let _ = progress_app.emit(MC_INSTALL_EVENT, progress_dto(&progress_instance, &event, false)); };
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
        emit_mc_progress(&app_emit, &instance, "loader", "Установка NeoForge…", 0, None, false);
        run_quiet_loader_installer(&java, &installer, &dir)?;
        let launcher = Launcher::new(&dir);
        let merged = launcher.load_version(&id).map_err(mc_error)?;
        mc_launcher_core::install::client::install_version_files(&merged, &dir, &mut report).map_err(mc_error)?;
        Ok(id)
    }).await.map_err(|_| join_error())?
}

/// Idempotent: the crate skips files whose checksum already matches, so this is
/// both "download" and "verify what is on disk".
#[allow(clippy::too_many_arguments)]
async fn install_profile(
    app: &AppHandle,
    state: &MinecraftState,
    instance_id: String,
    version: String,
    loader: Option<LoaderSpec>,
    preparation_lease: Option<Arc<InstallLock>>,
    java_consent: Option<&super::java_consent::JavaConsent>,
) -> LineResult<McInstalled> {
    let claim = state.begin_install(&instance_id, preparation_lease.is_some())?;
    let lease = match preparation_lease {
        Some(lease) => lease,
        None => acquire_instance_lease(app, &instance_id)?,
    };
    let claim = Arc::new(InstanceOperation {
        _claim: claim,
        lease,
    });
    let dir = game_root(app, &instance_id)?;
    let legacy = legacy_neoforge_version(&version, &loader);
    let emit_app = app.clone();
    let emit_instance = instance_id.clone();
    let installed = match legacy {
        Err(error) => Err(error),
        Ok(Some(legacy_version)) => {
            install_legacy_neoforge(
                app,
                dir,
                legacy_version,
                emit_app,
                emit_instance,
                Arc::clone(&claim),
                java_consent,
            )
            .await
        }
        Ok(None) => {
            let worker_claim = Arc::clone(&claim);
            tokio::task::spawn_blocking(move || -> LineResult<String> {
                let _worker_claim = worker_claim;
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
            .and_then(|result| result)
        }
    };
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
#[allow(clippy::too_many_arguments)]
async fn resolve_java(
    dir: &Path,
    component: Option<String>,
    requirement: JavaRequirement,
    preferences: &LauncherSettings,
    app: &AppHandle,
    instance_id: &str,
    claim: &Arc<InstanceOperation>,
    consent: Option<&super::java_consent::JavaConsent>,
    purpose: &str,
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
    // A local Mojang runtime should be reused before asking or downloading.
    if let Some(component) = component.as_deref() {
        if let Some(path) = runtime::get_executable_path(component, dir) {
            if let Ok(existing) = java::inspect_path(&path.to_string_lossy()).await {
                if existing.major == required_major {
                    return Ok(existing.path);
                }
            }
        }
    }
    // Private Windows runtime validation is read-only and performs no network IO.
    if cfg!(all(target_os = "windows", target_arch = "x86_64"))
        && matches!(required_major, 8 | 17 | 21 | 25)
    {
        if let Some(path) = super::java_auto::find_cached_windows_x64(dir, required_major).await? {
            return Ok(path);
        }
        if let Some(consent) = consent {
            consent.require(required_major, purpose, "adoptium")?;
        }
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
            format!("Нужна Java {required_major}. Установите её или укажите путь к java.exe в настройках."),
            false,
        ));
    };
    if let Some(consent) = consent {
        consent.require(required_major, purpose, "mojang")?;
    }
    let owned_dir = dir.to_path_buf();
    let owned_component = component.clone();
    let worker_claim = Arc::clone(claim);
    tokio::task::spawn_blocking(move || -> LineResult<()> {
        let _worker_claim = worker_claim;
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
        None,
        None,
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
    // Claim the instance before any pack resolution, sync or live-file scan.
    // The inner install and launch are allowed only as part of this operation.
    let preparation_claim = state.begin_preparation(&instance_id)?;
    let lease = acquire_instance_lease(&app, &instance_id)?;
    let preparation = Arc::new((preparation_claim, lease));
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server.id)?;

    // Show work before the first network request: fetching pack.json may be
    // slow or fail and must not leave the player looking at an idle interface.
    emit_mc_progress(
        &app,
        &instance_id,
        "resolve",
        "Проверка сборки на сервере…",
        0,
        None,
        false,
    );

    // 1. Resolve the archive metadata exactly once, and include it in the
    // diagnostic duration. Source packs resolve their own metadata below.
    let pack_started = std::time::Instant::now();
    let effective_result = if server.source.is_some() {
        Ok(server.clone())
    } else {
        pack::effective_server(&line.http, &server, &base).await
    };
    let effective = match effective_result {
        Ok(server) => server,
        Err(error) => {
            log_preparation_stage("pack", pack_started, false);
            return Err(error);
        }
    };

    // 2. Download or verify. The installer returns an existing matching receipt
    // untouched, without fetching the already resolved pack.json again.
    let receipt = {
        let operation_id = Uuid::new_v4().to_string();
        let registration = line.register_install(&server.id, &operation_id)?;
        let cancel = registration.cancel_flag();
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
        let installed = install::download_and_extract_resolved(
            &line.http,
            &effective,
            &base,
            &operation_id,
            cancel,
            &sink,
        )
        .await;
        drop(registration);
        log_preparation_stage("pack", pack_started, installed.is_ok());
        installed?
    };
    let java_consent = server
        .source
        .is_none()
        .then(|| super::java_consent::JavaConsent {
            server_id: server.id.clone(),
            instance_id: instance_id.clone(),
            release_sha256: receipt.sha256.clone(),
            prepare_only: request.prepare_only,
            test_mode: request.test_mode,
            approved: request.approve_java_download.clone(),
        });
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

    // The installer released its server lock when returning the receipt. Reclaim
    // it before inspecting or copying the release; a concurrent update or
    // rollback could have changed current.json in the gap.
    let release_lease = Arc::new(InstallLock::acquire(&base)?);
    // A previous process can have died between the two directory renames.
    // Recovery may hash a whole release, and must retain the lock if cancelled.
    let recovery_lease = Arc::clone(&release_lease);
    let recovery_base = base.clone();
    tokio::task::spawn_blocking(move || {
        let _lease = recovery_lease;
        install::recover_releases(&recovery_base)
    })
    .await
    .map_err(|_| LineError::storage())??;
    let current = install::current_receipt(&base, &server.id);
    if !current
        .as_ref()
        .is_some_and(|value| value.sha256 == receipt.sha256)
    {
        return Err(LineError::new(
            ErrorCode::Busy,
            "Сборка изменилась во время подготовки. Повторите действие.",
            true,
        ));
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
        .or_else(|| effective.minecraft_version.clone());
    let release_base = base.clone();
    let sha256 = receipt.sha256.clone();
    let instance_dir = instance_root(&app, &instance_id)?;
    let inspect_instance = instance_id.clone();
    let inspect_app = app.clone();
    let verify_started = std::time::Instant::now();
    let audit_live_assets = request.prepare_only;
    let audit_runtime = server.source.is_none();
    // A blocking task continues after its awaiting future is dropped. Keep its
    // claim alive until all live-file verification and synchronization has stopped.
    let worker_preparation = Arc::clone(&preparation);
    let worker_release_lease = Arc::clone(&release_lease);
    let detected_result = tokio::task::spawn_blocking(
        move || -> LineResult<(DetectedInstance, integrity::FileIndex)> {
            let _worker_preparation = worker_preparation;
            let _worker_release_lease = worker_release_lease;
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
                if !super::launch::is_mod_jar(relative) {
                    continue;
                }
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
            if audit_runtime {
                // The expected checksums come only from version JSON already
                // present in the verified release, never from the writable game.
                let mut profiles = Vec::new();
                let mut ids = std::collections::BTreeSet::new();
                ids.insert(detected.version_id.clone());
                ids.insert(detected.minecraft_version.clone());
                let release_game = release.join(&detected.prefix);
                for id in ids {
                    let relative = format!("versions/{id}/{id}.json");
                    let indexed = format!("{}{relative}", detected.prefix);
                    if !index.files.iter().any(|entry| entry.path == indexed) {
                        continue;
                    }
                    let path = pack::checked_game_path(&release_game, &relative, false)?;
                    if !super::storage::is_real_file(&path) {
                        return Err(LineError::storage());
                    }
                    let metadata = std::fs::metadata(&path).map_err(|e| LineError::io(&e))?;
                    if metadata.len() > 8 * 1024 * 1024 {
                        return Err(LineError::input("JSON версии в сборке слишком большой."));
                    }
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    std::fs::File::open(path)
                        .map_err(|e| LineError::io(&e))?
                        .take(8 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|e| LineError::io(&e))?;
                    if bytes.len() > 8 * 1024 * 1024 {
                        return Err(LineError::input("JSON версии в сборке слишком большой."));
                    }
                    profiles.push((id, bytes));
                }
                if !profiles.is_empty() {
                    let borrowed: Vec<_> = profiles
                        .iter()
                        .map(|(id, bytes)| (id.as_str(), bytes.as_slice()))
                        .collect();
                    detected.live_runtime = Some(super::runtime_inventory::inspect(
                        &borrowed,
                        &game,
                        |path| mc_launcher_core::io::hash::sha1_file(path).map_err(mc_error),
                    )?);
                }
            }
            // An archive hint remains true forever even after a repair. Re-audit
            // assets on ZIP play only when that hint can be disproved with the
            // release index; do not infer completeness from directory existence.
            if (audit_live_assets || (audit_runtime && detected.missing.contains(&"assets")))
                && detected.asset_inventory.is_some()
            {
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
                    use sha2::{Digest, Sha256};
                    let mut digest = Sha256::new();
                    // Domain-separated, deterministic records; the inventory iterates
                    // unique hashes in sorted order. Preview stays bounded for IPC.
                    digest.update(b"line-asset-issues-v1\0");
                    let mut preview = Vec::new();
                    detected.live_assets = Some(super::asset_inventory::inspect_live(
                        &bytes,
                        &game,
                        |path| mc_launcher_core::io::hash::sha1_file(path).map_err(mc_error),
                        |hash, size, reason| {
                            digest.update(hash.as_bytes());
                            digest.update(size.to_be_bytes());
                            digest.update(reason.as_bytes());
                            digest.update(b"\0");
                            if preview.len() < 32 {
                                preview.push(format!("assets/objects/{}/{}", &hash[..2], hash));
                            }
                        },
                    )?);
                    detected.live_asset_digest = Some(format!("{:x}", digest.finalize()));
                    detected.live_asset_preview = preview;
                }
            }
            Ok((detected, index))
        },
    )
    .await
    .map_err(|_| join_error())
    .and_then(|result| result);
    log_preparation_stage("verify_and_sync", verify_started, detected_result.is_ok());
    let (detected, verified_index) = detected_result?;
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
    // The release index was just checked, and the server/instance locks still
    // cover this scan. Only byte-identical declared direct nested jars qualify;
    // the generic rule also applies to other generators, not just Connector.
    let scan_base = instance_dir.clone();
    let scan_server = server.clone();
    let scan_files = detected.files.clone();
    let scan_prefix = detected.prefix.clone();
    let scan_preparation = Arc::clone(&preparation);
    let scan_lease = Arc::clone(&release_lease);
    let scan_result = tokio::task::spawn_blocking(move || {
        let _preparation = scan_preparation;
        let _lease = scan_lease;
        let game = scan_base.join("game");
        let mut checked = super::connector::ParentChecks::default();
        super::launch::scan_packs_with(&scan_base, &scan_server, &scan_files, |relative| {
            super::connector::matches_verified_nested(
                &game,
                &verified_index,
                &scan_prefix,
                relative,
                &mut checked,
            )
        })
    })
    .await
    .map_err(|_| join_error())
    .and_then(|result| result);
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

    // The release is no longer read; allow provider updates while the
    // separately locked live instance installs missing Minecraft components.
    drop(release_lease);

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
    let live_asset_issues = if server.source.is_none() {
        detected
            .live_assets
            .map(|inventory| inventory.missing + inventory.wrong_size + inventory.wrong_hash)
            .unwrap_or(0)
    } else {
        0
    };
    // A verified live client/asset set supersedes stale archive-only hints.
    // Everything without complete evidence remains conservative and still
    // prompts. This does not establish completeness of libraries or natives.
    let verified_client = detected.live_runtime.as_ref().is_some_and(|inventory| {
        inventory
            .verified_clients
            .contains(&detected.minecraft_version)
    });
    let verified_assets = detected.live_assets.is_some_and(|inventory| {
        inventory.missing == 0 && inventory.wrong_size == 0 && inventory.wrong_hash == 0
    });
    let unresolved_hints = if server.source.is_none() {
        super::repair_evidence::unresolved_archive_hints(
            &detected.missing,
            verified_client,
            verified_assets,
        )
    } else {
        detected.missing.clone()
    };
    let live_runtime_issues = detected
        .live_runtime
        .as_ref()
        .map(|value| value.missing + value.wrong_size + value.wrong_hash)
        .unwrap_or(0);
    if !unresolved_hints.is_empty()
        || live_runtime_issues > 0
        || loader.is_some()
        || detected.generated_profile
        || live_asset_issues > 0
    {
        // ZIP repair consent is scoped to this exact release and operation. The
        // list describes archive hints, not an exhaustive file-level plan: the
        // installer checks official metadata and may need additional components.
        if server.source.is_none() {
            let plan = super::zip_repair::ZipRepairPlan {
                schema: 1,
                server_id: server.id.clone(),
                instance_id: instance_id.clone(),
                release_sha256: receipt.sha256.clone(),
                minecraft_version: detected.minecraft_version.clone(),
                profile_id: detected.version_id.clone(),
                detected_loader: detected
                    .loader
                    .as_ref()
                    .map(|(kind, version)| format!("{kind:?}:{version}")),
                requested_loader: request.loader.as_ref().map(|value| {
                    format!("{}:{}", value.kind, value.version.as_deref().unwrap_or(""))
                }),
                generated_profile: detected.generated_profile,
                install_loader: loader.is_some(),
                missing_from_archive: unresolved_hints
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect(),
                live_asset_issues,
                live_asset_digest: detected.live_asset_digest.clone(),
                live_asset_preview: detected.live_asset_preview.clone(),
                live_runtime_issues,
                live_runtime_files: detected
                    .live_runtime
                    .as_ref()
                    .map(|value| value.issues.clone())
                    .unwrap_or_default(),
                live_runtime_bytes: detected
                    .live_runtime
                    .as_ref()
                    .map(|value| value.needed_bytes)
                    .unwrap_or(0),
                live_runtime_skipped: detected
                    .live_runtime
                    .as_ref()
                    .map(|value| value.skipped)
                    .unwrap_or(0),
                live_asset_bytes: detected
                    .live_assets
                    .map(|value| value.needed_bytes)
                    .unwrap_or(0),
                prepare_only: request.prepare_only,
                test_mode: request.test_mode,
            };
            if !plan.is_approved_by(request.approve_zip_repair.as_ref()) {
                let mut error = LineError::new(ErrorCode::ConfirmationRequired,
                    "Для подготовки ZIP нужны дополнительные компоненты Minecraft. Подтвердите их проверку и возможную загрузку.", false);
                error.zip_repair = Some(Box::new(plan));
                return Err(error);
            }
        }
        let loader_started = std::time::Instant::now();
        let filled_result = install_profile(
            &app,
            &state,
            instance_id.clone(),
            detected.minecraft_version.clone(),
            loader,
            Some(Arc::clone(&preparation.1)),
            java_consent.as_ref(),
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
        Some(Arc::clone(&preparation.1)),
        java_consent.as_ref(),
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
    preparation_lease: Option<Arc<InstallLock>>,
    java_consent: Option<&super::java_consent::JavaConsent>,
) -> LineResult<McGameStatus> {
    // One account per project: the nickname and the stable UUID come from it.
    let session = line.session()?;
    let username = session.username.clone();
    let uuid = player_uuid(&username);
    let stop = Arc::new(AtomicBool::new(false));
    let claim = state.begin_start(&instance_id, preparation_lease.is_some())?;
    let lease = match preparation_lease {
        Some(lease) => lease,
        None => acquire_instance_lease(app, &instance_id)?,
    };
    let claim = Arc::new(InstanceOperation {
        _claim: claim,
        lease,
    });

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
        &claim,
        java_consent,
    )
    .await;
    if started.is_err() {
        if let Ok(mut inner) = state.lock() {
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
                    phase: if error.code == ErrorCode::ConfirmationRequired {
                        GamePhase::Idle
                    } else {
                        GamePhase::Failed
                    },
                    started_at: None,
                    exit_code: None,
                    message: if error.code == ErrorCode::ConfirmationRequired {
                        None
                    } else {
                        Some(error.message.clone())
                    },
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
    claim: &Arc<InstanceOperation>,
    java_consent: Option<&super::java_consent::JavaConsent>,
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
    let load_claim = Arc::clone(claim);
    let (version, component, required_major, quick_play) = tokio::task::spawn_blocking(
        move || -> LineResult<(VersionJson, Option<String>, u16, bool)> {
            let _worker_claim = load_claim;
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
        claim,
        java_consent,
        "launch",
    )
    .await?;

    let build_dir = game_dir.clone();
    let account_name = username.to_string();
    let account_uuid = uuid.to_string();
    let window = (preferences.window_width, preferences.window_height);
    let join_host = host.to_string();
    let build_claim = Arc::clone(claim);
    let command = tokio::task::spawn_blocking(move || -> LineResult<LaunchCommand> {
        let _worker_claim = build_claim;
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
    // Keep the cross-process lease for the entire lifetime of the game.
    let game_lease = Arc::clone(&claim.lease);
    tauri::async_runtime::spawn(async move {
        let _game_lease = game_lease;
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
mod preparation_lock_tests {
    use super::*;

    #[test]
    fn preparation_claim_is_exclusive_per_instance_and_released_on_drop() {
        let state = MinecraftState::default();
        let first = state.begin_preparation("server-one").unwrap();
        std::thread::scope(|scope| {
            let other = scope.spawn(|| state.begin_preparation("server-one").is_err());
            assert!(other.join().unwrap());
        });
        let other_instance = state.begin_preparation("server-two").unwrap();
        drop(other_instance);
        drop(first);
        assert!(state.begin_preparation("server-one").is_ok());
    }

    #[test]
    fn blocking_worker_keeps_claim_after_awaiter_drops_it() {
        let state = MinecraftState::default();
        let guard = state.begin_preparation("server").unwrap();
        let worker_guard = Arc::clone(&guard);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = worker_guard;
            ready_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
        });
        ready_rx.recv().unwrap();
        drop(guard); // The async caller can disappear while blocking work continues.
        assert!(state.begin_preparation("server").is_err());
        assert!(state.begin_preparation("other").is_ok());
        finish_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(state.begin_preparation("server").is_ok());
    }

    #[test]
    fn install_and_start_claims_survive_detached_workers_and_release() {
        for install in [true, false] {
            let state = MinecraftState::default();
            let claim = if install {
                state.begin_install("server", false).unwrap()
            } else {
                state.begin_start("server", false).unwrap()
            };
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (finish_tx, finish_rx) = std::sync::mpsc::channel();
            let worker_claim = Arc::clone(&claim);
            let worker = std::thread::spawn(move || {
                let _claim = worker_claim;
                ready_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
            });
            ready_rx.recv().unwrap();
            drop(claim);
            assert!(state.begin_preparation("server").is_err());
            assert!(state.begin_install("server", false).is_err());
            assert!(state.begin_start("server", false).is_err());
            finish_tx.send(()).unwrap();
            worker.join().unwrap();
            assert!(state.begin_preparation("server").is_ok());
        }
    }

    #[test]
    fn nested_operation_claims_do_not_bypass_other_active_operations() {
        let state = MinecraftState::default();
        let preparation = state.begin_preparation("server").unwrap();
        assert!(state.begin_install("server", false).is_err());
        assert!(state.begin_start("server", false).is_err());
        let install = state.begin_install("server", true).unwrap();
        assert!(state.begin_start("server", true).is_err());
        drop(install);
        let start = state.begin_start("server", true).unwrap();
        assert!(state.begin_install("server", true).is_err());
        drop(start);
        drop(preparation);
        assert!(state.begin_install("server", false).is_ok());
    }

    #[test]
    fn instance_file_lock_survives_worker_and_excludes_another_process() {
        const CHILD_DIR: &str = "LINE_TEST_INSTANCE_LOCK_DIR";
        const CHILD_BUSY: &str = "LINE_TEST_INSTANCE_LOCK_BUSY";
        if let Some(dir) = std::env::var_os(CHILD_DIR) {
            let expected_busy = std::env::var_os(CHILD_BUSY).is_some();
            let result = InstallLock::acquire(std::path::Path::new(&dir));
            if expected_busy {
                assert_eq!(result.err().unwrap().code, ErrorCode::Busy);
            } else {
                assert!(result.is_ok());
            }
            return;
        }
        let dir = std::env::temp_dir().join(format!("line-instance-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lease = Arc::new(InstallLock::acquire(&dir).unwrap());
        let worker_lease = Arc::clone(&lease);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _lease = worker_lease;
            ready_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
        });
        ready_rx.recv().unwrap();
        drop(lease);
        let check_child = |busy: bool| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .arg("instance_file_lock_survives_worker_and_excludes_another_process")
                .arg("--test-threads=1")
                .env(CHILD_DIR, &dir);
            if busy {
                command.env(CHILD_BUSY, "1");
            } else {
                command.env_remove(CHILD_BUSY);
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "child failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        check_child(true);
        finish_tx.send(()).unwrap();
        worker.join().unwrap();
        check_child(false);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn loader_command_passes_paths_as_distinct_arguments_without_a_shell() {
        let command = loader_installer_command(
            Path::new("java path/java"),
            Path::new("installer path/setup.jar"),
            Path::new("game path"),
        );
        assert_eq!(
            command.get_program(),
            std::ffi::OsStr::new("java path/java")
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                std::ffi::OsStr::new("-jar"),
                std::ffi::OsStr::new("installer path/setup.jar"),
                std::ffi::OsStr::new("--installClient"),
                std::ffi::OsStr::new("game path")
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn loader_log_rejects_symlink() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("logs")).unwrap();
        let external = root.path().join("external");
        std::fs::write(&external, b"keep").unwrap();
        std::os::unix::fs::symlink(&external, root.path().join("logs/line-loader-install.log"))
            .unwrap();
        assert!(run_quiet_loader_installer(
            Path::new("java"),
            Path::new("installer.jar"),
            root.path()
        )
        .is_err());
        assert_eq!(std::fs::read(external).unwrap(), b"keep");
    }

    #[test]
    fn preparation_refuses_existing_install_start_or_running_game() {
        let state = MinecraftState::default();
        {
            let mut inner = state.lock().unwrap();
            inner.installing.insert("server".into());
        }
        assert!(state.begin_preparation("server").is_err());
        {
            let mut inner = state.lock().unwrap();
            inner.installing.remove("server");
            inner.starting.insert("server".into());
        }
        assert!(state.begin_preparation("server").is_err());
        {
            let mut inner = state.lock().unwrap();
            inner.starting.remove("server");
            inner.running.insert(
                "server".into(),
                Running {
                    stop: Arc::new(AtomicBool::new(false)),
                    version_id: "1.20.1".into(),
                    started_at: 1,
                },
            );
        }
        assert!(state.begin_preparation("server").is_err());
    }

    #[test]
    fn early_error_releases_preparation_claim() {
        fn fail_after_claim(state: &MinecraftState) -> LineResult<()> {
            let _guard = state.begin_preparation("server")?;
            Err(LineError::input("simulated error"))
        }
        let state = MinecraftState::default();
        assert!(fail_after_claim(&state).is_err());
        assert!(state.begin_preparation("server").is_ok());
    }
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
