//! Read-only inventory of the asset objects named by a Minecraft asset index.
//!
//! Matching a path and size is only an inventory hint, not proof that the
//! object's SHA-1 is correct. The enclosing release index has SHA-256 hashes of
//! its own files but does not authenticate their correspondence to Mojang's
//! asset index. A future downloader must validate the expected object hash.
use super::error::{LineError, LineResult};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

pub const MAX_ASSET_INDEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_ASSET_ENTRIES: usize = 500_000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AssetInventory {
    pub unique_objects: u64,
    pub present_by_size: u64,
    pub missing: u64,
    pub wrong_size: u64,
    /// Sum of expected bytes for missing or wrong-sized unique objects.
    pub missing_bytes: u64,
}

fn invalid() -> LineError {
    LineError::input("Индекс ресурсов Minecraft повреждён или превышает допустимые пределы.")
}

/// `release_files` must describe files from a separately verified release.
/// Duplicate logical asset names with the same object hash count only once.
pub fn inventory(
    bytes: &[u8],
    release_files: impl IntoIterator<Item = (String, u64)>,
    prefix: &str,
) -> LineResult<AssetInventory> {
    if bytes.len() > MAX_ASSET_INDEX_BYTES {
        return Err(invalid());
    }
    let expected = parse_objects(bytes)?;
    let files: BTreeMap<_, _> = release_files.into_iter().collect();
    let mut result = AssetInventory::default();
    for (hash, size) in expected {
        result.unique_objects += 1;
        let path = format!("{prefix}assets/objects/{}/{}", &hash[..2], hash);
        match files.get(&path) {
            Some(actual) if *actual == size => result.present_by_size += 1,
            Some(_) => {
                result.wrong_size += 1;
                result.missing_bytes =
                    result.missing_bytes.checked_add(size).ok_or_else(invalid)?;
            }
            None => {
                result.missing += 1;
                result.missing_bytes =
                    result.missing_bytes.checked_add(size).ok_or_else(invalid)?;
            }
        }
    }
    Ok(result)
}

fn parse_objects(bytes: &[u8]) -> LineResult<BTreeMap<String, u64>> {
    if bytes.len() > MAX_ASSET_INDEX_BYTES {
        return Err(invalid());
    }
    let json: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let objects = json
        .get("objects")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if objects.len() > MAX_ASSET_ENTRIES {
        return Err(invalid());
    }
    let mut expected = BTreeMap::new();
    for object in objects.values() {
        let hash = object
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let size = object
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(invalid)?;
        if hash.len() != 40
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        if let Some(old) = expected.insert(hash.to_string(), size) {
            if old != size {
                return Err(invalid());
            }
        }
    }
    Ok(expected)
}

/// Read-only comparison with actual live asset files. `hash_file` must calculate
/// lowercase SHA-1 over the file bytes. SHA-1 matches Mojang's asset-index format;
/// it is not a modern anti-cheat authenticity guarantee. The caller must obtain
/// `bytes` from an already verified release, not from the writable game tree.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LiveAssets {
    pub unique_objects: u64,
    pub matched_sha1: u64,
    pub missing: u64,
    pub wrong_size: u64,
    pub wrong_hash: u64,
    pub needed_bytes: u64,
}

fn checked_directory(path: &Path) -> LineResult<bool> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(LineError::io(&e)),
        Ok(_) if super::storage::is_real_dir(path) => Ok(true),
        Ok(_) => Err(LineError::new(
            super::error::ErrorCode::Integrity,
            "Папка ресурсов не является обычным каталогом.",
            false,
        )),
    }
}

