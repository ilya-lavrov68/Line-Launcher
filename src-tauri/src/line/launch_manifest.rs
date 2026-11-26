//! Strict, provider-supplied launch manifest stored inside the verified ZIP.
//! It is validated twice: before publishing a release and again before spawn.
//! No JVM arguments, executable paths or installation paths are accepted.
use super::error::{ErrorCode, LineError, LineResult};
use super::install::safe_entry_path;
use super::storage::{is_real_dir, is_real_file};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MANIFEST_FILE: &str = "line-launch.json";
pub const MANIFEST_SCHEMA: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_CLASSPATH_ENTRIES: usize = 4096;
/// Enough for Forge/Fabric style argument sets, far below any OS argv limit.
pub const MAX_GAME_ARGS: usize = 128;
/// Arguments the launcher owns. A pack may not redefine identity, paths or the
/// version it claims to be: those come from the verified receipt and the
/// signed-in provider account, not from a file inside the pack.
pub const LAUNCHER_OWNED_ARGS: &[&str] = &[
    "gamedir",
    "username",
    "uuid",
    "accesstoken",
    "usertype",
    "version",
    "versiontype",
    "assetindex",
    "assetsdir",
    "session",
    "userproperties",
];

/// Extra *game* arguments, never JVM arguments: strictly `--name value` pairs,
/// no duplicates, nothing that overrides a launcher-owned flag, no value that
/// could be read as another flag. This is what lets a modded pack pass
/// `--launchTarget`/`--fml.*` without opening a hole for `-javaagent`.
pub fn game_args_are_safe(args: &[String]) -> bool {
    if args.len() > MAX_GAME_ARGS || !args.len().is_multiple_of(2) {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    for pair in args.chunks(2) {
        let Some(flag) = pair[0].strip_prefix("--") else {
            return false;
        };
        let lower = flag.to_ascii_lowercase();
        if flag.is_empty()
            || flag.len() > 64
            || !flag.as_bytes()[0].is_ascii_alphabetic()
            || !flag
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            // The JVM's -X/-XX family and its module/classpath switches are
            // never game arguments, whatever their spelling with two dashes.
            || lower.starts_with('x')
            || matches!(
                lower.as_str(),
                "add-opens"
                    | "add-exports"
                    | "add-reads"
                    | "add-modules"
                    | "patch-module"
                    | "enable-native-access"
                    | "jar"
                    | "module"
                    | "class-path"
                    | "classpath"
                    | "cp"
                    | "p"
            )
            || LAUNCHER_OWNED_ARGS.contains(&lower.as_str())
            || !seen.insert(lower)
        {
            return false;
        }
        let value = &pair[1];
        if value.is_empty()
            || value.len() > 512
            || value.starts_with('-')
            || value.chars().any(char::is_control)
        {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchManifest {
    pub schema_version: u32,
    /// Exact Java feature release required by the pack, e.g. 21.
    pub java_major: u16,
    pub main_class: String,
    /// Relative regular files inside the release. Directories and globs are rejected.
    pub classpath: Vec<String>,
    pub minecraft_version: String,
    #[serde(default)]
    pub asset_index: Option<String>,
    #[serde(default)]
    pub assets_dir: Option<String>,
    #[serde(default)]
    pub natives_dir: Option<String>,
    /// Optional log4j2 configuration shipped inside the release.
    #[serde(default)]
    pub logging_config: Option<String>,
    /// Extra game arguments (see `game_args_are_safe`). Never JVM arguments.
    #[serde(default)]
    pub game_args: Vec<String>,
    /// How much heap this pack needs, in MiB. A *number*, not an argument
    /// string: the launcher turns it into `-Xmx` itself, clamps it to what the
    /// machine can spare, and ignores it entirely when the player chose a value.
    /// That is why it is a field and not a `-Xmx` in `game_args` — a manifest
    /// that could pass flags would need the whole flag whitelist this manifest
    /// exists to avoid.
    #[serde(default)]
    pub recommended_memory_mb: Option<u32>,
    /// Minecraft account type reported to the client: mojang | msa | legacy.
    #[serde(default)]
    pub user_type: Option<String>,
    /// Which loader family the pack runs under: fabric | quilt | forge |
    /// neoforge. Absent keeps the historical behaviour, which is a bare
    /// classpath launch.
    ///
    /// This field is a *selector*, not an argument list: it can only choose one
    /// of the flag sets the launcher already carries (`jvm_profile.rs`), and an
    /// unknown value is rejected. That is the difference between "the pack says
    /// which loader it needs" and "the pack says what the JVM should run",
    /// which is the hole this manifest exists to keep shut.
    #[serde(default)]
    pub loader: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedManifest {
    pub manifest: LaunchManifest,
    pub classpath: Vec<PathBuf>,
    pub assets_dir: Option<PathBuf>,
    pub natives_dir: Option<PathBuf>,
    pub logging_config: Option<PathBuf>,
}

fn invalid() -> LineError {
    LineError::new(
        ErrorCode::Integrity,
        "Манифест запуска сборки повреждён или не поддерживается.",
        false,
    )
}

fn validate_main_class(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.contains("..")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'$'))
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        })
}

/// Walk every component: checking only the final file would miss a parent
/// directory replaced by a symlink after installation.
fn resolve_relative(release: &Path, raw: &str, want_dir: bool) -> LineResult<PathBuf> {
    let relative = safe_entry_path(raw)?;
    let mut path = release.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        path.push(component);
        let final_component = index + 1 == components.len();
        let ok = if final_component && !want_dir {
            is_real_file(&path)
        } else {
            is_real_dir(&path)
        };
        if !ok {
            return Err(invalid());
        }
    }
    Ok(path)
}

