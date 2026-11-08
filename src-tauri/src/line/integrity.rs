//! Per-file integrity of one installed release.
//!
//! Every server has its own instance (`instances/<server-id>/`) and its own
//! immutable release directory. Until now the only proof of a complete install
//! was the `.line-complete` marker: a jar replaced by hand, a deleted library or
//! a dropped-in mod would still launch. This module records a SHA-256 for every
//! extracted file at install time and re-checks the whole tree before launch.
//!
//! Policy, as asked for:
//!   * a file that is not in the published index is **foreign** → deleted;
//!   * a file that is missing or whose bytes changed → the release is downloaded
//!     and unpacked again (the caller does that, this module only decides);
//!   * a symlink or special file inside the release is never trusted → the whole
//!     release is repaired instead of trying to reason about its target.
//!
//! The comparison itself is a pure function so it can be unit-tested without a
//! filesystem, and so the deletion decision has exactly one source of truth.
use super::error::{ErrorCode, LineError, LineResult};
use super::install::safe_entry_path;
use super::storage::{atomic_write, is_real_dir};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Written inside the release, next to the completion marker.
pub const INDEX_FILE: &str = ".line-files.json";
pub const COMPLETE_MARKER: &str = ".line-complete";
pub const INDEX_SCHEMA: u32 = 1;
const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;
/// Same bound as the archive itself: an index cannot describe more files than
/// the extractor is willing to write.
pub const MAX_INDEXED_FILES: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    /// Forward-slash path relative to the release root.
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileIndex {
    pub schema_version: u32,
    pub files: Vec<FileEntry>,
}

/// What the scan found. `foreign` is deleted on the spot; `missing`/`changed`
/// require the archive, because the launcher cannot invent the original bytes.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub checked: usize,
    pub missing: Vec<String>,
    pub changed: Vec<String>,
    pub foreign: Vec<String>,
}

impl ScanReport {
    pub fn needs_download(&self) -> bool {
        !self.missing.is_empty() || !self.changed.is_empty()
    }

    pub fn is_clean(&self) -> bool {
        !self.needs_download() && self.foreign.is_empty()
    }
}

/// The two bookkeeping files are the launcher's own, not the provider's.
pub fn is_reserved(relative: &str) -> bool {
    relative == INDEX_FILE || relative == COMPLETE_MARKER
}

/// Only the root-level copies are bookkeeping. A file named `.line-complete`
/// inside a subdirectory is an ordinary (foreign) file and must not be exempt
/// from the scan.
fn is_bookkeeping(relative: &str) -> bool {
    !relative.contains('/') && is_reserved(relative)
}

fn invalid_index() -> LineError {
    LineError::new(
        ErrorCode::Integrity,
        "Список файлов сборки повреждён. Сборка будет восстановлена.",
        false,
    )
}

pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl FileIndex {
    pub fn validate(&self) -> LineResult<()> {
        if self.schema_version != INDEX_SCHEMA
            || self.files.is_empty()
            || self.files.len() > MAX_INDEXED_FILES
        {
            return Err(invalid_index());
        }
        let mut seen = BTreeSet::new();
        for entry in &self.files {
            if !valid_sha256(&entry.sha256)
                || entry.size > super::config::MAX_UNPACKED_BYTES
                || is_reserved(&entry.path)
                || !seen.insert(entry.path.as_str())
            {
                return Err(invalid_index());
            }
            // Rejects absolute paths, `..`, backslashes and device names before
            // the path is ever joined with the release directory.
            safe_entry_path(&entry.path)?;
        }
        Ok(())
    }
}

/// Pure decision: published index versus what is actually on disk.
///
/// `actual` maps a relative path to (sha256, size). Anything present on disk but
/// absent from the index is foreign, which is what makes a dropped-in mod or a
/// replaced jar visible even when its name looks legitimate.
pub fn compare(index: &FileIndex, actual: &BTreeMap<String, (String, u64)>) -> ScanReport {
    let expected: BTreeSet<&str> = index.files.iter().map(|e| e.path.as_str()).collect();
    let mut report = ScanReport {
        checked: index.files.len(),
        ..ScanReport::default()
    };
    for entry in &index.files {
        match actual.get(&entry.path) {
            None => report.missing.push(entry.path.clone()),
            Some((sha, size)) if *sha != entry.sha256 || *size != entry.size => {
                report.changed.push(entry.path.clone());
            }
            Some(_) => {}
        }
    }
    for path in actual.keys() {
        if !expected.contains(path.as_str()) {
            report.foreign.push(path.clone());
        }
    }
    report
}

pub fn write_index(release: &Path, index: &FileIndex) -> LineResult<()> {
    index.validate()?;
    let bytes = serde_json::to_vec(index).map_err(|_| invalid_index())?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err(invalid_index());
    }
    atomic_write(&release.join(INDEX_FILE), &bytes)
}

pub fn read_index(release: &Path) -> LineResult<FileIndex> {
    let path = release.join(INDEX_FILE);
    let metadata = fs::symlink_metadata(&path).map_err(|_| invalid_index())?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_INDEX_BYTES {
        return Err(invalid_index());
    }
    let bytes = fs::read(&path).map_err(|_| invalid_index())?;
    let index: FileIndex = serde_json::from_slice(&bytes).map_err(|_| invalid_index())?;
    index.validate()?;
    Ok(index)
}

