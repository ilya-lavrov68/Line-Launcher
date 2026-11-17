//! Explicit pointer rollback and bounded release retention.
//! Immutable release trees are never renamed while a game may be using them.
use super::error::{ErrorCode, LineError, LineResult};
use super::install::InstallReceipt;
use super::state::LineState;
use super::storage::{atomic_write, remove_dir_if_present, server_dir, InstallLock};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

pub const HISTORY_FILE: &str = "history.json";
pub const MAX_KEPT_RELEASES: usize = 3;
const MAX_HISTORY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseHistory {
    pub server_id: String,
    /// Most recent first. Includes the current release when known.
    pub releases: Vec<InstallReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub receipt: InstallReceipt,
    pub removed_releases: Vec<String>,
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn read_history(base: &Path, server_id: &str) -> LineResult<ReleaseHistory> {
    let path = base.join(HISTORY_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ReleaseHistory {
                server_id: server_id.into(),
                releases: Vec::new(),
            })
        }
        Err(e) => return Err(LineError::io(&e)),
    };
    if bytes.len() > MAX_HISTORY_BYTES {
        return Err(LineError::storage());
    }
    let history: ReleaseHistory =
        serde_json::from_slice(&bytes).map_err(|_| LineError::storage())?;
    if history.server_id != server_id
        || history.releases.len() > 100
        || history.releases.iter().any(|r| {
            r.server_id != server_id
                || !valid_sha(&r.sha256)
                || r.version.trim().is_empty()
                || r.version.len() > 64
        })
    {
        return Err(LineError::storage());
    }
    Ok(history)
}

fn write_history(base: &Path, history: &ReleaseHistory) -> LineResult<()> {
    let bytes = serde_json::to_vec(history).map_err(|_| LineError::storage())?;
    atomic_write(&base.join(HISTORY_FILE), &bytes)
}

/// Record a successful publication. Caller holds the cross-process install lock.
pub fn record_release(base: &Path, receipt: &InstallReceipt) -> LineResult<()> {
    let mut history = read_history(base, &receipt.server_id)?;
    history.releases.retain(|r| r.sha256 != receipt.sha256);
    history.releases.insert(0, receipt.clone());
    history.releases.truncate(100);
    write_history(base, &history)
}

/// Remove only unreferenced, complete release directories. The current pointer,
/// history retention window and any running release are always protected.
pub fn prune_releases(
    base: &Path,
    server_id: &str,
    running_sha: Option<&str>,
) -> LineResult<Vec<String>> {
    let history = read_history(base, server_id)?;
    let current = fs::read(base.join("current.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<InstallReceipt>(&bytes).ok())
        .filter(|r| r.server_id == server_id && valid_sha(&r.sha256))
        .map(|r| r.sha256);
    let mut keep = HashSet::new();
    if let Some(current) = current.clone() {
        keep.insert(current);
    }
    for receipt in history
        .releases
        .iter()
        .filter(|r| Some(&r.sha256) != current.as_ref())
    {
        if keep.len() >= MAX_KEPT_RELEASES {
            break;
        }
        keep.insert(receipt.sha256.clone());
    }
    if let Some(running) = running_sha {
        keep.insert(running.to_owned());
    }
    let releases = base.join("releases");
    if !super::storage::is_real_dir(&releases) {
        return Ok(Vec::new());
    }
    let entries = match fs::read_dir(&releases) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(LineError::io(&e)),
    };
    let mut removed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| LineError::io(&e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| LineError::io(&e))?;
        if !meta.is_dir() || meta.file_type().is_symlink() || !valid_sha(&name) {
            continue;
        }
        if keep.contains(&name) {
            continue;
        }
        remove_dir_if_present(&entry.path())?;
        removed.push(name);
    }
    Ok(removed)
}

