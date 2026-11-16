//! Provider packs are ZIP archives of a whole Minecraft instance.
//!
//! The provider zips their `.minecraft` folder and uploads it. A small
//! `pack.json` beside the archive says where it is and what its checksum is, so
//! «Играть» can tell "nothing changed" from "there is a new revision" without
//! downloading gigabytes: the verified installer already short-circuits when the
//! receipt's sha256 matches the distribution it was asked for.
//!
//! Two directories, deliberately:
//!   * `servers/<id>/releases/<sha>/` — the unpacked archive, owned by the
//!     launcher and hash-verified. The player never writes here.
//!   * `minecraft/<instance>/game/` — the live game directory. Pack files are
//!     copied in when the revision changes; worlds, logs and personal settings
//!     are never deleted, and an unchanged revision is not re-copied at all, so
//!     the player's own mod config edits survive.
use super::config::{validate_https, Distribution, Server, MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES};
use super::error::{ErrorCode, LineError, LineResult};
use super::http;
use super::instance::{
    self, keep_local, loader_from_libraries, loader_from_main_class, overlay_removals,
};
use super::integrity::{self, FileIndex};
use super::minecraft_core::{validate_version_id, LoaderChoice};
use super::storage::{atomic_write, create_private_dir, is_real_dir, is_real_file};
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const PACK_SCHEMA_VERSION: u32 = 1;
pub const MAX_PACK_MANIFEST_BYTES: usize = 64 * 1024;
/// Cached copy of the last good `pack.json`, so a temporary outage does not
/// block playing an already installed revision.
pub const PACK_CACHE_FILE: &str = "pack-manifest.json";
/// Which revision the live game directory was built from, and which files the
/// pack owned then — that list is what makes safe removals possible.
pub const PACK_STATE_FILE: &str = "pack-state.json";

/// `pack.json`. snake_case, like `config.json` and the archive index.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PackManifest {
    pub schema_version: u32,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub unpacked_size_bytes: u64,
    /// Human label shown in the UI; never used as a path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// Optional hint when the instance holds several version profiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minecraft_version: Option<String>,
}

impl PackManifest {
    pub fn parse(bytes: &[u8]) -> LineResult<Self> {
        if bytes.len() > MAX_PACK_MANIFEST_BYTES {
            return Err(LineError::input(
                "pack.json превышает лимит 64 КиБ. Он должен описывать архив, а не содержать его.",
            ));
        }
        let manifest: Self = serde_json::from_slice(bytes).map_err(|error| {
            LineError::input(format!(
                "pack.json повреждён или не поддерживается: {error}. Ожидаются поля schema_version, url, sha256, size_bytes, unpacked_size_bytes."
            ))
        })?;
        manifest.distribution()?;
        Ok(manifest)
    }

    /// The same bounds the pinned `distribution` block obeys: an HTTPS archive
    /// with a lowercase sha256 and sizes inside the installer's limits.
    pub fn distribution(&self) -> LineResult<Distribution> {
        if self.schema_version != PACK_SCHEMA_VERSION {
            return Err(LineError::new(
                ErrorCode::UnsupportedVersion,
                "Версия pack.json не поддерживается. Обновите Line Launcher.",
                false,
            ));
        }
        validate_https(&self.url)?;
        if !integrity::valid_sha256(&self.sha256) {
            return Err(LineError::input(
                "В pack.json некорректный sha256: ожидается 64 шестнадцатеричных символа в нижнем регистре.",
            ));
        }
        if self.size_bytes == 0
            || self.size_bytes > MAX_ARCHIVE_BYTES
            || self.unpacked_size_bytes == 0
            || self.unpacked_size_bytes > MAX_UNPACKED_BYTES
        {
            return Err(LineError::input(
                "В pack.json некорректные размеры архива или распакованной сборки.",
            ));
        }
        if let Some(revision) = &self.revision {
            if revision.chars().count() > 64 || revision.chars().any(char::is_control) {
                return Err(LineError::input(
                    "Слишком длинная метка revision в pack.json.",
                ));
            }
        }
        if let Some(version) = &self.minecraft_version {
            validate_version_id(version)?;
        }
        // pack.json always carries the full description — it is generated from
        // the archive itself by `npm run pack:manifest` — so resolving it here
        // produces a fully pinned distribution even when the config's own
        // record was a bare link.
        Ok(Distribution {
            url: self.url.clone(),
            sha256: Some(self.sha256.clone()),
            size_bytes: Some(self.size_bytes),
            unpacked_size_bytes: Some(self.unpacked_size_bytes),
        })
    }
}

