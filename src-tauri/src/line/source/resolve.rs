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
use std::sync::Arc;

/// The launcher's HTTP client, handed in rather than created: one client per
/// process, with the same certificate and proxy policy as everything else.
pub type HttpClient = Arc<reqwest::Client>;

/// A future the trait can name without the `async-trait` crate.
pub type FetchFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = LineResult<Vec<u8>>> + Send + 'a>>;

/// What a resolver needs from the network. One method, so a test can implement it
/// with a map of URL → bytes and prove the rules without a server.
///
/// Hand-written boxed futures rather than `#[async_trait]`: adding a proc-macro
/// dependency to save ten lines is a bad trade in a launcher that vendors its
/// supply chain.
pub trait Fetch: Send + Sync {
    /// Bytes of a document that must be small (manifests, JSON).
    fn get<'a>(&'a self, url: &'a str, limit: usize) -> FetchFuture<'a>;
}

pub struct HttpFetch {
    pub client: HttpClient,
}

impl Fetch for HttpFetch {
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
}

/// Resolves any source to a file list. The one entry point the installer uses.
pub async fn resolve(
    fetch: &dyn Fetch,
    kind: &SourceKind,
) -> LineResult<ResolvedPack> {
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

/// Fetches a packwiz pack: `pack.toml` → `index.toml` (hash-checked) → each
/// listed `.pw.toml`.
pub async fn resolve_packwiz(fetch: &dyn Fetch, pack_toml_url: &str) -> LineResult<ResolvedPack> {
    let base = parent_of(pack_toml_url)?;
    let pack_bytes = fetch.get(pack_toml_url, packwiz::MAX_MANIFEST_BYTES).await?;
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
    if pack.index.file.contains("..") || pack.index.file.starts_with('/') {
        return Err(LineError::input("index.file не может выходить за папку сборки."));
    }
    let index_url = super::super::config::validate_https(&format!(
        "{base}{}",
        pack.index.file.trim_start_matches("./")
    ))?
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
        super::super::install::safe_entry_path(path)?;
        if path.contains('\\') || super::super::integrity::is_reserved(path) {
            return Err(LineError::input("Некорректный путь файла packwiz."));
        }
        let hash = entry.hash.as_deref().ok_or_else(|| LineError::input("В index.toml отсутствует хеш файла."))?.to_ascii_lowercase();
        let expected_len = if format.eq_ignore_ascii_case("sha512") { 128 } else { 64 };
        if hash.len() != expected_len || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(LineError::input("Некорректный хеш файла в index.toml."));
        }
        let url = super::super::config::validate_https(&format!("{base}{path}"))?.to_string();
        if entry.metafile.unwrap_or(false) {
            let bytes = fetch.get(&url, packwiz::MAX_MANIFEST_BYTES).await?;
            if !packwiz::digest(format, &bytes).eq_ignore_ascii_case(&hash) {
                return Err(LineError::new(ErrorCode::Integrity, "Хеш метафайла packwiz не совпадает с index.toml.", false));
            }
            metafiles.push((path.to_owned(), packwiz::parse_metafile(&bytes, path)?));
        } else {
            ordinary.push(super::PackFile {
                path: path.to_owned(), url,
                sha256: if format.eq_ignore_ascii_case("sha256") { hash.clone() } else { String::new() },
                sha512: if format.eq_ignore_ascii_case("sha512") { Some(hash) } else { None },
                inline: None,
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
    let versions: Vec<modrinth::McVersion> = serde_json::from_slice(&bytes).map_err(|_| {
        LineError::input("Modrinth вернул неожиданный ответ вместо списка версий.")
    })?;
    let picked = modrinth::pick_version(&versions, version)?.clone();
    let file = picked.pack_file()?.clone();
    let pack_url = super::super::config::validate_https(&file.url)?.as_str().to_owned();
    let expected = file
        .hashes
        .get("sha512")
        .cloned()
        .ok_or_else(|| LineError::input("У .mrpack нет sha512: проверить его нечем."))?;
    // The index is read from the ZIP's central directory; the archive itself is
    // not kept — the files it names are what gets installed.
    let archive = fetch.get(&pack_url, 64 * 1024 * 1024).await?;
    if !modrinth::matches_sha512(&archive, &expected) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Файл .mrpack не совпадает с sha512, указанным в версии Modrinth. Установка остановлена.",
            false,
        ));
    }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|_| LineError::input(".mrpack не является ZIP-архивом."))?;
    let index_bytes = {
        let mut entry = zip
            .by_name("modrinth.index.json")
            .map_err(|_| LineError::input("В .mrpack нет modrinth.index.json."))?;
        if entry.size() > modrinth::MAX_INDEX_BYTES as u64 {
            return Err(LineError::input("modrinth.index.json слишком велик."));
        }
        let mut buffer = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut buffer)
            .map_err(|_| LineError::input("Не удалось прочитать modrinth.index.json."))?;
        buffer
    };
    let index = modrinth::parse_index(&index_bytes)?;
    let mut resolved = modrinth::assemble(&index)?;
    apply_overrides(&mut zip, &mut resolved.files)?;
    // The version id, not the project name: two versions of one project must not
    // look like the same build to the installer.
    resolved.revision = format!("{}-{}", picked.id, picked.version_number.unwrap_or_default());
    Ok(resolved)
}

