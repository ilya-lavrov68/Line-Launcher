use super::config::{Distribution, Server, MAX_ZIP_ENTRIES};
use super::error::{ErrorCode, LineError, LineResult};
use super::state::{epoch_millis, LineState};
use super::storage::{
    atomic_write, create_private_dir, remove_dir_if_present, server_dir, sync_directory,
    InstallLock,
};
use super::{http, LAUNCHER_VERSION};
use reqwest::header::{HeaderMap, ACCEPT_ENCODING};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

pub const PROGRESS_EVENT: &str = "line://install-progress";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallPhase {
    Downloading,
    Verifying,
    Extracting,
    Committing,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub operation_id: String,
    pub server_id: String,
    pub phase: InstallPhase,
    pub percent: f64,
    pub received_bytes: u64,
    pub total_bytes: u64,
    pub extracted_bytes: u64,
    pub unpacked_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallReceipt {
    pub server_id: String,
    pub version: String,
    pub sha256: String,
    pub installed_at: u64,
    pub already_installed: bool,
}

#[derive(Clone)]
pub struct ProgressSink(Arc<dyn Fn(InstallProgress) + Send + Sync>);
impl ProgressSink {
    pub fn new(f: impl Fn(InstallProgress) + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }
    pub fn emit(&self, p: InstallProgress) {
        (self.0)(p);
    }
}

/// True when a normalized path is both a file and a directory, or when a file is
/// an ancestor of another entry. Keys use `\\` separators and are lowercased.
/// Evaluated after the whole scan so the verdict is independent of entry order.
fn has_path_conflict(
    file_paths: &std::collections::HashSet<String>,
    directory_paths: &std::collections::HashSet<String>,
) -> bool {
    if file_paths.iter().any(|file| directory_paths.contains(file)) {
        return true;
    }
    for file in file_paths {
        let parts: Vec<&str> = file.split('\\').collect();
        for depth in 1..parts.len() {
            if file_paths.contains(&parts[..depth].join("\\")) {
                return true;
            }
        }
    }
    false
}

fn check_cancelled(cancel: &AtomicBool) -> LineResult<()> {
    if cancel.load(Ordering::Acquire) {
        Err(LineError::new(
            ErrorCode::Cancelled,
            "Установка отменена.",
            false,
        ))
    } else {
        Ok(())
    }
}

fn zip_error(_: impl std::fmt::Display) -> LineError {
    // Zip errors can include entry names; do not expose local or provider paths.
    LineError::new(
        ErrorCode::Integrity,
        "Повреждённый или неподдерживаемый ZIP-архив.",
        false,
    )
}

/// Reject traversal, absolute paths, Windows ADS/drive prefixes, alternate path
/// separators and device names on EVERY platform. enclosed_name alone is not
/// sufficient: it allows internal `..` and is platform-dependent.
pub fn safe_entry_path(raw: &str) -> LineResult<PathBuf> {
    let invalid = || {
        LineError::new(
            ErrorCode::UnsafeArchive,
            "Архив содержит небезопасный путь.",
            false,
        )
    };
    if raw.is_empty()
        || raw.len() > 1024
        || raw.contains('\\')
        || raw.contains(':')
        || raw.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let path = Path::new(raw);
    let mut depth = 0usize;
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err(invalid());
        };
        let Some(name) = name.to_str() else {
            return Err(invalid());
        };
        if name.is_empty() || name.ends_with(['.', ' ']) || name.len() > 255 {
            return Err(invalid());
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            stem.as_str(),
            "con"
                | "prn"
                | "aux"
                | "nul"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
        ) {
            return Err(invalid());
        }
        depth += 1;
        if depth > 64 {
            return Err(invalid());
        }
    }
    if depth == 0 {
        return Err(invalid());
    }
    Ok(path.to_path_buf())
}