/// Replaces the server's pinned distribution with the one `pack.json` currently
/// advertises. Without `pack_manifest_url` the config stays the source of truth.
/// A network failure falls back to the last good manifest; a malformed response
/// does not, because that is a provider bug and must be visible.
pub async fn effective_server(
    client: &reqwest::Client,
    server: &Server,
    base: &Path,
) -> LineResult<Server> {
    let Some(raw_url) = server.pack_manifest_url.as_deref() else {
        return Ok(server.clone());
    };
    validate_https(raw_url)?;
    create_private_dir(base)?;
    let cache = base.join(PACK_CACHE_FILE);
    let fetched = async {
        let response = http::get(client, raw_url, HeaderMap::new()).await?;
        let mut response = http::success(response)?;
        let bytes = http::read_limited(&mut response, MAX_PACK_MANIFEST_BYTES).await?;
        Ok::<Vec<u8>, LineError>(bytes)
    }
    .await;
    let bytes = match fetched {
        Ok(bytes) => {
            let manifest = PackManifest::parse(&bytes)?;
            let _ = atomic_write(&cache, &bytes);
            return Ok(apply(server, &manifest));
        }
        Err(error) => {
            if !is_real_file(&cache) {
                return Err(error);
            }
            fs::read(&cache).map_err(|e| LineError::io(&e))?
        }
    };
    let manifest = PackManifest::parse(&bytes)?;
    Ok(apply(server, &manifest))
}

fn apply(server: &Server, manifest: &PackManifest) -> Server {
    let mut updated = server.clone();
    updated.distribution = Distribution {
        url: manifest.url.clone(),
        sha256: Some(manifest.sha256.clone()),
        size_bytes: Some(manifest.size_bytes),
        unpacked_size_bytes: Some(manifest.unpacked_size_bytes),
    };
    if updated.minecraft_version.is_none() {
        updated.minecraft_version = manifest.minecraft_version.clone();
    }
    updated
}

pub fn release_dir(base: &Path, sha256: &str) -> LineResult<PathBuf> {
    if !integrity::valid_sha256(sha256) {
        return Err(LineError::input("Некорректный отпечаток сборки."));
    }
    Ok(base.join("releases").join(sha256))
}

/// What the archive turned out to contain.
#[derive(Debug, Clone)]
pub struct DetectedInstance {
    /// Prefix of the game directory inside the release (`""`, `.minecraft/`, …).
    pub prefix: String,
    /// Profile to launch, e.g. `fabric-loader-0.16.9-1.21.1`.
    pub version_id: String,
    /// Vanilla version behind it, used to fill in anything the ZIP lacks.
    pub minecraft_version: String,
    pub loader: Option<(LoaderChoice, String)>,
    /// Minimal source profile is a hint, not an installed loader profile.
    pub generated_profile: bool,
    /// Parts that must come from the official hosts (`instance::missing_parts`).
    pub missing: Vec<&'static str>,
    /// Optional read-only inventory. Size matches are not SHA-1 validation.
    pub asset_inventory: Option<super::asset_inventory::AssetInventory>,
    /// Safe index id if a verified release supplied a readable asset index.
    pub asset_index_id: Option<String>,
    /// Live-file audit is run only for an explicit prepare operation.
    pub live_assets: Option<super::asset_inventory::LiveAssets>,
    /// Game-relative files the pack owns.
    pub files: Vec<String>,
}

