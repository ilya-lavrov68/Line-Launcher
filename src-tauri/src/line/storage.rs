use super::error::{LineError, LineResult};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// All persistent data is contained in Tauri's per-user app-data directory.
/// A server slug is validated again at the filesystem boundary.
pub fn server_dir(root: &Path, id: &str) -> LineResult<PathBuf> {
    let reserved = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if !super::config::validate_slug(id) || reserved.contains(&id.to_ascii_lowercase().as_str()) {
        return Err(LineError::input("Небезопасный идентификатор сервера."));
    }
    Ok(root.join("instances").join(id))
}

pub fn create_private_dir(path: &Path) -> LineResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|e| LineError::io(&e))?;
        // recursive(true) does not tighten permissions of existing directories.
        fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .map_err(|e| LineError::io(&e))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path).map_err(|e| LineError::io(&e))?;
    }
    Ok(())
}

/// Same-directory temporary file + flush + atomic replacement. Readers see
/// either the old document or the new one, never a partially written JSON.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> LineResult<()> {
    let parent = path.parent().ok_or_else(LineError::storage)?;
    create_private_dir(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| LineError::io(&e))?;
    temp.write_all(bytes).map_err(|e| LineError::io(&e))?;
    temp.as_file().sync_all().map_err(|e| LineError::io(&e))?;
    temp.persist(path).map_err(|_| LineError::storage())?;
    sync_directory(parent)
}

pub fn sync_directory(path: &Path) -> LineResult<()> {
    // Directory fsync is not supported by Windows filesystems in this form.
    #[cfg(unix)]
    File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| LineError::io(&e))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Cross-process advisory lock. The lock file is intentionally never unlinked:
/// removing it while another process waits would allow two independent locks.
pub struct InstallLock(File);
impl InstallLock {
    pub fn acquire(directory: &Path) -> LineResult<Self> {
        create_private_dir(directory)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(".install.lock"))
            .map_err(|e| LineError::io(&e))?;
        match file.try_lock() {
            Ok(()) => Ok(Self(file)),
            Err(std::fs::TryLockError::WouldBlock) => Err(LineError::new(
                super::error::ErrorCode::Busy,
                "Другой процесс уже изменяет эту сборку или удерживает её для игры.",
                false,
            )),
            Err(std::fs::TryLockError::Error(e)) => Err(LineError::io(&e)),
        }
    }
}
impl Drop for InstallLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub fn remove_dir_if_present(path: &Path) -> LineResult<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            #[cfg(unix)]
            fs::remove_file(path).map_err(|e| LineError::io(&e))?;
            #[cfg(windows)]
            fs::remove_dir(path).map_err(|e| LineError::io(&e))?;
            Ok(())
        }
        Ok(_) => fs::remove_dir_all(path).map_err(|e| LineError::io(&e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(LineError::io(&e)),
    }
}

/// Reject symlinks/reparse points at a filesystem trust boundary.
pub fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

pub fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
}