/// Synchronous CPU/disk work runs inside spawn_blocking, never on a UI worker.
/// No archive helper extracts symlinks. Actual bytes are counted independently
/// of central-directory claims to stop bombs and corrupt size metadata.
pub fn extract_verified_zip(
    archive_path: &Path,
    staging: &Path,
    // Optional: `None` means the provider did not pin a size, so the archive's
    // own central directory is the reference. Whatever it is, the launcher's
    // hard ceiling below still applies — a bare link must not remove the limit,
    // only the requirement to state the number.
    expected_unpacked: Option<u64>,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> LineResult<super::integrity::FileIndex> {
    create_private_dir(staging)?;
    let file = File::open(archive_path).map_err(|e| LineError::io(&e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(zip_error)?;
    if archive.is_empty() || archive.len() > MAX_ZIP_ENTRIES {
        return Err(LineError::new(
            ErrorCode::UnsafeArchive,
            "Превышен лимит количества файлов в архиве.",
            false,
        ));
    }
    if expected_unpacked.is_some_and(|bytes| {
        bytes == 0 || bytes > super::config::MAX_UNPACKED_BYTES
    }) {
        return Err(LineError::input("Некорректный распакованный размер."));
    }
    let mut names = std::collections::HashSet::new();
    let mut file_paths = std::collections::HashSet::new();
    let mut directory_paths = std::collections::HashSet::new();
    let mut declared_total = 0u64;
    for index in 0..archive.len() {
        check_cancelled(cancel)?;
        let entry = archive.by_index_raw(index).map_err(zip_error)?;
        let relative = safe_entry_path(entry.name())?;
        // A pack must not be able to forge the integrity index or the marker.
        if super::integrity::is_reserved(entry.name()) {
            return Err(LineError::new(
                ErrorCode::UnsafeArchive,
                "Архив содержит служебное имя файла лаунчера.",
                false,
            ));
        }
        if entry.is_symlink() || entry.encrypted() {
            return Err(LineError::new(
                ErrorCode::UnsafeArchive,
                "Ссылки и зашифрованные ZIP-записи запрещены.",
                false,
            ));
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170_000;
            if kind != 0 && kind != 0o100_000 && kind != 0o040_000 {
                return Err(LineError::new(
                    ErrorCode::UnsafeArchive,
                    "Архив содержит специальный файл.",
                    false,
                ));
            }
        }
        if !entry.is_dir() {
            if !matches!(
                entry.compression(),
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            ) {
                return Err(LineError::new(
                    ErrorCode::UnsafeArchive,
                    "Поддерживаются только ZIP-методы Stored и Deflate.",
                    false,
                ));
            }
            declared_total = declared_total.checked_add(entry.size()).ok_or_else(|| {
                LineError::new(
                    ErrorCode::UnsafeArchive,
                    "Некорректный распакованный размер.",
                    false,
                )
            })?;
            if declared_total > expected_unpacked.unwrap_or(super::config::MAX_UNPACKED_BYTES) {
                // Same class of failure as the equality check below: the archive
                // disagrees with the configured size. Structural attacks keep
                // UnsafeArchive; a size mismatch is Integrity.
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    "Распакованный размер превышает заявленный в конфигурации.",
                    false,
                ));
            }
        }
        // Case-insensitive uniqueness prevents cross-platform overwrite collisions.
        let normalized = relative.to_string_lossy().replace('/', "\\").to_lowercase();
        if !names.insert(normalized.clone()) {
            return Err(LineError::new(
                ErrorCode::UnsafeArchive,
                "Архив содержит повторяющиеся пути.",
                false,
            ));
        }
        if entry.is_dir() {
            directory_paths.insert(normalized);
        } else {
            file_paths.insert(normalized);
        }
    }
    // A path cannot be both a file and a directory, and a file cannot be an
    // ancestor of another entry. Check after the scan so the result does not
    // depend on entry order: "mods" then "mods/a.jar" must fail exactly like
    // "mods/a.jar" then "mods".
    let conflict = || {
        LineError::new(
            ErrorCode::UnsafeArchive,
            "Конфликт файла и каталога в ZIP.",
            false,
        )
    };
    if has_path_conflict(&file_paths, &directory_paths) {
        return Err(conflict());
    }
    if expected_unpacked.is_some_and(|bytes| declared_total != bytes) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Распакованный размер не совпадает с конфигурацией.",
            false,
        ));
    }
    let mut extracted = 0u64;
    let mut last_report = Instant::now();
    let mut buffer = vec![0u8; 128 * 1024];
    let mut indexed: Vec<super::integrity::FileEntry> = Vec::new();
    for index in 0..archive.len() {
        check_cancelled(cancel)?;
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        let relative = safe_entry_path(entry.name())?;
        let target = staging.join(&relative);
        if entry.is_dir() {
            create_private_dir(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            create_private_dir(parent)?;
        }
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| LineError::io(&e))?;
        let mut output = BufWriter::with_capacity(128 * 1024, output);
        let mut hasher = Sha256::new();
        let mut entry_size = 0u64;
        loop {
            check_cancelled(cancel)?;
            let count = entry.read(&mut buffer).map_err(zip_error)?;
            if count == 0 {
                break;
            }
            entry_size = entry_size.saturating_add(count as u64);
            extracted = extracted.saturating_add(count as u64);
            if extracted > expected_unpacked.unwrap_or(super::config::MAX_UNPACKED_BYTES)
                || entry_size > entry.size()
            {
                return Err(LineError::new(
                    ErrorCode::UnsafeArchive,
                    "Фактический размер ZIP-записи превышает лимит.",
                    false,
                ));
            }
            hasher.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|e| LineError::io(&e))?;
            if last_report.elapsed() >= Duration::from_millis(80) {
                progress(extracted);
                last_report = Instant::now();
            }
        }
        if entry_size != entry.size() {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Размер распакованного файла повреждён.",
                false,
            ));
        }
        output.flush().map_err(|e| LineError::io(&e))?;
        output.get_ref().sync_all().map_err(|e| LineError::io(&e))?;
        indexed.push(super::integrity::FileEntry {
            path: relative.to_string_lossy().replace('\\', "/"),
            sha256: format!("{:x}", hasher.finalize()),
            size: entry_size,
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = entry.unix_mode().is_some_and(|m| m & 0o111 != 0);
            let mode = if executable { 0o700 } else { 0o600 };
            fs::set_permissions(&target, fs::Permissions::from_mode(mode))
                .map_err(|e| LineError::io(&e))?;
        }
    }
    // Every entry was written above, so `extracted` is the archive's real size.
    // It is compared to the pinned value only when there is one; either way it
    // is the number the progress bar has been promising.
    if expected_unpacked.is_some_and(|bytes| extracted != bytes) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Распаковка завершена не полностью.",
            false,
        ));
    }
    progress(extracted);
    sync_directory(staging)?;
    let index = super::integrity::FileIndex {
        schema_version: super::integrity::INDEX_SCHEMA,
        files: indexed,
    };
    index.validate()?;
    Ok(index)
}

