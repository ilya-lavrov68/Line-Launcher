//! Where a server's build comes from.
//!
//! Three sources, one contract. A source's only job is to answer "which files,
//! from where, checked against what" — everything after that (downloading,
//! writing, verifying, deciding the loader, launching) is the existing installer
//! and does not know which source produced the list.
//!
//! ```text
//! Archive   — today's ZIP + pack.json.            (unchanged since 0.1)
//! Packwiz   — pack.toml → index.toml → files.      (0.15)
//! Modrinth  — project page → .mrpack → files.      (0.15)
//! ```
//!
//! The contract exists because the alternative — one installer per source — is
//! how a launcher ends up with three subtly different integrity checks. Every
//! `PackFile` carries a sha256 by the time it reaches the installer; where a
//! source does not publish one (a packwiz entry without `hash`), the file is
//! downloaded, hashed and then pinned, so it is as rigid from the second launch
//! on as anything else. There is no "trusted source" flag.
use super::config::{Distribution, Server};
use super::error::{ErrorCode, LineError, LineResult};
use super::minecraft_core::LoaderChoice;
use std::path::PathBuf;

pub mod install;
pub mod modrinth;
pub mod packwiz;
pub mod resolve;

/// How many files a source may describe. Matches the extractor's limit, so a
/// source cannot describe more than an archive could contain.
pub const MAX_FILES: usize = 50_000;
/// One file's ceiling: a mod jar is megabytes, this is generous.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// One file the build is made of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackFile {
    /// Path inside the game directory, forward slashes, already validated.
    pub path: String,
    /// HTTPS URL to fetch it from.
    pub url: String,
    /// Lowercase sha256 the bytes must hash to.
    pub sha256: String,
    /// SHA-512 supplied by the source when SHA-256 is not available.
    pub sha512: Option<String>,
    /// Authenticated bytes embedded in a verified .mrpack override.
    pub inline: Option<std::sync::Arc<Vec<u8>>>,
    pub size: u64,
}

impl PackFile {
    /// Checks the fields every source must produce, and nothing about where they
    /// came from. Called once per file as the list is built.
    pub fn validate(&self) -> LineResult<()> {
        if self.path.is_empty()
            || self.path.len() > 512
            || self.path.starts_with('/')
            || self.path.contains("..")
            || self.path.contains('\\')
            || self.path.chars().any(char::is_control)
        {
            return Err(LineError::input(format!(
                "Некорректный путь файла в сборке: {}",
                self.path
            )));
        }
        super::config::validate_https(&self.url)?;
        if !super::integrity::valid_sha256(&self.sha256) {
            return Err(LineError::input(format!(
                "Некорректный sha256 для файла {}.",
                self.path
            )));
        }
        if self.size == 0 || self.size > MAX_FILE_BYTES {
            return Err(LineError::input(format!(
                "Некорректный размер файла {}.",
                self.path
            )));
        }
        Ok(())
    }
}

/// What a source resolved to.
#[derive(Debug, Clone, Default)]
pub struct ResolvedPack {
    /// Human label: the source's own revision, shown in the UI and logged.
    pub revision: String,
    /// Files to download into the game directory.
    pub files: Vec<PackFile>,
    pub minecraft_version: Option<String>,
    pub loader: Option<(LoaderChoice, String)>,
    /// Archive source only: the pinned distribution the installer expects.
    pub archive: Option<Distribution>,
}

impl ResolvedPack {
    /// A stable identity for what was resolved.
    ///
    /// The files' own digests are folded into one hash in path order, so two
    /// resolutions of an unchanged pack produce the same revision and the
    /// installed copy is not re-downloaded. A source that reorders its list
    /// therefore does not look like a new build.
    pub fn compute_revision(files: &[PackFile]) -> String {
        use sha2::{Digest, Sha256};
        let mut ordered: Vec<&PackFile> = files.iter().collect();
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
}

/// Which source a server uses, after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceKind {
    Archive,
    Packwiz {
        pack_toml_url: String,
    },
    Modrinth {
        project: String,
        version: Option<String>,
    },
}

/// Reads the server's `source` block, if any. Older configs have none.
pub fn kind_of(server: &Server) -> LineResult<SourceKind> {
    let Some(source) = &server.source else {
        return Ok(SourceKind::Archive);
    };
    match source.kind.as_str() {
        "packwiz" => {
            let url = source
                .pack_toml_url
                .as_deref()
                .ok_or_else(|| LineError::input("source.kind=packwiz требует pack_toml_url."))?;
            super::config::validate_https(url)?;
            Ok(SourceKind::Packwiz {
                pack_toml_url: url.to_owned(),
            })
        }
        "modrinth" => {
            let project = source
                .project
                .as_deref()
                .ok_or_else(|| LineError::input("source.kind=modrinth требует project."))?;
            let (project, url_version) = if project.starts_with("https://") {
                modrinth::project_from_url(project)?
            } else if modrinth::valid_project_id(project) {
                (project.to_owned(), None)
            } else {
                return Err(LineError::input("Некорректный проект Modrinth."));
            };
            if url_version.is_some() && source.version.is_some() {
                return Err(LineError::input("Версия Modrinth указана дважды."));
            }
            Ok(SourceKind::Modrinth {
                project,
                version: source.version.clone().or(url_version),
            })
        }
        other => Err(LineError::new(
            ErrorCode::UnsupportedVersion,
            format!("Источник сборки «{other}» не поддерживается этой версией лаунчера."),
            false,
        )),
    }
}

/// Feature names a config using each source must declare.
pub fn required_feature(kind: &SourceKind) -> Option<&'static str> {
    match kind {
        SourceKind::Archive => None,
        SourceKind::Packwiz { .. } => Some("packwiz-v1"),
        SourceKind::Modrinth { .. } => Some("modrinth-v1"),
    }
}

/// Where unpacked source files land before the installer copies them into the
/// game directory. Under the server's own directory, never shared.
pub fn staging_dir(base: &std::path::Path) -> PathBuf {
    base.join("source-stage")
}
