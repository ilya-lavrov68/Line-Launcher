//! Local skin library: history stays on this machine, and the one active skin
//! is pushed to the project account automatically.
//!
//! Why this exists: the wardrobe used to be a thin proxy over provider
//! endpoints, so it was unusable until a provider implemented `wardrobe` AND the
//! player signed in. The library is deliberately provider-independent — it works
//! offline, before login, and on servers that have no skin API at all.
//!
//! Layout under app-data:
//!   skins/index.json        metadata + the active skin + what was last synced
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
    /// The active skin for the whole project account. None = standard look.
    pub active: Option<String>,
    /// What the provider last accepted. Comparing it with `active` is what makes
    /// the sync automatic and idempotent: no button, and no re-upload on every
    /// launch. Cleared when the account changes so a new player is not skipped.
    pub synced: Option<String>,
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
    prune_library(&mut library);
    library
}

/// `Option` has no `retain`. Keeps the slot only while `keep` holds for the id
/// inside it, and clears it otherwise.
pub fn keep_slot(slot: &mut Option<String>, keep: impl Fn(&str) -> bool) {
    if !slot.as_deref().is_some_and(keep) {
        *slot = None;
    }
}

/// Repairs an index read from disk: invalid or surplus textures go, and the
/// active/synced slots are cleared when they point at a skin that is gone.
pub fn prune_library(library: &mut SkinLibrary) {
    library.skins.retain(|s| valid_skin_id(&s.id));
    library.skins.truncate(MAX_LIBRARY_SKINS);
    let known: Vec<String> = library.skins.iter().map(|s| s.id.clone()).collect();
    keep_slot(&mut library.active, |id| known.iter().any(|k| k == id));
    keep_slot(&mut library.synced, |id| known.iter().any(|k| k == id));
}

