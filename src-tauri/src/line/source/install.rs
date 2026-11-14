//! Installing a resolved file list as a release.
//!
//! The end state is deliberately the same as the archive path's: a directory
//! under `releases/` with a `FileIndex` and the completion marker, published by
//! the same `current.json` write. Everything downstream — `sync_game_dir`,
//! launch, repair, rollback, the anticheat scan — therefore works unchanged, and
//! there is no third notion of "installed" to keep in step.
//!
//! What differs is only how the bytes arrive: one archive versus a list. The
//! list is downloaded file by file, each verified before it is written into
//! staging, and the index is built from measured digests. A file whose digest
//! does not match stops the install and leaves `current.json` untouched.
use super::super::config::Server;
use super::super::error::{ErrorCode, LineError, LineResult};
use super::super::install::{self, InstallPhase, InstallProgress, ProgressSink};
use super::super::integrity::{FileEntry, FileIndex};
use super::super::state::epoch_millis;
use super::super::storage::{
    atomic_write, create_private_dir, remove_dir_if_present, sync_directory, InstallLock,
};
use super::super::{http, LAUNCHER_VERSION};
use super::resolve::HttpFetch;
use super::{ResolvedPack, SourceKind};
use reqwest::header::{HeaderMap, ACCEPT_ENCODING};
use sha2::{Digest, Sha256, Sha512};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How many files are fetched at once. Sequential downloads of a few hundred
/// mods are dominated by round trips; more than a handful just queues requests
/// behind each other at the CDN and makes cancellations slower to notice.
const PARALLEL_DOWNLOADS: usize = 4;

/// A digest the launcher may have to fill in after download.
///
/// A packwiz entry may state sha512 only, and a Modrinth index only ever states
/// sha512. The list is therefore not fully known until the bytes are here, and
/// this is what carries the difference: `sha256` is `None` exactly when the
/// source could not supply one before the download.
#[derive(Debug, Clone)]
pub struct PendingFile {
    pub path: String,
    pub url: String,
    /// `None` when only a sha512 is published.
    pub sha256: Option<String>,
    /// Present when the source published a sha512 instead.
    pub sha512: Option<String>,
    pub inline: Option<Arc<Vec<u8>>>,
    pub override_file: Option<super::OverrideFile>,
    /// `0` = not published.
    pub size: u64,
}

/// The list a source produced, ready to download.
#[derive(Debug, Clone, Default)]
pub struct PendingPack {
    pub revision: String,
    pub files: Vec<PendingFile>,
    pub minecraft_version: Option<String>,
    pub loader: Option<(super::super::minecraft_core::LoaderChoice, String)>,
}

impl PendingPack {
    /// Fills in sha256 from a verified sha512.
    ///
    /// Only called after the sha512 matched, so the sha256 written here
    /// describes the bytes the source vouched for, not merely the bytes served.
    pub fn settle(&mut self, index: usize, sha256: String) {
        if let Some(file) = self.files.get_mut(index) {
            file.sha256 = Some(sha256);
            file.sha512 = None;
        }
    }
}

