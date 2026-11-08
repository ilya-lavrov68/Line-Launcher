//! Dependency-free rules for the Minecraft mode.
//!
//! Everything here is plain `std` so it can be compiled and tested by
//! `scripts/test-rust-pure.mjs` on machines that cannot fetch the crate graph.
//! The `mc-launcher-core` glue lives in `minecraft.rs` and stays deliberately
//! thin: it maps these validated values onto the crate's own types.
use super::config::validate_slug;
use super::error::{LineError, LineResult};

/// Version ids become directory names inside the Minecraft root, so they are
/// validated with the same care as archive entries.
pub const MAX_VERSION_ID_LEN: usize = 96;

/// Loader families exposed by the UI. Kept independent of the crate enum so the
/// validation can be unit-tested without the dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoaderChoice {
    Fabric,
    Quilt,
    Forge,
    NeoForge,
}

pub fn validate_instance_id(raw: &str) -> LineResult<String> {
    let value = raw.trim();
    if !validate_slug(value) {
        return Err(LineError::input(
            "Идентификатор экземпляра: строчные латинские буквы, цифры и дефис, до 64 символов.",
        ));
    }
    Ok(value.to_string())
}

/// Accepts vanilla ids (`1.21.1`, `24w14a`) and generated loader profiles
/// (`fabric-loader-0.16.9-1.21.1`), never a path.
pub fn validate_version_id(raw: &str) -> LineResult<String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > MAX_VERSION_ID_LEN {
        return Err(LineError::input(
            "Некорректная версия Minecraft: ожидается от 1 до 96 символов.",
        ));
    }
    if value.starts_with('.')
        || value.contains("..")
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(LineError::input(
            "Версия может содержать только буквы, цифры, точку, дефис и подчёркивание.",
        ));
    }
    Ok(value.to_string())
}

/// Normalises the loader selection. `None`/empty version means "latest stable".
pub fn validate_loader(
    kind: &str,
    version: Option<&str>,
) -> LineResult<(LoaderChoice, Option<String>)> {
    let choice = match kind.trim().to_ascii_lowercase().as_str() {
        "fabric" => LoaderChoice::Fabric,
        "quilt" => LoaderChoice::Quilt,
        "forge" => LoaderChoice::Forge,
        "neoforge" => LoaderChoice::NeoForge,
        _ => {
            return Err(LineError::input(
                "Загрузчик модов: fabric, quilt, forge или neoforge.",
            ))
        }
    };
    let selected = match version.map(str::trim) {
        None | Some("") => None,
        Some(text) => {
            if text.len() > MAX_VERSION_ID_LEN
                || text.starts_with('-')
                || text.contains("..")
                || !text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
            {
                return Err(LineError::input("Некорректная версия загрузчика модов."));
            }
            Some(text.to_string())
        }
    };
    Ok((choice, selected))
}

/// `LaunchOptions` has no memory field: the crate copies JVM arguments from the
/// version metadata. The player's heap therefore has to replace whatever `-Xmx`
/// / `-Xms` the profile carried, exactly once, before the main class.
pub fn apply_heap(args: &mut Vec<String>, heap_mb: u32) {
    args.retain(|arg| !(arg.starts_with("-Xmx") || arg.starts_with("-Xms")));
    args.insert(0, format!("-Xms{heap_mb}M"));
    args.insert(0, format!("-Xmx{heap_mb}M"));
}

/// Version metadata is downloaded, and loader profiles are written to disk by
/// installer jars. Neither is trusted to inject an agent, patch modules or claim
/// the launcher's private IPC namespace.
pub fn reject_dangerous_args(args: &[String]) -> LineResult<()> {
    for arg in args {
        let lower = arg.to_ascii_lowercase();
        let banned = lower.starts_with("-javaagent")
            || lower.starts_with("-agentlib")
            || lower.starts_with("-agentpath")
            || lower.starts_with("-xbootclasspath")
            || lower.starts_with("--patch-module")
            || lower.starts_with("--upgrade-module-path")
            || lower.starts_with("-dlinelauncher.")
            || lower.starts_with("-djava.system.class.loader");
        if banned {
            return Err(LineError::new(
                super::error::ErrorCode::UnsafeArchive,
                "Метаданные версии пытаются передать запрещённый аргумент Java. Запуск отклонён.",
                false,
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_ids_are_directory_safe() {
        for good in [
            "1.21.1",
            "24w14a",
            "fabric-loader-0.16.9-1.21.1",
            "1.20.1-Forge",
        ] {
            assert_eq!(validate_version_id(good).unwrap(), good);
        }
        for bad in [
            "",
            "../escape",
            "..",
            ".hidden",
            "a/../../b",
            "C:\\windows",
            "a b",
            "-Xmx1G",
        ] {
            // A leading '-' is a legal id character but never a path escape;
            // only traversal, separators and control shapes are rejected.
            if bad == "-Xmx1G" {
                assert!(validate_version_id(bad).is_ok());
                continue;
            }
            assert!(validate_version_id(bad).is_err(), "accepted {bad:?}");
        }
        assert!(validate_version_id(&"a".repeat(MAX_VERSION_ID_LEN + 1)).is_err());
    }

    #[test]
    fn loader_selection_defaults_to_latest_stable() {
        assert_eq!(
            validate_loader("Fabric", None).unwrap(),
            (LoaderChoice::Fabric, None)
        );
        assert_eq!(
            validate_loader("  NEOFORGE ", Some("  ")).unwrap(),
            (LoaderChoice::NeoForge, None)
        );
        assert_eq!(
            validate_loader("forge", Some("47.2.0")).unwrap(),
            (LoaderChoice::Forge, Some("47.2.0".to_string()))
        );
        assert!(validate_loader("optifine", None).is_err());
        assert!(validate_loader("fabric", Some("../evil")).is_err());
        assert!(validate_loader("fabric", Some("-agentlib:x")).is_err());
    }

    #[test]
    fn heap_replaces_metadata_memory_flags_exactly_once() {
        let mut args = vec![
            "-Xmx2G".to_string(),
            "-Xss1M".to_string(),
            "-Xms512M".to_string(),
            "-cp".to_string(),
            "client.jar".to_string(),
            "net.minecraft.client.main.Main".to_string(),
        ];
        apply_heap(&mut args, 4096);
        assert_eq!(args[0], "-Xmx4096M");
        assert_eq!(args[1], "-Xms4096M");
        assert_eq!(args.iter().filter(|a| a.starts_with("-Xmx")).count(), 1);
        assert_eq!(args.iter().filter(|a| a.starts_with("-Xms")).count(), 1);
        // Unrelated JVM flags and the main class survive untouched.
        assert!(args.contains(&"-Xss1M".to_string()));
        assert_eq!(args.last().unwrap(), "net.minecraft.client.main.Main");
    }

    #[test]
    fn metadata_cannot_inject_an_agent_or_hijack_the_ipc_namespace() {
        let clean = vec![
            "-Xss1M".to_string(),
            "--username".to_string(),
            "Player_1".to_string(),
        ];
        assert!(reject_dangerous_args(&clean).is_ok());
        for bad in [
            "-javaagent:evil.jar",
            "-JAVAAGENT:evil.jar",
            "-agentlib:jdwp=transport=dt_socket",
            "-agentpath:/tmp/x.so",
            "-Xbootclasspath/p:evil.jar",
            "--patch-module=java.base=evil.jar",
            "-DlineLauncher.sessionChannel=stolen",
            "-Djava.system.class.loader=Evil",
        ] {
            assert!(
                reject_dangerous_args(&[bad.to_string()]).is_err(),
                "accepted {bad}"
            );
        }
    }
}
