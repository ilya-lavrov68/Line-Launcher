//! Verified-manifest Java launch with a one-shot private ticket channel.
//! Provider access tokens and launch tickets never appear in JVM arguments,
//! WebView DTOs, events or logs.
use super::error::{ErrorCode, LineError, LineResult};
use super::install::current_receipt;
use super::ipc::{PrivateChannel, TicketGrant};
use super::java;
use super::launch_manifest::read_optional;
use super::state::LineState;
use super::storage::{create_private_dir, is_real_dir, is_real_file, server_dir, InstallLock};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;
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
    /// log4j2 configuration from the pack, already resolved inside the release.
    pub logging_config: Option<PathBuf>,
    /// Extra game arguments from the manifest; validated twice.
    pub game_args: Vec<String>,
    /// Stable per-account identifier handed to the client. The authoritative
    /// UUID still comes from the provider's session exchange over private IPC.
    pub player_uuid: String,
    /// mojang | msa | legacy, as declared by the pack.
    pub user_type: String,
    /// Non-secret rendezvous identifier for the private IPC channel.
    pub session_channel_id: Option<String>,
    pub total_memory_bytes: u64,
    /// Player override from settings; None keeps the automatic sizing.
    pub heap_mb: Option<u32>,
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
    /// The launch was refused on purpose — the release failed its integrity
    /// scan, or the resource-pack check found a cheat. Distinct from `Failed`
    /// because nothing crashed: the player has to decide something.
    Blocked,
}

pub const MIN_HEAP_MB: u32 = 1024;
pub const MAX_HEAP_MB: u32 = 16_384;

/// Upper player-selectable heap: at most 3/4 of physical memory, capped at
/// MAX_HEAP_MB. Leaves the OS and the launcher itself room to breathe.
pub fn heap_ceiling(total_memory_bytes: u64) -> u32 {
    let mib = total_memory_bytes / (1024 * 1024);
    let ceiling = (mib / 4) * 3;
    ceiling.clamp(MIN_HEAP_MB as u64, MAX_HEAP_MB as u64) as u32
}

/// Reject rather than clamp, so the saved settings and the UI cannot disagree.
pub fn validate_heap(requested: u32, total_memory_bytes: u64) -> LineResult<u32> {
    let ceiling = heap_ceiling(total_memory_bytes);
    if requested < MIN_HEAP_MB || requested > ceiling {
        return Err(LineError::input(format!(
            "Объём памяти должен быть от {MIN_HEAP_MB} до {ceiling} МБ."
        )));
    }
    Ok(requested)
}

pub fn optimal_heap_mb(total_memory_bytes: u64) -> u32 {
    let mib = total_memory_bytes / (1024 * 1024);
    (mib / 2).clamp(1024, 8192) as u32
}

/// Formats 16 bytes as a UUID and sets the RFC 4122 version/variant bits, so the
/// client always receives a well-formed identifier. Pure: unit-tested without a
/// hasher.
pub fn format_uuid(bytes: &[u8]) -> String {
    let mut raw = [0u8; 16];
    for (index, slot) in raw.iter_mut().enumerate() {
        *slot = bytes.get(index).copied().unwrap_or(0);
    }
    raw[6] = (raw[6] & 0x0f) | 0x40;
    raw[8] = (raw[8] & 0x3f) | 0x80;
    let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Deterministic UUID for a provider account: the same login always produces the
/// same client-side identity (so single-player worlds keep their player data),
/// and two accounts never collide. This is *not* an authentication artefact —
/// the provider's session exchange decides the real profile.
pub fn player_uuid(username: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("line-launcher:player:{username}").as_bytes());
    format_uuid(&digest[..16])
}