/// What a downloaded archive turned out to be.
///
/// The digest is the release's identity: it names the directory the build is
/// published into and is what a later install compares against. Measuring it
/// here, rather than requiring the provider to state it, is what makes a
/// one-line config possible — and it is strictly more trustworthy than a value
/// typed into a file, because it describes the bytes that actually arrived.
struct Downloaded {
    sha256: String,
}

async fn download_part(
    client: &reqwest::Client,
    distribution: &Distribution,
    part: &Path,
    cancel: &AtomicBool,
    report: impl Fn(u64),
) -> LineResult<Downloaded> {
    let mut response = http::success(
        http::get(
            client,
            &distribution.url,
            HeaderMap::from_iter([(
                ACCEPT_ENCODING,
                reqwest::header::HeaderValue::from_static("identity"),
            )]),
        )
        .await?,
    )?;
    // Only meaningful against a pinned size. With a bare link the length is
    // merely the server's claim; the stream itself is what gets measured below.
    if let Some(pinned) = distribution.size_bytes {
        if response.content_length().is_some_and(|size| size != pinned) {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Размер ответа не совпадает с конфигурацией.",
                false,
            ));
        }
    }
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|e| LineError::io(&e))?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_report = Instant::now();
    loop {
        check_cancelled(cancel)?;
        let chunk = tokio::time::timeout(Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| {
                LineError::new(
                    ErrorCode::Network,
                    "Загрузка остановилась: истёк таймаут ожидания данных.",
                    true,
                )
            })?
            .map_err(|e| LineError::network(&e))?;
        let Some(chunk) = chunk else {
            break;
        };
        received = received.checked_add(chunk.len() as u64).ok_or_else(|| {
            LineError::new(ErrorCode::Integrity, "Некорректный размер загрузки.", false)
        })?;
        // A pinned size is a hard ceiling; without one, the launcher's own
        // maximum still is. Never let an endless response fill the disk.
        if received
            > distribution
                .size_bytes
                .unwrap_or(super::config::MAX_ARCHIVE_BYTES)
        {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Загружено больше данных, чем заявлено.",
                false,
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| LineError::io(&e))?;
        hasher.update(&chunk);
        if last_report.elapsed() >= Duration::from_millis(80) {
            report(received);
            last_report = Instant::now();
        }
    }
    file.flush().await.map_err(|e| LineError::io(&e))?;
    file.sync_all().await.map_err(|e| LineError::io(&e))?;
    drop(file);
    check_cancelled(cancel)?;
    if distribution.size_bytes.is_some_and(|size| received != size) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Загрузка оборвалась до получения полного архива.",
            true,
        ));
    }
    report(received);
    let actual = format!("{:x}", hasher.finalize());
    // Public digest, not a secret; ordinary comparison is appropriate.
    // A pinned digest must match. When it is absent, the computed one becomes
    // the reference for this install and every later comparison of it.
    if let Some(expected) = &distribution.sha256 {
        if actual.as_bytes() != expected.as_bytes() {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "SHA-256 архива не совпадает. Установка заблокирована.",
                false,
            ));
        }
    }
    Ok(Downloaded { sha256: actual })
}

