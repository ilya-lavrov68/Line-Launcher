//! Verified-manifest Java launch with a one-shot private ticket channel.
//! Provider access tokens and launch tickets never appear in JVM arguments,
//! WebView DTOs, events or logs.
use super::error::{ErrorCode, LineError, LineResult};
use super::install::current_receipt;
use super::ipc::{PrivateChannel, TicketGrant};
use super::java;
use super::launch_manifest::read_optional;
use super::minecraft_core;
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

use super::jvm_profile::{self, LoaderFamily};
use super::minecraft_core::LoaderChoice;

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
    /// The pack's own recommendation from the verified manifest. Only consulted
    /// when `heap_mb` is None; never able to exceed `heap_ceiling`.
    pub pack_memory_mb: Option<u32>,
    /// The loader this build runs under, from the verified release. Forge and
    /// NeoForge need module-system flags; Fabric and Quilt must not receive
    /// them. The pack cannot influence this beyond choosing its own loader.
    pub loader: LoaderChoice,
    /// Extra module-path entries for a modular loader (`-p`). Empty for
    /// classpath loaders and for modular ones whose modules are on the class
    /// path, which is the normal Forge layout.
    pub module_path: Vec<PathBuf>,
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

/// How much heap a pack can actually use on this machine.
///
/// Half of physical memory, capped at 8 GiB — the same figure the launcher has
/// always suggested, so turning the automatic mode on changes nothing for a
/// pack that declares no budget of its own.
pub fn optimal_heap_mb(total_memory_bytes: u64) -> u32 {
    let mib = total_memory_bytes / (1024 * 1024);
    (mib / 2).clamp(1024, 8192) as u32
}

