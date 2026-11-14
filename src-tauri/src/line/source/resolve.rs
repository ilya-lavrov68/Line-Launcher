//! Turning a `source` into a `ResolvedPack`, over the network.
//!
//! Fetching is a small injectable trait: the resolution logic (which files, which
//! order, which checks) is tested against fixtures, and the HTTP client is the
//! launcher's existing one — same User-Agent, no proxy surprises, manual
//! redirects, HTTPS on every hop. Nothing here downloads a game file; it only
//! reads manifests and the `.mrpack` index.
use super::super::error::{ErrorCode, LineError, LineResult};
use super::super::http;
use super::{modrinth, packwiz, ResolvedPack, SourceKind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The launcher's HTTP client, handed in rather than created: one client per
/// process, with the same certificate and proxy policy as everything else.
pub type HttpClient = Arc<reqwest::Client>;

/// A future the trait can name without the `async-trait` crate.
pub type FetchFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = LineResult<Vec<u8>>> + Send + 'a>>;

pub type ArchiveFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = LineResult<(std::fs::File, String)>> + Send + 'a>,
>;

fn check_cancel(cancel: &AtomicBool) -> LineResult<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(LineError::new(
            ErrorCode::Cancelled,
            "Установка отменена.",
            false,
        ))
    } else {
        Ok(())
    }
}

/// What a resolver needs from the network. One method, so a test can implement it
/// with a map of URL → bytes and prove the rules without a server.
///
/// Hand-written boxed futures rather than `#[async_trait]`: adding a proc-macro
/// dependency to save ten lines is a bad trade in a launcher that vendors its
/// supply chain.
pub trait Fetch: Send + Sync {
    /// Bytes of a document that must be small (manifests, JSON).
    fn get<'a>(&'a self, url: &'a str, limit: usize) -> FetchFuture<'a>;
    // Default is only used by small in-memory test fixtures.
    fn archive<'a>(&'a self, url: &'a str, limit: usize) -> ArchiveFuture<'a> {
        Box::pin(async move {
            use sha2::{Digest, Sha512};
            use std::io::{Seek, Write};
            let bytes = self.get(url, limit).await?;
            let hash = format!("{:x}", Sha512::digest(&bytes));
            let mut file = tempfile::tempfile().map_err(|e| LineError::io(&e))?;
            file.write_all(&bytes).map_err(|e| LineError::io(&e))?;
            file.rewind().map_err(|e| LineError::io(&e))?;
            Ok((file, hash))
        })
    }
    fn extraction_reporter(&self) -> Option<Arc<dyn Fn(u64, u64) + Send + Sync>> {
        None
    }
    fn work_dir(&self) -> Option<&Path> {
        None
    }
    fn cancelled(&self) -> bool {
        false
    }
    fn cancel_flag(&self) -> Option<Arc<AtomicBool>> {
        None
    }
}

pub struct HttpFetch {
    pub client: HttpClient,
    pub cancel: Arc<AtomicBool>,
    pub work_dir: PathBuf,
    pub sink: super::super::install::ProgressSink,
    pub progress: super::super::install::InstallProgress,
}

