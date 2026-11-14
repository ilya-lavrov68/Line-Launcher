//! Modrinth modpacks.
//!
//! Input is the official project page — `modrinth.com/modpack/<slug>` — or the
//! API's project id. The page is not scraped: its URL is reduced to a slug, and
//! the launcher talks to `api.modrinth.com`, which is the only thing that can
//! tell a pack from a project that merely looks like one. That also means a
//! project URL and a project id are the same source with the same checks.
//!
//! What comes back is a `.mrpack`, which is a ZIP containing
//! `modrinth.index.json` and `overrides/`:
//!
//! ```json
//! {
//!   "formatVersion": 1,
//!   "game": "minecraft",
//!   "dependencies": { "minecraft": "1.21.1", "fabric-loader": "0.16.9" },
//!   "files": [
//!     { "path": "mods/sodium.jar",
//!       "hashes": { "sha1": "…", "sha512": "…" },
//!       "downloads": ["https://cdn.modrinth.com/…"],
//!       "fileSize": 123456 }
//!   ]
//! }
//! ```
//!
//! Rules, and why:
//!
//! - **Release versions only.** Betas exist, but a launcher that puts beta packs
//!   on players without the provider choosing one is a launcher that ships other
//!   people's bugs.
//! - **sha512 is checked, sha1 is not used.** The index carries both; the sha1
//!   is there for old tooling, and checking it instead of the sha512 would be
//!   choosing the weaker of two checks that are both offered.
//! - **No CurseForge fallback.** Some `.mrpack` files list CurseForge download
//!   URLs; those need a key this launcher does not ship. The file is refused by
//!   name rather than failing with a 403 mid-download.
use super::super::error::{ErrorCode, LineError, LineResult};
use super::{PackFile, ResolvedPack};
use serde::Deserialize;
use sha2::{Digest, Sha512};

/// `.mrpack` files are JSON inside a ZIP; the index is small.
pub const MAX_INDEX_BYTES: usize = 16 * 1024 * 1024;

/// `modrinth.index.json`.
#[derive(Debug, Clone, Deserialize)]
pub struct McIndex {
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    #[serde(default)]
    pub game: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub dependencies: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub files: Vec<McFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct McFile {
    pub path: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub hashes: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub downloads: Vec<String>,
    #[serde(rename = "fileSize", default)]
    pub file_size: u64,
}

/// Extracts the project slug from an official Modrinth URL.
///
/// Strict on purpose: the value ends up in an API request and then in a file
/// path on disk, so `modrinth.com` (or `www.`), a `/modpack/` segment and a slug
/// is the whole grammar. A URL that does not fit is refused with the expected
/// shape, not with a parse error.
pub fn project_from_url(raw: &str) -> LineResult<(String, Option<String>)> {
    let url = super::super::config::validate_https(raw)?;
    let host = url.host_str().unwrap_or_default();
    if host != "modrinth.com" && host != "www.modrinth.com" {
        return Err(LineError::input(
            "Официальная ссылка Modrinth выглядит так: https://modrinth.com/modpack/<slug>. Другие хосты не принимаются.",
        ));
    }
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.filter(|part| !part.is_empty()).collect())
        .unwrap_or_default();
    let (slug, version) = match segments.as_slice() {
        ["modpack", slug] => (*slug, None),
        ["modpack", slug, "version", version] => {
            let decoded = percent_decode(version);
            (*slug, Some(decoded))
        }
        _ => {
            return Err(LineError::input(
                "Официальная ссылка Modrinth выглядит так: https://modrinth.com/modpack/<slug> или …/version/<id>.",
            ))
        }
    };
    if !valid_project_id(slug) {
        return Err(LineError::input("Некорректный slug проекта Modrinth."));
    }
    if let Some(value) = &version {
        if value.is_empty() || value.len() > 64 || value.chars().any(char::is_control) {
            return Err(LineError::input("Некорректный номер версии Modrinth."));
        }
    }
    Ok((slug.to_owned(), version))
}