fn relative_dir(release: &Path, raw: &str) -> LineResult<PathBuf> {
    resolve_relative(release, raw, true)
}

impl LaunchManifest {
    pub fn parse(bytes: &[u8]) -> LineResult<Self> {
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err(invalid());
        }
        let manifest: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        manifest.validate_fields()?;
        Ok(manifest)
    }

    fn validate_fields(&self) -> LineResult<()> {
        if self.schema_version != MANIFEST_SCHEMA
            || !(8..=26).contains(&self.java_major)
            || !validate_main_class(&self.main_class)
            || self.classpath.is_empty()
            || self.classpath.len() > MAX_CLASSPATH_ENTRIES
            || self.minecraft_version.trim().is_empty()
            || self.minecraft_version.len() > 64
            || self.minecraft_version.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        if self
            .asset_index
            .as_ref()
            .is_some_and(|v| !super::config::validate_slug(v))
        {
            return Err(invalid());
        }
        let mut seen = std::collections::HashSet::new();
        for entry in &self.classpath {
            let relative = safe_entry_path(entry)?;
            let key = relative.to_string_lossy().replace('/', "\\").to_lowercase();
            if !seen.insert(key) || !entry.to_ascii_lowercase().ends_with(".jar") {
                return Err(invalid());
            }
        }
        for dir in [&self.assets_dir, &self.natives_dir, &self.logging_config]
            .into_iter()
            .flatten()
        {
            safe_entry_path(dir)?;
        }
        if !game_args_are_safe(&self.game_args) {
            return Err(invalid());
        }
        if self
            .user_type
            .as_deref()
            .is_some_and(|kind| !matches!(kind, "mojang" | "msa" | "legacy"))
        {
            return Err(invalid());
        }
        // Known loader names only. The name selects a flag set the launcher
        // already owns; anything else is a manifest we do not understand, and
        // guessing would mean running the wrong loader's flags.
        if self.loader.as_deref().is_some_and(|kind| {
            !matches!(kind, "fabric" | "quilt" | "forge" | "neoforge")
        }) {
            return Err(invalid());
        }
        Ok(())
    }

    /// Resolve against an already verified release. Symlinks are rejected both
    /// at install time and here, so a post-install filesystem edit cannot escape.
    pub fn resolve(&self, release: &Path) -> LineResult<ResolvedManifest> {
        self.validate_fields()?;
        let mut classpath = Vec::with_capacity(self.classpath.len());
        for entry in &self.classpath {
            let path = resolve_relative(release, entry, false)?;
            if fs::metadata(&path).map_err(|_| invalid())?.len() == 0 {
                return Err(invalid());
            }
            classpath.push(path);
        }
        let assets_dir = self
            .assets_dir
            .as_deref()
            .map(|dir| relative_dir(release, dir))
            .transpose()?;
        let natives_dir = self
            .natives_dir
            .as_deref()
            .map(|dir| relative_dir(release, dir))
            .transpose()?;
        if self.asset_index.is_some() != assets_dir.is_some() {
            return Err(invalid());
        }
        let logging_config = self
            .logging_config
            .as_deref()
            .map(|file| resolve_relative(release, file, false))
            .transpose()?;
        Ok(ResolvedManifest {
            manifest: self.clone(),
            classpath,
            assets_dir,
            natives_dir,
            logging_config,
        })
    }
}