impl Fetch for HttpFetch {
    fn extraction_reporter(&self) -> Option<Arc<dyn Fn(u64, u64) + Send + Sync>> {
        let sink = self.sink.clone();
        let template = self.progress.clone();
        Some(Arc::new(move |done, total| {
            let mut update = template.clone();
            update.phase = super::super::install::InstallPhase::Extracting;
            update.files_done = Some(done);
            update.files_total = Some(total);
            update.percent = if total > 0 {
                30.0 * done as f64 / total as f64
            } else {
                0.0
            };
            sink.emit(update);
        }))
    }
    fn get<'a>(&'a self, url: &'a str, limit: usize) -> FetchFuture<'a> {
        Box::pin(async move {
            let response = http::get(&self.client, url, Default::default()).await?;
            // A 404 on a manifest is a provider mistake with a specific fix, so
            // it gets its own wording instead of the generic HTTP error.
            if response.status().as_u16() == 404 {
                return Err(LineError::input(format!(
                    "Документ сборки не найден (404): {url}. Проверьте, что ссылка открывается в браузере без входа в аккаунт."
                )));
            }
            let mut response = http::success(response)?;
            http::read_limited(&mut response, limit).await
        })
    }
    fn archive<'a>(&'a self, url: &'a str, limit: usize) -> ArchiveFuture<'a> {
        Box::pin(async move {
            use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING};
            use sha2::{Digest, Sha512};
            use tokio::io::{AsyncSeekExt, AsyncWriteExt};
            check_cancel(&self.cancel)?;
            let mut response = http::success(
                http::get(
                    &self.client,
                    url,
                    HeaderMap::from_iter([(ACCEPT_ENCODING, HeaderValue::from_static("identity"))]),
                )
                .await?,
            )?;
            if response.content_length().is_some_and(|n| n > limit as u64) {
                return Err(LineError::input(
                    "Архив .mrpack превышает допустимый размер.",
                ));
            }
            let expected_size = response.content_length().unwrap_or(0);
            super::super::install::available_space(
                &self.work_dir,
                expected_size.saturating_add(64 * 1024 * 1024),
            )?;
            let tmp = tempfile::tempfile_in(&self.work_dir).map_err(|e| LineError::io(&e))?;
            let mut output = tokio::fs::File::from_std(tmp);
            let mut received = 0u64;
            let mut hasher = Sha512::new();
            let mut last_space_check = 0u64;
            let mut last_report = std::time::Instant::now();
            loop {
                check_cancel(&self.cancel)?;
                let read = response.chunk();
                tokio::pin!(read);
                let chunk = tokio::time::timeout(std::time::Duration::from_secs(60), async {
                    loop {
                        tokio::select! {
                            result = &mut read => break result.map_err(|e| LineError::network(&e)),
                            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => check_cancel(&self.cancel)?,
                        }
                    }
                }).await.map_err(|_| LineError::new(ErrorCode::Network, "Загрузка .mrpack остановилась: истёк таймаут ожидания данных.", true))??;
                let Some(chunk) = chunk else { break };
                super::super::download_limit::acquire(chunk.len(), &self.cancel).await?;
                received = received
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| LineError::input("Некорректный размер архива."))?;
                if received > limit as u64 {
                    return Err(LineError::input(
                        "Архив .mrpack превышает допустимый размер.",
                    ));
                }
                if received.saturating_sub(last_space_check) >= 64 * 1024 * 1024 {
                    super::super::install::available_space(&self.work_dir, 64 * 1024 * 1024)?;
                    last_space_check = received;
                }
                output
                    .write_all(&chunk)
                    .await
                    .map_err(|e| LineError::io(&e))?;
                hasher.update(&chunk);
                if last_report.elapsed() >= std::time::Duration::from_millis(120) {
                    let mut p = self.progress.clone();
                    p.received_bytes = received;
                    p.total_bytes = expected_size;
                    p.percent = if expected_size > 0 {
                        (received as f64 / expected_size as f64 * 30.0).min(30.0)
                    } else {
                        0.0
                    };
                    self.sink.emit(p);
                    last_report = std::time::Instant::now();
                }
            }
            if expected_size > 0 && expected_size != received {
                return Err(LineError::input("Загрузка .mrpack оборвалась."));
            }
            output.flush().await.map_err(|e| LineError::io(&e))?;
            output
                .seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(|e| LineError::io(&e))?;
            Ok((output.into_std().await, format!("{:x}", hasher.finalize())))
        })
    }
    fn work_dir(&self) -> Option<&Path> {
        Some(&self.work_dir)
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
    fn cancel_flag(&self) -> Option<Arc<AtomicBool>> {
        Some(self.cancel.clone())
    }
}

/// Resolves any source to a file list. The one entry point the installer uses.
pub async fn resolve(fetch: &dyn Fetch, kind: &SourceKind) -> LineResult<ResolvedPack> {
    match kind {
        SourceKind::Archive => Ok(ResolvedPack::default()),
        SourceKind::Packwiz { pack_toml_url } => resolve_packwiz(fetch, pack_toml_url).await,
        SourceKind::Modrinth { project, version } => {
            resolve_modrinth(fetch, project, version.as_deref()).await
        }
    }
}

/// Parent directory of a URL, so relative references resolve like they do in git.
fn parent_of(url: &str) -> LineResult<String> {
    let parsed = super::super::config::validate_https(url)?;
    let joined = parsed
        .join("./")
        .map_err(|_| LineError::input("Не удалось разобрать ссылку на сборку."))?;
    Ok(joined.as_str().to_owned())
}