/// The heap a pack should get when it declares `recommended_memory_mb`.
///
/// One pack's budget is not another's: a 200-mod kitchen sink needs several
/// gigabytes before the first chunk loads, while a vanilla-shaped pack runs
/// fine in one and is *worse* with four — a large heap makes the collector
/// defer and then pause longer. So the pack may say what it needs, and this
/// decides what it gets.
///
/// The pack is a hint, never an order. It cannot raise the heap past what the
/// machine can spare (`heap_ceiling`), because a manifest asking for 12 GiB on
/// an 8 GiB laptop is exactly how a launcher wins the RAM fight and loses the
/// game. Within the machine's limit the request is honoured, rounded down to a
/// whole 256 MiB so the slider and `-Xmx` agree on a readable number.
///
/// `None` (a pack that declares nothing) means `optimal_heap_mb`.
pub fn pack_heap_mb(recommended_memory_mb: Option<u32>, total_memory_bytes: u64) -> u32 {
    let Some(requested) = recommended_memory_mb else {
        return optimal_heap_mb(total_memory_bytes);
    };
    let ceiling = heap_ceiling(total_memory_bytes);
    // Below the minimum the game will not start at all, so a pack asking for
    // 512 MiB still gets the floor rather than a crash it cannot explain.
    requested.clamp(MIN_HEAP_MB, ceiling) / 256 * 256
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
    // Priority: the player's own number (validated against this machine), then
    // the pack's declared budget, then the automatic figure. A player who
    // picked 6 GiB keeps it even on a pack that asks for 2 — the setting is
    // theirs, and the pack only fills in when nobody chose.
    let heap = match spec.heap_mb {
        Some(requested) => validate_heap(requested, spec.total_memory_bytes)?,
        None => pack_heap_mb(spec.pack_memory_mb, spec.total_memory_bytes),
    };
    let mut args = vec![
        spec.java.to_string_lossy().into_owned(),
        format!("-Xmx{heap}M"),
        // Not `-Xms{heap}M`. Pinning the initial heap to the maximum makes the
        // JVM commit the whole heap as one block before the first class loads;
        // on Windows that bursts the page file while the game, the WebView and
        // the GPU driver are starting, and on an XMP/EXPO-tuned machine the
        // stress can end in a hard reset — which lands in the firmware, not in
        // a blue screen. A small initial heap grows into `-Xmx` on demand, the
        // way the JDK and every other launcher do it. See `initial_heap_mb`.
        format!("-Xms{}M", minecraft_core::initial_heap_mb(heap)),
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
    // Forge and NeoForge launch through the module system and need the flags
    // the manifest is forbidden to carry. The launcher builds them itself from
    // the loader family, which comes from the verified release — see
    // `jvm_profile.rs` for why the pack must not supply this list.
    let family = LoaderFamily::of(spec.loader);
    if family == LoaderFamily::Modular {
        let module_path = spec
            .module_path
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        args.extend(
            jvm_profile::module_path_args(&module_path)
                .map_err(|message| LineError::input(message))?,
        );
    }
    args.extend(jvm_profile::loader_jvm_args(family));
    if family == LoaderFamily::Modular {
        // The loader re-reads the class path from this property. Its value is
        // the classpath already validated above, so no new input reaches the
        // process here.
        args.push(
            jvm_profile::legacy_class_path_arg(&classpath)
                .map_err(LineError::input)?,
        );
    }
    args.extend([
        "-cp".into(),
        classpath.clone(),
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
    super::install::recover_releases(base)?;
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

/// Minecraft mod archives, case-insensitively; settings and cache data inside
/// mods are not themselves mod JARs. Links are handled separately, fail closed.
pub fn is_mod_jar(path: &str) -> bool {
    path.strip_prefix("mods/")
        .and_then(|name| name.rsplit('/').next())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".jar"))
}

/// Compare live mod JARs to the published list without inspecting their words.
/// Non-JAR data is not treated as a mod. Links and special files are never
/// followed, and no player files are removed.
/// Strict form: any unproved mod is an error, which is what every caller that
/// has no way to offer a quarantine decision needs.
pub fn check_live_mods(game: &Path, owned: &[String]) -> LineResult<()> {
    let unproved = check_live_mods_with(game, owned, |_| Ok(false))?;
    if let Some(first) = unproved.first() {
        return Err(LineError::new(
            ErrorCode::Integrity,
            format!(
                "В папке mods найден лишний мод: {first}. Уберите его и повторите запуск."
            ),
            false,
        ));
    }
    Ok(())
}

fn check_live_mods_with(
    game: &Path,
    owned: &[String],
    mut prove: impl FnMut(&str) -> LineResult<bool>,
) -> LineResult<Vec<String>> {
    let dir = game.join("mods");
    match std::fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if owned.iter().any(|path| is_mod_jar(path)) {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    "Папка mods и необходимые моды отсутствуют. Восстановите сборку.",
                    false,
                ));
            }
            return Ok(Vec::new());
        }
        Err(error) => return Err(LineError::io(&error)),
        Ok(_) if !is_real_dir(&dir) => {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Папка mods не является обычным каталогом.",
                false,
            ))
        }
        Ok(_) => {}
    }
    let mut files = std::collections::BTreeSet::new();
    for path in owned.iter().filter(|path| is_mod_jar(path)) {
        let target = super::pack::checked_game_path(game, path, false)?;
        if !is_real_file(&target) {
            return Err(LineError::new(
                ErrorCode::Integrity,
                format!("Мод {path} отсутствует или заменён ссылкой. Восстановите сборку."),
                false,
            ));
        }
        files.insert(path.as_str());
    }
    // Files that are neither published nor proved derived. Reported, not acted on.
    let mut unproved: Vec<String> = Vec::new();
    let mut pending = vec![(dir, "mods".to_string())];
    let mut visited = 0usize;
    while let Some((directory, prefix)) = pending.pop() {
        for entry in std::fs::read_dir(directory).map_err(|e| LineError::io(&e))? {
            let entry = entry.map_err(|e| LineError::io(&e))?;
            visited += 1;
            if visited > super::source::MAX_FILES * 4 {
                return Err(LineError::input(
                    "В папке mods слишком много файлов или каталогов.",
                ));
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| LineError::input("Некорректное имя в папке mods."))?;
            let relative = format!("{prefix}/{name}");
            let kind = std::fs::symlink_metadata(entry.path())
                .map_err(|e| LineError::io(&e))?
                .file_type();
            if kind.is_dir() && is_real_dir(&entry.path()) {
                pending.push((entry.path(), relative));
            } else if kind.is_file() && is_real_file(&entry.path()) {
                if !is_mod_jar(&relative) || files.contains(relative.as_str()) || prove(&relative)?
                {
                    continue;
                }
                // Not proved: collect it. The caller decides whether to refuse
                // the launch or to offer the file to quarantine; the scan itself
                // never moves anything (see `quarantine.rs`).
                unproved.push(relative);
            } else {
                return Err(LineError::new(ErrorCode::Integrity,
                    format!("В папке mods найден посторонний файл или каталог: {relative}. Уберите его и повторите запуск."), false));
            }
        }
    }
    Ok(unproved)
}

