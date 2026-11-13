//! packwiz packs, read straight from a raw `pack.toml` on GitHub or any HTTPS
//! host.
//!
//! The format is TOML in a git repository, so the provider's publishing flow is
//! "commit and push" rather than "zip and upload". What the launcher needs from
//! it is small and stable:
//!
//! ```text
//! pack.toml      index.file + index.hash + versions.{minecraft,fabric|…}
//! index.toml     [[files]] file = "mods/x.pw.toml"  hash = "…"
//! mods/x.pw.toml filename = "x.jar" + [download] url, hash-format, hash
//! ```
//!
//! Three rules keep this honest:
//!
//! 1. **The index hash is checked.** `pack.toml` says what `index.toml` must
//!    hash to; a mismatch means the file served is not the one the pack author
//!    wrote, and installation stops.
//! 2. **Only strong hashes.** `sha256` and `sha512` are accepted; `md5`, `sha1`
//!    and `murmur2` are refused with an explanation. A weak digest in a feature
//!    whose purpose is proving the files are the right ones is worse than none.
//! 3. **`metadata:curseforge` is refused by name.** That mode resolves URLs
//!    through the CurseForge API, which needs a key this launcher does not ship.
//!    Saying so beats a 403 halfway through a download.
use super::super::error::{ErrorCode, LineError, LineResult};
use super::{PackFile, ResolvedPack, MAX_FILES};
use serde::Deserialize;
use sha2::{Digest, Sha256, Sha512};

/// `pack.toml` is small; anything larger is not a manifest.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;
/// How many `.pw.toml` files the index may list.
pub const MAX_ENTRIES: usize = MAX_FILES;

/// The parts of `pack.toml` this launcher reads.
#[derive(Debug, Clone, Deserialize)]
pub struct PackToml {
    pub name: String,
    #[serde(rename = "pack-format", default)]
    pub pack_format: Option<String>,
    pub index: IndexRef,
    #[serde(default)]
    pub versions: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IndexRef {
    pub file: String,
    #[serde(rename = "hash-format")]
    pub hash_format: String,
    pub hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IndexToml {
    #[serde(rename = "hash-format", default)]
    pub hash_format: Option<String>,
    #[serde(default)]
    pub files: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IndexEntry {
    pub file: String,
    #[serde(default)]
    pub metafile: Option<bool>,
    #[serde(default)]
    pub hash: Option<String>,
}

/// One `mods/….pw.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct Metafile {
    pub filename: String,
    /// `client` | `server` | `both`. Server-only mods are not downloaded.
    #[serde(default)]
    pub side: Option<String>,
    /// Present for `metadata:curseforge` entries; those are refused.
    #[serde(default)]
    pub update: Option<UpdateBlock>,
    #[serde(default)]
    pub option: Option<OptionBlock>,
    pub download: Download,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateBlock {
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OptionBlock {
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Download {
    pub url: String,
    #[serde(rename = "hash-format", default)]
    pub hash_format: Option<String>,
    #[serde(default)]
    pub hash: Option<String>,
}

/// Parsed fields of the three files, with no network involved. Pure, so the
/// format rules are testable without a server.
pub fn parse_pack(bytes: &[u8]) -> LineResult<PackToml> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(LineError::input(
            "pack.toml больше 256 КиБ: это не манифест сборки.",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| LineError::input("pack.toml не является текстом UTF-8."))?;
    let parsed: PackToml = toml::from_str(text)
        .map_err(|error| LineError::input(format!("pack.toml повреждён: {error}")))?;
    // Every consumer must support the major version it claims to implement.
    let format = parsed.pack_format.as_deref().unwrap_or("packwiz:1.0.0");
    let Some(version) = format.strip_prefix("packwiz:") else {
        return Err(LineError::input(
            "pack-format должен начинаться с «packwiz:»: это не сборка packwiz.",
        ));
    };
    let major: u64 = version
        .split('.')
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or_else(|| LineError::input("pack-format должен содержать корректную версию."))?;
    if major > 1 {
        return Err(LineError::new(
            ErrorCode::UnsupportedVersion,
            format!(
                "Сборка требует pack-format {format}, лаунчер поддерживает packwiz:1.x. Обновите Line Launcher."
            ),
            false,
        ));
    }
    Ok(parsed)
}

pub fn parse_index(bytes: &[u8]) -> LineResult<IndexToml> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(LineError::input("index.toml больше 8 МиБ."));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| LineError::input("index.toml не является текстом UTF-8."))?;
    toml::from_str(text).map_err(|error| LineError::input(format!("index.toml повреждён: {error}")))
}

pub fn parse_metafile(bytes: &[u8], path: &str) -> LineResult<Metafile> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(LineError::input(format!(
            "{path} больше 256 КиБ: это не метафайл мода."
        )));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| LineError::input(format!("{path} не является текстом UTF-8.")))?;
    toml::from_str(text).map_err(|error| LineError::input(format!("{path} повреждён: {error}")))
}

/// Which hashes are accepted. `md5`/`sha1`/`murmur2` are refused: a digest that
/// can be forged by accident is not a check.
pub fn strong_hash(format: &str) -> bool {
    matches!(format.to_ascii_lowercase().as_str(), "sha256" | "sha512")
}

/// Hex digest of `bytes` in the given format, lowercased, for comparison.
pub fn digest(format: &str, bytes: &[u8]) -> String {
    match format.to_ascii_lowercase().as_str() {
        "sha512" => format!("{:x}", Sha512::digest(bytes)),
        _ => format!("{:x}", Sha256::digest(bytes)),
    }
}

/// Normalises a packwiz hash: sha512 is kept as sha512 (the caller compares it
/// against its own digest), sha256 is the identity everything else uses.
pub fn expected_hash(download: &Download) -> LineResult<(String, String)> {
    let format = download
        .hash_format
        .as_deref()
        .ok_or_else(|| LineError::input("У файла в .pw.toml нет hash-format."))?;
    if !strong_hash(format) {
        return Err(LineError::input(format!(
            "Хеш {format} не поддерживается: нужен sha256 или sha512. Слабый хеш в проверке файлов хуже, чем отсутствие проверки."
        )));
    }
    let hash = download
        .hash
        .as_deref()
        .ok_or_else(|| LineError::input("У файла в .pw.toml нет hash."))?
        .to_ascii_lowercase();
    let expected_len = if format.eq_ignore_ascii_case("sha512") { 128 } else { 64 };
    if hash.len() != expected_len || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(LineError::input("Некорректный хеш файла в .pw.toml."));
    }
    Ok((format.to_ascii_lowercase(), hash))
}