fn available_space(root: &Path, required: u64) -> LineResult<()> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let root = std::path::absolute(root).map_err(|e| LineError::io(&e))?;
    let disk = disks
        .iter()
        .filter(|d| root.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len());
    match disk {
        Some(d) if d.available_space() >= required => Ok(()),
        Some(_) => Err(LineError::new(
            ErrorCode::DiskSpace,
            "Недостаточно места для архива, распаковки и резервной копии.",
            false,
        )),
        None => Err(LineError::storage()),
    }
}

fn read_receipt(path: &Path) -> LineResult<InstallReceipt> {
    let bytes = fs::read(path).map_err(|e| LineError::io(&e))?;
    if bytes.len() > 4096 {
        return Err(LineError::storage());
    }
    serde_json::from_slice(&bytes).map_err(|_| LineError::storage())
}

pub fn current_receipt(base: &Path, server_id: &str) -> Option<InstallReceipt> {
    let receipt = read_receipt(&base.join("current.json")).ok()?;
    if receipt.server_id != server_id || !valid_release_sha(&receipt.sha256) {
        return None;
    }
    let releases = base.join("releases");
    let release = releases.join(&receipt.sha256);
    if !super::storage::is_real_dir(&releases)
        || !super::storage::is_real_dir(&release)
        || !super::storage::is_real_file(&release.join(".line-complete"))
    {
        return None;
    }
    Some(receipt)
}

fn valid_release_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Is this server already installed at its current build?
///
/// A pinned digest is definitive: the receipt must carry exactly it. With a
/// bare link there is nothing to compare against until the archive is fetched,
/// so the installed build stands on its version alone — the check that decides
/// whether a *new* archive is a different build happens when one is actually
/// downloaded, and it compares digests then. Treating "no pin" as "never
/// matches" would re-download a working install on every launch.
pub fn installed_receipt(base: &Path, server: &Server) -> Option<InstallReceipt> {
    let receipt = current_receipt(base, &server.id)?;
    if receipt.version != server.version {
        return None;
    }
    if let Some(pinned) = &server.distribution.sha256 {
        if &receipt.sha256 != pinned {
            return None;
        }
    }
    Some(receipt)
}

/// Remove only launcher-owned staging directories. Caller holds InstallLock.
pub fn cleanup_staging(base: &Path) -> LineResult<()> {
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(LineError::io(&e)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| LineError::io(&e))?;
        if entry.file_name().to_string_lossy().starts_with(".staging-") {
            remove_dir_if_present(&entry.path())?;
        }
    }
    Ok(())
}