fn read_json(path: &Path) -> LineResult<Value> {
    let bytes = fs::read(path).map_err(|e| LineError::io(&e))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(LineError::input("JSON версии в сборке слишком большой."));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        LineError::new(
            ErrorCode::Integrity,
            "JSON версии внутри сборки повреждён. Пересоберите архив из рабочего instance.",
            false,
        )
    })
}

fn text_field<'a>(json: &'a Value, key: &str) -> Option<&'a str> {
    json.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

fn library_names(json: &Value) -> Vec<String> {
    json.get("libraries")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| text_field(entry, "name").map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn profile_loader(json: &Value) -> Option<(LoaderChoice, String)> {
    if let Some(found) = loader_from_libraries(&library_names(json)) {
        return Some(found);
    }
    let kind = loader_from_main_class(text_field(json, "mainClass")?)?;
    // The family is known but the exact version is not: the caller must not
    // pretend it is, so an empty version means "detected, version unknown".
    Some((kind, String::new()))
}

fn asset_index(json: &Value) -> Option<String> {
    json.get("assetIndex")
        .and_then(|index| text_field(index, "id"))
        .or_else(|| text_field(json, "assets"))
        .map(str::to_string)
}

/// Bounded read from the already-scanned immutable release, never the live game.
pub fn read_release_asset_index(release: &Path, prefix: &str, id: &str) -> LineResult<Vec<u8>> {
    use std::io::Read;
    let id = validate_version_id(id)?;
    let path = release
        .join(prefix)
        .join("assets/indexes")
        .join(format!("{id}.json"));
    if !is_real_file(&path) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Индекс ресурсов отсутствует или заменён ссылкой.",
            false,
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| LineError::io(&e))?
        .take(super::asset_inventory::MAX_ASSET_INDEX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| LineError::io(&e))?;
    Ok(bytes)
}