/// Modrinth ids are base62: mixed case, digits, dash and underscore.
///
/// Deliberately not `validate_slug` from the config module: that one lowercases
/// and rejects dots because it guards file names, and a Modrinth id is neither
/// a file name nor necessarily lowercase.
pub fn valid_project_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The API request for a project's versions, newest first.
///
/// One endpoint covers "latest release" and "this exact version": the list is
/// returned whole and `pick_version` chooses. Using `/v2/version/<id>` would
/// need a second code path and a second error message for the same outcome.
pub fn versions_url(project: &str) -> LineResult<String> {
    if !valid_project_id(project) {
        return Err(LineError::input(
            "Некорректный идентификатор проекта Modrinth.",
        ));
    }
    Ok(format!(
        "https://api.modrinth.com/v2/project/{project}/version"
    ))
}

/// One version from the API. Only the fields that decide whether we may use it.
#[derive(Debug, Clone, Deserialize)]
pub struct McVersion {
    pub id: String,
    #[serde(default)]
    pub version_number: Option<String>,
    #[serde(rename = "version_type", default)]
    pub version_type: Option<String>,
    pub files: Vec<McVersionFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct McVersionFile {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub hashes: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub primary: bool,
}

impl McVersion {
    /// The `.mrpack` among the version's files, or an explanation.
    pub fn pack_file(&self) -> LineResult<&McVersionFile> {
        self.files
            .iter()
            .find(|file| file.primary && file.filename.ends_with(".mrpack"))
            .or_else(|| {
                self.files
                    .iter()
                    .find(|file| file.filename.ends_with(".mrpack"))
            })
            .ok_or_else(|| {
                LineError::input("У этой версии Modrinth нет файла .mrpack: это не модпак.")
            })
    }

    /// A release is what a provider may put in front of players.
    pub fn is_release(&self) -> bool {
        self.version_type.as_deref().unwrap_or("release") == "release"
    }
}

/// Picks the version to install.
///
/// `requested` matches either the API id or the version number, because the
/// official page URL carries the number while the config carries what the
/// provider copied. A pinned version is installed even if it is a beta — the
/// provider chose it. With nothing pinned, only a release qualifies: putting a
/// beta in front of players because it happened to be newest is the launcher
/// making the provider's decision for them.
pub fn pick_version<'a>(
    versions: &'a [McVersion],
    requested: Option<&str>,
) -> LineResult<&'a McVersion> {
    if let Some(value) = requested {
        return versions
            .iter()
            .find(|version| version.id == value || version.version_number.as_deref() == Some(value))
            .ok_or_else(|| {
                LineError::input(format!(
                    "Версия «{value}» не найдена у этого проекта Modrinth."
                ))
            });
    }
    versions.iter().find(|version| version.is_release()).ok_or_else(|| {
        LineError::new(
            ErrorCode::InvalidInput,
            "У проекта Modrinth нет стабильных версий сборки — только бета. Укажите version явно или попросите провайдера выбрать другую сборку.",
            false,
        )
    })
}

/// `%2E` in a version number is legal on the page and would otherwise become
/// part of a path. Only `%XX` is decoded; anything else is left alone.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&raw[index + 1..index + 3], 16) {
                if value.is_ascii() && !value.is_ascii_control() {
                    out.push(value as char);
                    index += 3;
                    continue;
                }
            }
        }
        out.push(bytes[index] as char);
        index += 1;
    }
    out
}

pub fn parse_index(bytes: &[u8]) -> LineResult<McIndex> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(LineError::input("modrinth.index.json больше 16 МиБ."));
    }
    let index: McIndex = serde_json::from_slice(bytes)
        .map_err(|error| LineError::input(format!("modrinth.index.json повреждён: {error}")))?;
    if index.format_version != 1 {
        return Err(LineError::new(
            ErrorCode::UnsupportedVersion,
            format!(
                "Формат .mrpack {} не поддерживается этой версией лаунчера.",
                index.format_version
            ),
            false,
        ));
    }
    if index
        .game
        .as_deref()
        .is_some_and(|game| game != "minecraft")
    {
        return Err(LineError::input("Этот .mrpack не для Minecraft."));
    }
    Ok(index)
}