fn hash_file(path: &Path) -> LineResult<(String, u64)> {
    let mut file = File::open(path).map_err(|e| LineError::io(&e))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 128 * 1024];
    let mut size = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(|e| LineError::io(&e))?;
        if count == 0 {
            break;
        }
        size = size.saturating_add(count as u64);
        hasher.update(&buffer[..count]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

/// Walks the release without following links. A symlink or special file is not
/// something to hash: it fails the scan so the caller repairs the whole release.
fn collect(release: &Path) -> LineResult<BTreeMap<String, (String, u64)>> {
    let mut actual = BTreeMap::new();
    let mut stack: Vec<PathBuf> = vec![release.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| LineError::io(&e))?;
        for entry in entries {
            let entry = entry.map_err(|e| LineError::io(&e))?;
            let path = entry.path();
            let kind = fs::symlink_metadata(&path)
                .map_err(|e| LineError::io(&e))?
                .file_type();
            let relative = path
                .strip_prefix(release)
                .map_err(|_| invalid_index())?
                .to_string_lossy()
                .replace('\\', "/");
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            if !kind.is_file() {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    "В сборке появился посторонний объект (ссылка или специальный файл).",
                    false,
                ));
            }
            if is_bookkeeping(&relative) {
                continue;
            }
            visited += 1;
            if visited > MAX_INDEXED_FILES {
                return Err(invalid_index());
            }
            actual.insert(relative, hash_file(&path)?);
        }
    }
    Ok(actual)
}

/// Deletes only regular files, only inside the release, and only paths that pass
/// the same traversal validation used at extraction time.
pub fn remove_foreign(release: &Path, foreign: &[String]) -> LineResult<usize> {
    let mut removed = 0usize;
    for relative in foreign {
        let safe = safe_entry_path(relative)?;
        if is_bookkeeping(relative) {
            continue;
        }
        let path = release.join(safe);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => {
                fs::remove_file(&path).map_err(|e| LineError::io(&e))?;
                removed += 1;
            }
            // Already gone, or not a regular file: never recurse into it.
            _ => {}
        }
    }
    Ok(removed)
}

/// Removes directories that became empty after foreign files were deleted.
/// Only ancestors of deleted files are considered, so a directory the pack
/// shipped empty is left alone. The release root is always kept.
pub fn prune_empty_dirs(release: &Path, removed: &[String]) -> LineResult<()> {
    let mut dirs: BTreeSet<PathBuf> = BTreeSet::new();
    for relative in removed {
        let safe = safe_entry_path(relative)?;
        let mut parent = safe.parent();
        while let Some(dir) = parent {
            if dir.as_os_str().is_empty() {
                break;
            }
            dirs.insert(dir.to_path_buf());
            parent = dir.parent();
        }
    }
    let mut ordered: Vec<PathBuf> = dirs.into_iter().collect();
    ordered.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for dir in ordered {
        let path = release.join(dir);
        if is_real_dir(&path) && fs::read_dir(&path).is_ok_and(|mut it| it.next().is_none()) {
            let _ = fs::remove_dir(&path);
        }
    }
    Ok(())
}