/// Reads the verified archive's file list and version JSONs and decides what to
/// launch. Nothing is guessed from folder names alone: the loader comes from
/// Maven coordinates, the vanilla version from `inheritsFrom`/`jar`.
pub fn inspect(
    release: &Path,
    index: &FileIndex,
    hint: Option<&str>,
) -> LineResult<DetectedInstance> {
    let paths: Vec<String> = index
        .files
        .iter()
        .filter(|entry| !integrity::is_reserved(&entry.path))
        .map(|entry| entry.path.replace('\\', "/"))
        .collect();
    let prefix = instance::find_game_prefix(&paths).ok_or_else(|| {
        LineError::input(
            "В архиве не найдена папка игры. Пришлите ZIP целиком: внутри должны быть mods/, config/ или versions/, а не отдельные файлы.",
        )
    })?;
    let ids = instance::version_profile_ids(&paths, &prefix);
    let mut candidates = Vec::new();
    for id in &ids {
        let path = release
            .join(&prefix)
            .join("versions")
            .join(id)
            .join(format!("{id}.json"));
        let json = read_json(&path)?;
        let loader = profile_loader(&json);
        candidates.push((
            id.clone(),
            loader.is_some() || json.get("inheritsFrom").is_some(),
        ));
    }
    // Prism stores its component list beside either game directory spelling.
    // Never ignore that list when a Mojang profile happens to exist as well.
    let prism_root = prefix
        .strip_suffix(".minecraft/")
        .or_else(|| prefix.strip_suffix("minecraft/"));
    let mut prism = None;
    if let Some(root) = prism_root {
        let metadata = format!("{root}mmc-pack.json");
        if paths.iter().any(|path| path == &metadata) {
            let dot_game = format!("{root}.minecraft/");
            let plain_game = format!("{root}minecraft/");
            if paths.iter().any(|path| path.starts_with(&dot_game))
                && paths.iter().any(|path| path.starts_with(&plain_game))
            {
                return Err(LineError::input("В архиве Prism найдены обе папки игры: minecraft и .minecraft. Уточните состав архива."));
            }
            let metadata_path = release.join(&metadata);
            if !is_real_file(&metadata_path) {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    "Метаданные Prism отсутствуют или заменены ссылкой.",
                    false,
                ));
            }
            use std::io::Read;
            let mut bytes = Vec::new();
            fs::File::open(&metadata_path)
                .map_err(|e| LineError::io(&e))?
                .take(256 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| LineError::io(&e))?;
            let profile = super::prism::PrismProfile::parse(&bytes)?;
            if candidates.is_empty() {
                return Err(LineError::input(format!(
                    "Обнаружен экземпляр Prism Launcher без профиля versions. {} Метаданные mmc-pack.json пока не поддерживаются для установки: загрузчик не будет установлен автоматически. Дождитесь поддержки Prism.",
                    profile.summary()
                )));
            }
            let patches = format!("{root}patches/");
            prism = Some((profile, paths.iter().any(|path| path.starts_with(&patches))));
        }
    }
    // A mods-only archive has no profiles at all: then the provider's version
    // hint is the contract, and the official hosts supply the rest.
    let version_id = if candidates.is_empty() {
        match hint {
            Some(value) => validate_version_id(value)?,
            None => instance::choose_version(&[], None)?,
        }
    } else {
        instance::choose_version(&candidates, hint)?
    };
    let profile_path = release
        .join(&prefix)
        .join("versions")
        .join(&version_id)
        .join(format!("{version_id}.json"));
    let profile = if is_real_file(&profile_path) {
        read_json(&profile_path)?
    } else {
        Value::Null
    };
    let loader = profile_loader(&profile);
    let inherited = text_field(&profile, "inheritsFrom").or_else(|| text_field(&profile, "jar"));
    let minecraft_version = validate_version_id(inherited.unwrap_or(&version_id))?;
    // When the server hint names an included vanilla profile, it denotes the
    // expected base. A unique loader for another base is not a safe fallback.
    if let Some(hint) = hint.map(str::trim) {
        if candidates
            .iter()
            .any(|(id, is_loader)| id == hint && !is_loader)
            && version_id != hint
            && minecraft_version != hint
        {
            return Err(LineError::input(
                "Профиль загрузчика относится к другой версии Minecraft, чем указано у сервера.",
            ));
        }
    }
    if let Some((profile, has_patches)) = &prism {
        profile.verify_profile_identity(
            &minecraft_version,
            loader
                .as_ref()
                .map(|(kind, version)| (*kind, version.as_str())),
            *has_patches,
        )?;
    }
    // Assets are described by the vanilla profile when a loader inherits it.
    let mut assets = asset_index(&profile);
    if assets.is_none() && minecraft_version != version_id {
        let parent = release
            .join(&prefix)
            .join("versions")
            .join(&minecraft_version)
            .join(format!("{minecraft_version}.json"));
        if is_real_file(&parent) {
            assets = asset_index(&read_json(&parent)?);
        }
    }
    // Inventory only: do not infer content integrity from a matching size, and
    // do not use this diagnostic to trigger downloads without a repair plan.
    let asset_index_id = assets
        .as_deref()
        .and_then(|id| validate_version_id(id).ok())
        .filter(|id| paths.contains(&format!("{prefix}assets/indexes/{id}.json")));
    let asset_inventory = asset_index_id.as_deref().and_then(|id| {
        let bytes = read_release_asset_index(release, &prefix, id).ok()?;
        super::asset_inventory::inventory(
            &bytes,
            index
                .files
                .iter()
                .map(|entry| (entry.path.clone(), entry.size)),
            &prefix,
        )
        .ok()
    });
    let missing = instance::missing_parts(&paths, &prefix, &minecraft_version, assets.as_deref());
    let files: Vec<String> = paths
        .iter()
        .filter_map(|path| path.strip_prefix(prefix.as_str()))
        .filter_map(instance::normalize_rel)
        .collect();
    Ok(DetectedInstance {
        prefix,
        version_id,
        minecraft_version,
        loader,
        generated_profile: profile
            .get("line")
            .and_then(|v| v.get("generated"))
            .and_then(Value::as_bool)
            == Some(true),
        missing,
        asset_inventory,
        asset_index_id,
        live_assets: None,
        files,
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PackState {
    pub sha256: String,
    pub files: Vec<String>,
}

/// Files the current revision owns, as recorded when the game directory was
/// last synced. Empty when nothing was recorded (an instance installed by an
/// older launcher): the caller then treats every pack as foreign, which is the
/// honest reading of "we have no list".
pub fn owned_files(instance_root: &Path) -> Vec<String> {
    read_state(&instance_root.join(PACK_STATE_FILE)).files
}

fn read_state(path: &Path) -> PackState {
    fs::read(path)
        .ok()
        .filter(|bytes| bytes.len() <= 16 * 1024 * 1024)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Validate every live parent before copying or reading. Never follow a link or
/// a special object planted inside the writable game directory.
pub fn checked_game_path(game: &Path, relative: &str, create_parents: bool) -> LineResult<PathBuf> {
    let safe = super::install::safe_entry_path(relative)?;
    if !is_real_dir(game) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Папка игры не является обычным каталогом.",
            false,
        ));
    }
    let mut parent = game.to_path_buf();
    if let Some(parts) = safe.parent() {
        for component in parts.components() {
            parent.push(component.as_os_str());
            match fs::symlink_metadata(&parent) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_parents => {
                    fs::create_dir(&parent).map_err(|e| LineError::io(&e))?;
                }
                Err(error) => return Err(LineError::io(&error)),
                Ok(_) => {}
            }
            if !is_real_dir(&parent) {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    format!("Каталог игры не является обычной папкой: {relative}."),
                    false,
                ));
            }
        }
    }
    Ok(game.join(safe))
}