/// Converts the index into the files to fetch.
pub fn assemble(index: &McIndex) -> LineResult<ResolvedPack> {
    let mut files = Vec::with_capacity(index.files.len());
    for file in &index.files {
        if file
            .env
            .get("client")
            .is_some_and(|value| value == "unsupported")
        {
            continue;
        }
        let url = file
            .downloads
            .iter()
            .find(|url| !is_curseforge(url))
            .ok_or_else(|| {
                LineError::input(format!(
                    "Файл {} скачивается только через CurseForge, а для этого нужен API-ключ, которого в лаунчере нет.",
                    file.path
                ))
            })?;
        let sha512 = file.hashes.get("sha512").ok_or_else(|| {
            LineError::input(format!(
                "У файла {} нет sha512: проверить его нечем.",
                file.path
            ))
        })?;
        if sha512.len() != 128 || !sha512.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(LineError::input(format!(
                "Некорректный sha512 у файла {}.",
                file.path
            )));
        }
        files.push(PackFile {
            path: file.path.clone(),
            url: url.clone(),
            // Filled after download: the index only carries sha512, and the rest
            // of the pipeline speaks sha256.
            sha256: String::new(),
            sha512: Some(sha512.to_ascii_lowercase()),
            inline: None,
            override_file: None,
            size: file.file_size,
        });
    }
    let loader = ["fabric-loader", "quilt-loader", "neoforge", "forge"]
        .iter()
        .find_map(|key| {
            index.dependencies.get(*key).map(|version| {
                let kind = match *key {
                    "fabric-loader" => super::super::minecraft_core::LoaderChoice::Fabric,
                    "quilt-loader" => super::super::minecraft_core::LoaderChoice::Quilt,
                    "neoforge" => super::super::minecraft_core::LoaderChoice::NeoForge,
                    _ => super::super::minecraft_core::LoaderChoice::Forge,
                };
                (kind, version.clone())
            })
        })
        .or_else(|| {
            index.dependencies.get("forge").map(|version| {
                (
                    super::super::minecraft_core::LoaderChoice::Forge,
                    version.clone(),
                )
            })
        });
    Ok(ResolvedPack {
        revision: index
            .version_id
            .clone()
            .or_else(|| index.name.clone())
            .unwrap_or_else(|| "modrinth".to_owned()),
        files,
        minecraft_version: index.dependencies.get("minecraft").cloned(),
        loader,
        archive: None,
    })
}

/// A CurseForge-hosted download inside a `.mrpack`.
pub fn is_curseforge(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("curseforge.com") || lower.contains("forgecdn.net")
}

/// Verifies a downloaded `.mrpack` file against the sha512 the index promised.
pub fn matches_sha512(bytes: &[u8], expected: &str) -> bool {
    let actual = format!("{:x}", Sha512::digest(bytes));
    actual.eq_ignore_ascii_case(expected.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_battlearmory_ids_select_exact_version() {
        assert_eq!(
            versions_url("rQiXwLhB").unwrap(),
            "https://api.modrinth.com/v2/project/rQiXwLhB/version"
        );
        let versions: Vec<McVersion> = serde_json::from_str(
            r#"[
            {"id":"NEWER", "version_type":"release", "files":[]},
            {"id":"TQIsQXtg", "version_number":"1.3.1", "version_type":"release", "files":[
                {"filename":"BattleArmory 1.3.1.mrpack", "primary":true}
            ]}
        ]"#,
        )
        .unwrap();
        let chosen = pick_version(&versions, Some("TQIsQXtg")).unwrap();
        assert_eq!(chosen.id, "TQIsQXtg");
        assert_eq!(
            chosen.pack_file().unwrap().filename,
            "BattleArmory 1.3.1.mrpack"
        );
        assert!(project_from_url(
            "https://cdn.modrinth.com/data/rQiXwLhB/versions/TQIsQXtg/BattleArmory%201.3.1.mrpack"
        )
        .is_err());
    }

    #[test]
    fn modrinth_index_preserves_neoforge_dependency() {
        let index = parse_index(
            br#"{"formatVersion":1,"game":"minecraft","dependencies":{"minecraft":"1.20.1","neoforge":"20.1.0"},"files":[]}"#,
        )
        .unwrap();
        let pack = assemble(&index).unwrap();
        assert_eq!(pack.minecraft_version.as_deref(), Some("1.20.1"));
        let (loader, version) = pack.loader.unwrap();
        assert!(matches!(
            loader,
            super::super::super::minecraft_core::LoaderChoice::NeoForge
        ));
        assert_eq!(version, "20.1.0");
    }
}