/// Forgets a deleted texture everywhere. Clearing `synced` is what makes the
/// next sync fall back to the standard look instead of pointing at lost bytes.
pub fn forget_skin(library: &mut SkinLibrary, id: &str) {
    library.skins.retain(|s| s.id != id);
    keep_slot(&mut library.active, |active| active != id);
    keep_slot(&mut library.synced, |synced| synced != id);
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
        forget_skin(&mut library, &id);
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

/// Chooses the active skin for the account. Local-only: the caller runs the
/// automatic sync afterwards, so a failed upload never loses the local choice.
#[tauri::command]
pub async fn set_active_skin(
    id: Option<String>,
    app: AppHandle,
) -> LineResult<SkinLibrarySnapshot> {
    let dir = skins_dir(&app)?;
    let library = tauri::async_runtime::spawn_blocking(move || -> LineResult<SkinLibrary> {
        let mut library = read_index(&dir);
        if let Some(id) = &id {
            if !library.skins.iter().any(|s| &s.id == id) {
                return Err(LineError::input("Скин не найден в истории."));
            }
        }
        library.active = id;
        write_index(&dir, &library)?;
        Ok(library)
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(snapshot(library))
}

/// The decision, as a pure function of the index so it can be unit-tested
/// without a provider or a filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SyncAction {
    Unchanged,
    Reset,
    Upload(String),
}

fn sync_action(library: &SkinLibrary) -> SyncAction {
    if library.active == library.synced {
        return SyncAction::Unchanged;
    }
    match &library.active {
        None => SyncAction::Reset,
        Some(id) => SyncAction::Upload(id.clone()),
    }
}

/// What the automatic sync has to do, decided from the index alone.
enum SyncPlan {
    /// `active == synced`: the account already has this look (including the
    /// standard one). Nothing is sent.
    Unchanged,
    /// The player chose the standard look; clear it on the account.
    Reset,
    Upload(SkinEntry, Vec<u8>),
}

fn plan_sync(dir: &Path) -> LineResult<SyncPlan> {
    let library = read_index(dir);
    let id = match sync_action(&library) {
        SyncAction::Unchanged => return Ok(SyncPlan::Unchanged),
        SyncAction::Reset => return Ok(SyncPlan::Reset),
        SyncAction::Upload(id) => id,
    };
    let entry = library
        .skins
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| LineError::input("Активный скин не найден в истории."))?;
    let bytes = std::fs::read(texture_path(dir, &entry.id)?)
        .map_err(|_| LineError::input("Файл активного скина отсутствует."))?;
    validate_skin_png(&bytes)?;
    Ok(SyncPlan::Upload(entry, bytes))
}

/// Pushes the active skin to the project account, automatically.
///
/// Idempotent: when the provider already accepted this exact texture it does
/// nothing, so calling this on every mount/login is cheap. With no active skin
/// it resets the account to the standard look. The result reports what the
/// provider now has, so the UI shows a status instead of a send button.
#[tauri::command]
pub async fn sync_active_skin(
    app: AppHandle,
    state: State<'_, super::state::LineState>,
) -> LineResult<SkinSyncResult> {
    // Held across the upload: two automatic syncs must not interleave, or the
    // "already uploaded" marker could describe a texture the account no longer has.
    let _serialize = state.skin_sync.lock().await;
    let dir = skins_dir(&app)?;
    let plan_dir = dir.clone();
    let plan = tauri::async_runtime::spawn_blocking(move || plan_sync(&plan_dir))
        .await
        .map_err(|_| LineError::storage())??;

    let (id, skin) = match plan {
        SyncPlan::Unchanged => {
            return Ok(SkinSyncResult {
                status: SkinSyncStatus::Unchanged,
                skin: None,
            });
        }
        SyncPlan::Reset => {
            super::wardrobe::reset_skin(&state).await?;
            (None, None)
        }
        SyncPlan::Upload(entry, bytes) => {
            let skin = super::wardrobe::push_skin(entry.model, bytes, &state).await?;
            (Some(entry.id), Some(skin))
        }
    };
    // Remember only after the provider accepted it, so a failed upload is
    // retried by the next automatic sync instead of being silently skipped.
    tauri::async_runtime::spawn_blocking(move || -> LineResult<()> {
        let mut library = read_index(&dir);
        library.synced = id;
        write_index(&dir, &library)
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(SkinSyncResult {
        status: SkinSyncStatus::Synced,
        skin,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkinSyncStatus {
    /// The provider already had this texture; nothing was sent.
    Unchanged,
    /// The active skin (or the standard look) is now on the account.
    Synced,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinSyncResult {
    pub status: SkinSyncStatus,
    pub skin: Option<super::wardrobe::SkinState>,
}

/// Forgets what the provider accepted, so the next automatic sync re-uploads.
/// Called after sign-in/out and provider changes: a different account must not
/// inherit the previous player's "already synced" marker.
#[tauri::command]
pub async fn forget_synced_skin(app: AppHandle) -> LineResult<SkinLibrarySnapshot> {
    let dir = skins_dir(&app)?;
    let library = tauri::async_runtime::spawn_blocking(move || -> LineResult<SkinLibrary> {
        let mut library = read_index(&dir);
        library.synced = None;
        write_index(&dir, &library)?;
        Ok(library)
    })
    .await
    .map_err(|_| LineError::storage())??;
    Ok(snapshot(library))
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

    fn skin_entry(id: &str) -> SkinEntry {
        SkinEntry {
            id: id.into(),
            name: String::from("s"),
            model: SkinModel::Classic,
            width: 64,
            height: 64,
            size_bytes: 1,
            added_at: 0,
        }
    }

    #[test]
    fn an_index_pointing_at_a_lost_texture_is_repaired_not_trusted() {
        let keep = "a".repeat(64);
        let mut library = SkinLibrary {
            skins: vec![
                skin_entry(&keep),
                skin_entry("not-a-sha"),
                skin_entry(&"b".repeat(64)),
            ],
            active: Some("c".repeat(64)),
            synced: Some(keep.clone()),
        };
        prune_library(&mut library);
        // The invalid id is gone, the good ones stay in order.
        assert_eq!(library.skins.len(), 2);
        assert_eq!(library.skins[0].id, keep);
        // `active` pointed at a skin that is not on the shelf: cleared.
        assert_eq!(library.active, None);
        // `synced` still exists: kept, so the sync stays idempotent.
        assert_eq!(library.synced, Some(keep));
    }

    #[test]
    fn deleting_the_worn_skin_clears_both_slots() {
        let id = "a".repeat(64);
        let other = "b".repeat(64);
        let mut library = SkinLibrary {
            skins: vec![skin_entry(&id), skin_entry(&other)],
            active: Some(id.clone()),
            synced: Some(id.clone()),
        };
        forget_skin(&mut library, &id);
        assert_eq!(library.skins.len(), 1);
        assert_eq!(library.skins[0].id, other);
        assert_eq!(library.active, None);
        // Otherwise the next sync would think the deleted bytes are uploaded.
        assert_eq!(library.synced, None);
        // Deleting something else must not touch the current choice.
        library.active = Some(other.clone());
        library.synced = Some(other.clone());
        forget_skin(&mut library, &id);
        assert_eq!(library.active, Some(other.clone()));
        assert_eq!(library.synced, Some(other));
    }

    #[test]
    fn keep_slot_only_clears_when_the_predicate_fails() {
        let mut slot = None;
        keep_slot(&mut slot, |_| false);
        assert_eq!(slot, None);
        slot = Some(String::from("a"));
        keep_slot(&mut slot, |id| id == "a");
        assert_eq!(slot, Some(String::from("a")));
        keep_slot(&mut slot, |id| id == "b");
        assert_eq!(slot, None);
    }

    #[test]
    fn automatic_sync_is_idempotent_and_resets_the_standard_look() {
        let mut library = SkinLibrary::default();
        // Fresh install: nothing chosen, nothing uploaded, nothing to send.
        assert_eq!(sync_action(&library), SyncAction::Unchanged);

        let id = "a".repeat(64);
        library.active = Some(id.clone());
        assert_eq!(sync_action(&library), SyncAction::Upload(id.clone()));

        // The provider accepted it: opening the wardrobe again sends nothing.
        library.synced = Some(id.clone());
        assert_eq!(sync_action(&library), SyncAction::Unchanged);

        // Back to the standard look clears it on the account exactly once.
        library.active = None;
        assert_eq!(sync_action(&library), SyncAction::Reset);
        library.synced = None;
        assert_eq!(sync_action(&library), SyncAction::Unchanged);
    }

    #[test]
    fn an_unconfirmed_or_forgotten_upload_is_retried_not_skipped() {
        let id = "b".repeat(64);
        let mut library = SkinLibrary {
            active: Some(id.clone()),
            synced: Some("c".repeat(64)),
            ..SkinLibrary::default()
        };
        // A failed upload leaves the old marker, so the next sync tries again.
        assert_eq!(sync_action(&library), SyncAction::Upload(id.clone()));
        // Signing in as somebody else forgets the marker for the same reason.
        library.synced = None;
        assert_eq!(sync_action(&library), SyncAction::Upload(id));
    }
}