/// Result of the resource-pack check. `blocked` is fatal; `foreign` alone is
/// reported and the player decides (see `docs/ANTICHEAT.md`).
pub struct PackScan {
    pub blocked: Option<String>,
    pub foreign: usize,
    /// Extra mod JARs whose provenance could not be proved. Fatal for the
    /// launch, and the exact list the quarantine command accepts — so the
    /// dialog offers what the scan actually found, not a guess.
    pub unproved: Vec<String>,
}

/// Checks mod composition, then resource-pack keywords in the live game.
/// Provider and player resource packs are treated identically; ownership alone
/// does not block a pack or turn it into a suspicious finding.
pub fn scan_packs(
    base: &Path,
    server: &super::config::Server,
    owned: &[String],
) -> LineResult<PackScan> {
    scan_packs_with(base, server, owned, |_| Ok(false))
}

/// The callback may admit only content proved against the current verified
/// release. Callers without that evidence keep the strict default.
pub fn scan_packs_with(
    base: &Path,
    server: &super::config::Server,
    owned: &[String],
    prove: impl FnMut(&str) -> LineResult<bool>,
) -> LineResult<PackScan> {
    let game = instance_game_dir(base)?;
    let unproved = check_live_mods_with(&game, owned, prove)?;
    let settings = server.anticheat.clone().unwrap_or_default();
    if !settings.scan_resourcepacks {
        // The mod composition check above is independent of this switch.
        return Ok(PackScan {
            blocked: None,
            foreign: 0,
            unproved: Vec::new(),
        });
    }
    let (findings, foreign) =
        super::resourcepack::scan_all(&game, owned, &settings.allow, &settings.extra_keywords)?;
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
    // An unproved mod blocks the launch before the resource-pack findings are
    // even relevant: the player has to decide about the file, not read a
    // keyword report. `blocked` carries the sentence, `unproved` the evidence.
    let blocked = if unproved.is_empty() {
        blocked
    } else {
        Some(format!(
            "В папке mods {} файл(ов) неизвестного происхождения: {}. Их можно убрать в карантин — файлы не удаляются, и их можно вернуть.",
            unproved.len(),
            summarize_paths(&unproved, 3)
        ))
    };
    Ok(PackScan {
        blocked,
        foreign: foreign.len(),
        unproved,
    })
}

/// First few paths, then a count. The dialog shows the whole list; this is the
/// sentence that has to stay readable in a toast and a log line.
fn summarize_paths(paths: &[String], limit: usize) -> String {
    let mut shown: Vec<&str> = paths.iter().take(limit).map(String::as_str).collect();
    let rest = paths.len().saturating_sub(shown.len());
    if rest > 0 {
        shown.push("…");
        return format!("{}, и ещё {rest}", shown.join(", "));
    }
    shown.join(", ")
}

/// What a quarantine batch actually did, for the dialog that asked for it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineOutcome {
    /// Files moved, in the order they were requested.
    pub moved: Vec<String>,
    /// Files refused, each with the launcher's own explanation.
    pub refused: Vec<String>,
}