/// Downloads one file, verifies it and returns its sha256.
///
/// The bytes go straight to `target`; if verification fails the file is removed,
/// so a partially written or wrong file can never be mistaken for a good one by
/// the extraction step that follows.
async fn fetch_one(
    client: &reqwest::Client,
    file: &PendingFile,
    target: &Path,
    cancel: &AtomicBool,
    budget: &AtomicU64,
    progress: &(dyn Fn(u64, u64) + Sync),
) -> LineResult<String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(LineError::new(
            ErrorCode::Cancelled,
            "Установка отменена.",
            false,
        ));
    }
    if let Some(bytes) = &file.inline {
        let sha256 = format!("{:x}", Sha256::digest(bytes.as_slice()));
        if bytes.len() as u64 > super::MAX_FILE_BYTES
            || (file.size > 0 && file.size != bytes.len() as u64)
            || file
                .sha256
                .as_ref()
                .is_some_and(|expected| !expected.eq_ignore_ascii_case(&sha256))
            || file.sha512.as_ref().is_some_and(|expected| {
                !format!("{:x}", Sha512::digest(bytes.as_slice())).eq_ignore_ascii_case(expected)
            })
        {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Встроенный файл сборки не совпадает с описанием.",
                false,
            ));
        }
        if budget
            .fetch_add(bytes.len() as u64, Ordering::Relaxed)
            .saturating_add(bytes.len() as u64)
            > super::super::config::MAX_UNPACKED_BYTES
        {
            return Err(LineError::input("Сборка превышает допустимый размер."));
        }
        if let Some(parent) = target.parent() {
            create_private_dir(parent)?;
        }
        tokio::fs::write(target, bytes.as_slice())
            .await
            .map_err(|e| LineError::io(&e))?;
        return Ok(sha256);
    }
    if let Some(source) = &file.override_file {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut input = tokio::fs::File::open(source.directory.path().join(&source.name))
            .await
            .map_err(|e| LineError::io(&e))?;
        if let Some(parent) = target.parent() {
            create_private_dir(parent)?;
        }
        let mut output = tokio::fs::File::create(target)
            .await
            .map_err(|e| LineError::io(&e))?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut bytes = [0u8; 64 * 1024];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(LineError::new(
                    ErrorCode::Cancelled,
                    "Установка отменена.",
                    false,
                ));
            }
            let count = input
                .read(&mut bytes)
                .await
                .map_err(|e| LineError::io(&e))?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > file.size
                || total > super::MAX_FILE_BYTES
                || budget
                    .fetch_add(count as u64, Ordering::Relaxed)
                    .saturating_add(count as u64)
                    > super::super::config::MAX_UNPACKED_BYTES
            {
                return Err(LineError::input(
                    "Размер файла overrides превышает допустимый.",
                ));
            }
            output
                .write_all(&bytes[..count])
                .await
                .map_err(|e| LineError::io(&e))?;
            hasher.update(&bytes[..count]);
        }
        let digest = format!("{:x}", hasher.finalize());
        if total != file.size
            || file
                .sha256
                .as_ref()
                .is_none_or(|expected| !expected.eq_ignore_ascii_case(&digest))
        {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Файл overrides не совпадает с проверенным содержимым.",
                false,
            ));
        }
        output.flush().await.map_err(|e| LineError::io(&e))?;
        return Ok(digest);
    }
    let response = http::get(
        client,
        &file.url,
        HeaderMap::from_iter([(
            ACCEPT_ENCODING,
            reqwest::header::HeaderValue::from_static("identity"),
        )]),
    )
    .await?;
    let mut response = http::success(response)?;
    if file.size > 0
        && response
            .content_length()
            .is_some_and(|len| len != file.size)
    {
        return Err(LineError::new(
            ErrorCode::Integrity,
            format!("Размер {} не совпадает с заявленным в сборке.", file.path),
            false,
        ));
    }
    if let Some(parent) = target.parent() {
        create_private_dir(parent)?;
    }
    let mut handle = tokio::fs::File::create(target)
        .await
        .map_err(|e| LineError::io(&e))?;
    let mut hasher256 = Sha256::new();
    let mut hasher512 = Sha512::new();
    let mut received = 0u64;
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(target).await;
            return Err(LineError::new(
                ErrorCode::Cancelled,
                "Установка отменена.",
                false,
            ));
        }
        let chunk = tokio::time::timeout(Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| {
                LineError::new(
                    ErrorCode::Network,
                    format!("Загрузка {} остановилась: истёк таймаут.", file.path),
                    true,
                )
            })?
            .map_err(|e| LineError::network(&e))?;
        let Some(chunk) = chunk else { break };
        received = received.saturating_add(chunk.len() as u64);
        if budget
            .fetch_add(chunk.len() as u64, Ordering::Relaxed)
            .saturating_add(chunk.len() as u64)
            > super::super::config::MAX_UNPACKED_BYTES
        {
            return Err(LineError::input("Сборка превышает допустимый размер."));
        }
        if received > super::MAX_FILE_BYTES || (file.size > 0 && received > file.size) {
            let _ = tokio::fs::remove_file(target).await;
            return Err(LineError::new(
                ErrorCode::Integrity,
                format!("{} больше, чем заявлено в сборке.", file.path),
                false,
            ));
        }
        tokio::io::AsyncWriteExt::write_all(&mut handle, &chunk)
            .await
            .map_err(|e| LineError::io(&e))?;
        hasher256.update(&chunk);
        hasher512.update(&chunk);
        if last.elapsed() >= Duration::from_millis(120) {
            progress(file.size, received);
            last = Instant::now();
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut handle)
        .await
        .map_err(|e| LineError::io(&e))?;
    drop(handle);
    if file.size > 0 && received != file.size {
        let _ = tokio::fs::remove_file(target).await;
        return Err(LineError::new(
            ErrorCode::Integrity,
            format!("Загрузка {} оборвалась.", file.path),
            true,
        ));
    }
    let sha256 = format!("{:x}", hasher256.finalize());
    if let Some(expected) = &file.sha512 {
        let actual = format!("{:x}", hasher512.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(target).await;
            return Err(LineError::new(
                ErrorCode::Integrity,
                format!(
                    "SHA-512 файла {} не совпадает с опубликованным. Установка остановлена.",
                    file.path
                ),
                false,
            ));
        }
    } else if let Some(expected) = &file.sha256 {
        if &sha256 != expected {
            let _ = tokio::fs::remove_file(target).await;
            return Err(LineError::new(
                ErrorCode::Integrity,
                format!(
                    "SHA-256 файла {} не совпадает с опубликованным. Установка остановлена.",
                    file.path
                ),
                false,
            ));
        }
    }
    progress(file.size, received);
    Ok(sha256)
}