/// Hashes every file of the release and compares it with the published index.
/// Read-only: the caller decides what to delete and what to re-download.
pub fn scan(release: &Path) -> LineResult<ScanReport> {
    let index = read_index(release)?;
    let actual = collect(release)?;
    Ok(compare(&index, &actual))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, sha: &str, size: u64) -> FileEntry {
        FileEntry {
            path: path.into(),
            sha256: sha.into(),
            size,
        }
    }

    fn index() -> FileIndex {
        FileIndex {
            schema_version: INDEX_SCHEMA,
            files: vec![
                entry("client.jar", &"a".repeat(64), 10),
                entry("libraries/core.jar", &"b".repeat(64), 20),
            ],
        }
    }

    fn actual() -> BTreeMap<String, (String, u64)> {
        BTreeMap::from([
            ("client.jar".to_string(), ("a".repeat(64), 10)),
            ("libraries/core.jar".to_string(), ("b".repeat(64), 20)),
        ])
    }

    #[test]
    fn an_untouched_release_needs_nothing() {
        let report = compare(&index(), &actual());
        assert!(report.is_clean());
        assert!(!report.needs_download());
        assert_eq!(report.checked, 2);
    }

    #[test]
    fn a_dropped_in_file_is_foreign_even_with_a_plausible_name() {
        let mut disk = actual();
        disk.insert("libraries/cheat.jar".into(), ("c".repeat(64), 5));
        disk.insert("mods/injected.jar".into(), ("d".repeat(64), 7));
        let report = compare(&index(), &disk);
        assert_eq!(
            report.foreign,
            vec!["libraries/cheat.jar", "mods/injected.jar"]
        );
        // Foreign files are deleted, not re-downloaded: the archive has no such file.
        assert!(!report.needs_download());
        assert!(!report.is_clean());
    }

    #[test]
    fn a_replaced_or_missing_file_forces_a_download() {
        let mut disk = actual();
        disk.insert("client.jar".into(), ("f".repeat(64), 10));
        disk.remove("libraries/core.jar");
        let report = compare(&index(), &disk);
        assert_eq!(report.changed, vec!["client.jar"]);
        assert_eq!(report.missing, vec!["libraries/core.jar"]);
        assert!(report.needs_download());
    }

    #[test]
    fn a_same_size_edit_is_still_detected_by_hash() {
        let mut disk = actual();
        // Same length, different bytes: a size-only check would miss this.
        disk.insert("client.jar".into(), ("e".repeat(64), 10));
        let report = compare(&index(), &disk);
        assert_eq!(report.changed, vec!["client.jar"]);
        assert!(report.needs_download());
    }

    #[test]
    fn bookkeeping_names_are_exempt_only_at_the_release_root() {
        assert!(is_bookkeeping(INDEX_FILE));
        assert!(is_bookkeeping(COMPLETE_MARKER));
        assert!(!is_bookkeeping("mods/.line-complete"));
        // A foreign file must not hide behind a bookkeeping name in a subdir.
        let mut disk = actual();
        disk.insert("mods/.line-files.json".into(), ("c".repeat(64), 3));
        let report = compare(&index(), &disk);
        assert_eq!(report.foreign, vec!["mods/.line-files.json"]);
    }

    #[test]
    fn the_index_rejects_unsafe_and_duplicate_paths() {
        for bad in [
            "../evil.jar",
            "/etc/passwd",
            "..\\evil.jar",
            INDEX_FILE,
            COMPLETE_MARKER,
        ] {
            let mut broken = index();
            broken.files.push(entry(bad, &"a".repeat(64), 1));
            assert!(broken.validate().is_err(), "accepted {bad}");
        }
        let mut duplicate = index();
        duplicate
            .files
            .push(entry("client.jar", &"a".repeat(64), 10));
        assert!(duplicate.validate().is_err());
        let mut bad_hash = index();
        bad_hash.files[0].sha256 = "A".repeat(64);
        assert!(bad_hash.validate().is_err());
        assert!(index().validate().is_ok());
    }
}

#[cfg(test)]
mod filesystem_tests {
    use super::*;

    fn release() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let release = temp.path().join("release");
        fs::create_dir_all(release.join("libraries")).unwrap();
        fs::write(release.join("client.jar"), b"client bytes").unwrap();
        fs::write(release.join("libraries/core.jar"), b"core bytes").unwrap();
        let mut files = Vec::new();
        for (path, bytes) in [
            ("client.jar", &b"client bytes"[..]),
            ("libraries/core.jar", &b"core bytes"[..]),
        ] {
            files.push(FileEntry {
                path: path.into(),
                sha256: format!("{:x}", Sha256::digest(bytes)),
                size: bytes.len() as u64,
            });
        }
        let index = FileIndex {
            schema_version: INDEX_SCHEMA,
            files,
        };
        write_index(&release, &index).unwrap();
        (temp, release)
    }

    #[test]
    fn a_written_index_scans_clean_and_survives_a_round_trip() {
        let (_temp, release) = release();
        let report = scan(&release).unwrap();
        assert!(report.is_clean());
        assert_eq!(report.checked, 2);
        assert_eq!(read_index(&release).unwrap().files.len(), 2);
    }

    #[test]
    fn tampering_editing_and_deleting_are_all_visible() {
        let (_temp, release) = release();
        fs::create_dir_all(release.join("mods")).unwrap();
        fs::write(release.join("mods/cheat.jar"), b"cheat").unwrap();
        // Same length as the original, different bytes.
        fs::write(release.join("client.jar"), b"CLIENT BYTES").unwrap();
        fs::remove_file(release.join("libraries/core.jar")).unwrap();
        let report = scan(&release).unwrap();
        assert_eq!(report.changed, vec!["client.jar"]);
        assert_eq!(report.missing, vec!["libraries/core.jar"]);
        assert_eq!(report.foreign, vec!["mods/cheat.jar"]);
        assert!(report.needs_download());
        assert_eq!(remove_foreign(&release, &report.foreign).unwrap(), 1);
        prune_empty_dirs(&release, &report.foreign).unwrap();
        assert!(!release.join("mods").exists());
        // Deleting the foreign file does not repair the edited/missing ones.
        assert!(scan(&release).unwrap().needs_download());
    }

    #[test]
    fn a_missing_index_forces_a_repair_instead_of_launching() {
        let (_temp, release) = release();
        fs::remove_file(release.join(INDEX_FILE)).unwrap();
        assert!(scan(&release).is_err());
    }

    #[test]
    fn a_planted_symlink_is_never_hashed_or_followed() {
        let (temp, release) = release();
        let outside = temp.path().join("outside.jar");
        fs::write(&outside, b"outside").unwrap();
        fs::remove_file(release.join("client.jar")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, release.join("client.jar")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, release.join("client.jar")).unwrap();
        assert!(scan(&release).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
    }
}
