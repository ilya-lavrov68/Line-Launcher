//! Read-only inventory of the asset objects named by a Minecraft asset index.
//!
//! Matching a path and size is only an inventory hint, not proof that the
//! object's SHA-1 is correct. The enclosing release index has SHA-256 hashes of
//! its own files but does not authenticate their correspondence to Mojang's
//! asset index. A future downloader must validate the expected object hash.
use super::error::{LineError, LineResult};
use serde_json::Value;
use std::collections::BTreeMap;

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
    fn missing_byte_sum_cannot_overflow() {
        let input = br#"{"objects":{"x":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":18446744073709551615},"y":{"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":1}}}"#;
        assert!(inventory(input, Vec::new(), "").is_err());
    }
}