/// Downloads a list into `staging` and returns the index that describes it.
pub async fn fetch_files(
    client: &reqwest::Client,
    pack_files: &mut PendingPack,
    staging: &Path,
    cancel: Arc<AtomicBool>,
    sink: &ProgressSink,
    base_progress: InstallProgress,
) -> LineResult<FileIndex> {
    // Reject aliases and file/directory conflicts before concurrent writers start.
    let mut paths = std::collections::BTreeSet::new();
    for file in &pack_files.files {
        install::safe_entry_path(&file.path)?;
        if file
            .path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
            || super::super::integrity::is_reserved(&file.path.to_ascii_lowercase())
            || !paths.insert(file.path.to_ascii_lowercase())
        {
            return Err(LineError::input(
                "Повторяющийся или некорректный путь файла сборки.",
            ));
        }
        if file.inline.is_none() && file.sha256.is_none() && file.sha512.is_none() {
            return Err(LineError::input("Для файла сборки не указан хеш."));
        }
    }
    for path in &paths {
        for (position, _) in path.match_indices('/') {
            if paths.contains(&path[..position]) {
                return Err(LineError::input("Пути файлов сборки конфликтуют."));
            }
        }
    }
    if paths.is_empty() || paths.len() > super::MAX_FILES {
        return Err(LineError::input(
            "Список файлов сборки пуст или слишком велик.",
        ));
    }
    let total = pack_files.files.len() as u64;
    let budget = Arc::new(AtomicU64::new(0));
    let mut done = 0u64;
    let mut index = FileIndex {
        schema_version: super::super::integrity::INDEX_SCHEMA,
        files: Vec::with_capacity(pack_files.files.len()),
    };
    let concurrency = PARALLEL_DOWNLOADS.max(1);
    let mut next = 0usize;
    let mut initial = base_progress.clone();
    initial.files_done = Some(0);
    initial.files_total = Some(total);
    initial.received_bytes = 0;
    initial.total_bytes = 0;
    sink.emit(initial);

    while next < pack_files.files.len() {
        let batch_end = (next + concurrency).min(pack_files.files.len());
        let batch: Vec<(usize, PendingFile)> = (next..batch_end)
            .map(|position| (position, pack_files.files[position].clone()))
            .collect();
        let client_ref = client.clone();
        let staging_ref = staging.to_path_buf();
        let cancel_ref = cancel.clone();
        let progress_template = base_progress.clone();
        let progress_sink = sink.clone();
        let batch_total = total;
        let mut tasks = Vec::new();
        for (position, file) in batch {
            let client = client_ref.clone();
            let root = staging_ref.clone();
            let cancel = cancel_ref.clone();
            let sink = progress_sink.clone();
            let template = progress_template.clone();
            let budget = budget.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                let target = root.join(
                    install::safe_entry_path(&file.path)
                        .map_err(|_| LineError::input("Некорректный путь файла в сборке."))?,
                );
                let progress = move |_total: u64, _received: u64| {
                    let mut update = template.clone();
                    update.phase = InstallPhase::Downloading;
                    // Concurrent per-file bytes are not a percentage of the pack;
                    // report completed files instead.
                    update.percent = if batch_total > 0 {
                        template.percent
                            + (done as f64 / batch_total as f64) * (60.0 - template.percent)
                    } else {
                        0.0
                    };
                    update.files_done = Some(done);
                    update.files_total = Some(batch_total);
                    // Bytes from concurrent files are not comparable to the pack total.
                    update.received_bytes = 0;
                    update.total_bytes = 0;
                    sink.emit(update);
                };
                let digest =
                    fetch_one(&client, &file, &target, &cancel, &budget, &progress).await?;
                Ok::<(usize, String), LineError>((position, digest))
            }));
        }
        // Await every spawned task even after a failure. Dropping a join handle
        // detaches it, allowing it to write into staging after cleanup starts.
        let mut batch_error = None;
        for task in tasks {
            match task.await {
                Ok(Ok((position, digest))) => {
                    if pack_files.files[position].sha256.is_none() {
                        pack_files.settle(position, digest.clone());
                    }
                    let file = &pack_files.files[position];
                    let size = std::fs::symlink_metadata(
                        staging.join(install::safe_entry_path(&file.path)?),
                    )
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                    let path = file.path.clone();
                    pack_files.files[position].size = size;
                    index.files.push(FileEntry {
                        path,
                        sha256: digest,
                        size,
                    });
                    done += 1;
                }
                Ok(Err(error)) => {
                    if batch_error.is_none() {
                        batch_error = Some(error);
                    }
                }
                Err(_) => {
                    if batch_error.is_none() {
                        batch_error = Some(LineError::new(
                            ErrorCode::Internal,
                            "Задача загрузки завершилась аварийно.",
                            false,
                        ));
                    }
                }
            }
        }
        if let Some(error) = batch_error {
            return Err(error);
        }
        next = batch_end;
        let mut update = base_progress.clone();
        update.phase = InstallPhase::Downloading;
        update.percent = if total > 0 {
            done as f64 / total as f64 * 60.0
        } else {
            60.0
        };
        update.files_done = Some(done);
        update.files_total = Some(total);
        update.received_bytes = 0;
        update.total_bytes = 0;
        if done % 32 == 0 || done == total {
            sink.emit(update);
        }
    }
    index
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(index)
}