/// Low-level reusable implementation, independent of Tauri for integration tests.
/// The caller supplies a config-derived destination, NOT an arbitrary IPC path.
///
/// `pack.json` is resolved here, before anything is downloaded. That file is how
/// a provider publishes a new build without touching `config.json`: it carries
/// the archive's digest and sizes, generated from the ZIP itself by
/// `npm run pack:manifest`. Until this call existed, that manifest was honoured
/// by the Minecraft mode only — a provider who configured it for a ZIP pack got
/// a silent no-op, which looked like the feature not working at all.
pub async fn download_and_extract(
    client: &reqwest::Client,
    server: &Server,
    base: &Path,
    operation_id: &str,
    cancel: Arc<AtomicBool>,
    sink: &ProgressSink,
) -> LineResult<InstallReceipt> {
    // Two shapes of build, one entry point. A `source` server resolves to a file
    // list; everything after the bytes are on disk — release directory, index,
    // marker, current.json, history — is shared, so launch, repair, rollback and
    // the anticheat scan do not need to know which one they are looking at.
    //
    // `pack.json` is not applied here: it describes an archive, and a source
    // server has none. Applying it would let a stale manifest override the pack
    // the provider just pointed `source` at.
    if !matches!(super::source::kind_of(server)?, super::source::SourceKind::Archive) {
        return super::source::install::install_source(
            client,
            server,
            base,
            operation_id,
            cancel,
            sink,
        )
        .await;
    }
    let server = super::pack::effective_server(client, server, base).await?;
    install_inner(client, &server, base, operation_id, cancel, sink, false).await
}

/// `repair` skips the "already installed" short circuit: the files on disk are
/// known to be wrong, so the archive must be fetched and unpacked again.
pub async fn repair(
    client: &reqwest::Client,
    server: &Server,
    base: &Path,
    operation_id: &str,
    cancel: Arc<AtomicBool>,
    sink: &ProgressSink,
) -> LineResult<InstallReceipt> {
    if !matches!(super::source::kind_of(server)?, super::source::SourceKind::Archive) {
        return super::source::install::install_source(client, server, base, operation_id, cancel, sink).await;
    }
    install_inner(client, server, base, operation_id, cancel, sink, true).await
}