/// A literal relative packwiz path cannot be a URL, a query or an encoded
/// traversal. The same path is used for network lookup and the installed file.
fn validate_packwiz_path(path: &str) -> LineResult<()> {
    super::super::install::safe_entry_path(path)?;
    if path.contains(['%', '?', '#'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(LineError::input("Некорректный относительный путь packwiz."));
    }
    Ok(())
}

/// Fetches a packwiz pack: `pack.toml` → `index.toml` (hash-checked) → each
/// listed `.pw.toml`.
pub async fn resolve_packwiz(fetch: &dyn Fetch, pack_toml_url: &str) -> LineResult<ResolvedPack> {
    let base = parent_of(pack_toml_url)?;
    let pack_bytes = fetch
        .get(pack_toml_url, packwiz::MAX_MANIFEST_BYTES)
        .await?;
    let pack = packwiz::parse_pack(&pack_bytes)?;

    // 1. The index the pack author wrote, identified by its own hash.
    if !packwiz::strong_hash(&pack.index.hash_format) {
        return Err(LineError::input(format!(
            "index.hash-format={} не поддерживается: нужен sha256 или sha512.",
            pack.index.hash_format
        )));
    }
    let expected_len = if pack.index.hash_format.eq_ignore_ascii_case("sha512") {
        128
    } else {
        64
    };
    if pack.index.hash.len() != expected_len
        || !pack.index.hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(LineError::input(format!(
            "index.hash в pack.toml не похож на {}: ожидаются {expected_len} шестнадцатеричных символов.",
            pack.index.hash_format
        )));
    }
    let index_path = pack.index.file.trim_start_matches("./");
    validate_packwiz_path(index_path)?;
    let index_url = super::super::config::validate_https(&format!("{base}{index_path}"))?
        .as_str()
        .to_owned();
    let index_bytes = fetch.get(&index_url, packwiz::MAX_INDEX_BYTES).await?;
    let actual = packwiz::digest(&pack.index.hash_format, &index_bytes);
    if !actual.eq_ignore_ascii_case(pack.index.hash.trim()) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "index.toml не совпадает с хешем в pack.toml: файл на сервере отличается от того, что опубликовал автор сборки. Установка остановлена.".to_owned(),
            false,
        ));
    }
    let index = packwiz::parse_index(&index_bytes)?;

    // Every index entry is authenticated by the index hash. Ordinary files are
    // downloaded by the installer; metadata is checked before parsing it.
    let format = index.hash_format.as_deref().unwrap_or("sha256");
    if !packwiz::strong_hash(format) {
        return Err(LineError::input("Неподдерживаемый формат хеша index.toml."));
    }
    let mut metafiles = Vec::new();
    let mut ordinary = Vec::new();
    for entry in &index.files {
        let path = entry.file.trim_start_matches("./");
        validate_packwiz_path(path)?;
        if super::super::integrity::is_reserved(&path.to_ascii_lowercase()) {
            return Err(LineError::input("Некорректный путь файла packwiz."));
        }
        let hash = entry
            .hash
            .as_deref()
            .ok_or_else(|| LineError::input("В index.toml отсутствует хеш файла."))?
            .to_ascii_lowercase();
        let expected_len = if format.eq_ignore_ascii_case("sha512") {
            128
        } else {
            64
        };
        if hash.len() != expected_len || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(LineError::input("Некорректный хеш файла в index.toml."));
        }
        let url = super::super::config::validate_https(&format!("{base}{path}"))?.to_string();
        if entry.metafile.unwrap_or(false) {
            let bytes = fetch.get(&url, packwiz::MAX_MANIFEST_BYTES).await?;
            if !packwiz::digest(format, &bytes).eq_ignore_ascii_case(&hash) {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    "Хеш метафайла packwiz не совпадает с index.toml.",
                    false,
                ));
            }
            metafiles.push((path.to_owned(), packwiz::parse_metafile(&bytes, path)?));
        } else {
            ordinary.push(super::PackFile {
                path: path.to_owned(),
                url,
                sha256: if format.eq_ignore_ascii_case("sha256") {
                    hash.clone()
                } else {
                    String::new()
                },
                sha512: if format.eq_ignore_ascii_case("sha512") {
                    Some(hash)
                } else {
                    None
                },
                inline: None,
                override_file: None,
                size: 0,
            });
        }
    }
    let mut resolved = packwiz::assemble(&pack, &index, metafiles)?;
    resolved.files.extend(ordinary);
    if resolved.files.len() > super::MAX_FILES {
        return Err(LineError::input("Сборка описывает слишком много файлов."));
    }
    Ok(resolved)
}

