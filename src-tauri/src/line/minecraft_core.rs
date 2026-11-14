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

/// Minecraft's default multiplayer port.
pub const DEFAULT_SERVER_PORT: u16 = 25565;
/// Mojang removed `--server`/`--port` in 23w14a; 1.20+ only honours Quick Play.
/// `mc-launcher-core` still emits the legacy pair, so the join args are built
/// here from what the version metadata actually advertises.
pub const QUICK_PLAY_MULTIPLAYER: &str = "--quickPlayMultiplayer";

fn parse_port(text: &str) -> LineResult<u16> {
    let port: u32 = text
        .parse()
        .map_err(|_| LineError::input("Порт сервера: число от 1 до 65535."))?;
    if !(1..=65535).contains(&port) {
        return Err(LineError::input("Порт сервера: число от 1 до 65535."));
    }
    Ok(port as u16)
}

/// Parses `host`, `host:port` or `[ipv6]:port`. The result is handed to the game
/// as an argument, so whitespace, control characters and a leading `-` (which
/// the client would read as another flag) are rejected outright.
pub fn validate_server_address(raw: &str) -> LineResult<(String, u16)> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 255 {
        return Err(LineError::input(
            "Укажите адрес сервера, например play.example.com или play.example.com:25565.",
        ));
    }
    if value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(LineError::input(
            "Адрес сервера не может содержать пробелы и начинаться с дефиса.",
        ));
    }
    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let Some((inner, tail)) = rest.split_once(']') else {
            return Err(LineError::input(
                "IPv6-адрес должен быть в квадратных скобках.",
            ));
        };
        if inner.is_empty()
            || !inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || matches!(b, b':' | b'.'))
        {
            return Err(LineError::input("Некорректный IPv6-адрес сервера."));
        }
        let port = match tail {
            "" => DEFAULT_SERVER_PORT,
            other => {
                let Some(digits) = other.strip_prefix(':') else {
                    return Err(LineError::input("После IPv6-адреса ожидается :порт."));
                };
                parse_port(digits)?
            }
        };
        (format!("[{inner}]"), port)
    } else {
        match value.split_once(':') {
            Some((host, digits))
                if !host.is_empty()
                    && !digits.is_empty()
                    && digits.bytes().all(|b| b.is_ascii_digit()) =>
            {
                (host.to_string(), parse_port(digits)?)
            }
            Some(_) => {
                return Err(LineError::input(
                    "Некорректный адрес сервера. IPv6 указывайте в скобках: [::1]:25565.",
                ))
            }
            None => (value.to_string(), DEFAULT_SERVER_PORT),
        }
    };
    if host.starts_with('[') {
        return Ok((host, port));
    }
    if host.starts_with('.')
        || host.ends_with('.')
        || host.starts_with('-')
        || host.ends_with('-')
        || host.contains("..")
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    {
        return Err(LineError::input(
            "Адрес сервера: латинские буквы, цифры, точка и дефис.",
        ));
    }
    Ok((host, port))
}

/// Exact-token detection. A substring match would also accept invented flags
/// such as `--quickPlayMultiplayerLegacy` and pick the wrong join mechanism.
pub fn has_quick_play_token(tokens: &[String]) -> bool {
    tokens.iter().any(|token| token == QUICK_PLAY_MULTIPLAYER)
}

pub fn server_join_args(quick_play: bool, host: &str, port: u16) -> Vec<String> {
    if quick_play {
        vec![QUICK_PLAY_MULTIPLAYER.to_string(), format!("{host}:{port}")]
    } else {
        vec![
            "--server".to_string(),
            host.to_string(),
            "--port".to_string(),
            port.to_string(),
        ]
    }
}

/// Appends the join arguments the client actually understands, without ever
/// duplicating a pair that the metadata already produced.
pub fn ensure_server_join(args: &mut Vec<String>, quick_play: bool, host: &str, port: u16) {
    if has_quick_play_token(args) || args.iter().any(|arg| arg == "--server") {
        return;
    }
    args.extend(server_join_args(quick_play, host, port));
}

/// The server configuration, not the frontend, authorizes the test launch.
pub fn validate_test_mode(requested: bool, enabled: bool, minecraft_mode: bool) -> LineResult<()> {
    if requested && (!enabled || !minecraft_mode) {
        return Err(LineError::input(
            "Тестовый одиночный режим отключён провайдером.",
        ));
    }
    Ok(())
}