async fn install_inner(
    client: &reqwest::Client,
    server: &Server,
    base: &Path,
    operation_id: &str,
    cancel: Arc<AtomicBool>,
    sink: &ProgressSink,
    repair: bool,
) -> LineResult<InstallReceipt> {
    server.distribution.validate_bounds()?;
    create_private_dir(base)?;
    let _lock = InstallLock::acquire(base)?;
    // A crash may leave staging behind. Never touch releases/current.json here.
    cleanup_staging(base)?;
    if !repair {
        if let Some(mut receipt) = installed_receipt(base, server) {
            // A crash can land between current.json and history/prune. Repair those
            // side effects on the next successful install command instead of leaving
            // history inconsistent forever.
            super::rollback::record_release(base, &receipt)?;
            super::rollback::prune_releases(base, &server.id, None)?;
            receipt.already_installed = true;
            return Ok(receipt);
        }
    }
    // With no pinned sizes there is nothing to reserve against up front, so the
    // check falls back to the free-space floor rather than skipping the test.
    // Everything that arrives is still bounded by MAX_ARCHIVE_BYTES while it
    // streams (see `download_part`), so this cannot be used to fill a disk.
    available_space(
        base,
        server
            .distribution
            .size_bytes
            .unwrap_or(0)
            .saturating_add(server.distribution.unpacked_size_bytes.unwrap_or(0))
            .saturating_add(64 * 1024 * 1024),
    )?;
    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    let content = staging.join("content");
    let part = staging.join("archive.zip.part");
    create_private_dir(&staging)?;
    let mut progress = InstallProgress {
        operation_id: operation_id.to_owned(),
        server_id: server.id.clone(),
        phase: InstallPhase::Downloading,
        percent: 0.0,
        received_bytes: 0,
        // A zero total is the honest value before the first byte arrives: the
        // UI treats it as "unknown" and shows the received count, instead of
        // dividing by a guess and showing a bar that lies.
        total_bytes: server.distribution.size_bytes.unwrap_or(0),
        extracted_bytes: 0,
        unpacked_bytes: server.distribution.unpacked_size_bytes.unwrap_or(0),
    };
    let result = async {
        let mut attempt = 0u8;
        let mut high_water = 0.0f64;
        // The downloaded archive's measurement leaves this loop, so the release
        // can be named after the bytes that actually arrived. With a pinned
        // digest the two are equal; without one this is the only identity.
        let downloaded_archive: Downloaded = loop {
            check_cancelled(cancel.as_ref())?;
            attempt += 1;
            let dl_progress = progress.clone();
            let dl_sink = sink.clone();
            let reported = Arc::new(std::sync::Mutex::new(high_water));
            let report_progress = reported.clone();
            let downloaded = download_part(
                client,
                &server.distribution,
                &part,
                &cancel,
                move |received| {
                    let mut p = dl_progress.clone();
                    p.received_bytes = received;
                    // A retry starts at byte zero, but the visible overall bar must
                    // never jump backwards. Bytes still describe the current attempt.
                    if let Ok(mut maximum) = report_progress.lock() {
                        // With no pinned size there is no honest percentage; the
                        // bar stays at the phase floor and the byte counter is
                        // what moves. Dividing by zero here would have published
                        // NaN to the UI, which draws as an empty bar.
                        if p.total_bytes > 0 {
                            *maximum =
                                maximum.max(received as f64 / p.total_bytes as f64 * 70.0);
                        }
                        p.percent = *maximum;
                    }
                    dl_sink.emit(p);
                },
            )
            .await;
            high_water = reported.lock().map(|value| *value).unwrap_or(high_water);
            match downloaded {
                Ok(measured) => break measured,
                Err(error) if error.retryable && attempt < 3 => {
                    tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                    // Restart from byte zero: no unsafe Range/ETag assumptions.
                }
                Err(error) => return Err(error),
            }
        };
        check_cancelled(cancel.as_ref())?;
        progress.phase = InstallPhase::Verifying;
        progress.percent = 70.0;
        sink.emit(progress.clone());
        let extract_path = part.clone();
        let extract_target = content.clone();
        let expected = server.distribution.unpacked_size_bytes;
        let shared = cancel.clone();
        let extract_progress = progress.clone();
        let extract_sink = sink.clone();
        let index = tauri::async_runtime::spawn_blocking(move || {
            extract_verified_zip(
                &extract_path,
                &extract_target,
                expected,
                &shared,
                move |bytes| {
                    let mut p = extract_progress.clone();
                    p.phase = InstallPhase::Extracting;
                    p.extracted_bytes = bytes;
                    if p.unpacked_bytes > 0 {
                        p.percent = 70.0 + bytes as f64 / p.unpacked_bytes as f64 * 29.0;
                    }
                    extract_sink.emit(p);
                },
            )
        })
        .await
        .map_err(|_| {
            LineError::new(
                ErrorCode::Internal,
                "Задача распаковки завершилась аварийно.",
                false,
            )
        })??;
        check_cancelled(cancel.as_ref())?;
        // A malformed optional launch manifest blocks publication, not just launch.
        super::launch_manifest::read_optional(&content)?;
        progress.phase = InstallPhase::Committing;
        progress.percent = 99.0;
        sink.emit(progress.clone());
        // The index is written before the marker: a release is never advertised
        // as complete without the list every later launch is checked against.
        super::integrity::write_index(&content, &index)?;
        atomic_write(
            &content.join(super::integrity::COMPLETE_MARKER),
            b"line-release-v1\n",
        )?;
        let releases = base.join("releases");
        create_private_dir(&releases)?;
        // The directory is named after the archive that was just verified, not
        // after a claim in the config. Those are the same string whenever the
        // provider pinned a digest; when they are not, the measured one is the
        // only one that describes what is on disk — and it is what every later
        // launch and rollback compares against.
        let release = releases.join(&downloaded_archive.sha256);
        remove_dir_if_present(&release)?;
        fs::rename(&content, &release).map_err(|e| LineError::io(&e))?;
        sync_directory(&releases)?;
        let receipt = InstallReceipt {
            server_id: server.id.clone(),
            version: server.version.clone(),
            sha256: downloaded_archive.sha256.clone(),
            installed_at: epoch_millis(),
            already_installed: false,
        };
        // Immutable release directories + atomic pointer avoid renaming a live
        // game directory (especially important on Windows). Failed publish keeps
        // current.json pointing to the previous complete release.
        let bytes = serde_json::to_vec(&receipt).map_err(|_| LineError::storage())?;
        atomic_write(&base.join("current.json"), &bytes)?;
        super::rollback::record_release(base, &receipt)?;
        // The command layer rejects install while a game is running. Low-level
        // callers still protect the current pointer and retention window.
        super::rollback::prune_releases(base, &server.id, None)?;
        Ok(receipt)
    }
    .await;
    if let Err(error) = remove_dir_if_present(&staging) {
        // Keep original failure, but never hide a cleanup failure on success.
        if result.is_ok() {
            return Err(error);
        }
    }
    match &result {
        Ok(_) => {
            progress.phase = InstallPhase::Completed;
            progress.percent = 100.0;
            progress.extracted_bytes = progress.unpacked_bytes;
            sink.emit(progress);
        }
        Err(error) => {
            progress.phase = if error.code == ErrorCode::Cancelled {
                InstallPhase::Cancelled
            } else {
                InstallPhase::Failed
            };
            sink.emit(progress);
        }
    }
    result
}

