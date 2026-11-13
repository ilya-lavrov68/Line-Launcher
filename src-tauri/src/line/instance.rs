//! Reading a provider pack that is a ZIP of a whole Minecraft instance.
//!
//! The provider zips their `.minecraft` folder and uploads it, so the launcher
//! cannot assume a layout it generated itself: the archive may be the game
//! directory itself, or wrap it in `.minecraft/`, `minecraft/` or a named folder.
//! Everything here is pure — it works on the relative paths recorded in the
//! verified archive index and on fields lifted out of a version JSON — so the
//! layout rules are unit-testable without a filesystem or crates.io.
use super::error::{LineError, LineResult};
use super::minecraft_core::{validate_version_id, LoaderChoice};

/// A directory is the game directory when it holds at least one of these.
pub const GAME_MARKERS: &[&str] = &[
    "versions/",
    "libraries/",
    "assets/",
    "mods/",
    "config/",
    "options.txt",
    "resourcepacks/",
];

/// Written by the player or by the game while it runs. An update must never
/// delete these, even when the new pack revision no longer contains them.
pub const USER_DATA_PREFIXES: &[&str] = &[
    "saves/",
    "logs/",
    "screenshots/",
    "crash-reports/",
    "shaderpacks/",
    "backups/",
    "journeymap/",
    "xaerowaypoints/",
    "xaeroworldmap/",
    "local/",
    ".fabric/",
    ".mixin.out/",
    "debug/",
    "stats/",
    "advancements/",
    "playerdata/",
    "moddata/",
];

/// Pack-provided files that are still personal: copied on the first install,
/// left alone afterwards so an update does not reset video settings or the
/// player's own server list.
pub const KEEP_LOCAL_FILES: &[&str] = &[
    "options.txt",
    "optionsof.txt",
    "optionsshaders.txt",
    "options_1.20.txt",
    "servers.dat",
    "servers.dat_old",
    "usercache.json",
    "usernamecache.json",
];

/// Normalises a relative archive path to forward slashes. Absolute paths,
/// traversal, drive letters and control characters are refused: the archive is
/// provider input, and these paths later decide what gets copied and deleted.
pub fn normalize_rel(raw: &str) -> Option<String> {
    let value = raw.trim().replace('\\', "/");
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return None;
    }
    if value.starts_with('/') || value.contains(':') {
        return None;
    }
    let trimmed = value.trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn marker_present(paths: &[String], prefix: &str) -> bool {
    GAME_MARKERS.iter().any(|marker| {
        let full = format!("{prefix}{marker}");
        if marker.ends_with('/') {
            paths.iter().any(|path| path.starts_with(&full))
        } else {
            paths.iter().any(|path| path == &full)
        }
    })
}

/// Where the game directory sits inside the extracted archive. `""` means the
/// archive root is the game directory. The candidate order is fixed so the same
/// archive always resolves the same way, and only one wrapper level is accepted.
pub fn find_game_prefix(paths: &[String]) -> Option<String> {
    let mut candidates: Vec<String> = vec![
        ".minecraft/".to_string(),
        "minecraft/".to_string(),
        String::new(),
    ];
    let mut tops: Vec<String> = paths
        .iter()
        .filter_map(|path| path.split_once('/'))
        .map(|(top, _)| top.to_string())
        .collect();
    tops.sort();
    tops.dedup();
    for top in tops {
        if top.is_empty() || top.starts_with('.') {
            continue;
        }
        candidates.push(format!("{top}/.minecraft/"));
        candidates.push(format!("{top}/"));
    }
    candidates
        .into_iter()
        .find(|prefix| marker_present(paths, prefix))
}