/// Turns one metafile into the file to fetch.
///
/// sha512 is verified against the download and then re-expressed as sha256, so
/// the rest of the pipeline (which speaks sha256 everywhere) needs no knowledge
/// of packwiz's hash choices. The size is not in the format; the installer
/// records what it received, and `0` here means "unknown until downloaded".
pub fn file_from_metafile(path: &str, meta: &Metafile) -> LineResult<Option<PackFile>> {
    // Server-only and optional mods are the player's or the server's business,
    // not the client's: installing them would change what the game loads.
    if meta.side.as_deref() == Some("server") {
        return Ok(None);
    }
    if meta.option.as_ref().is_some_and(|option| option.optional) {
        return Ok(None);
    }
    if let Some(update) = &meta.update {
        // Only the CurseForge mode is refused, and by name. packwiz writes a
        // download URL and hash for every other mode, so those entries install
        // exactly like a plain one — refusing them too would turn a supported
        // mode into a wrong error message.
        if update
            .mode
            .as_deref()
            .is_some_and(|mode| mode.eq_ignore_ascii_case("metadata:curseforge"))
        {
            return Err(LineError::input(format!(
                "{path}: источник {mode} требует CurseForge API-ключ, которого в лаунчере нет. Провайдеру нужно экспортировать URL напрямую.",
                mode = update.mode.as_deref().unwrap_or_default()
            )));
        }
    }
    let (format, hash) = expected_hash(&meta.download)?;
    let sha512 = if format == "sha512" { Some(hash.clone()) } else { None };
    let sha256 = if format == "sha256" {
        hash
    } else {
        // A sha512 entry has no sha256 in the file; the download step fills it in
        // after verifying the sha512. Until then it is empty and `validate()` is
        // called only once the bytes are there.
        String::new()
    };
    let entry = PackFile {
        path: path.to_owned(),
        url: meta.download.url.clone(),
        sha256,
        sha512,
        inline: None,
        size: 0,
    };
    super::super::config::validate_https(&entry.url)?;
    Ok(Some(entry))
}

/// The filename a metafile says to write, or the metafile's own name.
pub fn target_path(meta_path: &str, meta: &Metafile) -> LineResult<String> {
    let filename = meta.filename.trim();
    if filename.is_empty()
        || filename.len() > 256
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
        || filename.chars().any(char::is_control)
    {
        return Err(LineError::input(format!(
            "{meta_path}: некорректное имя файла {filename:?}."
        )));
    }
    // The directory comes from the metafile's own location in the pack, which is
    // what packwiz itself does: `mods/foo.pw.toml` owns `mods/foo.jar`.
    let dir = meta_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let relative = if dir.is_empty() {
        filename.to_owned()
    } else {
        format!("{dir}/{filename}")
    };
    if relative.contains("..") {
        return Err(LineError::input(format!(
            "{meta_path}: путь выходит за пределы сборки."
        )));
    }
    Ok(relative)
}

/// Game version and loader from `[versions]`, which is the authoritative answer
/// for a packwiz pack (there is no `inspect`-able ZIP to read before download).
pub fn loader_of(
    versions: &std::collections::BTreeMap<String, String>,
) -> Option<(super::super::minecraft_core::LoaderChoice, String)> {
    use super::super::minecraft_core::LoaderChoice;
    for (key, kind) in [
        ("fabric", LoaderChoice::Fabric),
        ("quilt", LoaderChoice::Quilt),
        ("neoforge", LoaderChoice::NeoForge),
        ("forge", LoaderChoice::Forge),
    ] {
        if let Some(version) = versions.get(key) {
            return Some((kind, version.clone()));
        }
    }
    None
}

/// The whole resolution, given already-fetched bytes. Kept separate from the
/// network so a fixture can drive it: `resolve_with` in the caller supplies the
/// fetch.
pub fn assemble(
    pack: &PackToml,
    index: &IndexToml,
    mut metafiles: Vec<(String, Metafile)>,
) -> LineResult<ResolvedPack> {
    if index.files.len() > MAX_ENTRIES {
        return Err(LineError::input("В index.toml слишком много файлов."));
    }
    let mut files = Vec::new();
    metafiles.sort_by(|left, right| left.0.cmp(&right.0));
    for (meta_path, meta) in metafiles {
        let target = target_path(&meta_path, &meta)?;
        let Some(mut file) = file_from_metafile(&target, &meta)? else {
            continue;
        };
        // Size is unknown until the download; `0` is the marker for that, and
        // the installer replaces it. `validate()` is called with real values.
        file.size = 0;
        files.push(file);
    }
    if files.len() > MAX_FILES {
        return Err(LineError::input(
            "Сборка описывает слишком много файлов для одной установки.",
        ));
    }
    Ok(ResolvedPack {
        revision: pack.name.clone(),
        files,
        minecraft_version: pack.versions.get("minecraft").cloned(),
        loader: loader_of(&pack.versions),
        archive: None,
    })
}