/// Moves the *named* unproved mods into quarantine, on an explicit decision.
///
/// Why a separate command rather than an option on the launch: a launch is one
/// click and often a reflex. Moving files out of the game directory has to be
/// a second, deliberate action whose list the player has seen. The launch path
/// only reports `PackScan::unproved`; nothing moves until this is called.
///
/// The batch is re-validated here rather than trusted from the dialog. Between
/// the scan and the click, a release may have been reinstalled and a file the
/// player pointed at may now be part of it; `plan()` refuses published paths,
/// so a stale dialog cannot be used to move a provider's mod.
#[tauri::command]
pub async fn quarantine_mods(
    server_id: String,
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<QuarantineOutcome> {
    let (_, config) = state.fresh_config()?;
    let server = config.server(&server_id)?.clone();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server_id)?;
    let instance = base.clone();
    let moved = tauri::async_runtime::spawn_blocking(move || -> LineResult<QuarantineOutcome> {
        // The same lock the launch takes, so a quarantine cannot interleave with
        // an installation or another launch of this server.
        let _lock = InstallLock::acquire(&base)?;
        let game = instance_game_dir(&base)?;
        let published: std::collections::HashSet<String> =
            super::pack::owned_files(&base).into_iter().collect();
        let (accepted, refused) = super::quarantine::plan(&paths, &published);
        let mut done = Vec::new();
        let mut errors: Vec<String> = refused.iter().map(|e| e.message()).collect();
        let mut entries = Vec::new();
        for relative in accepted {
            match super::quarantine::quarantine_file(&base, &game, &relative) {
                Ok(entry) => {
                    done.push(entry.relative.clone());
                    entries.push(entry);
                }
                Err(error) => errors.push(error.message()),
            }
        }
        if !entries.is_empty() {
            let dir = base.join(super::quarantine::QUARANTINE_DIR);
            super::storage::create_private_dir(&dir)?;
            let manifest = dir.join(super::quarantine::QUARANTINE_MANIFEST);
            let previous =
                std::fs::read_to_string(&manifest).unwrap_or_default();
            let mut all = super::quarantine::parse_manifest(&previous);
            for entry in entries {
                if let Some(slot) = all.iter_mut().find(|e| e.relative == entry.relative) {
                    *slot = entry;
                } else {
                    all.push(entry);
                }
            }
            std::fs::write(&manifest, super::quarantine::render_manifest(&all))
                .map_err(|e| LineError::io(&e))?;
        }
        Ok(QuarantineOutcome {
            moved: done,
            refused: errors,
        })
    })
    .await
    .map_err(|_| LineError::storage())??;
    if !moved.moved.is_empty() {
        super::logger::info(
            super::logger::Area::Launch,
            "mods quarantined",
            &[super::logger::Field::num("moved", moved.moved.len() as u64)],
        );
    }
    Ok(moved)
}