/// Resolves a Modrinth project to its `.mrpack`, then reads the index inside it.
pub async fn resolve_modrinth(
    fetch: &dyn Fetch,
    project: &str,
    version: Option<&str>,
) -> LineResult<ResolvedPack> {
    let url = modrinth::versions_url(project)?;
    let bytes = fetch.get(&url, 4 * 1024 * 1024).await?;
    let versions: Vec<modrinth::McVersion> = serde_json::from_slice(&bytes)
        .map_err(|_| LineError::input("Modrinth вернул неожиданный ответ вместо списка версий."))?;
    let picked = modrinth::pick_version(&versions, version)?.clone();
    let file = picked.pack_file()?.clone();
    let pack_url = super::super::config::validate_https(&file.url)?
        .as_str()
        .to_owned();
    let expected = file
        .hashes
        .get("sha512")
        .cloned()
        .ok_or_else(|| LineError::input("У .mrpack нет sha512: проверить его нечем."))?;
    // The authenticated archive is streamed to a private temporary file, not RAM.
    let (archive, actual_sha512) = fetch
        .archive(
            &pack_url,
            usize::try_from(super::super::config::MAX_ARCHIVE_BYTES).unwrap_or(usize::MAX),
        )
        .await?;
    if fetch.cancelled() {
        return Err(LineError::new(
            ErrorCode::Cancelled,
            "Установка отменена.",
            false,
        ));
    }
    if !actual_sha512.eq_ignore_ascii_case(&expected) {
        return Err(LineError::new(ErrorCode::Integrity, "Файл .mrpack не совпадает с sha512, указанным в версии Modrinth. Установка остановлена.", false));
    }
    let work_dir = fetch.work_dir().map(Path::to_path_buf);
    let cancel = fetch.cancel_flag();
    let report = fetch.extraction_reporter();
    let mut resolved = tokio::task::spawn_blocking(move || {
        let mut zip = zip::ZipArchive::new(archive)
            .map_err(|_| LineError::input(".mrpack не является ZIP-архивом."))?;
        let index_bytes = {
            let mut entry = zip
                .by_name("modrinth.index.json")
                .map_err(|_| LineError::input("В .mrpack нет modrinth.index.json."))?;
            if entry.size() > modrinth::MAX_INDEX_BYTES as u64 {
                return Err(LineError::input("modrinth.index.json слишком велик."));
            }
            let declared = entry.size();
            let mut buffer = Vec::with_capacity(declared as usize);
            std::io::Read::read_to_end(
                &mut std::io::Read::take(&mut entry, modrinth::MAX_INDEX_BYTES as u64 + 1),
                &mut buffer,
            )
            .map_err(|_| LineError::input("Не удалось прочитать modrinth.index.json."))?;
            if buffer.len() as u64 != declared || buffer.len() > modrinth::MAX_INDEX_BYTES {
                return Err(LineError::input("Некорректный размер modrinth.index.json."));
            }
            buffer
        };
        let index = modrinth::parse_index(&index_bytes)?;
        let mut resolved = modrinth::assemble(&index)?;
        apply_overrides(
            &mut zip,
            &mut resolved.files,
            work_dir.as_deref(),
            &|| {
                cancel
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::SeqCst))
            },
            &|done, total| {
                if let Some(report) = &report {
                    report(done, total);
                }
            },
        )?;
        Ok::<ResolvedPack, LineError>(resolved)
    })
    .await
    .map_err(|_| LineError::new(ErrorCode::Internal, "Не удалось обработать .mrpack.", false))??;
    // The version id, not the project name: two versions of one project must not
    // look like the same build to the installer.
    resolved.revision = format!(
        "{}-{}",
        picked.id,
        picked.version_number.unwrap_or_default()
    );
    Ok(resolved)
}