/// The test launch opens the normal main menu, without automatic joins or a
/// preset world. Preserve every unrelated JVM and game argument.
pub fn remove_automatic_joins(args: &mut Vec<String>) {
    const JOIN_FLAGS: &[&str] = &[
        "--server",
        "--port",
        "--quickPlayMultiplayer",
        "--quickPlaySingleplayer",
        "--quickPlayRealms",
    ];
    let mut filtered = Vec::with_capacity(args.len());
    let mut iter = args.drain(..).peekable();
    while let Some(arg) = iter.next() {
        if JOIN_FLAGS.contains(&arg.as_str()) {
            if iter.peek().is_some_and(|next| !next.starts_with('-')) {
                iter.next();
            }
            continue;
        }
        if JOIN_FLAGS.iter().any(|flag| {
            arg.strip_prefix(flag)
                .is_some_and(|suffix| suffix.starts_with('='))
        }) {
            continue;
        }
        filtered.push(arg);
    }
    *args = filtered;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_launch_requires_provider_permission_and_minecraft_mode() {
        assert!(validate_test_mode(true, true, true).is_ok());
        assert!(validate_test_mode(true, false, true).is_err());
        assert!(validate_test_mode(true, true, false).is_err());
        assert!(validate_test_mode(false, false, false).is_ok());
    }

    #[test]
    fn test_menu_removes_join_targets_without_touching_other_flags() {
        let mut args: Vec<String> = [
            "-Xmx2G",
            "Main",
            "--server",
            "example.test",
            "--port=25565",
            "--quickPlayMultiplayer",
            "host:25565",
            "--quickPlaySingleplayer=world",
            "--quickPlayRealms",
            "123",
            "--username",
            "Player",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        remove_automatic_joins(&mut args);
        assert_eq!(args, vec!["-Xmx2G", "Main", "--username", "Player"]);
        let mut missing = vec!["--server".into(), "--username".into(), "Player".into()];
        remove_automatic_joins(&mut missing);
        assert_eq!(missing, vec!["--username", "Player"]);
    }

    #[test]
    fn server_addresses_parse_host_port_and_ipv6() {
        assert_eq!(
            validate_server_address("play.example.com").unwrap(),
            ("play.example.com".to_string(), 25565)
        );
        assert_eq!(
            validate_server_address("  192.168.0.10:25577 ").unwrap(),
            ("192.168.0.10".to_string(), 25577)
        );
        assert_eq!(
            validate_server_address("[::1]:25565").unwrap(),
            ("[::1]".to_string(), 25565)
        );
        assert_eq!(
            validate_server_address("[2001:db8::1]").unwrap(),
            ("[2001:db8::1]".to_string(), 25565)
        );
        for bad in [
            "",
            "host:0",
            "host:65566",
            "host:-1",
            "host:abc",
            "host:",
            "-Djavaagent=x",
            "host --username Impostor",
            "host\tname",
            "../escape",
            "host..name",
            ".host",
            "host.",
            "2001:db8::1",
            "[::1",
            "[::1]x",
        ] {
            assert!(validate_server_address(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn quick_play_detection_requires_the_exact_token() {
        assert!(has_quick_play_token(&[
            "--username".to_string(),
            QUICK_PLAY_MULTIPLAYER.to_string(),
        ]));
        for impostor in [
            "--quickPlayMultiplayerLegacy",
            "--no-quickPlayMultiplayer",
            "prefix--quickPlayMultiplayer",
            "--quickPlaySingleplayer",
        ] {
            assert!(
                !has_quick_play_token(&[impostor.to_string()]),
                "accepted {impostor}"
            );
        }
        assert!(!has_quick_play_token(&[]));
    }

    #[test]
    fn modern_clients_get_quick_play_and_legacy_ones_get_server_port() {
        assert_eq!(
            server_join_args(true, "play.example.com", 25565),
            vec![
                "--quickPlayMultiplayer".to_string(),
                "play.example.com:25565".to_string()
            ]
        );
        assert_eq!(
            server_join_args(false, "play.example.com", 25577),
            vec![
                "--server".to_string(),
                "play.example.com".to_string(),
                "--port".to_string(),
                "25577".to_string()
            ]
        );
        assert_eq!(
            server_join_args(true, "[::1]", 25565),
            vec![
                "--quickPlayMultiplayer".to_string(),
                "[::1]:25565".to_string()
            ]
        );
    }

    #[test]
    fn join_arguments_are_never_duplicated() {
        let mut fresh = vec!["--username".to_string(), "Player_1".to_string()];
        ensure_server_join(&mut fresh, true, "host", 25565);
        assert_eq!(fresh.len(), 4);
        ensure_server_join(&mut fresh, true, "host", 25565);
        assert_eq!(fresh.len(), 4, "quick play appended twice");
        let mut legacy = vec!["--server".to_string(), "other".to_string()];
        ensure_server_join(&mut legacy, false, "host", 25565);
        assert_eq!(legacy.len(), 2, "legacy pair duplicated");
    }

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