pub fn rollback_to(
    base: &Path,
    server_id: &str,
    sha256: &str,
    running_sha: Option<&str>,
) -> LineResult<RollbackResult> {
    if !valid_sha(sha256) {
        return Err(LineError::input("Некорректный идентификатор релиза."));
    }
    if running_sha == Some(sha256) {
        return Err(LineError::new(
            ErrorCode::Busy,
            "Этот релиз сейчас запущен. Остановите игру перед откатом.",
            false,
        ));
    }
    let _lock = InstallLock::acquire(base)?;
    super::install::recover_releases(base)?;
    let history = read_history(base, server_id)?;
    let mut receipt = history
        .releases
        .into_iter()
        .find(|r| r.sha256 == sha256)
        .ok_or_else(|| LineError::input("Этот релиз недоступен для отката."))?;
    let releases = base.join("releases");
    let release = releases.join(sha256);
    if !super::storage::is_real_dir(&releases)
        || !super::storage::is_real_dir(&release)
        || !super::storage::is_real_file(&release.join(".line-complete"))
    {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Файлы выбранного релиза повреждены или удалены.",
            false,
        ));
    }
    receipt.already_installed = true;
    let bytes = serde_json::to_vec(&receipt).map_err(|_| LineError::storage())?;
    atomic_write(&base.join("current.json"), &bytes)?;
    let removed = prune_releases(base, server_id, running_sha)?;
    Ok(RollbackResult {
        receipt,
        removed_releases: removed,
    })
}

#[tauri::command]
pub async fn list_release_history(
    server_id: String,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<ReleaseHistory> {
    let (_, config) = state.active_config()?;
    config.server(&server_id)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?;
    let base = server_dir(&root, &server_id)?;
    tauri::async_runtime::spawn_blocking(move || read_history(&base, &server_id))
        .await
        .map_err(|_| LineError::storage())?
}

#[tauri::command]
pub async fn rollback_release(
    server_id: String,
    sha256: String,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<RollbackResult> {
    let (_, config) = state.active_config()?;
    let server = config.server(&server_id)?.clone();
    // Reserve before any await/blocking IO. This closes the same-process TOCTOU
    // between the busy check and the cross-process lock acquired below.
    state.begin_rollback(&server_id)?;
    let rollback_server = server.id.clone();
    let result = async {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|_| LineError::storage())?;
        let base = server_dir(&root, &rollback_server)?;
        let running = state.running_release(&rollback_server)?;
        tauri::async_runtime::spawn_blocking(move || {
            rollback_to(&base, &rollback_server, &sha256, running.as_deref())
        })
        .await
        .map_err(|_| LineError::storage())?
    }
    .await;
    state.finish_rollback(&server.id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::line::storage::create_private_dir;

    fn receipt(sha: char) -> InstallReceipt {
        InstallReceipt {
            server_id: "survival".into(),
            version: "1".into(),
            sha256: sha.to_string().repeat(64),
            installed_at: 1,
            already_installed: false,
        }
    }

    fn release(base: &Path, sha: char) {
        let dir = base.join("releases").join(sha.to_string().repeat(64));
        create_private_dir(&dir).unwrap();
        fs::write(dir.join(".line-complete"), b"line-release-v1\n").unwrap();
    }

    #[test]
    fn rollback_switches_pointer_and_keeps_recent_releases() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        for sha in ['a', 'b', 'c', 'd'] {
            release(base, sha);
            record_release(base, &receipt(sha)).unwrap();
        }
        atomic_write(
            &base.join("current.json"),
            &serde_json::to_vec(&receipt('d')).unwrap(),
        )
        .unwrap();
        let result = rollback_to(base, "survival", &"b".repeat(64), None).unwrap();
        assert_eq!(result.receipt.sha256, "b".repeat(64));
        assert_eq!(result.removed_releases, vec!["a".repeat(64)]);
        assert!(base.join("releases").join("b".repeat(64)).exists());
        assert!(base.join("releases").join("c".repeat(64)).exists());
        assert!(base.join("releases").join("d".repeat(64)).exists());
    }

    #[test]
    fn running_release_is_never_pruned_or_rolled_back() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        for sha in ['a', 'b', 'c', 'd'] {
            release(base, sha);
            record_release(base, &receipt(sha)).unwrap();
        }
        let running = "d".repeat(64);
        assert_eq!(
            rollback_to(base, "survival", &running, Some(&running))
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        prune_releases(base, "survival", Some(&running)).unwrap();
        assert!(base.join("releases").join(&running).exists());
    }

    #[test]
    fn cross_process_lease_blocks_rollback() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        release(base, 'a');
        record_release(base, &receipt('a')).unwrap();
        let _lease = crate::line::storage::InstallLock::acquire(base).unwrap();
        assert_eq!(
            rollback_to(base, "survival", &"a".repeat(64), None)
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
    }
}