/// Resolves a server's source into a pending list.
///
/// Archive servers keep using the ZIP pipeline and never reach this function:
/// a `ResolvedPack::default()` means "no source", not "an empty build".
pub async fn pending_for(
    client: &reqwest::Client,
    server: &Server,
    work_dir: &Path,
    cancel: Arc<AtomicBool>,
    sink: &ProgressSink,
    progress: &InstallProgress,
) -> LineResult<Option<(PendingPack, ResolvedPack)>> {
    let kind = super::kind_of(server)?;
    if matches!(kind, SourceKind::Archive) {
        return Ok(None);
    }
    let fetch = HttpFetch {
        client: Arc::new(client.clone()),
        cancel,
        work_dir: work_dir.to_path_buf(),
        sink: sink.clone(),
        progress: progress.clone(),
    };
    let resolved = super::resolve::resolve(&fetch, &kind).await?;
    let mut files = Vec::with_capacity(resolved.files.len());
    for file in &resolved.files {
        // Two cases, and the difference matters:
        //  - the source published sha256 (a packwiz entry with hash-format
        //    sha256): it is checked as the bytes arrive;
        //  - it published sha512 only: retain that digest for comparison with
        //    the downloaded bytes, then pin the verified bytes by sha256.
        // A file with neither cannot reach this point — both parsers refuse it.
        files.push(PendingFile {
            path: file.path.clone(),
            url: file.url.clone(),
            sha256: if file.sha256.is_empty() {
                None
            } else {
                Some(file.sha256.clone())
            },
            sha512: file.sha512.clone(),
            inline: file.inline.clone(),
            override_file: file.override_file.clone(),
            size: file.size,
        });
    }
    Ok(Some((
        PendingPack {
            revision: resolved.revision.clone(),
            files,
            minecraft_version: resolved.minecraft_version.clone(),
            loader: resolved.loader.clone(),
        },
        resolved,
    )))
}

