//! Local skin library: history stays on this machine, only the active skin is
//! sent to the provider.
//!
//! Why this exists: the wardrobe used to be a thin proxy over provider
//! endpoints, so it was unusable until a provider implemented `wardrobe` AND the
//! player signed in. The library is deliberately provider-independent — it works
//! offline, before login, and on servers that have no skin API at all.
//!
//! Layout under app-data:
//!   skins/index.json        metadata + which skin is active per server
//!   skins/<sha256>.png      texture bytes, content-addressed
//!
//! Content addressing gives deduplication for free and makes every id safe to
//! use as a filename: it is validated as 64 lowercase hex chars before any path
//! is built, so a crafted id can never escape the directory.
use super::error::{ErrorCode, LineError, LineResult};
use super::state::epoch_millis;
use super::storage::{atomic_write, create_private_dir};
use super::wardrobe::{validate_skin_png, SkinModel};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// Textures are <=256 KiB, so 64 of them is at most 16 MiB. The cap is explicit
/// and reported to the player rather than silently deleting history.
pub const MAX_LIBRARY_SKINS: usize = 64;
const MAX_NAME_CHARS: usize = 64;
const MAX_INDEX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkinEntry {
    /// SHA-256 of the PNG, lowercase hex. Also the filename stem.
    pub id: String,
    pub name: String,
    pub model: SkinModel,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u32,
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SkinLibrary {
    /// Newest first.
    pub skins: Vec<SkinEntry>,
    /// server slug -> active skin id. A server with no entry has no local choice.
    pub active: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinLibrarySnapshot {
    pub library: SkinLibrary,
    pub limit: usize,
}

/// An id is only ever a SHA-256 digest. Validating it before building a path is
/// what keeps `../` and absolute paths out of the filesystem layer.
pub fn valid_skin_id(id: &str) -> bool {
    id.len() == 64
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Player-supplied label. It is metadata, never a path, but control characters
/// and unbounded length still have no place in the UI or the index.
pub fn normalize_name(raw: &str) -> LineResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(LineError::input("Укажите название скина."));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(LineError::input("Название содержит недопустимые символы."));
    }
    Ok(trimmed.chars().take(MAX_NAME_CHARS).collect())
}

/// Adding beyond the cap is refused, not auto-pruned: the player asked for
/// history to be kept, so deleting it silently would be the wrong default.
pub fn ensure_capacity(library: &SkinLibrary, id: &str) -> LineResult<()> {
    if library.skins.iter().any(|s| s.id == id) {
        return Ok(());
    }
    if library.skins.len() >= MAX_LIBRARY_SKINS {
        return Err(LineError::input(format!(
            "В истории уже {MAX_LIBRARY_SKINS} скинов. Удалите ненужные, чтобы добавить новый."
        )));
    }
    Ok(())
}

fn skins_dir(app: &AppHandle) -> LineResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?
        .join("skins"))
}

fn texture_path(dir: &Path, id: &str) -> LineResult<PathBuf> {
    if !valid_skin_id(id) {
        return Err(LineError::input("Некорректный идентификатор скина."));
    }
    Ok(dir.join(format!("{id}.png")))
}

/// A corrupt index must not brick the wardrobe. Textures are content-addressed,
/// so dropping a bad index loses labels but never points at the wrong bytes.
fn read_index(dir: &Path) -> SkinLibrary {
    let Ok(bytes) = std::fs::read(dir.join("index.json")) else {
        return SkinLibrary::default();
    };
    if bytes.len() > MAX_INDEX_BYTES {
        return SkinLibrary::default();
    }
    let Ok(mut library) = serde_json::from_slice::<SkinLibrary>(&bytes) else {
        return SkinLibrary::default();
    };
    library.skins.retain(|s| valid_skin_id(&s.id));
    library.skins.truncate(MAX_LIBRARY_SKINS);
    let known: Vec<String> = library.skins.iter().map(|s| s.id.clone()).collect();
    library
        .active
        .retain(|server, id| super::config::validate_slug(server) && known.contains(id));
    library
}