/// Puts quarantined files back. Refuses to overwrite anything, so a player who
/// accepted the prompt by mistake loses nothing.
#[tauri::command]
pub async fn restore_quarantined(
    server_id: String,
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<QuarantineOutcome> {
    let (_, config) = state.fresh_config()?;
    // Validate the id even though it is not used beyond the directory lookup:
    // the command surface is the same shape as its siblings.
    config.server(&server_id)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server_id)?;
    let outcome = tauri::async_runtime::spawn_blocking(move || -> LineResult<QuarantineOutcome> {
        let _lock = InstallLock::acquire(&base)?;
        let game = instance_game_dir(&base)?;
        let manifest_path = base
            .join(super::quarantine::QUARANTINE_DIR)
            .join(super::quarantine::QUARANTINE_MANIFEST);
        let text = std::fs::read_to_string(&manifest_path).unwrap_or_default();
        let entries = super::quarantine::parse_manifest(&text);
        let wanted: std::collections::HashSet<&str> =
            paths.iter().map(String::as_str).collect();
        let mut restored = Vec::new();
        let mut errors = Vec::new();
        for entry in entries.iter().filter(|e| wanted.contains(e.relative.as_str())) {
            match super::quarantine::restore_file(&base, &game, entry) {
                Ok(()) => restored.push(entry.relative.clone()),
                Err(error) => errors.push(error.message()),
            }
        }
        // A path the player asked for that is not in the manifest is reported,
        // not silently ignored: it usually means the file was already restored.
        for path in &paths {
            if !entries.iter().any(|e| &e.relative == path) {
                errors.push(format!("Файл {path} не найден в карантине."));
            }
        }
        if !restored.is_empty() {
            let remaining: Vec<super::quarantine::MovedFile> = entries
                .into_iter()
                .filter(|e| !restored.contains(&e.relative))
                .collect();
            std::fs::write(&manifest_path, super::quarantine::render_manifest(&remaining))
                .map_err(|e| LineError::io(&e))?;
        }
        Ok(QuarantineOutcome {
            moved: restored,
            refused: errors,
        })
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(outcome)
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
        // Check mod composition and resource-pack keywords before starting Java.
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
        // The loader the pack declares. Absent means a bare classpath launch,
        // which is what every manifest written before 0.15.4 means: Fabric,
        // Quilt and vanilla-shaped packs are unaffected. The manifest validator
        // already rejected unknown names, so `parse_loader` cannot fail here
        // for a manifest that reached this point.
        let launch_loader = match resolved.manifest.loader.as_deref() {
            None => LoaderChoice::Fabric,
            Some(kind) => super::minecraft_core::parse_loader(kind)?,
        };
        let launch_module_path: Vec<PathBuf> = Vec::new();
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
            pack_memory_mb: resolved.manifest.recommended_memory_mb,
            loader: launch_loader,
            module_path: launch_module_path,
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
    /// Retained for API compatibility; ownership is not a resource-pack finding.
    pub foreign: Vec<String>,
    /// Extra mod JARs the launch would refuse, with the exact paths, so the
    /// check and the launch report the same thing and the dialog can offer
    /// them by name.
    #[serde(default)]
    pub unproved: Vec<String>,
}

/// A resource-pack check is meaningful only for a completed provider release.
fn require_pack_check_install(base: &Path, server_id: &str) -> LineResult<()> {
    if super::install::current_receipt(base, server_id).is_none() {
        return Err(LineError::input(
            "Сборка отсутствует или установлена не полностью. Сначала установите сборку.",
        ));
    }
    Ok(())
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
    // Both modes store the installed provider release under instances; Minecraft
    // keeps the writable game directory separately under minecraft/.
    let release_base = server_dir(&root, &server_id)?;
    let base = if server.launch_mode == super::config::LaunchMode::Minecraft {
        root.join("minecraft")
            .join(super::minecraft_core::validate_instance_id(&server_id)?)
    } else {
        release_base.clone()
    };
    tauri::async_runtime::spawn_blocking(move || -> LineResult<PackCheck> {
        require_pack_check_install(&release_base, &server_id)?;
        let owned = super::pack::owned_files(&base);
        let settings = server.anticheat.clone().unwrap_or_default();
        let game = instance_game_dir(&base)?;
        if !settings.scan_resourcepacks {
            return Ok(PackCheck {
                findings: Vec::new(),
                foreign: Vec::new(),
                unproved: check_live_mods_with(
                    &game,
                    &owned,
                    |_| Ok(false),
                )?,
            });
        }
        let (findings, foreign) = super::resourcepack::scan_all(
            &game,
            &owned,
            &settings.allow,
            &settings.extra_keywords,
        )?;
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
            unproved: check_live_mods_with(&game, &owned, |_| Ok(false))?,
        })
    })
    .await
    .map_err(|_| LineError::storage())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_owned_mods_are_accepted_but_foreign_content_is_blocked() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("mods/1.20.1/subdir");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("owned.jar"), b"mod").unwrap();
        let owned = vec!["mods/1.20.1/subdir/owned.jar".to_owned()];
        assert!(check_live_mods(temp.path(), &owned).is_ok());
        std::fs::write(nested.join("foreign.jar"), b"foreign").unwrap();
        assert!(check_live_mods(temp.path(), &owned).is_err());
        std::fs::remove_file(nested.join("foreign.jar")).unwrap();
        std::fs::create_dir(nested.join("foreign-dir")).unwrap();
        // Empty directories may remain after a pack update; they load nothing.
        assert!(check_live_mods(temp.path(), &owned).is_ok());
        std::fs::write(nested.join("foreign-dir/hidden.jar"), b"foreign").unwrap();
        assert!(check_live_mods(temp.path(), &owned).is_err());
    }

    #[test]
    fn mod_jar_scope_excludes_service_files_and_other_folders() {
        assert!(is_mod_jar("mods/a.jar"));
        assert!(is_mod_jar("mods/cache/a.JAR"));
        assert!(!is_mod_jar("mods/cache/settings.json"));
        assert!(!is_mod_jar("mods/a.jar.disabled"));
        assert!(!is_mod_jar("resourcepacks/a.jar"));
    }

    #[test]
    fn mods_check_missing_and_extra_jars_not_service_data_or_words() {
        let temp = tempfile::tempdir().unwrap();
        let mods = temp.path().join("mods");
        std::fs::create_dir(&mods).unwrap();
        std::fs::write(mods.join("xray-allowed.jar"), b"provider mod").unwrap();
        std::fs::write(mods.join("xray-settings.json"), b"xray").unwrap();
        let owned = vec![
            "mods/xray-allowed.jar".to_string(),
            "mods/missing-config.json".to_string(),
        ];
        assert!(check_live_mods(temp.path(), &owned).is_ok());
        std::fs::write(mods.join("unowned.JAR"), b"unknown").unwrap();
        assert!(check_live_mods(temp.path(), &owned).is_err());
        std::fs::remove_file(mods.join("unowned.JAR")).unwrap();
        std::fs::remove_file(mods.join("xray-allowed.jar")).unwrap();
        assert!(check_live_mods(temp.path(), &owned).is_err());
        std::fs::remove_dir_all(mods).unwrap();
        assert!(check_live_mods(temp.path(), &owned).is_err());
    }

    #[test]
    fn foreign_mods_need_explicit_proof_and_proof_does_not_cover_links() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("mods/.connector/temp");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("parent$child.jar"), b"nested").unwrap();
        assert!(check_live_mods(temp.path(), &[]).is_err());
        assert!(check_live_mods_with(temp.path(), &[], |name| Ok(
            name == "mods/.connector/temp/parent$child.jar"
        ))
        .is_ok());
        std::fs::write(cache.join("foreign.jar"), b"unknown").unwrap();
        assert!(check_live_mods_with(temp.path(), &[], |name| Ok(
            name == "mods/.connector/temp/parent$child.jar"
        ))
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn nested_mod_symlinks_are_never_accepted() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("mods")).unwrap();
        symlink(temp.path(), temp.path().join("mods/nested")).unwrap();
        assert!(check_live_mods(temp.path(), &["mods/nested/file.jar".into()]).is_err());
    }

    #[test]
    fn pack_check_requires_a_complete_installed_release() {
        let temp = tempfile::tempdir().unwrap();
        assert!(require_pack_check_install(temp.path(), "demo").is_err());
        let receipt = super::super::install::InstallReceipt {
            server_id: "demo".into(),
            version: "1".into(),
            sha256: "a".repeat(64),
            installed_at: 1,
            already_installed: false,
        };
        std::fs::write(
            temp.path().join("current.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(require_pack_check_install(temp.path(), "demo").is_err());
        let release = temp.path().join("releases").join("a".repeat(64));
        std::fs::create_dir_all(&release).unwrap();
        std::fs::write(release.join(".line-complete"), b"line-release-v1\n").unwrap();
        assert!(require_pack_check_install(temp.path(), "demo").is_ok());
        assert!(require_pack_check_install(temp.path(), "other").is_err());
    }

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
            pack_memory_mb: None,
            loader: LoaderChoice::Fabric,
            module_path: Vec::new(),
        }
    }

    #[test]
    fn fabric_command_carries_no_module_flags() {
        // The historical behaviour, kept bit for bit: a classpath loader must
        // not start receiving module-system flags just because Forge gained
        // them. A stray `--add-opens` on a Fabric pack is a launch failure that
        // looks like a mod bug.
        let args = build_java_command(&spec()).unwrap();
        for flag in ["--add-opens", "--add-exports", "--add-modules", "-p"] {
            assert!(
                !args.iter().any(|arg| arg == flag),
                "Fabric launch must not contain {flag}"
            );
        }
        assert!(!args.iter().any(|a| a.starts_with("-DlegacyClassPath=")));
    }

    #[test]
    fn forge_command_gets_the_module_flags_the_manifest_cannot_carry() {
        // The whole point of 0.15.4: Forge/NeoForge finally launch. The flags
        // come from the launcher, not from the pack, so this is also the test
        // that the ban on manifest JVM args still holds.
        let mut forge = spec();
        forge.loader = LoaderChoice::Forge;
        let args = build_java_command(&forge).unwrap();
        assert!(args.iter().any(|arg| arg == "--add-opens"));
        assert!(args.iter().any(|arg| arg == "--add-exports"));
        assert!(args.iter().any(|arg| arg == "--add-modules"));
        assert!(
            args.iter().any(|a| a.starts_with("-DlegacyClassPath=")),
            "the loader re-reads the class path from this property"
        );
        // `-p` takes exactly one argument, and it comes before `-cp`.
        let cp = args.iter().position(|a| a == "-cp").unwrap();
        assert!(!args[..cp].iter().filter(|a| *a == "-p").count().gt(&1));
        // Nothing that could load code before the game's entry point.
        for arg in &args {
            let lower = arg.to_ascii_lowercase();
            assert!(!lower.starts_with("-javaagent"), "{arg}");
            assert!(!lower.starts_with("-agentlib"), "{arg}");
            assert!(!lower.starts_with("-agentpath"), "{arg}");
        }
    }

    #[test]
    fn neoforge_takes_the_same_family_flags_as_forge() {
        let mut neo = spec();
        neo.loader = LoaderChoice::NeoForge;
        let neo_args = build_java_command(&neo).unwrap();
        let mut forge = spec();
        forge.loader = LoaderChoice::Forge;
        let forge_args = build_java_command(&forge).unwrap();
        // Same family, same flags: the difference between the two loaders is
        // which jar the provider shipped, not which JVM options it needs.
        let flags = |args: &[String]| {
            args.iter()
                .filter(|a| a.starts_with("--add-") || a.starts_with("-DlegacyClassPath"))
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(flags(&neo_args), flags(&forge_args));
    }

    #[test]
    fn module_path_is_passed_as_one_argument() {
        let mut forge = spec();
        forge.loader = LoaderChoice::Forge;
        forge.module_path = vec![abs("libraries/a.jar"), abs("libraries/b.jar")];
        let args = build_java_command(&forge).unwrap();
        let index = args.iter().position(|a| a == "-p").unwrap();
        // The value right after `-p` lists both entries and is a single token.
        assert!(args[index + 1].contains("a.jar"));
        assert!(args[index + 1].contains("b.jar"));
        // One token, or the JVM reads the second jar as a main class.
        assert_eq!(args.iter().filter(|a| *a == "-p").count(), 1);
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
        // The initial heap grows into the maximum instead of committing it at
        // process start (see `initial_heap_mb`).
        assert!(args.contains(&"-Xms2048M".to_owned()));
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
    fn pack_budget_is_honoured_within_what_the_machine_can_spare() {
        const GIB: u64 = 1024 * 1024 * 1024;
        // A pack that declares nothing keeps the historical automatic figure,
        // so turning this feature on changes nothing for existing packs.
        assert_eq!(pack_heap_mb(None, 16 * GIB), optimal_heap_mb(16 * GIB));
        // A declared budget within the ceiling is honoured, rounded down to a
        // whole 256 MiB so the slider and `-Xmx` show the same number.
        assert_eq!(pack_heap_mb(Some(6144), 32 * GIB), 6144);
        assert_eq!(pack_heap_mb(Some(6000), 32 * GIB), 5888);
        // The machine wins: 12 GiB on an 8 GiB laptop would make the launcher
        // compete with Windows for RAM during boot, which is the failure this
        // cap exists to prevent.
        assert_eq!(pack_heap_mb(Some(12_288), 8 * GIB), heap_ceiling(8 * GIB));
        // Nothing starts below the floor, so a pack asking for 512 MiB gets the
        // minimum instead of a JVM that dies before the first chunk.
        assert_eq!(pack_heap_mb(Some(512), 16 * GIB), MIN_HEAP_MB);
        // Absurd input cannot escape the ceiling either.
        assert_eq!(pack_heap_mb(Some(u32::MAX), 16 * GIB), heap_ceiling(16 * GIB));
    }

    #[test]
    fn a_player_chosen_heap_beats_the_pack_budget() {
        let mut s = spec();
        s.total_memory_bytes = 32 * 1024 * 1024 * 1024;
        s.pack_memory_mb = Some(2048);
        s.heap_mb = None;
        // The pack asked for 2 GiB and nothing else was chosen, so it gets 2.
        let automatic = build_java_command(&s).unwrap();
        assert!(automatic.contains(&"-Xmx2048M".to_string()));
        // The player chose 6 GiB: the setting is theirs, the pack only fills in.
        s.heap_mb = Some(6144);
        let chosen = build_java_command(&s).unwrap();
        assert!(chosen.contains(&"-Xmx6144M".to_string()));
        assert!(!chosen.contains(&"-Xmx2048M".to_string()));
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