pub fn inspect_live(
    bytes: &[u8],
    game: &Path,
    mut hash_file: impl FnMut(&Path) -> LineResult<String>,
) -> LineResult<LiveAssets> {
    let expected = parse_objects(bytes)?;
    if !super::storage::is_real_dir(game) {
        return Err(LineError::new(
            super::error::ErrorCode::Integrity,
            "Папка игры не является обычным каталогом.",
            false,
        ));
    }
    let assets = game.join("assets");
    let objects = assets.join("objects");
    let objects_exist = checked_directory(&assets)? && checked_directory(&objects)?;
    let mut directories = BTreeMap::new();
    let mut result = LiveAssets::default();
    for (hash, size) in expected {
        result.unique_objects += 1;
        let part = &hash[..2];
        let folder = objects.join(part);
        let folder_exists = if !objects_exist {
            false
        } else if let Some(exists) = directories.get(part) {
            *exists
        } else {
            let exists = checked_directory(&folder)?;
            directories.insert(part.to_owned(), exists);
            exists
        };
        let path = folder.join(&hash);
        let meta = if folder_exists {
            match std::fs::symlink_metadata(&path) {
                Ok(meta) => Some(meta),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(LineError::io(&e)),
            }
        } else {
            None
        };
        match meta {
            None => result.missing += 1,
            Some(_) if !super::storage::is_real_file(&path) => {
                return Err(LineError::new(
                    super::error::ErrorCode::Integrity,
                    "Файл ресурсов не является обычным файлом.",
                    false,
                ))
            }
            Some(meta) if meta.len() != size => result.wrong_size += 1,
            Some(_) if hash_file(&path)? != hash => result.wrong_hash += 1,
            Some(_) => {
                result.matched_sha1 += 1;
                continue;
            }
        }
        result.needed_bytes = result.needed_bytes.checked_add(size).ok_or_else(invalid)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_unique_present_missing_and_wrong_size_without_trusting_sizes() {
        let input = br#"{"objects":{"first":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3},"duplicate":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3},"second":{"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":7},"third":{"hash":"cccccccccccccccccccccccccccccccccccccccc","size":11}}}"#;
        let files = vec![
            (
                "pack/.minecraft/assets/objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                3,
            ),
            (
                "pack/.minecraft/assets/objects/cc/cccccccccccccccccccccccccccccccccccccccc".into(),
                1,
            ),
            ("pack/.minecraft/assets/objects/xx/unrelated".into(), 7),
        ];
        let result = inventory(input, files, "pack/.minecraft/").unwrap();
        assert_eq!(
            result,
            AssetInventory {
                unique_objects: 3,
                present_by_size: 1,
                missing: 1,
                wrong_size: 1,
                missing_bytes: 18
            }
        );
    }

    #[test]
    fn rejects_invalid_hashes_conflicting_sizes_and_oversized_index() {
        for input in [
            &br#"{"objects":{"x":{"hash":"../../evil","size":1}}}"#[..],
            &br#"{"objects":{"x":{"hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","size":1}}}"#[..],
            &br#"{"objects":{"x":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1},"y":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":2}}}"#[..],
            &br#"{"objects":{"x":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":-1}}}"#[..],
            &br#"{"objects":[]}"#[..],
        ] {
            assert!(inventory(input, Vec::new(), "").is_err());
        }
        assert!(inventory(&vec![b' '; MAX_ASSET_INDEX_BYTES + 1], Vec::new(), "").is_err());
    }

    #[test]
    fn live_inventory_hashes_real_files_and_distinguishes_damage() {
        let root = std::env::temp_dir().join(format!(
            "line-assets-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("assets/objects/aa")).unwrap();
        std::fs::create_dir_all(root.join("assets/objects/bb")).unwrap();
        std::fs::create_dir_all(root.join("assets/objects/cc")).unwrap();
        let a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let c = "cccccccccccccccccccccccccccccccccccccccc";
        std::fs::write(root.join("assets/objects/aa").join(a), b"good").unwrap();
        std::fs::write(root.join("assets/objects/bb").join(b), b"evil").unwrap();
        std::fs::write(root.join("assets/objects/cc").join(c), b"x").unwrap();
        let input = br#"{"objects":{"a":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":4},"a-again":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":4},"b":{"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":4},"c":{"hash":"cccccccccccccccccccccccccccccccccccccccc","size":4},"d":{"hash":"dddddddddddddddddddddddddddddddddddddddd","size":10}}}"#;
        let mut calls = 0;
        let actual = inspect_live(input, &root, |path| {
            calls += 1;
            Ok(if std::fs::read(path).unwrap() == b"good" {
                a
            } else {
                "0000000000000000000000000000000000000000"
            }
            .to_string())
        })
        .unwrap();
        assert_eq!(
            actual,
            LiveAssets {
                unique_objects: 4,
                matched_sha1: 1,
                missing: 1,
                wrong_size: 1,
                wrong_hash: 1,
                needed_bytes: 18
            }
        );
        assert_eq!(calls, 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_inventory_refuses_a_symlinked_asset_directory() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "line-assets-links-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        symlink(std::env::temp_dir(), root.join("assets")).unwrap();
        let input =
            br#"{"objects":{"a":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":4}}}"#;
        assert!(inspect_live(input, &root, |_| panic!("must not read through a link")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_byte_sum_cannot_overflow() {
        let input = br#"{"objects":{"x":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":18446744073709551615},"y":{"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":1}}}"#;
        assert!(inventory(input, Vec::new(), "").is_err());
    }
}