fn write_index(dir: &Path, library: &SkinLibrary) -> LineResult<()> {
    let bytes = serde_json::to_vec_pretty(library).map_err(|_| LineError::storage())?;
    atomic_write(&dir.join("index.json"), &bytes)
}

fn snapshot(library: SkinLibrary) -> SkinLibrarySnapshot {
    SkinLibrarySnapshot {
        library,
        limit: MAX_LIBRARY_SKINS,
    }
}

#[tauri::command]
pub async fn list_skin_library(app: AppHandle) -> LineResult<SkinLibrarySnapshot> {
    let dir = skins_dir(&app)?;
    let library = tauri::async_runtime::spawn_blocking(move || read_index(&dir))
        .await
        .map_err(|_| LineError::storage())?;
    Ok(snapshot(library))
}

/// Stores the texture locally. No session, no network, no provider required.
#[tauri::command]
pub async fn add_skin_to_library(
    name: String,
    model: SkinModel,
    png: Vec<u8>,
    app: AppHandle,
) -> LineResult<SkinLibrarySnapshot> {
    let (width, height) = validate_skin_png(&png)?;
    let name = normalize_name(&name)?;
    let id = format!("{:x}", Sha256::digest(&png));
    let dir = skins_dir(&app)?;
    let added = tauri::async_runtime::spawn_blocking(move || -> LineResult<SkinLibrary> {
        create_private_dir(&dir)?;
        let mut library = read_index(&dir);
        ensure_capacity(&library, &id)?;
        // Re-adding identical bytes updates the label/model instead of storing a
        // duplicate, so the history does not fill up with the same texture.
        if let Some(existing) = library.skins.iter_mut().find(|s| s.id == id) {
            existing.name = name;
            existing.model = model;
        } else {
            atomic_write(&texture_path(&dir, &id)?, &png)?;
            library.skins.insert(
                0,
                SkinEntry {
                    id: id.clone(),
                    name,
                    model,
                    width,
                    height,
                    size_bytes: png.len() as u32,
                    added_at: epoch_millis(),
                },
            );
        }
        write_index(&dir, &library)?;
        Ok(library)
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(snapshot(added))
}

#[tauri::command]
pub async fn rename_skin(
    id: String,
    name: String,
    app: AppHandle,
) -> LineResult<SkinLibrarySnapshot> {
    let name = normalize_name(&name)?;
    let dir = skins_dir(&app)?;
    let library = tauri::async_runtime::spawn_blocking(move || -> LineResult<SkinLibrary> {
        let mut library = read_index(&dir);
        let entry = library
            .skins
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| LineError::input("Скин не найден в истории."))?;
        entry.name = name;
        write_index(&dir, &library)?;
        Ok(library)
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(snapshot(library))
}

/// Removes the texture and clears any server that had it active.
#[tauri::command]
pub async fn delete_skin_from_library(
    id: String,
    app: AppHandle,
) -> LineResult<SkinLibrarySnapshot> {
    let dir = skins_dir(&app)?;
    let library = tauri::async_runtime::spawn_blocking(move || -> LineResult<SkinLibrary> {
        let path = texture_path(&dir, &id)?;
        let mut library = read_index(&dir);
        library.skins.retain(|s| s.id != id);
        library.active.retain(|_, active| *active != id);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(LineError::io(&error)),
        }
        write_index(&dir, &library)?;
        Ok(library)
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(snapshot(library))
}

/// Returns the stored bytes so the WebView can build an object URL for the
/// preview. Bounded by the same cap that was enforced on the way in.
#[tauri::command]
pub async fn read_skin_texture(id: String, app: AppHandle) -> LineResult<Vec<u8>> {
    let dir = skins_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = texture_path(&dir, &id)?;
        let bytes = std::fs::read(&path).map_err(|_| {
            LineError::new(
                ErrorCode::InvalidInput,
                "Файл скина отсутствует. Добавьте его заново.",
                false,
            )
        })?;
        validate_skin_png(&bytes)?;
        Ok(bytes)
    })
    .await
    .map_err(|_| LineError::storage())?
}

/// Marks a skin active for a server. Purely local: it works signed out and on
/// servers without a skin API. Syncing to the provider is a separate step.
#[tauri::command]
pub async fn set_active_skin(
    server_id: String,
    id: Option<String>,
    app: AppHandle,
) -> LineResult<SkinLibrarySnapshot> {
    if !super::config::validate_slug(&server_id) {
        return Err(LineError::input("Некорректный идентификатор сервера."));
    }
    let dir = skins_dir(&app)?;
    let library = tauri::async_runtime::spawn_blocking(move || -> LineResult<SkinLibrary> {
        let mut library = read_index(&dir);
        match &id {
            Some(id) => {
                if !library.skins.iter().any(|s| &s.id == id) {
                    return Err(LineError::input("Скин не найден в истории."));
                }
                library.active.insert(server_id, id.clone());
            }
            None => {
                library.active.remove(&server_id);
            }
        }
        write_index(&dir, &library)?;
        Ok(library)
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(snapshot(library))
}

/// Uploads the locally active skin — and only that one — to the provider.
#[tauri::command]
pub async fn sync_active_skin(
    server_id: String,
    app: AppHandle,
    state: State<'_, super::state::LineState>,
) -> LineResult<super::wardrobe::SkinState> {
    let dir = skins_dir(&app)?;
    let wanted = server_id.clone();
    let (entry, bytes) =
        tauri::async_runtime::spawn_blocking(move || -> LineResult<(SkinEntry, Vec<u8>)> {
            let library = read_index(&dir);
            let id = library
                .active
                .get(&wanted)
                .ok_or_else(|| LineError::input("Сначала выберите активный скин в истории."))?;
            let entry = library
                .skins
                .iter()
                .find(|s| &s.id == id)
                .cloned()
                .ok_or_else(|| LineError::input("Активный скин не найден в истории."))?;
            let bytes = std::fs::read(texture_path(&dir, &entry.id)?)
                .map_err(|_| LineError::input("Файл активного скина отсутствует."))?;
            validate_skin_png(&bytes)?;
            Ok((entry, bytes))
        })
        .await
        .map_err(|_| LineError::storage())??;
    super::wardrobe::push_skin(&server_id, entry.model, bytes, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_lowercase_sha256_is_a_valid_id() {
        assert!(valid_skin_id(&"a".repeat(64)));
        assert!(valid_skin_id(&"0123456789abcdef".repeat(4)));
        for bad in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            format!("../{}", "a".repeat(61)),
            format!("/{}", "a".repeat(63)),
            "g".repeat(64),
        ] {
            assert!(!valid_skin_id(&bad), "accepted {bad:?}");
        }
    }

    #[test]
    fn names_are_trimmed_bounded_and_control_free() {
        assert_eq!(normalize_name("  Мой скин  ").unwrap(), "Мой скин");
        assert!(normalize_name("   ").is_err());
        assert!(normalize_name("bad\u{0}name").is_err());
        assert!(normalize_name("bad\nname").is_err());
        let long = normalize_name(&"я".repeat(200)).unwrap();
        assert_eq!(long.chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn capacity_refuses_new_skins_but_allows_duplicates() {
        let mut library = SkinLibrary::default();
        for i in 0..MAX_LIBRARY_SKINS {
            library.skins.push(SkinEntry {
                id: format!("{i:064x}"),
                name: String::from("s"),
                model: SkinModel::Classic,
                width: 64,
                height: 64,
                size_bytes: 1,
                added_at: 0,
            });
        }
        // Updating an existing texture must still work when the shelf is full.
        assert!(ensure_capacity(&library, &format!("{:064x}", 0)).is_ok());
        assert!(ensure_capacity(&library, &"f".repeat(64)).is_err());
    }
}