/// Copies the pack into the live game directory. Returns `false` when the same
/// revision is already there — the cheap path that also protects the player's
/// own edits. `true` means files were copied for a new revision.
pub fn sync_game_dir(
    release: &Path,
    detected: &DetectedInstance,
    instance_root: &Path,
    sha256: &str,
) -> LineResult<bool> {
    let game = instance_root.join("game");
    let state_path = instance_root.join(PACK_STATE_FILE);
    let previous = read_state(&state_path);
    if previous.sha256 == sha256 && !sha256.is_empty() && is_real_dir(&game) {
        return Ok(false);
    }
    if !integrity::valid_sha256(sha256) {
        return Err(LineError::input("Некорректный отпечаток сборки."));
    }
    if fs::symlink_metadata(&game).is_ok() && !is_real_dir(&game) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Папка игры не является обычным каталогом.",
            false,
        ));
    }
    create_private_dir(&game)?;
    let source_root = release.join(&detected.prefix);
    for relative in &detected.files {
        let safe = super::install::safe_entry_path(relative)?;
        let target = checked_game_path(&game, relative, true)?;
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if !metadata.is_file() || !is_real_file(&target) {
                return Err(LineError::new(
                    ErrorCode::Integrity,
                    format!("Недопустимый файл в папке игры: {relative}."),
                    false,
                ));
            }
        }
        if keep_local(relative) && is_real_file(&target) {
            continue;
        }
        let source = source_root.join(&safe);
        if !is_real_file(&source) {
            return Err(LineError::new(
                ErrorCode::Integrity,
                format!(
                    "Файл сборки исчез после распаковки: {relative}. Запустите проверку заново."
                ),
                false,
            ));
        }
        copy_file(&source, &target)?;
    }
    let stale = overlay_removals(&previous.files, &detected.files);
    for relative in &stale {
        let safe = super::install::safe_entry_path(relative)?;
        let target = game.join(&safe);
        if is_real_file(&target) {
            checked_game_path(&game, relative, false)?;
            fs::remove_file(&target).map_err(|e| LineError::io(&e))?;
        }
    }
    let state = PackState {
        sha256: sha256.to_string(),
        files: detected.files.clone(),
    };
    let bytes = serde_json::to_vec(&state).map_err(|_| LineError::storage())?;
    atomic_write(&state_path, &bytes)?;
    Ok(true)
}