/// Overlay common overrides first, then client-overrides, as specified by mrpack.
/// The containing archive was authenticated before this is called. Keep bounded
/// uncompressed bytes in memory until the installer's normal staging/index path.
fn apply_overrides<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>, files: &mut Vec<super::PackFile>,
) -> LineResult<()> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    const MAX_OVERRIDES: u64 = 128 * 1024 * 1024;
    if zip.len() > super::MAX_FILES + 1 {
        return Err(LineError::input("Слишком много записей в .mrpack."));
    }
    let mut total = 0u64;
    for prefix in ["overrides/", "client-overrides/"] {
        let mut seen = std::collections::HashSet::new();
        for position in 0..zip.len() {
            let mut entry = zip.by_index(position)
                .map_err(|_| LineError::input("Не удалось прочитать .mrpack."))?;
            if entry.is_dir() { continue; }
            let Some(path) = entry.name().strip_prefix(prefix).map(str::to_owned) else { continue };
            super::super::install::safe_entry_path(&path)?;
            if super::super::integrity::is_reserved(&path) || !seen.insert(path.to_ascii_lowercase()) {
                return Err(LineError::input("Повторяющийся или зарезервированный путь в overrides."));
            }
            // Symlinks and special ZIP entries are not files to install.
            if entry.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000) {
                return Err(LineError::input("Недопустимый тип файла в overrides."));
            }
            total = total.checked_add(entry.size()).ok_or_else(|| LineError::input("Overrides слишком велики."))?;
            if total > MAX_OVERRIDES { return Err(LineError::input("Overrides превышают 128 МиБ.")); }
            let declared = entry.size();
            let mut bytes = Vec::new();
            (&mut entry).take(declared + 1).read_to_end(&mut bytes)
                .map_err(|_| LineError::input("Не удалось распаковать overrides."))?;
            if bytes.len() as u64 != declared { return Err(LineError::input("Некорректный размер файла overrides.")); }
            let sha256 = format!("{:x}", Sha256::digest(&bytes));
            // A later client override replaces the common override or download.
            files.retain(|file| file.path != path);
            files.push(super::PackFile {
                path, url: String::new(), sha256, sha512: None,
                size: bytes.len() as u64, inline: Some(Arc::new(bytes)),
            });
            if files.len() > super::MAX_FILES { return Err(LineError::input("Слишком много файлов в .mrpack.")); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    fn archive(entries: &[(&str, &[u8])]) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
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
        apply_overrides(&mut zip, &mut files).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "config/test.txt");
        assert_eq!(files[0].inline.as_ref().unwrap().as_slice(), b"client");
        assert_eq!(files[0].size, 6);
        assert_eq!(files[0].sha256.len(), 64);
    }

    #[test]
    fn overrides_reject_unsafe_and_duplicate_paths() {
        for entries in [
            vec![("overrides/../outside", b"x".as_slice())],
            vec![("overrides/.line-complete", b"x".as_slice())],
            vec![("overrides/config/A", b"x".as_slice()), ("overrides/config/a", b"y".as_slice())],
        ] {
            assert!(apply_overrides(&mut archive(&entries), &mut vec![]).is_err());
        }
    }
}