/// Optional manifest: packs without it remain installable but cannot launch.
pub fn read_optional(release: &Path) -> LineResult<Option<ResolvedManifest>> {
    let path = release.join(MANIFEST_FILE);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(invalid()),
        Ok(_) if !is_real_file(&path) => return Err(invalid()),
        Ok(_) => {}
    }
    let meta = fs::metadata(&path).map_err(|_| invalid())?;
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(invalid());
    }
    let bytes = fs::read(&path).map_err(|_| invalid())?;
    let manifest = LaunchManifest::parse(&bytes)?;
    manifest.resolve(release).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> LaunchManifest {
        LaunchManifest {
            schema_version: 1,
            java_major: 21,
            main_class: "net.minecraft.client.main.Main".into(),
            classpath: vec!["client.jar".into()],
            minecraft_version: "1.21.1".into(),
            asset_index: None,
            assets_dir: None,
            natives_dir: None,
            logging_config: None,
            game_args: Vec::new(),
            recommended_memory_mb: None,
            user_type: None,
            loader: None,
        }
    }

    #[test]
    fn extra_game_arguments_cannot_smuggle_jvm_flags_or_identity() {
        let owned = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(game_args_are_safe(&[]));
        assert!(game_args_are_safe(&owned(&[
            "--launchTarget",
            "forgeclient",
            "--fml.forgeVersion",
            "47.2.0",
        ])));
        for bad in [
            vec!["-javaagent:evil"],
            vec!["--username", "SomeoneElse"],
            vec!["--accessToken", "stolen"],
            vec!["--gameDir", "/tmp"],
            vec!["--version", "9.9.9"],
            vec!["--assetIndex", "other"],
            vec!["--launchTarget"],
            vec!["--launchTarget", "-Dfabric.side=client"],
            vec!["--launchTarget", ""],
            vec!["--launchTarget", "a", "--launchTarget", "b"],
            vec!["---launchTarget", "a"],
            vec!["--Xmx", "16G"],
            vec!["--add-opens", "java.base/java.lang=ALL-UNNAMED"],
            vec!["--patch-module", "evil"],
        ] {
            assert!(!game_args_are_safe(&owned(&bad)), "accepted {bad:?}");
        }
    }

    #[test]
    fn recommended_memory_is_read_as_a_number_and_a_string_is_refused() {
        // A number is data: the launcher turns it into `-Xmx` itself.
        let parsed = LaunchManifest::parse(
            br#"{"schema_version":1,"java_major":21,"main_class":"Main","classpath":["client.jar"],"minecraft_version":"1.21.1","recommended_memory_mb":6144}"#,
        )
        .unwrap();
        assert_eq!(parsed.recommended_memory_mb, Some(6144));
        // A string that looks like a flag is not a heap hint, and must not be
        // accepted as one — `deny_unknown_fields` plus a typed field is what
        // keeps `-Xmx` out of the manifest.
        assert!(LaunchManifest::parse(
            br#"{"schema_version":1,"java_major":21,"main_class":"Main","classpath":["client.jar"],"minecraft_version":"1.21.1","recommended_memory_mb":"-Xmx16G"}"#,
        )
        .is_err());
        // Absent stays absent: a pack written before this field changes nothing.
        assert_eq!(manifest().recommended_memory_mb, None);
    }

    #[test]
    fn rejects_unknown_fields_paths_and_agents() {
        assert!(LaunchManifest::parse(
            br#"{"schema_version":1,"java_major":21,"main_class":"Main","classpath":["client.jar"],"minecraft_version":"1.21.1","jvm_args":["-javaagent:evil"]}"#
        ).is_err());
        let mut m = manifest();
        m.classpath = vec!["../evil.jar".into()];
        assert!(m.validate_fields().is_err());
        m.classpath = vec!["client.jar".into(), "CLIENT.JAR".into()];
        assert!(m.validate_fields().is_err());
        m.main_class = "-javaagent:evil".into();
        assert!(m.validate_fields().is_err());
    }

    #[test]
    fn resolves_only_regular_files_inside_release() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("client.jar"), b"jar").unwrap();
        let resolved = manifest().resolve(temp.path()).unwrap();
        assert_eq!(resolved.classpath, vec![temp.path().join("client.jar")]);
        fs::remove_file(temp.path().join("client.jar")).unwrap();
        assert!(manifest().resolve(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_parent_and_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("client.jar"), b"jar").unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("libs")).unwrap();
        let mut m = manifest();
        m.classpath = vec!["libs/client.jar".into()];
        assert!(m.resolve(temp.path()).is_err());
        std::os::unix::fs::symlink(
            outside.path().join("client.jar"),
            temp.path().join(MANIFEST_FILE),
        )
        .unwrap();
        assert!(read_optional(temp.path()).is_err());
    }
}