/// Installs a source-backed server: resolve, download, verify, publish.
///
/// Reuses `InstallLock`, the staging convention and the release publication of
/// the archive path. What it does not do is call back into it: the archive path
/// downloads one ZIP, and pretending a file list is one would mean building a
/// ZIP just to unpack it again.
pub async fn install_source(
    client: &reqwest::Client,
    server: &Server,
    base: &Path,
    operation_id: &str,
    cancel: Arc<AtomicBool>,
    sink: &ProgressSink,
) -> LineResult<super::super::install::InstallReceipt> {
    create_private_dir(base)?;
    let _lock = InstallLock::acquire(base)?;
    install::cleanup_staging(base)?;
    // Resolve/download on every request: a mutable source may change without the
    // provider changing server.version. Repair must never reuse a damaged tree.
    let staging = base.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    let content = staging.join("content");
    create_private_dir(&content)?;
    let mut progress = InstallProgress {
        operation_id: operation_id.to_owned(),
        server_id: server.id.clone(),
        phase: InstallPhase::Downloading,
        percent: 0.0,
        received_bytes: 0,
        total_bytes: 0,
        extracted_bytes: 0,
        unpacked_bytes: 0,
        files_done: None,
        files_total: None,
    };
    let result = async {
        let Some((mut pending, _resolved)) =
            pending_for(client, server, &staging, cancel.clone(), sink, &progress).await?
        else {
            return Err(LineError::input(
                "У этого сервера нет источника сборки: используйте архив.",
            ));
        };
        progress.percent = 30.0;
        progress.total_bytes = pending.files.iter().map(|file| file.size).sum();
        progress.unpacked_bytes = progress.total_bytes;
        install::available_space(
            &staging,
            progress.total_bytes.saturating_add(64 * 1024 * 1024),
        )?;
        let mut index = fetch_files(
            client,
            &mut pending,
            &content,
            cancel.clone(),
            sink,
            progress.clone(),
        )
        .await?;
        progress.phase = InstallPhase::Committing;
        progress.percent = 99.0;
        sink.emit(progress.clone());
        // The two files every other part of the launcher expects from a release,
        // built here rather than by extraction. Nothing about being list-backed
        // is visible after this point.
        // `inspect` needs a version profile; a packwiz/Modrinth list does not
        // always carry one. When it does not, the server's own config is the
        // only authority, and it is written as the minimal profile the launcher
        // reads — never guessed from folder names.
        ensure_version_profile(&content, &mut index, server, &pending)?;
        super::super::integrity::write_index(&content, &index)?;
        atomic_write(
            &content.join(super::super::integrity::COMPLETE_MARKER),
            b"line-release-v1\n",
        )?;
        if cancel.load(Ordering::SeqCst) {
            return Err(LineError::new(
                ErrorCode::Cancelled,
                "Установка отменена.",
                false,
            ));
        }
        // A source is resolved on every normal launch, but identical verified
        // content must keep its release ID: otherwise syncing a new ID would
        // overwrite pack-owned configuration after a test-world session.
        let prior_base = base.to_path_buf();
        let prior_server = server.clone();
        let prior_index = index.clone();
        let existing = tokio::task::spawn_blocking(move || {
            equivalent_current_release(&prior_base, &prior_server, &prior_index)
        })
        .await
        .map_err(|_| {
            LineError::new(
                ErrorCode::Internal,
                "Не удалось проверить прежнюю сборку.",
                false,
            )
        })?;
        if let Some(receipt) = existing {
            return Ok(receipt);
        }
        let releases = base.join("releases");
        create_private_dir(&releases)?;
        // Never remove an existing release before publishing: current.json can
        // still point to it if the process crashes during a repair/update.
        let release_sha = available_release_id(&releases, &index)?;
        let release = releases.join(&release_sha);
        std::fs::rename(&content, &release).map_err(|e| LineError::io(&e))?;
        sync_directory(&releases)?;
        let receipt = super::super::install::InstallReceipt {
            server_id: server.id.clone(),
            version: server.version.clone(),
            sha256: release_sha.clone(),
            installed_at: epoch_millis(),
            already_installed: false,
        };
        let bytes = serde_json::to_vec(&receipt).map_err(|_| LineError::storage())?;
        atomic_write(&base.join("current.json"), &bytes)?;
        super::super::rollback::record_release(base, &receipt)?;
        super::super::rollback::prune_releases(base, &server.id, None)?;
        Ok::<super::super::install::InstallReceipt, LineError>(receipt)
    }
    .await;
    if let Err(error) = remove_dir_if_present(&staging) {
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

/// The installed index includes generated profile metadata as well as downloads.
/// Hashing only the source files would give different loader profiles the same id.
fn revision_sha(index: &FileIndex) -> String {
    let mut ordered = index.files.clone();
    ordered.sort_by(|left, right| left.path.cmp(&right.path));
    let mut hasher = Sha256::new();
    for file in ordered {
        hasher.update(file.path.as_bytes());
        hasher.update([0u8]);
        hasher.update(file.sha256.as_bytes());
        hasher.update([0u8]);
        hasher.update(file.size.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

/// Reuse only the current, complete, independently scanned release with the
/// same server version and exact indexed content; a damaged tree is never reused.
fn equivalent_current_release(
    base: &Path,
    server: &Server,
    index: &FileIndex,
) -> Option<super::super::install::InstallReceipt> {
    let mut receipt = super::super::install::current_receipt(base, &server.id)?;
    if receipt.version != server.version {
        return None;
    }
    let release = base.join("releases").join(&receipt.sha256);
    let current = super::super::integrity::read_index(&release).ok()?;
    if revision_sha(&current) != revision_sha(index)
        || !super::super::integrity::scan(&release).ok()?.is_clean()
    {
        return None;
    }
    receipt.already_installed = true;
    Some(receipt)
}

/// Allocate a new immutable release when a content id is already occupied. The
/// old tree may be current or damaged: neither is safe to delete before commit.
fn available_release_id(releases: &Path, index: &FileIndex) -> LineResult<String> {
    let digest = revision_sha(index);
    for attempt in 0..8 {
        let candidate = if attempt == 0 {
            digest.clone()
        } else {
            format!(
                "{:x}",
                Sha256::digest(format!("{digest}-{}", uuid::Uuid::new_v4()).as_bytes())
            )
        };
        match std::fs::symlink_metadata(releases.join(&candidate)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(LineError::io(&error)),
            Ok(_) => continue,
        }
    }
    Err(LineError::storage())
}

/// Writes a minimal version profile when the pack does not ship one.
///
/// Not cosmetic: `pack::inspect` refuses an archive with no game directory, and
/// a packwiz pack of nothing but mods has no marker it would recognise. The
/// profile gives `inspect` a game root and the version it would otherwise have
/// to guess from a hint. The values are the server's own `minecraft_version` and
/// the loader the source declared, so nothing is invented.
fn ensure_version_profile(
    content: &Path,
    index: &mut FileIndex,
    server: &Server,
    pending: &PendingPack,
) -> LineResult<()> {
    // A pack that brings its own game directory keeps it: a provider who zipped
    // `versions/`, `libraries/` and `assets/` described their own loader, and
    // that beats anything the launcher could infer from a version string.
    let paths: Vec<String> = index.files.iter().map(|file| file.path.clone()).collect();
    if !super::super::instance::version_profile_ids(&paths, "").is_empty() {
        return Ok(());
    }

    let version = pending
        .minecraft_version
        .clone()
        .or_else(|| server.minecraft_version.clone());
    let Some(version) = version else {
        // No version means the pack cannot be launched from its own files. Say
        // so during install, when the provider can still fix the config, rather
        // than after a successful download when the player presses «Играть».
        return Err(LineError::input(
            "В сборке нет game-файлов, а сервер не указывает minecraft_version: лаунчер не знает, какую версию игры запускать. Добавьте minecraft_version серверу или опубликуйте полную сборку.",
        ));
    };
    // File lists are rooted at the game directory by definition (their paths are
    // `mods/…`, not `.minecraft/mods/…`), so there is no prefix to discover —
    // unlike an archive, whose layout is whatever the provider zipped.
    // The loader is expressed the way `inspect` reads it: a Maven coordinate in
    // `libraries`. Writing only the id (`fabric-loader-0.16.9-1.21.1`) would
    // look right and be read as "no loader", and the launch would then fetch a
    // vanilla profile for a pack full of mods.
    let (id, libraries) = match &pending.loader {
        Some((kind, loader_version)) => {
            let (name, group) = match kind {
                super::super::minecraft_core::LoaderChoice::Fabric => {
                    ("fabric-loader", "net.fabricmc")
                }
                super::super::minecraft_core::LoaderChoice::Quilt => {
                    ("quilt-loader", "org.quiltmc")
                }
                super::super::minecraft_core::LoaderChoice::Forge => {
                    ("forge", "net.minecraftforge")
                }
                super::super::minecraft_core::LoaderChoice::NeoForge => {
                    ("neoforge", "net.neoforged")
                }
            };
            (
                format!("{name}-{loader_version}-{version}"),
                vec![format!("{group}:{name}:{loader_version}")],
            )
        }
        None => (format!("line-vanilla-{version}"), Vec::new()),
    };
    super::super::minecraft_core::validate_version_id(&version)?;
    super::super::minecraft_core::validate_version_id(&id)?;
    let directory = content.join("versions").join(&id);
    let profile_path = directory.join(format!("{id}.json"));
    let profile_relative = format!("versions/{id}/{id}.json");
    if index
        .files
        .iter()
        .any(|file| file.path.eq_ignore_ascii_case(&profile_relative))
    {
        return Err(LineError::input(
            "Путь созданного профиля уже занят файлом сборки.",
        ));
    }
    match std::fs::symlink_metadata(&profile_path) {
        Ok(_) => {
            return Err(LineError::input(
                "Путь созданного профиля уже занят файлом сборки.",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(LineError::io(&error)),
    }
    create_private_dir(&directory)?;
    let profile = serde_json::json!({
        "id": id,
        "inheritsFrom": version,
        "type": "release",
        "libraries": libraries
            .into_iter()
            .map(|coordinate| serde_json::json!({ "name": coordinate }))
            .collect::<Vec<_>>(),
        "line": { "generated": true, "launcherVersion": LAUNCHER_VERSION },
    });
    let bytes = serde_json::to_vec(&profile).map_err(|_| LineError::storage())?;
    atomic_write(&profile_path, &bytes)?;
    index.files.push(FileEntry {
        path: profile_relative,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        size: bytes.len() as u64,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Explicit online acceptance check; never runs as part of ordinary cargo test.
    /// It downloads third-party data into an isolated temporary directory and
    /// validates the installed file index, but does not start Minecraft.
    #[tokio::test]
    #[ignore = "online: downloads BattleArmory and its files into a temporary directory"]
    async fn online_battlearmory_install_and_verify() {
        use std::sync::atomic::AtomicU64;
        use std::time::Duration;

        let temp = tempfile::Builder::new()
            .prefix("line-battlearmory-check-")
            .tempdir()
            .unwrap();
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "battlearmory-test", "name": "BattleArmory test",
            "description": "Isolated online installation check", "version": "1.3.1",
            "minecraft_version": "1.20.1",
            "source": {"kind": "modrinth", "project": "rQiXwLhB", "version": "TQIsQXtg"}
        }))
        .unwrap();
        let client = reqwest::Client::builder()
            .user_agent(concat!("LineLauncher/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let last_bytes = Arc::new(AtomicU64::new(0));
        let progress = ProgressSink::new(move |p| {
            let previous = last_bytes.load(Ordering::Relaxed);
            if p.received_bytes >= previous.saturating_add(32 * 1024 * 1024) {
                last_bytes.store(p.received_bytes, Ordering::Relaxed);
                eprintln!("Загрузка: {} байт из {}", p.received_bytes, p.total_bytes);
            }
        });
        eprintln!(
            "Проверка установки BattleArmory 1.3.1 во временный каталог; игра не запускается."
        );
        let receipt = install_source(
            &client,
            &server,
            temp.path(),
            "online-battlearmory-test",
            Arc::new(AtomicBool::new(false)),
            &progress,
        )
        .await
        .expect("Установка BattleArmory не завершилась");
        let current = super::super::super::install::current_receipt(temp.path(), &server.id)
            .expect("Нет опубликованной записи установки");
        assert_eq!(receipt.sha256, current.sha256);
        let release = temp.path().join("releases").join(&receipt.sha256);
        let index = super::super::super::integrity::read_index(&release)
            .expect("Не удалось прочитать индекс");
        assert!(!index.files.is_empty(), "Установлен пустой релиз");
        eprintln!(
            "Установлено файлов: {}. Проверяем все хеши на диске...",
            index.files.len()
        );
        let report =
            super::super::super::integrity::scan(&release).expect("Ошибка сканирования релиза");
        assert!(
            report.is_clean(),
            "Проверка файлов не прошла: отсутствует {}, изменено {}, лишних {}",
            report.missing.len(),
            report.changed.len(),
            report.foreign.len()
        );
        assert_eq!(report.checked, index.files.len());
        assert!(
            std::fs::read_dir(temp.path()).unwrap().all(|item| !item
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".staging-")),
            "Временный staging не очищен"
        );
        eprintln!("Установка и проверка хешей завершены. Minecraft и загрузчик не запускались.");
    }

    fn entry(path: &str, bytes: &[u8]) -> FileEntry {
        FileEntry {
            path: path.into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            size: bytes.len() as u64,
        }
    }

    #[test]
    fn identical_current_release_is_reused_only_when_intact() {
        let temp = tempfile::tempdir().unwrap();
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "demo", "name": "Demo", "description": "test", "version": "1"
        }))
        .unwrap();
        let digest = "a".repeat(64);
        let root = temp.path().join("releases").join(&digest);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("file.txt"), b"original").unwrap();
        let index = FileIndex {
            schema_version: super::super::super::integrity::INDEX_SCHEMA,
            files: vec![entry("file.txt", b"original")],
        };
        super::super::super::integrity::write_index(&root, &index).unwrap();
        std::fs::write(
            root.join(super::super::super::integrity::COMPLETE_MARKER),
            b"complete",
        )
        .unwrap();
        let receipt = super::super::super::install::InstallReceipt {
            server_id: server.id.clone(),
            version: server.version.clone(),
            sha256: digest,
            installed_at: 1,
            already_installed: false,
        };
        std::fs::write(
            temp.path().join("current.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert!(
            equivalent_current_release(temp.path(), &server, &index)
                .unwrap()
                .already_installed
        );
        std::fs::write(root.join("file.txt"), b"tampered").unwrap();
        assert!(equivalent_current_release(temp.path(), &server, &index).is_none());
    }

    #[test]
    fn release_identity_includes_generated_profile_and_never_replaces_existing_tree() {
        let temp = tempfile::tempdir().unwrap();
        let mut index = FileIndex {
            schema_version: super::super::super::integrity::INDEX_SCHEMA,
            files: vec![
                entry("mods/example.jar", b"mod"),
                entry("versions/profile.json", b"fabric"),
            ],
        };
        let first = available_release_id(temp.path(), &index).unwrap();
        let old = temp.path().join(&first);
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("keep"), b"old release").unwrap();
        let replacement = available_release_id(temp.path(), &index).unwrap();
        assert_ne!(first, replacement);
        assert_eq!(std::fs::read(old.join("keep")).unwrap(), b"old release");
        index.files[1] = entry("versions/profile.json", b"neoforge");
        assert_ne!(revision_sha(&index), first);
    }

    #[tokio::test]
    async fn embedded_files_are_verified_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("config.txt");
        let mut file = PendingFile {
            path: "config.txt".into(),
            url: String::new(),
            sha256: Some(format!("{:x}", Sha256::digest(b"valid"))),
            sha512: None,
            inline: Some(Arc::new(b"wrong".to_vec())),
            override_file: None,
            size: 5,
        };
        let client = reqwest::Client::new();
        let cancel = AtomicBool::new(false);
        let budget = AtomicU64::new(0);
        let progress = |_, _| {};
        let error = fetch_one(&client, &file, &target, &cancel, &budget, &progress)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Integrity);
        assert!(!target.exists());
        file.inline = Some(Arc::new(b"valid".to_vec()));
        let hash = fetch_one(&client, &file, &target, &cancel, &budget, &progress)
            .await
            .unwrap();
        assert_eq!(hash, file.sha256.unwrap());
        assert_eq!(std::fs::read(target).unwrap(), b"valid");
    }

    #[tokio::test]
    async fn disk_override_is_verified_again_before_publication() {
        let temp = tempfile::tempdir().unwrap();
        let directory = Arc::new(tempfile::tempdir().unwrap());
        std::fs::write(directory.path().join("entry"), b"bad!").unwrap();
        let file = PendingFile {
            path: "config.txt".into(),
            url: String::new(),
            sha256: Some(format!("{:x}", Sha256::digest(b"good"))),
            sha512: None,
            inline: None,
            override_file: Some(super::super::OverrideFile {
                directory,
                name: "entry".into(),
            }),
            size: 4,
        };
        let error = fetch_one(
            &reqwest::Client::new(),
            &file,
            &temp.path().join("file"),
            &AtomicBool::new(false),
            &AtomicU64::new(0),
            &|_, _| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Integrity);
    }

    fn progress_fixture() -> InstallProgress {
        InstallProgress {
            operation_id: "test".into(),
            server_id: "test".into(),
            phase: InstallPhase::Downloading,
            percent: 0.0,
            received_bytes: 0,
            total_bytes: 0,
            extracted_bytes: 0,
            unpacked_bytes: 0,
            files_done: None,
            files_total: None,
        }
    }

    fn inline_file(path: &str) -> PendingFile {
        PendingFile {
            path: path.into(),
            url: String::new(),
            sha256: Some(format!("{:x}", Sha256::digest(b"data"))),
            sha512: None,
            inline: Some(Arc::new(b"data".to_vec())),
            override_file: None,
            size: 4,
        }
    }

    #[tokio::test]
    async fn file_progress_counts_whole_stage_not_individual_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let mut pending = PendingPack {
            files: vec![inline_file("mods/a.jar"), inline_file("mods/b.jar")],
            ..Default::default()
        };
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = events.clone();
        let sink = ProgressSink::new(move |p| recorded.lock().unwrap().push(p));
        fetch_files(
            &reqwest::Client::new(),
            &mut pending,
            temp.path(),
            Arc::new(AtomicBool::new(false)),
            &sink,
            progress_fixture(),
        )
        .await
        .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.first().unwrap().files_done, Some(0));
        let last = events.last().unwrap();
        assert_eq!(last.files_done, Some(2));
        assert_eq!(last.files_total, Some(2));
        assert_eq!(last.total_bytes, 0);
    }

    #[tokio::test]
    async fn conflicting_paths_are_rejected_before_staging_writes() {
        let temp = tempfile::tempdir().unwrap();
        let mut pending = PendingPack {
            files: vec![inline_file("mods"), inline_file("mods/file.jar")],
            ..Default::default()
        };
        let result = fetch_files(
            &reqwest::Client::new(),
            &mut pending,
            temp.path(),
            Arc::new(AtomicBool::new(false)),
            &ProgressSink::new(|_| {}),
            progress_fixture(),
        )
        .await;
        assert!(result.is_err());
        assert!(std::fs::read_dir(temp.path()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn cancelled_batch_does_not_write_inline_files() {
        let temp = tempfile::tempdir().unwrap();
        let mut pending = PendingPack {
            files: vec![inline_file("mods/file.jar")],
            ..Default::default()
        };
        let error = fetch_files(
            &reqwest::Client::new(),
            &mut pending,
            temp.path(),
            Arc::new(AtomicBool::new(true)),
            &ProgressSink::new(|_| {}),
            progress_fixture(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(std::fs::read_dir(temp.path()).unwrap().next().is_none());
    }

    #[test]
    fn unrelated_versions_directory_does_not_suppress_generated_profile() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("versions/unrelated")).unwrap();
        let server: Server = serde_json::from_value(serde_json::json!({
            "id": "demo", "name": "Demo", "description": "test", "version": "1",
            "distribution": {"url": "https://example.com/pack.zip"},
            "minecraft_version": "1.20.1"
        }))
        .unwrap();
        let mut index = FileIndex {
            schema_version: super::super::super::integrity::INDEX_SCHEMA,
            files: vec![],
        };
        let pending = PendingPack::default();
        ensure_version_profile(temp.path(), &mut index, &server, &pending).unwrap();
        assert_eq!(index.files.len(), 1);
        assert!(temp.path().join(&index.files[0].path).is_file());
    }
}