/// Every `versions/<id>/<id>.json` profile under the game directory. The id must
/// survive the same validation as a provider-supplied version, because it is
/// later used as a directory name.
pub fn version_profile_ids(paths: &[String], prefix: &str) -> Vec<String> {
    let root = format!("{prefix}versions/");
    let mut ids: Vec<String> = paths
        .iter()
        .filter_map(|path| path.strip_prefix(root.as_str()))
        .filter_map(|rest| {
            let (id, file) = rest.split_once('/')?;
            if file != format!("{id}.json") || rest[id.len() + 1..].contains('/') {
                return None;
            }
            validate_version_id(id).ok()
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Picks the profile to launch. `candidates` carries "is this a loader profile"
/// alongside each id, which the caller learns from the JSON itself.
///
/// Order: the provider's explicit hint, then a single loader profile, then a
/// single profile of any kind. Anything else is an error naming the candidates
/// rather than a coin flip that could launch vanilla without the mods.
pub fn choose_version(
    candidates: &[(String, bool)],
    preferred: Option<&str>,
) -> LineResult<String> {
    if candidates.is_empty() {
        return Err(LineError::input(
            "В сборке нет папки versions/<версия>/<версия>.json. Пришлите instance целиком, вместе с versions.",
        ));
    }
    if let Some(hint) = preferred {
        let hint = hint.trim();
        if let Some((id, _)) = candidates.iter().find(|(id, _)| id == hint) {
            return Ok(id.clone());
        }
    }
    let loaders: Vec<&String> = candidates
        .iter()
        .filter(|(_, loader)| *loader)
        .map(|(id, _)| id)
        .collect();
    if loaders.len() == 1 {
        return Ok(loaders[0].clone());
    }
    if candidates.len() == 1 {
        return Ok(candidates[0].0.clone());
    }
    let names: Vec<&str> = candidates.iter().map(|(id, _)| id.as_str()).collect();
    Err(LineError::input(format!(
        "В сборке несколько профилей версии ({}). Укажите нужный в minecraft_version у сервера в config.json.",
        names.join(", ")
    )))
}

/// `group:artifact:version[:classifier]` — the coordinate form used by every
/// Minecraft version JSON since 1.6.
pub fn maven_parts(coord: &str) -> Option<(&str, &str, &str)> {
    let mut parts = coord.split(':');
    let group = parts.next()?;
    let artifact = parts.next()?;
    let version = parts.next()?;
    if group.is_empty() || artifact.is_empty() || version.is_empty() {
        return None;
    }
    if parts.next().is_some_and(str::is_empty) {
        return None;
    }
    Some((group, artifact, version))
}

/// The loader that is already installed inside the instance. Coordinates are
/// authoritative: Forge and NeoForge share `cpw.mods.bootstraplauncher`, so the
/// main class alone cannot tell them apart. Quilt wins over Fabric because a
/// Quilt instance legitimately carries Fabric compatibility libraries.
pub fn loader_from_libraries(coords: &[String]) -> Option<(LoaderChoice, String)> {
    let mut found: Option<(LoaderChoice, String)> = None;
    let rank = |kind: LoaderChoice| match kind {
        LoaderChoice::Quilt => 4,
        LoaderChoice::NeoForge => 3,
        LoaderChoice::Forge => 2,
        LoaderChoice::Fabric => 1,
    };
    for coord in coords {
        let Some((group, artifact, version)) = maven_parts(coord) else {
            continue;
        };
        let kind = match (group, artifact) {
            ("org.quiltmc", "quilt-loader") => LoaderChoice::Quilt,
            ("net.neoforged", "neoforge") => LoaderChoice::NeoForge,
            ("net.minecraftforge", "forge" | "fmlloader") => LoaderChoice::Forge,
            ("net.fabricmc", "fabric-loader") => LoaderChoice::Fabric,
            _ => continue,
        };
        if found
            .as_ref()
            .is_none_or(|(current, _)| rank(kind) > rank(*current))
        {
            found = Some((kind, version.to_string()));
        }
    }
    found
}

/// Fallback for hand-edited profiles whose library list was trimmed. Ambiguous
/// bootstrap launchers deliberately return `None`.
pub fn loader_from_main_class(main_class: &str) -> Option<LoaderChoice> {
    let value = main_class.trim();
    if value.starts_with("org.quiltmc.loader") {
        Some(LoaderChoice::Quilt)
    } else if value.starts_with("net.fabricmc.loader") {
        Some(LoaderChoice::Fabric)
    } else if value.starts_with("net.neoforged.") {
        Some(LoaderChoice::NeoForge)
    } else if value.starts_with("net.minecraftforge.") {
        Some(LoaderChoice::Forge)
    } else {
        None
    }
}

/// Player-owned data: never deleted by a pack update, whatever the new revision
/// contains. Matching is case-insensitive because Windows packs vary.
pub fn is_user_data(relative: &str) -> bool {
    let lower = relative.to_ascii_lowercase();
    USER_DATA_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        || KEEP_LOCAL_FILES.contains(&lower.as_str())
}

/// Personal settings: written on the first install only.
pub fn keep_local(relative: &str) -> bool {
    KEEP_LOCAL_FILES.contains(&relative.to_ascii_lowercase().as_str())
}

/// Pack-owned files that the new revision dropped. Everything the player or the
/// game created is filtered out, so worlds, logs and screenshots survive an
/// update that no longer ships them.
pub fn overlay_removals(previous: &[String], next: &[String]) -> Vec<String> {
    let mut removals: Vec<String> = previous
        .iter()
        .filter(|path| !next.contains(path))
        .filter(|path| !is_user_data(path))
        .cloned()
        .collect();
    removals.sort();
    removals.dedup();
    removals
}

/// What the archive does not contain and must therefore be fetched from the
/// official Mojang/loader hosts. An instance zipped from a machine that already
/// played it normally needs nothing; a mods-only export needs all of it.
pub fn missing_parts(
    paths: &[String],
    prefix: &str,
    version_id: &str,
    asset_index: Option<&str>,
) -> Vec<&'static str> {
    let has = |relative: &str| {
        let full = format!("{prefix}{relative}");
        paths.iter().any(|path| path == &full)
    };
    let has_dir = |relative: &str| {
        let full = format!("{prefix}{relative}");
        paths.iter().any(|path| path.starts_with(&full))
    };
    let mut missing = Vec::new();
    if !has(&format!("versions/{version_id}/{version_id}.jar")) {
        missing.push("client-jar");
    }
    if !has_dir("libraries/") {
        missing.push("libraries");
    }
    match asset_index {
        Some(index) => {
            if !has(&format!("assets/indexes/{index}.json")) {
                missing.push("asset-index");
            }
            if !has_dir("assets/objects/") {
                missing.push("assets");
            }
        }
        None => missing.push("asset-index"),
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn relative_paths_refuse_traversal_and_absolute_forms() {
        assert_eq!(normalize_rel("mods\\a.jar"), Some("mods/a.jar".to_string()));
        assert_eq!(normalize_rel("mods/"), Some("mods".to_string()));
        for bad in [
            "",
            "../evil",
            "mods/../../evil",
            "/etc/passwd",
            "C:/Windows/x",
            "mods//x",
            "./mods/x",
            "mods/\0x",
        ] {
            assert_eq!(normalize_rel(bad), None, "{bad}");
        }
    }

    #[test]
    fn game_directory_is_found_plain_wrapped_and_named() {
        let plain = paths(&["mods/a.jar", "versions/1.21.1/1.21.1.json"]);
        assert_eq!(find_game_prefix(&plain), Some(String::new()));
        let wrapped = paths(&[".minecraft/mods/a.jar", "readme.txt"]);
        assert_eq!(find_game_prefix(&wrapped), Some(".minecraft/".to_string()));
        let named = paths(&["MyPack/.minecraft/options.txt", "MyPack/icon.png"]);
        assert_eq!(
            find_game_prefix(&named),
            Some("MyPack/.minecraft/".to_string())
        );
        let flat_named = paths(&["MyPack/mods/a.jar"]);
        assert_eq!(find_game_prefix(&flat_named), Some("MyPack/".to_string()));
        assert_eq!(find_game_prefix(&paths(&["readme.txt"])), None);
        // A wrapper deeper than one level is not guessed at.
        assert_eq!(find_game_prefix(&paths(&["a/b/mods/x.jar"])), None);
    }

    #[test]
    fn version_profiles_are_paired_with_their_json() {
        let list = paths(&[
            "versions/1.21.1/1.21.1.json",
            "versions/1.21.1/1.21.1.jar",
            "versions/fabric-loader-0.16.9-1.21.1/fabric-loader-0.16.9-1.21.1.json",
            "versions/broken/other.json",
            "versions/nested/deep/nested.json",
            "versions/../evil/evil.json",
        ]);
        assert_eq!(
            version_profile_ids(&list, ""),
            paths(&["1.21.1", "fabric-loader-0.16.9-1.21.1"])
        );
        assert!(version_profile_ids(&list, "MyPack/").is_empty());
    }

    #[test]
    fn profile_choice_prefers_the_hint_then_the_single_loader() {
        let vanilla = ("1.21.1".to_string(), false);
        let fabric = ("fabric-loader-0.16.9".to_string(), true);
        let candidates = vec![vanilla.clone(), fabric.clone()];
        assert_eq!(
            choose_version(&candidates, Some("1.21.1")).unwrap(),
            "1.21.1"
        );
        assert_eq!(
            choose_version(&candidates, None).unwrap(),
            "fabric-loader-0.16.9"
        );
        assert_eq!(
            choose_version(std::slice::from_ref(&vanilla), None).unwrap(),
            "1.21.1"
        );
        // Two loaders and no hint: refuse rather than launch the wrong mods.
        let second = ("quilt-0.26".to_string(), true);
        let error = choose_version(&[fabric, second], None).unwrap_err();
        assert!(error.message.contains("несколько профилей"));
        assert!(error.message.contains("minecraft_version"));
        assert!(choose_version(&[], None).is_err());
    }

    #[test]
    fn loader_comes_from_coordinates_and_beats_the_ambiguous_main_class() {
        let coords = paths(&[
            "net.fabricmc:intermediary:1.21.1",
            "net.fabricmc:fabric-loader:0.16.9",
            "com.mojang:patchy:2.2.10",
        ]);
        assert_eq!(
            loader_from_libraries(&coords),
            Some((LoaderChoice::Fabric, "0.16.9".to_string()))
        );
        assert_eq!(
            loader_from_libraries(&paths(&["net.neoforged:neoforge:21.1.65"])),
            Some((LoaderChoice::NeoForge, "21.1.65".to_string()))
        );
        assert_eq!(
            loader_from_libraries(&paths(&["net.minecraftforge:fmlloader:1.20.1-47.3.0"])),
            Some((LoaderChoice::Forge, "1.20.1-47.3.0".to_string()))
        );
        // Quilt ships Fabric compatibility: Quilt must win.
        assert_eq!(
            loader_from_libraries(&paths(&[
                "net.fabricmc:fabric-loader:0.16.9",
                "org.quiltmc:quilt-loader:0.26.4",
            ])),
            Some((LoaderChoice::Quilt, "0.26.4".to_string()))
        );
        assert_eq!(loader_from_libraries(&paths(&["bad", "a:b", "a:b:"])), None);
        assert_eq!(
            loader_from_main_class("net.fabricmc.loader.impl.launch.knot.KnotClient"),
            Some(LoaderChoice::Fabric)
        );
        // Shared by Forge and NeoForge: not evidence on its own.
        assert_eq!(
            loader_from_main_class("cpw.mods.bootstraplauncher.BootstrapLauncher"),
            None
        );
        assert_eq!(
            loader_from_main_class("net.minecraft.client.main.Main"),
            None
        );
    }

    #[test]
    fn pack_updates_never_delete_player_data() {
        let previous = paths(&[
            "mods/old.jar",
            "config/mod.toml",
            "saves/World/level.dat",
            "logs/latest.log",
            "screenshots/shot.png",
            "options.txt",
            "shaderpacks/BSL.zip",
        ]);
        let next = paths(&["mods/new.jar", "config/mod.toml"]);
        assert_eq!(overlay_removals(&previous, &next), paths(&["mods/old.jar"]));
        assert!(is_user_data("SAVES/World/level.dat"));
        assert!(is_user_data(".fabric/remappedJars/x.jar"));
        assert!(!is_user_data("mods/a.jar"));
    }

    #[test]
    fn personal_settings_survive_an_update() {
        assert!(keep_local("options.txt"));
        assert!(keep_local("servers.dat"));
        assert!(!keep_local("mods/a.jar"));
        assert!(!keep_local("config/mod.toml"));
        // A dropped options.txt is not a removal candidate either.
        assert!(overlay_removals(&paths(&["options.txt"]), &[]).is_empty());
    }

    #[test]
    fn missing_runtime_parts_separate_full_instances_from_mods_only() {
        let full = paths(&[
            "versions/1.21.1/1.21.1.json",
            "versions/1.21.1/1.21.1.jar",
            "libraries/com/mojang/patchy/2.2.10/patchy-2.2.10.jar",
            "assets/indexes/17.json",
            "assets/objects/ab/abcdef",
        ]);
        assert!(missing_parts(&full, "", "1.21.1", Some("17")).is_empty());
        let mods_only = paths(&["mods/a.jar", "config/x.toml"]);
        assert_eq!(
            missing_parts(&mods_only, "", "1.21.1", None),
            vec!["client-jar", "libraries", "asset-index"]
        );
        assert_eq!(
            missing_parts(&full, "", "1.21.1", Some("18")),
            vec!["asset-index"]
        );
    }
}