pub fn valid_uuid(value: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == groups.len()
        && parts.iter().zip(groups).all(|(part, len)| {
            part.len() == len
                && part
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
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
        || spec
            .session_channel_id
            .as_deref()
            .is_some_and(|id| !super::config::validate_slug(id))
        || spec
            .asset_index
            .as_deref()
            .is_some_and(|v| !super::config::validate_slug(v))
        || spec.assets_dir.as_ref().is_some_and(|p| !p.is_absolute())
        || spec.natives_dir.as_ref().is_some_and(|p| !p.is_absolute())
        || spec.asset_index.is_some() != spec.assets_dir.is_some()
        || !valid_uuid(&spec.player_uuid)
        || !matches!(spec.user_type.as_str(), "mojang" | "msa" | "legacy")
        || spec
            .logging_config
            .as_ref()
            .is_some_and(|p| !p.is_absolute())
        || !super::launch_manifest::game_args_are_safe(&spec.game_args)
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
    let heap = match spec.heap_mb {
        Some(requested) => validate_heap(requested, spec.total_memory_bytes)?,
        None => optimal_heap_mb(spec.total_memory_bytes),
    };
    let mut args = vec![
        spec.java.to_string_lossy().into_owned(),
        format!("-Xmx{heap}M"),
        format!("-Xms{heap}M"),
        // Vanilla's world generation needs a larger thread stack than the JVM
        // default on several platforms; without it the game dies with a
        // StackOverflowError during chunk loading.
        "-Xss1M".into(),
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
    ];
    // Offline packs have no ticket channel and no auth mod to contact.
    if let Some(id) = &spec.session_channel_id {
        args.push(format!("-DlineLauncher.sessionChannel={id}"));
    }
    // LWJGL 3 (every modern Minecraft) must own the first thread on macOS.
    if cfg!(target_os = "macos") {
        args.push("-XstartOnFirstThread".into());
    }
    if let Some(natives) = &spec.natives_dir {
        args.push(format!("-Djava.library.path={}", natives.to_string_lossy()));
        // LWJGL 3 reads its own property, not java.library.path.
        args.push(format!(
            "-Dorg.lwjgl.librarypath={}",
            natives.to_string_lossy()
        ));
    }
    if let Some(config) = &spec.logging_config {
        args.push(format!(
            "-Dlog4j.configurationFile={}",
            config.to_string_lossy()
        ));
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
    // Identity arguments the real client expects. The access token is a
    // deliberately empty placeholder: the provider's real ticket travels only
    // over the private one-shot channel, never through argv, where any local
    // process could read it from the process list.
    args.extend([
        "--uuid".into(),
        spec.player_uuid.clone(),
        "--accessToken".into(),
        "0".into(),
        "--userType".into(),
        spec.user_type.clone(),
        "--versionType".into(),
        "release".into(),
    ]);
    if let (Some(index), Some(assets)) = (&spec.asset_index, &spec.assets_dir) {
        args.extend([
            "--assetIndex".into(),
            index.clone(),
            "--assetsDir".into(),
            assets.to_string_lossy().into_owned(),
        ]);
    }
    // Pack-supplied extras go last and cannot shadow anything above.
    args.extend(spec.game_args.iter().cloned());
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

/// Writable per-server directory for saves, options, resource packs and logs.
/// It lives next to `releases/`, not inside one: updating or repairing a build
/// must never touch the player's worlds, and two servers must never share them.
pub fn instance_game_dir(base: &Path) -> LineResult<PathBuf> {
    let dir = base.join("game");
    create_private_dir(&dir)?;
    Ok(dir)
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
    if !is_real_dir(&releases)
        || !is_real_dir(&dir)
        || !is_real_file(&dir.join(super::integrity::COMPLETE_MARKER))
    {
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

/// An explicit choice is re-verified, including its major. A wrong version is
/// reported instead of silently launching with another JDK.
async fn select_runtime(
    preferences: &super::settings::LauncherSettings,
    required_major: u16,
) -> LineResult<java::JavaRuntime> {
    if let Some(requested) = &preferences.java_path {
        let runtime = java::inspect_path(requested).await?;
        if runtime.major != required_major {
            return Err(LineError::new(
                ErrorCode::JavaRequired,
                format!("Выбрана Java {}, а сборке нужна Java {required_major}. Выберите другой рантайм в настройках.", runtime.major),
                false,
            ));
        }
        return Ok(runtime);
    }
    java::discover(required_major).await
}

fn total_memory() -> u64 {
    use sysinfo::System;
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory()
}

/// Result of checking one release under the cross-process lock.
struct ReleaseLease {
    lock: InstallLock,
    receipt: super::install::InstallReceipt,
    release: PathBuf,
    /// Missing index, missing files or changed bytes: only the archive can fix it.
    repair_needed: bool,
    /// Foreign files already deleted while the lock was held.
    removed: usize,
}

/// Hashes every file of this server's own release and deletes anything the
/// provider did not publish. Runs under the install lock so a concurrent
/// install/rollback cannot race the scan.
fn scan_release_blocking(base: &Path, server_id: &str) -> LineResult<ReleaseLease> {
    let lock = InstallLock::acquire(base)?;
    let receipt = current_receipt(base, server_id)
        .ok_or_else(|| LineError::new(ErrorCode::Integrity, "Сначала установите сборку.", false))?;
    let release = verified_game_dir(base, &receipt.sha256)?;
    let (repair_needed, removed) = match super::integrity::scan(&release) {
        Ok(report) => {
            let removed = if report.foreign.is_empty() {
                0
            } else {
                let count = super::integrity::remove_foreign(&release, &report.foreign)?;
                super::integrity::prune_empty_dirs(&release, &report.foreign)?;
                count
            };
            (report.needs_download(), removed)
        }
        // No index (installed by an older launcher), an unreadable tree or a
        // planted symlink: do not guess, re-download the verified archive.
        Err(_) => (true, 0),
    };
    Ok(ReleaseLease {
        lock,
        receipt,
        release,
        repair_needed,
        removed,
    })
}

/// Guarantees the release about to be launched matches the provider's published
/// bytes: foreign files are deleted, missing/changed ones are re-downloaded.
async fn prepare_release(
    app: &AppHandle,
    state: &LineState,
    server: &super::config::Server,
    base: &Path,
    stop: &Arc<AtomicBool>,
) -> LineResult<ReleaseLease> {
    // Hashing a multi-gigabyte release takes seconds; say what is happening
    // instead of leaving the button spinning without an explanation.
    publish(
        app,
        state,
        GameStatus {
            server_id: server.id.clone(),
            revision: 0,
            phase: GamePhase::Starting,
            sha256: None,
            started_at: None,
            exit_code: None,
            message: Some("Проверка файлов сборки…".into()),
        },
    );
    let scan_base = base.to_path_buf();
    let scan_server = server.id.clone();
    let lease = tauri::async_runtime::spawn_blocking(move || {
        scan_release_blocking(&scan_base, &scan_server)
    })
    .await
    .map_err(|_| LineError::storage())??;
    if !lease.repair_needed {
        if lease.removed > 0 {
            publish(
                app,
                state,
                GameStatus {
                    server_id: server.id.clone(),
                    revision: 0,
                    phase: GamePhase::Starting,
                    sha256: Some(lease.receipt.sha256.clone()),
                    started_at: None,
                    exit_code: None,
                    message: Some(format!(
                        "Проверка файлов: удалено посторонних — {}.",
                        lease.removed
                    )),
                },
            );
        }
        return Ok(lease);
    }
    publish(
        app,
        state,
        GameStatus {
            server_id: server.id.clone(),
            revision: 0,
            phase: GamePhase::Starting,
            sha256: Some(lease.receipt.sha256.clone()),
            started_at: None,
            exit_code: None,
            message: Some(
                "Проверка файлов: сборка изменена или неполная — скачиваем заново.".into(),
            ),
        },
    );
    // install takes the same lock itself, so the whole lease (lock included)
    // must be released before calling it.
    drop(lease);
    let operation_id = Uuid::new_v4().to_string();
    let emitter = app.clone();
    let sink = super::install::ProgressSink::new(move |progress| {
        let _ = emitter.emit(super::install::PROGRESS_EVENT, progress);
    });
    super::install::repair(
        &state.http,
        server,
        base,
        &operation_id,
        stop.clone(),
        &sink,
    )
    .await?;
    if stop.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    let scan_base = base.to_path_buf();
    let scan_server = server.id.clone();
    let lease = tauri::async_runtime::spawn_blocking(move || {
        scan_release_blocking(&scan_base, &scan_server)
    })
    .await
    .map_err(|_| LineError::storage())??;
    if lease.repair_needed || lease.removed > 0 {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Файлы сборки меняются снова сразу после восстановления. Проверьте диск, антивирус и сторонние программы.",
            false,
        ));
    }
    Ok(lease)
}

/// Block foreign files in the live mods directory without deleting player data.
/// Nested paths and links cannot be authenticated from the pack's flat file list.
pub fn check_live_mods(game: &Path, owned: &[String]) -> LineResult<()> {
    let dir = game.join("mods");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(LineError::io(&error)),
    };
    let owned: std::collections::BTreeSet<&str> = owned.iter().map(String::as_str).collect();
    for entry in entries {
        let entry = entry.map_err(|e| LineError::io(&e))?;
        let kind = std::fs::symlink_metadata(entry.path()).map_err(|e| LineError::io(&e))?.file_type();
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = format!("mods/{name}");
        if !kind.is_file() || !owned.contains(path.as_str()) {
            return Err(LineError::new(ErrorCode::Integrity,
                format!("В папке mods найден посторонний файл или каталог: {name}. Уберите его и повторите запуск."), false));
        }
    }
    Ok(())
}

/// Result of the resource-pack check. `blocked` is fatal; `foreign` alone is
/// reported and the player decides (see `docs/ANTICHEAT.md`).
pub struct PackScan {
    pub blocked: Option<String>,
    pub foreign: usize,
}

/// Checks what the game will actually load from `game/resourcepacks`.
///
/// Runs on the **live** directory, not the immutable release: a pack dropped
/// into `game/` is exactly what the release scan cannot see, and it is what the
/// game reads. Two questions, in order:
///
/// 1. Is every file in that folder one the provider published? (`pack-state.json`)
/// 2. Does any of them contain a cheat keyword — in its name, its entries or the
///    text of its models?
///
/// A keyword hit stops the launch. A foreign file that scans clean is reported
/// and left alone: a player is allowed to install a HUD pack, and deleting it
/// would be the launcher deciding it knows better about a file it did not ship.
pub fn scan_packs(
    base: &Path,
    server: &super::config::Server,
    owned: &[String],
) -> LineResult<PackScan> {
    let game = instance_game_dir(base)?;
    check_live_mods(&game, owned)?;
    let settings = server.anticheat.clone().unwrap_or_default();
    if !settings.scan_resourcepacks {
        // The hard half still runs: "nobody published this file" is not an
        // opinion about words and cannot be switched off.
        let (_, foreign) =
            super::resourcepack::scan_all(&game, owned, &settings.allow, &[])?;
        return Ok(PackScan {
            blocked: None,
            foreign: foreign.len(),
        });
    }
    let (findings, foreign) = super::resourcepack::scan_all(
        &game,
        owned,
        &settings.allow,
        &settings.extra_keywords,
    )?;
    for hit in &findings.hits {
        super::logger::warn(
            super::logger::Area::Launch,
            "resourcepack blocked",
            &[
                super::logger::Field::text("pack", &hit.pack),
                super::logger::Field::text("entry", &hit.entry),
                super::logger::Field::text("keyword", &hit.keyword),
            ],
        );
    }
    let blocked = if findings.is_clean() {
        None
    } else {
        Some(format!(
            "В ресурс-паках найдено запрещённое содержимое: {}. Удалите этот пак в «Открыть папку игры» → resourcepacks и попробуйте снова.",
            findings.summary(3)
        ))
    };
    Ok(PackScan {
        blocked,
        foreign: foreign.len(),
    })
}

#[tauri::command]
pub async fn launch_game(
    server_id: String,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<GameStatus> {
    let (_, config) = state.fresh_config()?;
    let total_memory_bytes = total_memory();
    let preferences = super::settings::load(&app, total_memory_bytes);
    let server = config.server(&server_id)?.clone();
    let session = state.session()?;
    let offline = server.launch_mode == super::config::LaunchMode::Offline;
    let ticket_url = server.auth.launch_ticket_url.as_deref();
    if !offline && ticket_url.is_none() {
        return Err(LineError::input(
            "Провайдер не настроил запуск для этого сервера.",
        ));
    }
    let exchange_url = server.auth.session_exchange_url.as_deref();
    if !offline && exchange_url.is_none() {
        return Err(LineError::input(
            "Провайдер не настроил обмен сессии для этого сервера.",
        ));
    }
    if let Some(url) = exchange_url {
        super::config::validate_https(url)?;
    }
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
        // Verify every file of this server's own release, then hold the same
        // cross-process lock used by install/rollback/prune for the whole game
        // lifetime, so another launcher process cannot delete a live release.
        let lease = tokio::select! {
            result = prepare_release(&app, &state, &server, &base, &stop) => result?,
            _ = wait_stop(&stop) => return Err(cancelled()),
        };
        let ReleaseLease {
            lock,
            receipt,
            release,
            ..
        } = lease;
        if stop.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        // The manifest is read from the immutable release; the game itself runs
        // in the server's writable directory so worlds and settings survive
        // updates and repairs.
        let io_release = release;
        let io_base = base.clone();
        let io = tauri::async_runtime::spawn_blocking(move || {
            let resolved = read_optional(&io_release)?.ok_or_else(|| {
                LineError::input("В сборке нет манифеста запуска line-launch.json.")
            })?;
            let game_dir = instance_game_dir(&io_base)?;
            Ok::<_, LineError>((resolved, game_dir))
        });
        let (resolved, game_dir) = tokio::select! {
            result = io => result.map_err(|_| LineError::storage())??,
            _ = wait_stop(&stop) => return Err(cancelled()),
        };
        // What the game will load from `game/resourcepacks`, checked against what
        // the provider actually published. Runs after the release scan (so the
        // published side is known good) and before Java exists, so a blocked
        // launch costs nothing but a message.
        let owned = super::pack::owned_files(&base);
        let scan_base = base.clone();
        let scan_server = server.clone();
        let scan = tauri::async_runtime::spawn_blocking(move || {
            scan_packs(&scan_base, &scan_server, &owned)
        });
        let scan = tokio::select! {
            result = scan => result.map_err(|_| LineError::storage())??,
            _ = wait_stop(&stop) => return Err(cancelled()),
        };
        if let Some(message) = scan.blocked {
            publish(
                &app,
                &state,
                GameStatus {
                    server_id: server_id.clone(),
                    revision: 0,
                    phase: GamePhase::Blocked,
                    sha256: Some(receipt.sha256.clone()),
                    started_at: None,
                    exit_code: None,
                    message: Some(message.clone()),
                },
            );
            return Err(LineError::new(ErrorCode::Integrity, message, false));
        }
        if scan.foreign > 0 {
            publish(
                &app,
                &state,
                GameStatus {
                    server_id: server_id.clone(),
                    revision: 0,
                    phase: GamePhase::Starting,
                    sha256: Some(receipt.sha256.clone()),
                    started_at: None,
                    exit_code: None,
                    message: Some(format!(
                        "Посторонних ресурс-паков: {}. Запуск продолжается — это ваши файлы.",
                        scan.foreign
                    )),
                },
            );
        }
        if stop.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let runtime = tokio::select! {
            result = select_runtime(&preferences, resolved.manifest.java_major) => result?,
            _ = wait_stop(&stop) => return Err(cancelled()),
        };
        if stop.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        // Bind before spawn in ticket mode. Explicit offline packs create no
        // pipe, request no ticket, and never wait for an auth-mod handshake.
        let launch_auth = if offline {
            None
        } else {
            let channel = PrivateChannel::create()?;
            let token = session.secret_token();
            let request = TicketRequest {
                server_id: &server_id,
                sha256: &receipt.sha256,
                channel_id: &channel.id,
                username: &session.username,
            };
            let (ticket, expires_in) = tokio::select! {
                result = issue_ticket(&state, ticket_url.ok_or_else(|| LineError::input("Не настроен launch_ticket_url."))?, &token, &request) => result?,
                _ = wait_stop(&stop) => return Err(cancelled()),
            };
            Some((channel, ticket, expires_in))
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
            logging_config: resolved.logging_config,
            game_args: resolved.manifest.game_args,
            player_uuid: player_uuid(&session.username),
            user_type: resolved
                .manifest
                .user_type
                .unwrap_or_else(|| "mojang".to_owned()),
            session_channel_id: launch_auth.as_ref().map(|(channel, _, _)| channel.id.clone()),
            total_memory_bytes,
            heap_mb: preferences.heap_mb,
        };
        let args = build_java_command(&spec)?;
        // Keep the game's own output instead of discarding it: a failed launch
        // (missing class, mod handshake error) is otherwise invisible. The log
        // lives in the server directory, never inside the immutable release,
        // and is truncated per launch so it cannot grow without bound.
        let log_dir = base.join("logs");
        super::storage::create_private_dir(&log_dir)?;
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(log_dir.join("launch.log"))
            .map_err(|e| LineError::io(&e))?;
        let log_copy = log_file.try_clone().map_err(|e| LineError::io(&e))?;
        let mut command = tokio::process::Command::new(&args[0]);
        command
            .args(&args[1..])
            .current_dir(&game_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_copy))
            .kill_on_drop(true);
        #[cfg(windows)]
        {
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
        let exchange_url = exchange_url.map(str::to_owned);
        let username = session.username.clone();
        let monitor_stop = stop.clone();
        tauri::async_runtime::spawn(async move {
            let _lock = lock;
            let ipc_server = monitor_server.clone();
            let ipc_sha = monitor_sha.clone();
            let mut ipc_task = launch_auth.map(|(channel, ticket, expires_in)| {
                tauri::async_runtime::spawn(async move {
                    let exchange_url = exchange_url.ok_or_else(|| LineError::input("Не настроен session_exchange_url."))?;
                    channel.serve_once(pid, ticket, TicketGrant {
                        exchange_url: &exchange_url,
                        server_id: &ipc_server,
                        sha256: &ipc_sha,
                        username: &username,
                        expires_in,
                    }).await
                })
            });
            let mut ipc_failure: Option<LineError> = None;
            let mut ipc_done = ipc_task.is_none();
            let mut stopped = false;
            let exit = loop {
                if monitor_stop.load(Ordering::Acquire) {
                    stopped = true;
                    let _ = child.kill().await;
                    if let Some(task) = &ipc_task {
                        task.abort();
                    }
                    break None;
                }
                if ipc_done {
                    tokio::select! {
                        result = child.wait() => break result.ok().and_then(|status| status.code()),
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                    }
                } else if let Some(task) = ipc_task.as_mut() {
                    tokio::select! {
                        result = &mut *task => {
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
                                match tokio::time::timeout(Duration::from_millis(500), &mut *task).await {
                                    Ok(Ok(Ok(()))) => {}
                                    Ok(Ok(Err(error))) => ipc_failure = Some(error),
                                    // The game exited before the mod asked
                                    // for its ticket. That is a mod/IPC
                                    // problem, and reporting it as an auth
                                    // failure signed the player out while
                                    // their session was perfectly valid.
                                    _ => ipc_failure = Some(LineError::new(
                                        ErrorCode::Busy,
                                        "Игра завершилась до получения launch ticket. Проверьте мод авторизации провайдера.",
                                        true,
                                    )),
                                }
                                task.abort();
                            }
                            break code;
                        }
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                    }
                } else {
                    ipc_done = true;
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

/// What a pack check found, for the «Проверить сейчас» button.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackCheck {
    /// Empty when nothing suspicious was found.
    pub findings: Vec<String>,
    /// Files in `game/resourcepacks` the provider did not publish.
    pub foreign: Vec<String>,
}

/// Runs the same check `launch_game` runs, without launching.
///
/// Exists because the answer is useful *before* pressing «Играть»: a player who
/// just installed a pack can find out now, instead of being blocked at the worst
/// possible moment. Same code path, so the two can never disagree.
#[tauri::command]
pub async fn check_resource_packs(
    server_id: String,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<PackCheck> {
    let (_, config) = state.fresh_config()?;
    let server = config.server(&server_id)?.clone();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = if server.launch_mode == super::config::LaunchMode::Minecraft {
        root.join("minecraft").join(super::minecraft_core::validate_instance_id(&server_id)?)
    } else {
        server_dir(&root, &server_id)?
    };
    let owned = super::pack::owned_files(&base);
    tauri::async_runtime::spawn_blocking(move || -> LineResult<PackCheck> {
        let settings = server.anticheat.clone().unwrap_or_default();
        // Keywords are the provider's switch; the foreign-file list is not.
        let extra: &[String] = if settings.scan_resourcepacks {
            &settings.extra_keywords
        } else {
            &[]
        };
        let game = instance_game_dir(&base)?;
        let (findings, foreign) =
            super::resourcepack::scan_all(&game, &owned, &settings.allow, extra)?;
        Ok(PackCheck {
            findings: findings
                .hits
                .iter()
                .filter(|_| settings.scan_resourcepacks)
                .map(|hit| {
                    if hit.entry.is_empty() {
                        format!("{} ({})", hit.pack, hit.keyword)
                    } else {
                        format!("{}: {} ({})", hit.pack, hit.entry, hit.keyword)
                    }
                })
                .collect(),
            foreign: foreign.into_iter().map(|pack| pack.path).collect(),
        })
    })
    .await
    .map_err(|_| LineError::storage())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Absolute paths differ per platform: "/game" is relative on Windows.
    fn abs(relative: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:\\line-test\\{relative}"))
        } else {
            PathBuf::from(format!("/line-test/{relative}"))
        }
    }

    fn spec() -> LaunchSpec {
        LaunchSpec {
            java: abs("java"),
            game_dir: abs("game"),
            classpath: vec![abs("game/client.jar")],
            main_class: "net.minecraft.client.main.Main".into(),
            username: "Player_1".into(),
            minecraft_version: "1.21.1".into(),
            asset_index: None,
            assets_dir: None,
            natives_dir: None,
            logging_config: None,
            game_args: Vec::new(),
            player_uuid: format_uuid(&[7u8; 16]),
            user_type: "mojang".into(),
            session_channel_id: Some("launch-channel-1".into()),
            total_memory_bytes: 16 * 1024 * 1024 * 1024,
            heap_mb: None,
        }
    }

    #[test]
    fn offline_command_has_no_session_channel_or_ticket_requirement() {
        let mut offline = spec();
        offline.session_channel_id = None;
        let args = build_java_command(&offline).unwrap();
        assert!(!args.iter().any(|arg| arg.contains("sessionChannel")));
        assert!(args.contains(&"--accessToken".to_owned()));
        assert!(args.contains(&"0".to_owned()));
        assert!(args.contains(&"--username".to_owned()));
    }

    #[test]
    fn command_contains_channel_not_secret_and_automatic_heap() {
        let args = build_java_command(&spec()).unwrap();
        assert!(args.contains(&"-Xmx8192M".to_owned()));
        let game_dir = args.iter().position(|a| a == "--gameDir").unwrap();
        assert_eq!(args[game_dir + 1], abs("game").to_string_lossy());
        assert!(args
            .iter()
            .any(|a| a == "-DlineLauncher.sessionChannel=launch-channel-1"));
        assert!(!args
            .iter()
            .any(|a| a.to_ascii_lowercase().contains("accesstoken=")));
    }

    #[test]
    fn real_client_gets_identity_arguments_but_never_a_secret() {
        let mut s = spec();
        s.game_args = vec!["--launchTarget".into(), "forgeclient".into()];
        let args = build_java_command(&s).unwrap();
        let value = |flag: &str| {
            let at = args.iter().position(|a| a == flag).expect(flag);
            args[at + 1].clone()
        };
        assert!(valid_uuid(&value("--uuid")));
        assert_eq!(value("--accessToken"), "0");
        assert_eq!(value("--userType"), "mojang");
        assert_eq!(value("--versionType"), "release");
        assert_eq!(value("--launchTarget"), "forgeclient");
        assert!(args.contains(&"-Xss1M".to_owned()));
        // The placeholder must be the only token-looking argument.
        assert!(!args
            .iter()
            .any(|a| a.to_ascii_lowercase().contains("accesstoken=")));
        assert!(!args.iter().any(|a| a == "--session"));
    }

    #[test]
    fn player_uuid_is_stable_per_account_and_well_formed() {
        // Same account -> same uuid, different account -> different uuid.
        assert_eq!(player_uuid("Player_1"), player_uuid("Player_1"));
        assert_ne!(player_uuid("Player_1"), player_uuid("Player_2"));
        assert!(valid_uuid(&player_uuid("Player_1")));
        assert!(valid_uuid(&player_uuid("")));
    }

    #[test]
    fn pack_arguments_cannot_override_the_launcher_owned_ones() {
        let mut s = spec();
        for pair in [
            vec!["--username".to_string(), "Impostor".to_string()],
            vec![
                "--gameDir".to_string(),
                abs("elsewhere").to_string_lossy().into_owned(),
            ],
            vec!["-javaagent:evil".to_string()],
        ] {
            s.game_args = pair;
            assert!(build_java_command(&s).is_err());
        }
        s.game_args = Vec::new();
        s.player_uuid = "not-a-uuid".into();
        assert!(build_java_command(&s).is_err());
        s.player_uuid = format_uuid(&[1u8; 16]);
        s.user_type = "pirate".into();
        assert!(build_java_command(&s).is_err());
    }

    #[test]
    fn uuid_formatting_sets_version_and_variant_bits() {
        let value = format_uuid(&[0xff; 16]);
        assert!(valid_uuid(&value));
        assert_eq!(value.len(), 36);
        assert_eq!(value.as_bytes()[14], b'4');
        assert!(matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        // Short input must still produce a well-formed value, not panic.
        assert!(valid_uuid(&format_uuid(&[1, 2, 3])));
        assert!(!valid_uuid(""));
        assert!(!valid_uuid(&"A".repeat(36)));
    }

    #[test]
    fn rejects_agent_injection_and_small_host_memory_is_bounded() {
        assert_eq!(optimal_heap_mb(0), 1024);
        assert_eq!(optimal_heap_mb(4 * 1024 * 1024 * 1024), 2048);
        let mut s = spec();
        s.session_channel_id = Some("-javaagent:evil".into());
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
