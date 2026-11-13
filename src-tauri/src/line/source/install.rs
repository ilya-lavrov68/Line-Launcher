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
        if budget.fetch_add(bytes.len() as u64, Ordering::Relaxed).saturating_add(bytes.len() as u64) > super::super::config::MAX_UNPACKED_BYTES {
            return Err(LineError::input("Сборка превышает допустимый размер."));
        }
        if let Some(parent) = target.parent() { create_private_dir(parent)?; }
        tokio::fs::write(target, bytes.as_slice()).await.map_err(|e| LineError::io(&e))?;
        return Ok(format!("{:x}", Sha256::digest(bytes.as_slice())));
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
    if file.size > 0 && response.content_length().is_some_and(|len| len != file.size) {
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
        if budget.fetch_add(chunk.len() as u64, Ordering::Relaxed).saturating_add(chunk.len() as u64) > super::super::config::MAX_UNPACKED_BYTES {
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
        if file.path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
            || super::super::integrity::is_reserved(&file.path.to_ascii_lowercase())
            || !paths.insert(file.path.to_ascii_lowercase()) {
            return Err(LineError::input("Повторяющийся или некорректный путь файла сборки."));
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
        return Err(LineError::input("Список файлов сборки пуст или слишком велик."));
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
                let progress = move |_total: u64, received: u64| {
                    let mut update = template.clone();
                    update.phase = InstallPhase::Downloading;
                    // Per-file bytes are not a percentage of the whole pack; what
                    // the user can see moving is the file count. The received
                    // count keeps the bar honest without pretending precision.
                    update.percent = if batch_total > 0 {
                        (done as f64 / batch_total as f64) * 60.0
                    } else {
                        0.0
                    };
                    update.received_bytes = received;
                    sink.emit(update);
                };
                let digest = fetch_one(&client, &file, &target, &cancel, &budget, &progress).await?;
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
                    let size = std::fs::symlink_metadata(staging.join(
                        install::safe_entry_path(&file.path)?,
                    ))
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                    let path = file.path.clone();
                    pack_files.files[position].size = size;
                    index.files.push(FileEntry { path, sha256: digest, size });
                    done += 1;
                }
                Ok(Err(error)) => {
                    if batch_error.is_none() { batch_error = Some(error); }
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
        if let Some(error) = batch_error { return Err(error); }
        next = batch_end;
        let mut update = base_progress.clone();
        update.phase = InstallPhase::Downloading;
        update.percent = if total > 0 {
            done as f64 / total as f64 * 60.0
        } else {
            60.0
        };
        sink.emit(update);
    }
    index.files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(index)
}

/// Resolves a server's source into a pending list.
///
/// Archive servers keep using the ZIP pipeline and never reach this function:
/// a `ResolvedPack::default()` means "no source", not "an empty build".
pub async fn pending_for(
    client: &reqwest::Client,
    server: &Server,
) -> LineResult<Option<(PendingPack, ResolvedPack)>> {
    let kind = super::kind_of(server)?;
    if matches!(kind, SourceKind::Archive) {
        return Ok(None);
    }
    let fetch = HttpFetch {
        client: Arc::new(client.clone()),
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
    let Some((pending, _resolved)) = pending_for(client, server).await? else {
        return Err(LineError::input(
            "У этого сервера нет источника сборки: используйте архив.",
        ));
    };
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
        total_bytes: pending.files.iter().map(|file| file.size).sum(),
        extracted_bytes: 0,
        unpacked_bytes: pending.files.iter().map(|file| file.size).sum(),
    };
    let result = async {
        let mut pending = pending;
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
        let release_sha = revision_sha(&pending);
        let releases = base.join("releases");
        create_private_dir(&releases)?;
        let release = releases.join(&release_sha);
        remove_dir_if_present(&release)?;
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

/// The release digest of a list: the same fold the resolver uses, so a re-resolve
/// of an unchanged pack names the same release directory.
fn revision_sha(pending: &PendingPack) -> String {
    let mut ordered: Vec<(String, String, u64)> = pending
        .files
        .iter()
        .map(|file| {
            (
                file.path.clone(),
                file.sha256.clone().unwrap_or_default(),
                file.size,
            )
        })
        .collect();
    ordered.sort();
    let mut hasher = Sha256::new();
    for (path, sha, size) in ordered {
        hasher.update(path.as_bytes());
        hasher.update([0u8]);
        hasher.update(sha.as_bytes());
        hasher.update([0u8]);
        hasher.update(size.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
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
    if super::super::instance::version_profile_ids(&paths, "").len() > 0 {
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
    let profiles = content.join("versions");
    if profiles.is_dir() {
        // The pack brought its own profile; it wins.
        return Ok(());
    }
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
                super::super::minecraft_core::LoaderChoice::Forge => ("forge", "net.minecraftforge"),
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
    atomic_write(&directory.join(format!("{id}.json")), &bytes)?;
    index.files.push(FileEntry {
        path: format!("versions/{id}/{id}.json"),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        size: bytes.len() as u64,
    });
    Ok(())
}
