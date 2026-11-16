//! Recoverable replacement of an existing digest-named release.
//!
//! Callers hold the server InstallLock. Backups remain beside the release,
//! never under staging (which is routinely removed after interruption).
use super::error::{ErrorCode, LineError, LineResult};
use super::storage::{is_real_dir, remove_dir_if_present, sync_directory};
use std::fs;
use std::path::Path;

const SWAP_PREFIX: &str = ".line-replace-";

fn valid_swap_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn unsafe_swap() -> LineError {
    LineError::new(ErrorCode::Integrity, "Не удалось безопасно восстановить предыдущую сборку. Обратитесь в поддержку; файлы сохранены.", false)
}

/// Recover any interrupted swap before cleanup, install, launch or rollback.
/// A complete replacement is checked by the caller before the old copy is
/// removed. If validation fails, both copies remain untouched for diagnosis.
pub fn recover_releases(base: &Path, verify: impl Fn(&Path) -> LineResult<bool>) -> LineResult<()> {
    let releases = base.join("releases");
    match fs::symlink_metadata(&releases) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(LineError::io(&e)),
        Ok(_) if !is_real_dir(&releases) => return Err(unsafe_swap()),
        Ok(_) => {}
    }
    for entry in fs::read_dir(&releases).map_err(|e| LineError::io(&e))? {
        let entry = entry.map_err(|e| LineError::io(&e))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(sha) = name.strip_prefix(SWAP_PREFIX) else {
            continue;
        };
        if !valid_swap_sha(sha) {
            continue;
        }
        let backup = entry.path();
        if !is_real_dir(&backup) {
            return Err(unsafe_swap());
        }
        let release = releases.join(sha);
        match fs::symlink_metadata(&release) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(&backup, &release).map_err(|e| LineError::io(&e))?;
                sync_directory(&releases)?;
            }
            Err(e) => return Err(LineError::io(&e)),
            Ok(_) => {
                if !is_real_dir(&release) || !verify(&release)? {
                    return Err(unsafe_swap());
                }
                remove_dir_if_present(&backup)?;
                sync_directory(&releases)?;
            }
        }
    }
    Ok(())
}

/// Place an already verified, fully staged release without deleting the old one
/// first. The backup is deliberately retained until publication succeeds.
pub fn stage_replacement(content: &Path, releases: &Path, sha: &str) -> LineResult<bool> {
    if !valid_swap_sha(sha) || !is_real_dir(releases) || !is_real_dir(content) {
        return Err(unsafe_swap());
    }
    let target = releases.join(sha);
    let backup = releases.join(format!("{SWAP_PREFIX}{sha}"));
    match fs::symlink_metadata(&backup) {
        Ok(_) => return Err(unsafe_swap()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(LineError::io(&error)),
    }
    let had_previous = match fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(LineError::io(&e)),
        Ok(_) if !is_real_dir(&target) => return Err(unsafe_swap()),
        Ok(_) => {
            fs::rename(&target, &backup).map_err(|e| LineError::io(&e))?;
            sync_directory(releases)?;
            true
        }
    };
    if let Err(error) = fs::rename(content, &target) {
        // If restoring fails, the backup remains discoverable on the next run.
        if had_previous && fs::rename(&backup, &target).is_ok() {
            let _ = sync_directory(releases);
        }
        return Err(LineError::io(&error));
    }
    sync_directory(releases)?;
    Ok(had_previous)
}

/// Called only after publishing a successfully verified replacement.
pub fn finish_replacement(releases: &Path, sha: &str, had_previous: bool) -> LineResult<()> {
    if !had_previous {
        return Ok(());
    }
    if !valid_swap_sha(sha) || !is_real_dir(releases) {
        return Err(unsafe_swap());
    }
    let backup = releases.join(format!("{SWAP_PREFIX}{sha}"));
    if !is_real_dir(&backup) {
        return Err(unsafe_swap());
    }
    remove_dir_if_present(&backup)?;
    sync_directory(releases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn swap_temp() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "line-swap-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(dir.join("releases")).unwrap();
        dir
    }

    #[test]
    fn swap_preserves_old_until_commit_and_recovers_completed_replacement() {
        let base = swap_temp();
        let releases = base.join("releases");
        let sha = "a".repeat(64);
        let old = releases.join(&sha);
        let staged = base.join("content");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("file"), b"old").unwrap();
        fs::create_dir(&staged).unwrap();
        fs::write(staged.join("file"), b"new").unwrap();
        assert!(stage_replacement(&staged, &releases, &sha).unwrap());
        let backup = releases.join(format!("{SWAP_PREFIX}{sha}"));
        assert_eq!(fs::read(backup.join("file")).unwrap(), b"old");
        assert_eq!(fs::read(old.join("file")).unwrap(), b"new");
        recover_releases(&base, |path| {
            Ok(fs::read(path.join("file")).unwrap() == b"new")
        })
        .unwrap();
        assert!(!backup.exists());
        assert_eq!(fs::read(old.join("file")).unwrap(), b"new");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn swap_recovery_restores_missing_and_never_discards_backup_for_bad_target() {
        let base = swap_temp();
        let releases = base.join("releases");
        let sha = "b".repeat(64);
        let backup = releases.join(format!("{SWAP_PREFIX}{sha}"));
        let target = releases.join(&sha);
        fs::create_dir(&backup).unwrap();
        fs::write(backup.join("file"), b"old").unwrap();
        recover_releases(&base, |_| panic!("no new release to verify")).unwrap();
        assert_eq!(fs::read(target.join("file")).unwrap(), b"old");
        fs::rename(&target, &backup).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("file"), b"bad").unwrap();
        assert!(recover_releases(&base, |_| Ok(false)).is_err());
        assert_eq!(fs::read(backup.join("file")).unwrap(), b"old");
        assert_eq!(fs::read(target.join("file")).unwrap(), b"bad");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn swap_failure_restores_original_and_first_install_needs_no_backup() {
        let base = swap_temp();
        let releases = base.join("releases");
        let sha = "c".repeat(64);
        let target = releases.join(&sha);
        fs::create_dir(&target).unwrap();
        let nested = target.join("nested");
        fs::create_dir(&nested).unwrap();
        assert!(stage_replacement(&nested, &releases, &sha).is_err());
        assert!(target.join("nested").is_dir());
        assert!(!releases.join(format!("{SWAP_PREFIX}{sha}")).exists());
        let new_sha = "d".repeat(64);
        let staged = base.join("content");
        fs::create_dir(&staged).unwrap();
        assert!(!stage_replacement(&staged, &releases, &new_sha).unwrap());
        finish_replacement(&releases, &new_sha, false).unwrap();
        assert!(releases.join(&new_sha).is_dir());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn swap_rejects_symlink_target_without_touching_it() {
        let base = swap_temp();
        let releases = base.join("releases");
        let sha = "e".repeat(64);
        let external = base.join("other");
        fs::create_dir(&external).unwrap();
        std::os::unix::fs::symlink(&external, releases.join(&sha)).unwrap();
        let staged = base.join("content");
        fs::create_dir(&staged).unwrap();
        assert!(stage_replacement(&staged, &releases, &sha).is_err());
        assert!(staged.is_dir());
        assert!(external.is_dir());
        fs::remove_dir_all(base).unwrap();
    }
}
