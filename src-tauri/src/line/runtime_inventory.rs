//! Partial, read-only inventory of runtime artifacts in verified version JSON.
//! This is installation integrity, not the mod/resource-pack word scanner.
//! Explicit SHA-1/size artifacts with no rules or simple OS-name-only rules
//! can be counted; complex rules, classifiers and missing metadata are skipped.
use super::error::{ErrorCode, LineError, LineResult};
use super::storage::{is_real_dir, is_real_file};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path};

const MAX_PROFILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_LIBRARIES: usize = 20_000;
/// A bounded IPC payload; refuse rather than approve an incomplete issue list.
const MAX_ISSUES: usize = 2_000;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RuntimeInventory {
    pub checked: u64,
    pub matched: u64,
    pub missing: u64,
    pub wrong_size: u64,
    pub wrong_hash: u64,
    pub needed_bytes: u64,
    pub skipped: u64,
    /// Stable, sorted records: reason, expected SHA-1, expected size, path.
    /// They are informational consent data, never used as filesystem input.
    pub issues: Vec<String>,
}

fn invalid() -> LineError {
    LineError::new(
        ErrorCode::Integrity,
        "Некорректные метаданные файлов Minecraft в сборке.",
        false,
    )
}

fn valid_sha1(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Evaluate only the unambiguous OS-name subset of Mojang rules. Unknown fields,
/// architectures, OS-version regexes and feature flags remain unverified rather
/// than guessing. Matching rules are ordered and the last match wins.
fn simple_os_rules(rules: &Value, os: &str) -> Option<bool> {
    let rules = rules.as_array()?;
    // The installer treats an empty rule list like no rules.
    if rules.is_empty() {
        return Some(true);
    }
    let mut allowed = false;
    for rule in rules {
        let fields = rule.as_object()?;
        if fields.keys().any(|key| key != "action" && key != "os") {
            return None;
        }
        let action = match rule.get("action")?.as_str()? {
            "allow" => true,
            "disallow" => false,
            _ => return None,
        };
        let matches = match rule.get("os") {
            None => true,
            Some(value) => {
                let fields = value.as_object()?;
                if fields.len() != 1 || !fields.contains_key("name") {
                    return None;
                }
                let name = fields.get("name")?.as_str()?;
                if !matches!(name, "windows" | "linux" | "osx") {
                    return None;
                }
                name == os
            }
        };
        if matches {
            allowed = action;
        }
    }
    Some(allowed)
}

fn current_os() -> Option<&'static str> {
    match std::env::consts::OS {
        "windows" => Some("windows"),
        "linux" => Some("linux"),
        "macos" => Some("osx"),
        _ => None,
    }
}

fn add_artifact(
    expected: &mut BTreeMap<String, (String, u64)>,
    path: String,
    artifact: &Value,
) -> LineResult<bool> {
    let (Some(hash), Some(size)) = (
        artifact.get("sha1").and_then(Value::as_str),
        artifact.get("size").and_then(Value::as_u64),
    ) else {
        return Ok(false);
    };
    if !valid_sha1(hash)
        || path.len() > 1024
        || path.chars().any(char::is_control)
        || super::install::safe_entry_path(&path).is_err()
    {
        return Err(invalid());
    }
    let entry = (hash.to_owned(), size);
    if let Some(old) = expected.insert(path, entry.clone()) {
        if old != entry {
            return Err(invalid());
        }
    }
    Ok(true)
}