/// Copy through a temporary name so a crash cannot leave half a mod jar in the
/// game directory looking like a complete file.
fn copy_file(source: &Path, target: &Path) -> LineResult<()> {
    let parent = target.parent().ok_or_else(LineError::storage)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| LineError::io(&e))?;
    let mut input = fs::File::open(source).map_err(|e| LineError::io(&e))?;
    std::io::copy(&mut input, &mut temp).map_err(|e| LineError::io(&e))?;
    temp.persist(target).map_err(|_| LineError::storage())?;
    Ok(())
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn prism_without_profiles_does_not_silently_fall_back_to_vanilla() {
        for (metadata, game_file) in [
            ("Example/mmc-pack.json", "Example/.minecraft/mods/mod.jar"),
            ("Example/mmc-pack.json", "Example/minecraft/mods/mod.jar"),
            ("mmc-pack.json", "minecraft/mods/mod.jar"),
            ("mmc-pack.json", ".minecraft/mods/mod.jar"),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join(metadata);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.neoforged","version":"47.1.106"}]}"#,
            ).unwrap();
            let index = FileIndex {
                schema_version: integrity::INDEX_SCHEMA,
                files: [metadata, game_file]
                    .into_iter()
                    .map(|path| integrity::FileEntry {
                        path: path.into(),
                        sha256: "0".repeat(64),
                        size: 1,
                    })
                    .collect(),
            };
            let error = inspect(temp.path(), &index, Some("1.20.1")).unwrap_err();
            assert!(error.message.contains("Prism Launcher"), "{game_file}");
            assert!(error.message.contains("mmc-pack.json"));
            assert!(error.message.contains("NeoForge 47.1.106"));
        }
    }

    #[test]
    fn prism_profile_must_match_component_manifest_and_has_no_custom_patches() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Example");
        let version_dir = root.join("minecraft/versions/neoforge");
        std::fs::create_dir_all(&version_dir).unwrap();
        std::fs::write(
            root.join("mmc-pack.json"),
            br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.neoforged","version":"47.1.106"}]}"#,
        ).unwrap();
        let profile = version_dir.join("neoforge.json");
        std::fs::write(&profile, br#"{"inheritsFrom":"1.20.1","libraries":[{"name":"net.neoforged:forge:1.20.1-47.1.106"}]}"#).unwrap();
        let entries = [
            "Example/mmc-pack.json",
            "Example/minecraft/versions/neoforge/neoforge.json",
        ];
        let mut index = FileIndex {
            schema_version: integrity::INDEX_SCHEMA,
            files: entries
                .into_iter()
                .map(|path| integrity::FileEntry {
                    path: path.into(),
                    sha256: "0".repeat(64),
                    size: 1,
                })
                .collect(),
        };
        let detected = inspect(temp.path(), &index, None).unwrap();
        assert_eq!(detected.minecraft_version, "1.20.1");
        assert_eq!(
            detected.loader,
            Some((LoaderChoice::NeoForge, "1.20.1-47.1.106".into()))
        );
        std::fs::write(&profile, br#"{"inheritsFrom":"1.20.1","libraries":[]}"#).unwrap();
        assert!(inspect(temp.path(), &index, None).is_err());
        index.files.push(integrity::FileEntry {
            path: "Example/patches/custom.json".into(),
            sha256: "0".repeat(64),
            size: 1,
        });
        let error = inspect(temp.path(), &index, None).unwrap_err();
        assert!(error.message.contains("patches"));
    }

    #[test]
    fn prism_with_two_game_directories_is_not_guessed() {
        let temp = tempfile::tempdir().unwrap();
        let index = FileIndex {
            schema_version: integrity::INDEX_SCHEMA,
            files: [
                "mmc-pack.json",
                ".minecraft/mods/a.jar",
                "minecraft/mods/b.jar",
            ]
            .into_iter()
            .map(|path| integrity::FileEntry {
                path: path.into(),
                sha256: "0".repeat(64),
                size: 1,
            })
            .collect(),
        };
        let error = inspect(temp.path(), &index, Some("1.20.1")).unwrap_err();
        assert!(error.message.contains("обе папки"));
    }

    #[test]
    fn vanilla_hint_does_not_hide_the_installed_loader() {
        let temp = tempfile::tempdir().unwrap();
        let vanilla = temp.path().join("versions/1.20.1/1.20.1.json");
        let loader = temp.path().join("versions/neoforge/neoforge.json");
        std::fs::create_dir_all(vanilla.parent().unwrap()).unwrap();
        std::fs::create_dir_all(loader.parent().unwrap()).unwrap();
        std::fs::write(&vanilla, br#"{"id":"1.20.1"}"#).unwrap();
        std::fs::write(&loader, br#"{"inheritsFrom":"1.20.1","libraries":[{"name":"net.neoforged:forge:1.20.1-47.1.106"}]}"#).unwrap();
        let index = FileIndex {
            schema_version: integrity::INDEX_SCHEMA,
            files: [
                "versions/1.20.1/1.20.1.json",
                "versions/neoforge/neoforge.json",
            ]
            .into_iter()
            .map(|path| integrity::FileEntry {
                path: path.into(),
                sha256: "0".repeat(64),
                size: 1,
            })
            .collect(),
        };
        let detected = inspect(temp.path(), &index, Some("1.20.1")).unwrap();
        assert_eq!(detected.version_id, "neoforge");
        assert_eq!(detected.minecraft_version, "1.20.1");
        assert_eq!(detected.loader.unwrap().0, LoaderChoice::NeoForge);
        std::fs::write(&loader, br#"{"inheritsFrom":"1.20.2","libraries":[{"name":"net.neoforged:forge:1.20.2-47.1.106"}]}"#).unwrap();
        assert!(inspect(temp.path(), &index, Some("1.20.1")).is_err());
    }

    #[test]
    fn mods_only_without_prism_metadata_keeps_existing_version_hint() {
        let temp = tempfile::tempdir().unwrap();
        let index = FileIndex {
            schema_version: integrity::INDEX_SCHEMA,
            files: vec![integrity::FileEntry {
                path: "mods/mod.jar".into(),
                sha256: "0".repeat(64),
                size: 1,
            }],
        };
        let detected = inspect(temp.path(), &index, Some("1.20.1")).unwrap();
        assert_eq!(detected.minecraft_version, "1.20.1");
    }

    #[test]
    fn checked_paths_support_nested_files_and_reject_file_parents() {
        let temp = tempfile::tempdir().unwrap();
        let target = checked_game_path(temp.path(), "mods/1.20.1/file.jar", true).unwrap();
        assert_eq!(target, temp.path().join("mods/1.20.1/file.jar"));
        std::fs::write(temp.path().join("mods/block"), b"x").unwrap();
        assert!(checked_game_path(temp.path(), "mods/block/file.jar", true).is_err());
        assert!(checked_game_path(temp.path(), "mods/../file.jar", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn checked_paths_refuse_symlinked_parents() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("mods")).unwrap();
        symlink(outside.path(), temp.path().join("mods/linked")).unwrap();
        assert!(checked_game_path(temp.path(), "mods/linked/file.jar", true).is_err());
        assert!(!outside.path().join("file.jar").exists());
    }
}