/// Overlay common overrides first, then client-overrides, as specified by mrpack.
/// The archive is authenticated first; bounded overrides are streamed to private
/// temporary files and verified again when copied into the release staging tree.
fn apply_overrides<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    files: &mut Vec<super::PackFile>,
    work_dir: Option<&Path>,
    cancelled: &dyn Fn() -> bool,
    report: &dyn Fn(u64, u64),
) -> LineResult<()> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let directory = Arc::new(
        match work_dir {
            Some(dir) => tempfile::tempdir_in(dir),
            None => tempfile::tempdir(),
        }
        .map_err(|e| LineError::io(&e))?,
    );
    if zip.len() > super::MAX_FILES + 1 {
        return Err(LineError::input("Слишком много записей в .mrpack."));
    }
    let mut total = 0u64;
    let mut file_total = 0u64;
    for i in 0..zip.len() {
        if cancelled() {
            return Err(LineError::new(
                ErrorCode::Cancelled,
                "Установка отменена.",
                false,
            ));
        }
        let entry = zip
            .by_index(i)
            .map_err(|_| LineError::input("Не удалось прочитать .mrpack."))?;
        if !entry.is_dir()
            && (entry.name().starts_with("overrides/")
                || entry.name().starts_with("client-overrides/"))
        {
            file_total += 1;
            if entry.size() > super::MAX_FILE_BYTES {
                return Err(LineError::input("Файл overrides слишком велик."));
            }
            total = total
                .checked_add(entry.size())
                .ok_or_else(|| LineError::input("Overrides слишком велики."))?;
            if total > super::super::config::MAX_UNPACKED_BYTES {
                return Err(LineError::input("Overrides превышают допустимый размер."));
            }
        }
    }
    if let Some(root) = work_dir {
        super::super::install::available_space(
            root,
            total.saturating_mul(2).saturating_add(64 * 1024 * 1024),
        )?;
    }
    total = 0;
    let mut file_done = 0u64;
    let mut present: std::collections::HashSet<String> =
        files.iter().map(|file| file.path.clone()).collect();
    report(0, file_total);
    for prefix in ["overrides/", "client-overrides/"] {
        let mut seen = std::collections::HashSet::new();
        for position in 0..zip.len() {
            if cancelled() {
                return Err(LineError::new(
                    ErrorCode::Cancelled,
                    "Установка отменена.",
                    false,
                ));
            }
            let mut entry = zip
                .by_index(position)
                .map_err(|_| LineError::input("Не удалось прочитать .mrpack."))?;
            if entry.is_dir() {
                continue;
            }
            let Some(path) = entry.name().strip_prefix(prefix).map(str::to_owned) else {
                continue;
            };
            super::super::install::safe_entry_path(&path)?;
            if super::super::integrity::is_reserved(&path)
                || !seen.insert(path.to_ascii_lowercase())
            {
                return Err(LineError::input(
                    "Повторяющийся или зарезервированный путь в overrides.",
                ));
            }
            // Symlinks and special ZIP entries are not files to install.
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
            {
                return Err(LineError::input("Недопустимый тип файла в overrides."));
            }
            total = total
                .checked_add(entry.size())
                .ok_or_else(|| LineError::input("Overrides слишком велики."))?;
            if total > super::super::config::MAX_UNPACKED_BYTES
                || entry.size() > super::MAX_FILE_BYTES
            {
                return Err(LineError::input("Overrides превышают допустимый размер."));
            }
            let declared = entry.size();
            let name = format!(
                "{}-{}",
                if prefix == "overrides/" { 0 } else { 1 },
                position
            );
            let mut output = std::fs::File::create(directory.path().join(&name))
                .map_err(|e| LineError::io(&e))?;
            let mut hasher = Sha256::new();
            let mut written = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if cancelled() {
                    return Err(LineError::new(
                        ErrorCode::Cancelled,
                        "Установка отменена.",
                        false,
                    ));
                }
                let count = entry
                    .read(&mut buffer)
                    .map_err(|_| LineError::input("Не удалось распаковать overrides."))?;
                if count == 0 {
                    break;
                }
                written += count as u64;
                if written > declared {
                    return Err(LineError::input("Некорректный размер файла overrides."));
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| LineError::io(&e))?;
                hasher.update(&buffer[..count]);
            }
            if written != declared {
                return Err(LineError::input("Некорректный размер файла overrides."));
            }
            let sha256 = format!("{:x}", hasher.finalize());
            if !present.insert(path.clone()) {
                files.retain(|file| file.path != path);
            }
            files.push(super::PackFile {
                path,
                url: String::new(),
                sha256,
                sha512: None,
                size: written,
                inline: None,
                override_file: Some(super::OverrideFile {
                    directory: directory.clone(),
                    name,
                }),
            });
            file_done += 1;
            if file_done % 32 == 0 || file_done == file_total {
                report(file_done, file_total);
            }
            if files.len() > super::MAX_FILES {
                return Err(LineError::input("Слишком много файлов в .mrpack."));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    struct FixtureFetch(std::collections::HashMap<String, Vec<u8>>);

    impl Fetch for FixtureFetch {
        fn get<'a>(&'a self, url: &'a str, limit: usize) -> FetchFuture<'a> {
            Box::pin(async move {
                let bytes = self
                    .0
                    .get(url)
                    .ok_or_else(|| LineError::input("Нет тестового файла."))?;
                if bytes.len() > limit {
                    return Err(LineError::input("Тестовый файл слишком велик."));
                }
                Ok(bytes.clone())
            })
        }
    }

    #[test]
    fn packwiz_relative_paths_cannot_change_url_meaning() {
        assert!(validate_packwiz_path("mods/example file.toml").is_ok());
        for path in [
            "../outside",
            "mods/%2e%2e/outside",
            "mods/a?x=1",
            "mods/a#fragment",
            "mods//a",
            "mods/./a",
        ] {
            assert!(validate_packwiz_path(path).is_err(), "{path}");
        }
    }

    #[tokio::test]
    async fn packwiz_resolves_hash_checked_index_and_metadata() {
        let metadata = format!(
            "name = \"Example\"\nfilename = \"example.jar\"\nside = \"client\"\n[download]\nurl = \"https://example.org/example.jar\"\nhash-format = \"sha256\"\nhash = \"{}\"\n",
            "a".repeat(64)
        );
        let index = format!(
            "hash-format = \"sha256\"\n[[files]]\nfile = \"mods/example.pw.toml\"\nmetafile = true\nhash = \"{}\"\n",
            packwiz::digest("sha256", metadata.as_bytes())
        );
        let pack = format!(
            "name = \"Fixture\"\npack-format = \"packwiz:1.1.0\"\n[index]\nfile = \"index.toml\"\nhash-format = \"sha256\"\nhash = \"{}\"\n[versions]\nminecraft = \"1.20.1\"\n",
            packwiz::digest("sha256", index.as_bytes())
        );
        let mut fetch = FixtureFetch(std::collections::HashMap::from([
            ("https://example.org/pack.toml".into(), pack.into_bytes()),
            ("https://example.org/index.toml".into(), index.into_bytes()),
            (
                "https://example.org/mods/example.pw.toml".into(),
                metadata.into_bytes(),
            ),
        ]));
        let result = resolve_packwiz(&fetch, "https://example.org/pack.toml")
            .await
            .unwrap();
        assert_eq!(result.minecraft_version.as_deref(), Some("1.20.1"));
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "mods/example.jar");
        assert_eq!(result.files[0].sha256, "a".repeat(64));
        fetch
            .0
            .get_mut("https://example.org/mods/example.pw.toml")
            .unwrap()
            .push(b' ');
        assert_eq!(
            resolve_packwiz(&fetch, "https://example.org/pack.toml")
                .await
                .unwrap_err()
                .code,
            ErrorCode::Integrity
        );
        fetch
            .0
            .get_mut("https://example.org/index.toml")
            .unwrap()
            .push(b' ');
        assert_eq!(
            resolve_packwiz(&fetch, "https://example.org/pack.toml")
                .await
                .unwrap_err()
                .code,
            ErrorCode::Integrity
        );
    }

    /// This fixture is also converted by the Node test. Both sides compare the
    /// real file paths, measured hashes and sizes with that converter manifest.
    #[tokio::test]
    async fn packwiz_resolver_and_installer_match_converter_fixture() {
        use crate::line::install::{InstallPhase, InstallProgress, ProgressSink};
        use crate::line::source::install::{fetch_files, PendingFile, PendingPack};
        use std::sync::atomic::AtomicBool;

        macro_rules! fixture {
            ($path:literal) => {
                include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../tests/fixtures/packwiz-parity/",
                    $path
                ))
                .to_vec()
            };
        }
        let fetch = FixtureFetch(std::collections::HashMap::from([
            (
                "https://example.test/pack.toml".into(),
                fixture!("pack.toml"),
            ),
            (
                "https://example.test/index.toml".into(),
                fixture!("index.toml"),
            ),
            (
                "https://example.test/mods/alpha.pw.toml".into(),
                fixture!("mods/alpha.pw.toml"),
            ),
            (
                "https://example.test/mods/beta.pw.toml".into(),
                fixture!("mods/beta.pw.toml"),
            ),
            (
                "https://example.test/mods/optional.pw.toml".into(),
                fixture!("mods/optional.pw.toml"),
            ),
            (
                "https://example.test/mods/server.pw.toml".into(),
                fixture!("mods/server.pw.toml"),
            ),
            (
                "https://example.test/resourcepacks/theme.pw.toml".into(),
                fixture!("resourcepacks/theme.pw.toml"),
            ),
            (
                "https://example.test/config/example.txt".into(),
                fixture!("config/example.txt"),
            ),
            (
                "https://files.example.test/alpha.jar".into(),
                fixture!("payloads/alpha.jar"),
            ),
            (
                "https://files.example.test/beta.jar".into(),
                fixture!("payloads/beta.jar"),
            ),
            (
                "https://files.example.test/theme.zip".into(),
                fixture!("payloads/theme.zip"),
            ),
        ]));
        let result = resolve_packwiz(&fetch, "https://example.test/pack.toml")
            .await
            .unwrap();
        assert_eq!(result.minecraft_version.as_deref(), Some("1.20.1"));
        assert!(
            matches!(result.loader, Some((crate::line::minecraft_core::LoaderChoice::Fabric, ref version)) if version == "0.15.11")
        );
        let files = result
            .files
            .iter()
            .map(|file| PendingFile {
                path: file.path.clone(),
                url: file.url.clone(),
                sha256: (!file.sha256.is_empty()).then(|| file.sha256.clone()),
                sha512: file.sha512.clone(),
                inline: Some(Arc::new(
                    fetch.0.get(&file.url).expect("fixture payload").clone(),
                )),
                size: file.size,
                override_file: None,
            })
            .collect();
        let mut pending = PendingPack {
            files,
            ..Default::default()
        };
        let temp = tempfile::tempdir().unwrap();
        let progress = InstallProgress {
            operation_id: "parity".into(),
            server_id: "fixture".into(),
            phase: InstallPhase::Downloading,
            percent: 0.0,
            received_bytes: 0,
            total_bytes: 0,
            extracted_bytes: 0,
            unpacked_bytes: 0,
            files_done: None,
            files_total: None,
        };
        let index = fetch_files(
            &reqwest::Client::new(),
            &mut pending,
            temp.path(),
            Arc::new(AtomicBool::new(false)),
            &ProgressSink::new(|_| {}),
            progress,
        )
        .await
        .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fixture!("expected.json")).unwrap();
        let expected: std::collections::BTreeMap<String, (String, u64)> = manifest["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                (
                    file["path"].as_str().unwrap().to_owned(),
                    (
                        file["sha256"].as_str().unwrap().to_owned(),
                        file["size_bytes"].as_u64().unwrap(),
                    ),
                )
            })
            .collect();
        let actual: std::collections::BTreeMap<String, (String, u64)> = index
            .files
            .iter()
            .map(|file| (file.path.clone(), (file.sha256.clone(), file.size)))
            .collect();
        assert_eq!(actual, expected);
        assert!(!actual.contains_key("mods/optional.jar"));
        assert!(!actual.contains_key("mods/server.jar"));
    }

    #[tokio::test]
    async fn modrinth_resolves_pinned_archive_and_rejects_tampering() {
        use sha2::{Digest, Sha512};
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("modrinth.index.json", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(br#"{"formatVersion":1,"game":"minecraft","dependencies":{"minecraft":"1.20.1","neoforge":"20.1.0"},"files":[]}"#).unwrap();
        writer
            .start_file(
                "client-overrides/config/example.txt",
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"client").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let digest = format!("{:x}", Sha512::digest(&bytes));
        let versions = serde_json::json!([{"id":"TQIsQXtg","version_type":"release","files":[{
            "filename":"BattleArmory.mrpack","url":"https://example.org/pack.mrpack",
            "hashes":{"sha512":digest},"primary":true
        }]}]);
        let mut fetch = FixtureFetch(std::collections::HashMap::from([
            (
                "https://api.modrinth.com/v2/project/rQiXwLhB/version".into(),
                serde_json::to_vec(&versions).unwrap(),
            ),
            ("https://example.org/pack.mrpack".into(), bytes),
        ]));
        let resolved = resolve_modrinth(&fetch, "rQiXwLhB", Some("TQIsQXtg"))
            .await
            .unwrap();
        assert_eq!(resolved.minecraft_version.as_deref(), Some("1.20.1"));
        assert!(matches!(
            resolved.loader.unwrap().0,
            super::super::super::minecraft_core::LoaderChoice::NeoForge
        ));
        assert_eq!(resolved.files[0].path, "config/example.txt");
        assert_eq!(
            std::fs::read(
                resolved.files[0]
                    .override_file
                    .as_ref()
                    .unwrap()
                    .directory
                    .path()
                    .join(&resolved.files[0].override_file.as_ref().unwrap().name)
            )
            .unwrap(),
            b"client"
        );
        fetch
            .0
            .get_mut("https://example.org/pack.mrpack")
            .unwrap()
            .push(0);
        assert_eq!(
            resolve_modrinth(&fetch, "rQiXwLhB", Some("TQIsQXtg"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Integrity
        );
    }

    fn archive(entries: &[(&str, &[u8])]) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        zip::ZipArchive::new(Cursor::new(writer.finish().unwrap().into_inner())).unwrap()
    }

    #[test]
    fn client_override_wins_and_is_hashed() {
        let mut zip = archive(&[
            ("client-overrides/config/test.txt", b"client"),
            ("overrides/config/test.txt", b"common"),
            ("server-overrides/config/server.txt", b"server"),
        ]);
        let mut files = vec![];
        let events = std::cell::RefCell::new(Vec::new());
        apply_overrides(&mut zip, &mut files, None, &|| false, &|done, total| {
            events.borrow_mut().push((done, total));
        })
        .unwrap();
        assert_eq!(*events.borrow(), vec![(0, 2), (2, 2)]);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "config/test.txt");
        assert_eq!(
            std::fs::read(
                files[0]
                    .override_file
                    .as_ref()
                    .unwrap()
                    .directory
                    .path()
                    .join(&files[0].override_file.as_ref().unwrap().name)
            )
            .unwrap(),
            b"client"
        );
        assert_eq!(files[0].size, 6);
        assert_eq!(files[0].sha256.len(), 64);
    }

    #[test]
    fn overrides_reject_unsafe_and_duplicate_paths() {
        for entries in [
            vec![("overrides/../outside", b"x".as_slice())],
            vec![("overrides/.line-complete", b"x".as_slice())],
            vec![
                ("overrides/config/A", b"x".as_slice()),
                ("overrides/config/a", b"y".as_slice()),
            ],
        ] {
            assert!(apply_overrides(
                &mut archive(&entries),
                &mut vec![],
                None,
                &|| false,
                &|_, _| {}
            )
            .is_err());
        }
    }
    #[test]
    fn large_overrides_are_disk_backed_and_cancel_cleans_workdir() {
        use std::io::{Seek, Write};
        let work = tempfile::tempdir().unwrap();
        let mut archive = tempfile::tempfile().unwrap();
        {
            let mut writer = zip::ZipWriter::new(&mut archive);
            writer
                .start_file(
                    "overrides/config/large.bin",
                    SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .unwrap();
            let block = vec![0u8; 1024 * 1024];
            for _ in 0..129 {
                writer.write_all(&block).unwrap();
            }
            writer.finish().unwrap();
        }
        archive.rewind().unwrap();
        let mut zip = zip::ZipArchive::new(archive).unwrap();
        let mut files = vec![];
        apply_overrides(
            &mut zip,
            &mut files,
            Some(work.path()),
            &|| false,
            &|_, _| {},
        )
        .unwrap();
        assert_eq!(files[0].size, 129 * 1024 * 1024);
        assert!(files[0].inline.is_none());
        let disk = files[0].override_file.as_ref().unwrap();
        assert_eq!(
            std::fs::metadata(disk.directory.path().join(&disk.name))
                .unwrap()
                .len(),
            files[0].size
        );
        drop(files);
        assert!(std::fs::read_dir(work.path()).unwrap().next().is_none());
        let error = apply_overrides(
            &mut zip,
            &mut vec![],
            Some(work.path()),
            &|| true,
            &|_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(std::fs::read_dir(work.path()).unwrap().next().is_none());
    }
    #[test]
    fn cancellation_during_override_copy_removes_temporary_files() {
        let work = tempfile::tempdir().unwrap();
        let bytes = vec![7u8; 150 * 1024];
        let mut zip = archive(&[("overrides/config/big", &bytes)]);
        let calls = std::cell::Cell::new(0);
        let error = apply_overrides(
            &mut zip,
            &mut vec![],
            Some(work.path()),
            &|| {
                calls.set(calls.get() + 1);
                calls.get() >= 4
            },
            &|_, _| {},
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(std::fs::read_dir(work.path()).unwrap().next().is_none());
    }
}
