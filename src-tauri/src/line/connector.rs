//! Narrow proof for Connector's untransformed direct nested-JAR cache.
//! The caller supplies a release index that was just integrity-scanned while
//! holding the server lock. Unknown cache entries remain blocked.
use super::error::{LineError, LineResult};
use super::integrity::{self, FileIndex};
use super::pack::checked_game_path;
use super::storage::is_real_file;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

const MAX_PARENT: u64 = 256 * 1024 * 1024;
const MAX_METADATA: u64 = 1024 * 1024;
const MAX_NESTED: u64 = 128 * 1024 * 1024;
const MAX_JAR_ENTRIES: usize = 50_000;

/// Only direct, untransformed children of a top-level provider mod are covered.
/// No wildcard exemption for `.connector`, recursive caches or transformed jars.
fn connector_names(relative: &str) -> Option<(&str, &str)> {
    let name = relative.strip_prefix("mods/.connector/temp/")?;
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    let (parent, child) = name.split_once('$')?;
    if parent.is_empty() || child.is_empty() || child.contains('$') || !child.ends_with(".jar") {
        return None;
    }
    Some((parent, child))
}

#[derive(Default)]
pub struct ParentChecks(Option<(String, Vec<u8>)>);

/// Returns false for anything not proved; never considers a cache path trusted
/// merely because of its name or because it was seen on a previous run.
pub fn matches_verified_nested(
    game: &Path,
    index: &FileIndex,
    prefix: &str,
    relative: &str,
    checked: &mut ParentChecks,
) -> LineResult<bool> {
    let Some((parent_name, child_name)) = connector_names(relative) else {
        return Ok(false);
    };
    let expected_parent = format!("mods/{parent_name}.jar");
    let mut parents = index
        .files
        .iter()
        .filter(|entry| entry.path.strip_prefix(prefix) == Some(expected_parent.as_str()));
    let Some(parent) = parents.next() else {
        return Ok(false);
    };
    if parents.next().is_some() {
        return Ok(false);
    }
    let path = checked_game_path(game, &expected_parent, false)?;
    if !is_real_file(&path) || parent.size > MAX_PARENT {
        return Ok(false);
    }
    if !checked
        .0
        .as_ref()
        .is_some_and(|(name, _)| name == &expected_parent)
    {
        let file = std::fs::File::open(path).map_err(|e| LineError::io(&e))?;
        let mut bytes = Vec::new();
        file.take(MAX_PARENT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| LineError::io(&e))?;
        if bytes.len() as u64 != parent.size
            || format!("{:x}", Sha256::digest(&bytes)) != parent.sha256
        {
            checked.0 = None;
            return Ok(false);
        }
        checked.0 = Some((expected_parent, bytes));
    }
    let bytes = &checked.0.as_ref().expect("verified parent").1;
    let mut archive = match zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    if archive.len() > MAX_JAR_ENTRIES {
        return Ok(false);
    }
    // Reject duplicate metadata or nested paths; ZIP name lookup alone is ambiguous.
    let mut metadata_count = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| LineError::storage())?;
        if entry.name() == "fabric.mod.json" {
            metadata_count += 1;
        }
    }
    if metadata_count != 1 {
        return Ok(false);
    }
    let mut metadata = Vec::new();
    {
        let entry = match archive.by_name("fabric.mod.json") {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        if entry.size() > MAX_METADATA {
            return Ok(false);
        }
        entry
            .take(MAX_METADATA + 1)
            .read_to_end(&mut metadata)
            .map_err(|_| LineError::storage())?;
    }
    if metadata.len() as u64 > MAX_METADATA {
        return Ok(false);
    }
    let json: serde_json::Value = match serde_json::from_slice(&metadata) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let Some(jars) = json.get("jars").and_then(|value| value.as_array()) else {
        return Ok(false);
    };
    if jars.len() > 4096 {
        return Ok(false);
    }
    let mut candidate = None;
    for jar in jars {
        let Some(name) = jar.get("file").and_then(|value| value.as_str()) else {
            return Ok(false);
        };
        if super::install::safe_entry_path(name).is_err() || name.contains('\\') {
            return Ok(false);
        }
        if name.rsplit('/').next() == Some(child_name) {
            if candidate.replace(name).is_some() {
                return Ok(false);
            }
        }
    }
    let Some(candidate) = candidate else {
        return Ok(false);
    };
    let mut matches = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| LineError::storage())?;
        if entry.name() == candidate {
            matches += 1;
        }
    }
    if matches != 1 {
        return Ok(false);
    }
    let entry = match archive.by_name(candidate) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    if entry.is_dir() || entry.size() > MAX_NESTED {
        return Ok(false);
    }
    let expected_size = entry.size();
    let mut reader = entry.take(MAX_NESTED + 1);
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buffer).map_err(|_| LineError::storage())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_NESTED {
            return Ok(false);
        }
        hasher.update(&buffer[..n]);
    }
    if total != expected_size {
        return Ok(false);
    }
    let live = checked_game_path(game, relative, false)?;
    if !is_real_file(&live) {
        return Ok(false);
    }
    let meta = std::fs::metadata(&live).map_err(|e| LineError::io(&e))?;
    if meta.len() != total {
        return Ok(false);
    }
    let (actual, size) = integrity::hash_file(&live)?;
    Ok(size == total && actual == format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn narrow_cache_names_only() {
        assert_eq!(
            connector_names("mods/.connector/temp/parent$child.jar"),
            Some(("parent", "child.jar"))
        );
        for name in [
            "mods/.connector/temp/parent$child$grandchild.jar",
            "mods/.connector/output/parent$child.jar",
            "mods/.connector/temp/sub/parent$child.jar",
            "mods/.connector/temp/parent$child.zip",
            "mods/.connector/temp/$child.jar",
        ] {
            assert_eq!(connector_names(name), None);
        }
    }
    fn parent_jar(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn only_declared_byte_identical_nested_jar_of_verified_parent_is_accepted() {
        let temp = tempfile::tempdir().unwrap();
        let game = temp.path();
        std::fs::create_dir_all(game.join("mods/.connector/temp")).unwrap();
        let parent = game.join("mods/parent.jar");
        let child = game.join("mods/.connector/temp/parent$child.jar");
        let bytes = parent_jar(&[
            (
                "fabric.mod.json",
                br#"{"jars":[{"file":"META-INF/jars/child.jar"}]}"#,
            ),
            ("META-INF/jars/child.jar", b"nested jar bytes"),
            ("META-INF/jars/undeclared.jar", b"other"),
        ]);
        std::fs::write(&parent, &bytes).unwrap();
        std::fs::write(&child, b"nested jar bytes").unwrap();
        let index = FileIndex {
            schema_version: integrity::INDEX_SCHEMA,
            files: vec![integrity::FileEntry {
                path: "wrapped/minecraft/mods/parent.jar".into(),
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                size: bytes.len() as u64,
            }],
        };
        let check = |name: &str| {
            matches_verified_nested(
                game,
                &index,
                "wrapped/minecraft/",
                name,
                &mut ParentChecks::default(),
            )
            .unwrap()
        };
        assert!(check("mods/.connector/temp/parent$child.jar"));
        std::fs::write(&child, b"nested jar byteS").unwrap();
        assert!(!check("mods/.connector/temp/parent$child.jar"));
        std::fs::write(
            game.join("mods/.connector/temp/parent$undeclared.jar"),
            b"other",
        )
        .unwrap();
        assert!(!check("mods/.connector/temp/parent$undeclared.jar"));
        std::fs::write(&child, b"nested jar bytes").unwrap();
        std::fs::write(
            &parent,
            parent_jar(&[
                (
                    "fabric.mod.json",
                    br#"{"jars":[{"file":"META-INF/jars/child.jar"}]}"#,
                ),
                ("META-INF/jars/child.jar", b"nested jar bytes"),
            ]),
        )
        .unwrap();
        assert!(!check("mods/.connector/temp/parent$child.jar"));
    }

    #[test]
    fn duplicate_declared_basename_is_not_trusted() {
        let temp = tempfile::tempdir().unwrap();
        let game = temp.path();
        std::fs::create_dir_all(game.join("mods/.connector/temp")).unwrap();
        let bytes = parent_jar(&[
            (
                "fabric.mod.json",
                br#"{"jars":[{"file":"a/child.jar"},{"file":"b/child.jar"}]}"#,
            ),
            ("a/child.jar", b"child"),
            ("b/child.jar", b"child"),
        ]);
        std::fs::write(game.join("mods/parent.jar"), &bytes).unwrap();
        std::fs::write(game.join("mods/.connector/temp/parent$child.jar"), b"child").unwrap();
        let index = FileIndex {
            schema_version: integrity::INDEX_SCHEMA,
            files: vec![integrity::FileEntry {
                path: "mods/parent.jar".into(),
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                size: bytes.len() as u64,
            }],
        };
        assert!(!matches_verified_nested(
            game,
            &index,
            "",
            "mods/.connector/temp/parent$child.jar",
            &mut ParentChecks::default()
        )
        .unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn parent_symlink_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let game = temp.path();
        std::fs::create_dir_all(game.join("mods/.connector/temp")).unwrap();
        std::os::unix::fs::symlink(game.join("outside"), game.join("mods/parent.jar")).unwrap();
        let index = FileIndex {
            schema_version: integrity::INDEX_SCHEMA,
            files: vec![integrity::FileEntry {
                path: "mods/parent.jar".into(),
                sha256: "a".repeat(64),
                size: 1,
            }],
        };
        assert!(!matches_verified_nested(
            game,
            &index,
            "",
            "mods/.connector/temp/parent$child.jar",
            &mut ParentChecks::default()
        )
        .unwrap_or(false));
    }
}