/// Profiles and their identifiers come from the independently scanned release.
/// No URLs from the profile are fetched; the caller supplies the SHA-1 reader.
pub fn inspect(
    profiles: &[(&str, &[u8])],
    game: &Path,
    mut hash_file: impl FnMut(&Path) -> LineResult<String>,
) -> LineResult<RuntimeInventory> {
    if !is_real_dir(game) {
        return Err(invalid());
    }
    let mut expected = BTreeMap::new();
    let mut skipped = 0u64;
    for (id, bytes) in profiles {
        let id = super::minecraft_core::validate_version_id(id)?;
        if bytes.len() > MAX_PROFILE_BYTES {
            return Err(invalid());
        }
        let profile: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if let Some(client) = profile.get("downloads").and_then(|v| v.get("client")) {
            if !add_artifact(&mut expected, format!("versions/{id}/{id}.jar"), client)? {
                skipped += 1;
            }
        }
        if let Some(libraries) = profile.get("libraries") {
            let libraries = libraries.as_array().ok_or_else(invalid)?;
            if libraries.len() > MAX_LIBRARIES {
                return Err(invalid());
            }
            for library in libraries {
                if library.get("natives").is_some() {
                    skipped += 1;
                    continue;
                }
                if let Some(rules) = library.get("rules") {
                    match current_os().and_then(|os| simple_os_rules(rules, os)) {
                        Some(true) => {}
                        Some(false) => continue,
                        None => {
                            skipped += 1;
                            continue;
                        }
                    }
                }
                let Some(artifact) = library.get("downloads").and_then(|v| v.get("artifact"))
                else {
                    skipped += 1;
                    continue;
                };
                let Some(path) = artifact.get("path").and_then(Value::as_str) else {
                    skipped += 1;
                    continue;
                };
                if super::install::safe_entry_path(path).is_err() {
                    return Err(invalid());
                }
                if !add_artifact(&mut expected, format!("libraries/{path}"), artifact)? {
                    skipped += 1;
                }
            }
        }
    }
    let mut result = RuntimeInventory {
        skipped,
        ..Default::default()
    };
    for (relative, (hash, size)) in expected {
        result.checked += 1;
        let safe = super::install::safe_entry_path(&relative)?;
        let mut path = game.to_path_buf();
        let components: Vec<_> = safe.components().collect();
        let mut missing = false;
        for (i, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                return Err(invalid());
            };
            path.push(name);
            match std::fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing = true;
                    break;
                }
                Err(error) => return Err(LineError::io(&error)),
                Ok(_) if i + 1 < components.len() && !is_real_dir(&path) => return Err(invalid()),
                Ok(_) if i + 1 == components.len() && !is_real_file(&path) => return Err(invalid()),
                Ok(_) => {}
            }
        }
        let reason = if missing {
            result.missing += 1;
            "missing"
        } else if std::fs::metadata(&path)
            .map_err(|e| LineError::io(&e))?
            .len()
            != size
        {
            result.wrong_size += 1;
            "size"
        } else if hash_file(&path)? != hash {
            result.wrong_hash += 1;
            "hash"
        } else {
            result.matched += 1;
            continue;
        };
        if result.issues.len() == MAX_ISSUES {
            return Err(LineError::input("Слишком много отсутствующих или повреждённых компонентов для безопасного подтверждения."));
        }
        result
            .issues
            .push(format!("{reason}\t{hash}\t{size}\t{relative}"));
        result.needed_bytes = result.needed_bytes.checked_add(size).ok_or_else(invalid)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_lowercase_sha1_digests() {
        assert!(valid_sha1(&"a".repeat(40)));
        assert!(!valid_sha1(&"A".repeat(40)));
        assert!(!valid_sha1(&"a".repeat(39)));
        assert!(!valid_sha1(&"g".repeat(40)));
    }

    #[test]
    fn verifies_only_explicit_unruled_artifacts_and_deduplicates() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("libraries/example")).unwrap();
        std::fs::write(temp.path().join("libraries/example/good.jar"), b"good").unwrap();
        std::fs::write(temp.path().join("libraries/example/bad.jar"), b"xxxx").unwrap();
        let json = br#"{"downloads":{"client":{"sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":7}},"libraries":[{"downloads":{"artifact":{"path":"example/good.jar","sha1":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":4}}},{"downloads":{"artifact":{"path":"example/bad.jar","sha1":"cccccccccccccccccccccccccccccccccccccccc","size":4}}},{"rules":[{"action":"allow","features":{"demo":true}}],"downloads":{"artifact":{"path":"example/other.jar","sha1":"dddddddddddddddddddddddddddddddddddddddd","size":4}}}]}"#;
        let report = inspect(&[("1.20.1", json), ("1.20.1", json)], temp.path(), |path| {
            Ok(if path.ends_with("good.jar") {
                "b".repeat(40)
            } else {
                "e".repeat(40)
            })
        })
        .unwrap();
        assert_eq!(
            (
                report.checked,
                report.matched,
                report.missing,
                report.wrong_hash,
                report.needed_bytes,
                report.skipped
            ),
            (3, 1, 1, 1, 11, 2)
        );
        assert_eq!(report.issues.len(), 2);
        assert!(report.issues[0].contains("libraries/example/bad.jar"));
        assert!(report.issues[1].contains("versions/1.20.1/1.20.1.jar"));
    }
    #[test]
    fn simple_platform_rules_are_ordered_and_unknown_conditions_stay_unverified() {
        let parse = |text: &str| serde_json::from_str::<Value>(text).unwrap();
        let rules = parse(
            r#"[{"action":"allow"},{"action":"disallow","os":{"name":"windows"}},{"action":"allow","os":{"name":"linux"}}]"#,
        );
        assert_eq!(simple_os_rules(&parse("[]"), "windows"), Some(true));
        assert_eq!(simple_os_rules(&rules, "windows"), Some(false));
        assert_eq!(simple_os_rules(&rules, "linux"), Some(true));
        assert_eq!(simple_os_rules(&rules, "osx"), Some(true));
        assert_eq!(
            simple_os_rules(
                &parse(r#"[{"action":"allow","os":{"name":"windows"}}]"#),
                "linux"
            ),
            Some(false)
        );
        for unsupported in [
            r#"[{"action":"allow","os":{"name":"windows","arch":"x86"}}]"#,
            r#"[{"action":"allow","os":{"name":"windows","version":"^10"}}]"#,
            r#"[{"action":"allow","features":{"is_demo_user":true}}]"#,
            r#"[{"action":"allow","os":{"name":"unknown"}}]"#,
            r#"[{"action":"other"}]"#,
            r#"{}"#,
        ] {
            assert_eq!(simple_os_rules(&parse(unsupported), "windows"), None);
        }
    }

    #[test]
    fn audits_applicable_rules_but_not_excluded_or_complex_ones() {
        let temp = tempfile::tempdir().unwrap();
        let os = current_os().unwrap();
        let json = format!(
            r#"{{"libraries":[
          {{"rules":[{{"action":"allow","os":{{"name":"{os}"}}}}],"downloads":{{"artifact":{{"path":"included.jar","sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}}}}}},
          {{"rules":[{{"action":"disallow"}}],"downloads":{{"artifact":{{"path":"excluded.jar","sha1":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":3}}}}}},
          {{"rules":[{{"action":"allow","features":{{"demo":true}}}}],"downloads":{{"artifact":{{"path":"unknown.jar","sha1":"cccccccccccccccccccccccccccccccccccccccc","size":3}}}}}}
        ]}}"#
        );
        let report = inspect(
            &[("1.20.1", json.as_bytes())],
            temp.path(),
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!((report.checked, report.missing, report.skipped), (1, 1, 1));
        assert!(report.issues[0].ends_with("libraries/included.jar"));
    }

    #[test]
    fn rejects_bad_paths_and_conflicting_expectations() {
        let temp = tempfile::tempdir().unwrap();
        for json in [
            &br#"{"libraries":[{"downloads":{"artifact":{"path":"../escape.jar","sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}}}]}"#[..],
            &br#"{"libraries":[{"downloads":{"artifact":{"path":"a.jar","sha1":"bad","size":1}}}]}"#[..],
            &br#"{"libraries":[{"downloads":{"artifact":{"path":"a.jar","sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}}},{"downloads":{"artifact":{"path":"a.jar","sha1":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":1}}}]}"#[..],
        ] { assert!(inspect(&[("1.20.1", json)], temp.path(), |_| Ok(String::new())).is_err()); }
    }
    #[test]
    fn issue_identity_changes_even_when_counts_and_sizes_match() {
        let temp = tempfile::tempdir().unwrap();
        let a = br#"{"libraries":[{"downloads":{"artifact":{"path":"a.jar","sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}}}]}"#;
        let b = br#"{"libraries":[{"downloads":{"artifact":{"path":"b.jar","sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":3}}}]}"#;
        let first = inspect(&[("1.20.1", a)], temp.path(), |_| unreachable!()).unwrap();
        let second = inspect(&[("1.20.1", b)], temp.path(), |_| unreachable!()).unwrap();
        assert_eq!(
            (first.missing, first.needed_bytes),
            (second.missing, second.needed_bytes)
        );
        assert_ne!(first.issues, second.issues);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_parents() {
        let temp = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(temp.path(), temp.path().join("libraries")).unwrap();
        let json = br#"{"libraries":[{"downloads":{"artifact":{"path":"a.jar","sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}}}]}"#;
        assert!(inspect(&[("1.20.1", json)], temp.path(), |_| Ok(String::new())).is_err());
    }
}
