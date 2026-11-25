//! Loader profile writing and installer process helpers.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{core::version::VersionJson, loader::LoaderKind, LauncherError, Result};

/// Returns the standard local path for a loader profile JSON.
pub fn loader_profile_path(minecraft_dir: impl AsRef<Path>, version_id: &str) -> PathBuf {
    minecraft_dir
        .as_ref()
        .join("versions")
        .join(version_id)
        .join(format!("{version_id}.json"))
}

/// Writes a loader profile JSON to `<minecraft_dir>/versions/<id>/<id>.json`.
///
/// # Errors
///
/// Returns [`crate::LauncherError`] if the profile has no `id`, the directory
/// cannot be created, or the profile cannot be serialized.
pub fn write_loader_profile(
    minecraft_dir: impl AsRef<Path>,
    profile: &VersionJson,
) -> Result<PathBuf> {
    let version_id = profile
        .id
        .as_deref()
        .ok_or_else(|| LauncherError::MissingField {
            context: "loader profile".to_string(),
            field: "id".to_string(),
        })?;
    let path = loader_profile_path(minecraft_dir, version_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_vec_pretty(profile)?)?;
    Ok(path)
}

/// Process inputs for a Java-based loader installer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallerInvocation {
    /// Loader family being installed.
    pub loader: LoaderKind,
    /// Java executable used to run the installer jar.
    pub java_executable: PathBuf,
    /// Downloaded installer jar path.
    pub installer_path: PathBuf,
    /// Minecraft directory passed to the installer.
    pub minecraft_dir: PathBuf,
}

/// Builds the argument list used to run a loader installer jar.
pub fn installer_command_args(invocation: &InstallerInvocation) -> Vec<String> {
    let mut args = vec![
        "-jar".to_string(),
        invocation.installer_path.to_string_lossy().to_string(),
        "--installClient".to_string(),
        invocation.minecraft_dir.to_string_lossy().to_string(),
    ];
    if invocation.loader == LoaderKind::NeoForge {
        // This is the fallback NeoForge itself documents for Maven outages.
        args.extend([
            "--mirror".to_string(),
            "https://maven.creeperhost.net".to_string(),
        ]);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::{installer_command_args, InstallerInvocation};
    use crate::loader::LoaderKind;

    #[test]
    fn neoforge_installer_uses_the_recommended_maven_mirror() {
        let args = installer_command_args(&InstallerInvocation {
            loader: LoaderKind::NeoForge,
            java_executable: "java".into(),
            installer_path: "neoforge-installer.jar".into(),
            minecraft_dir: "game".into(),
        });
        assert_eq!(args[4], "--mirror");
        assert_eq!(args[5], "https://maven.creeperhost.net");
    }

    #[test]
    fn forge_does_not_receive_a_neoforge_mirror_argument() {
        let args = installer_command_args(&InstallerInvocation {
            loader: LoaderKind::Forge,
            java_executable: "java".into(),
            installer_path: "forge-installer.jar".into(),
            minecraft_dir: "game".into(),
        });
        assert_eq!(args.len(), 4);
    }
}

/// Runs a Java-based loader installer.
///
/// # Errors
///
/// Returns [`crate::LauncherError`] if the installer cannot be started or exits
/// with a non-zero status.
pub fn run_loader_installer(invocation: &InstallerInvocation) -> Result<()> {
    let status = Command::new(&invocation.java_executable)
        .args(installer_command_args(invocation))
        .status()?;

    if status.success() {
        Ok(())
    } else {
        Err(LauncherError::InstallerFailed {
            loader: invocation.loader,
            status: status.code(),
        })
    }
}