impl Distribution {
    /// Reject a record whose *pinned* fields are impossible.
    ///
    /// Nothing is required any more: a bare link is a complete distribution,
    /// because the archive is measured as it downloads. What a provider does
    /// state is still enforced — a zero epoch, an oversized archive or a
    /// malformed digest is a config bug, and failing here beats downloading
    /// four gigabytes to discover it.
    fn validate_bounds(&self) -> LineResult<()> {
        let bad_size = self
            .size_bytes
            .is_some_and(|bytes| bytes == 0 || bytes > super::config::MAX_ARCHIVE_BYTES);
        let bad_unpacked = self.unpacked_size_bytes.is_some_and(|bytes| {
            bytes == 0 || bytes > super::config::MAX_UNPACKED_BYTES
        });
        let bad_sha = self.sha256.as_ref().is_some_and(|sha| {
            sha.len() != 64
                || !sha
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        if bad_size || bad_unpacked || bad_sha {
            Err(LineError::input("Некорректные параметры дистрибутива."))
        } else {
            Ok(())
        }
    }
}

/// Tauri-facing command: no URL, token or destination path accepted from WebView.
#[tauri::command]
pub async fn download_and_extract_zip(
    server_id: String,
    operation_id: String,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<InstallReceipt> {
    if Uuid::parse_str(&operation_id).is_err() {
        return Err(LineError::input("Некорректный идентификатор операции."));
    }
    let (_, config) = state.fresh_config()?;
    config.validate(LAUNCHER_VERSION)?;
    let server = config.server(&server_id)?.clone();
    state.session()?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server_id)?;
    let cancel = state.begin_install(&server_id, &operation_id)?;
    let emitter = app.clone();
    let sink = ProgressSink::new(move |p| {
        let _ = emitter.emit(PROGRESS_EVENT, p);
    });
    let result =
        download_and_extract(&state.http, &server, &base, &operation_id, cancel, &sink).await;
    state.finish_install(&server_id, &operation_id);
    result
}

#[tauri::command]
pub async fn cancel_install(operation_id: String, state: State<'_, LineState>) -> LineResult<bool> {
    state.cancel(&operation_id)
}

#[tauri::command]
pub async fn get_installed_build(
    server_id: String,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<Option<InstallReceipt>> {
    let (_, config) = state.active_config()?;
    let server = config.server(&server_id)?.clone();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server_id)?;
    tauri::async_runtime::spawn_blocking(move || Ok(current_receipt(&base, &server.id)))
        .await
        .map_err(|_| LineError::storage())?
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
