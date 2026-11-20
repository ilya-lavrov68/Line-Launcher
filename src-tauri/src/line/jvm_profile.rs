//! JVM arguments a modded loader needs, built by the launcher rather than
//! supplied by the pack.
//!
//! ## Why this exists
//!
//! Forge and NeoForge do not run from a bare classpath. Since 1.13 they launch
//! through the module system: the loader is told which modules to open with
//! `--add-opens`/`--add-exports`, which module path to use (`-p`), and, on
//! 1.17+, which class path the game should see (`-DlegacyClassPath`). Without
//! them the game dies during bootstrap with an `IllegalAccessError` that says
//! nothing about the launcher.
//!
//! The manifest deliberately accepts **no** JVM arguments (`launch_manifest.rs`):
//! a provider that can pass `-javaagent` can run code before the game's own
//! entry point, which is exactly the hole the anti-cheat design closes. The
//! answer is not to open that door, it is for the launcher to know the flag set
//! for each loader family and add it itself.
//!
//! ## What the pack may still say
//!
//! Nothing here reads a file. The choice comes from `LoaderChoice`, which is
//! itself derived from the verified release (`parse_loader` / `pack::inspect`).
//! A pack cannot ask for `Fabric` and receive Forge flags, and it cannot widen
//! the set: the arrays below are the complete list for each family.
//!
//! ## Deliberately dependency-free
//!
//! Plain `std`, like the rest of this module, so `scripts/test-rust-pure.mjs`
//! runs the real functions and their real tests on a machine without the crate
//! graph. Anything that needs the filesystem belongs in `launch.rs`.

use super::minecraft_core::LoaderChoice;

/// How a loader is launched, and therefore which arguments it needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoaderFamily {
    /// Fabric and Quilt: plain classpath, no module system, no extra flags.
    Classpath,
    /// Forge and NeoForge: the module system plus the legacy class path.
    Modular,
}

impl LoaderFamily {
    pub fn of(loader: LoaderChoice) -> Self {
        match loader {
            LoaderChoice::Fabric | LoaderChoice::Quilt => Self::Classpath,
            LoaderChoice::Forge | LoaderChoice::NeoForge => Self::Modular,
        }
    }
}

/// Modules the loaders reflect into. The list is the union of what Forge and
/// NeoForge declare in their own version manifests, restricted to packages that
/// exist in every Java the launcher ships (17+). Opening fewer of them does not
/// fail fast — it fails later, inside a mixin, with a stack trace pointing at
/// the game rather than at the launcher.
///
/// `ALL-UNNAMED` is the unnamed module: every mod jar and the game itself live
/// there, so this is "open to the pack", not "open to everything in Java".
const OPENED_PACKAGES: &[&str] = &[
    "java.base/java.lang",
    "java.base/java.lang.invoke",
    "java.base/java.lang.reflect",
    "java.base/java.net",
    "java.base/java.nio",
    "java.base/java.nio.charset",
    "java.base/java.nio.file",
    "java.base/java.security",
    "java.base/java.text",
    "java.base/java.time",
    "java.base/java.util",
    "java.base/java.util.concurrent",
    "java.base/java.util.concurrent.atomic",
    "java.base/jdk.internal.misc",
    "java.base/sun.nio.ch",
    "java.base/sun.nio.cs",
    "java.base/sun.security.util",
    "java.base/sun.security.x509",
    "java.management/sun.management",
];

/// Packages the loaders export to the unnamed module. Kept separate from
/// `OPENED_PACKAGES` because exporting changes compilation visibility, not
/// reflective access, and the two lists are not the same in the loader's own
/// manifests.
const EXPORTED_PACKAGES: &[&str] = &[
    "java.base/java.lang",
    "java.base/java.lang.invoke",
    "java.base/java.lang.reflect",
    "java.base/java.net",
    "java.base/java.nio",
    "java.base/java.util",
    "java.base/java.util.concurrent",
];

/// Modules added to the boot layer. `jdk.naming.dns` is the one Forge needs for
/// `InetAddress` lookups on some platforms; `jdk.unsupported` backs `sun.misc`.
const ADDED_MODULES: &[&str] = &["jdk.unsupported", "jdk.naming.dns"];

/// JVM options that are not the `-X`/`-XX` tuning already in `launch.rs`.
///
/// `LegacyClassPath` is set by the caller, because its value is the resolved
/// classpath of the release — this module never sees a path.
pub fn loader_jvm_args(family: LoaderFamily) -> Vec<String> {
    match family {
        LoaderFamily::Classpath => Vec::new(),
        LoaderFamily::Modular => {
            let mut args = Vec::with_capacity(
                OPENED_PACKAGES.len() * 2 + EXPORTED_PACKAGES.len() + ADDED_MODULES.len() * 2 + 4,
            );
            for package in OPENED_PACKAGES {
                args.push("--add-opens".to_string());
                args.push(format!("{package}=ALL-UNNAMED"));
            }
            for package in EXPORTED_PACKAGES {
                args.push("--add-exports".to_string());
                args.push(format!("{package}=ALL-UNNAMED"));
            }
            for module in ADDED_MODULES {
                args.push("--add-modules".to_string());
                args.push((*module).to_string());
            }
            // Forge discovers its own libraries through this property; without
            // it the loader finds an empty class path and reports a missing
            // `minecraft` dependency.
            args.push("-DignoreList=client.jar".to_string());
            args.push("-DlibraryDirectory=libraries".to_string());
            args
        }
    }
}

/// The module path (`-p`) entries, in the order the JVM should see them.
///
/// This is deliberately *not* a free-form list from the pack: the caller passes
/// the release's own library paths, and only files that are inside the verified
/// release reach this function at all.
pub fn module_path_args(module_path: &[String]) -> Result<Vec<String>, String> {
    if module_path.is_empty() {
        return Ok(Vec::new());
    }
    for entry in module_path {
        if entry.is_empty() {
            return Err("Пустой путь модуля.".to_string());
        }
        if entry.contains('\n') || entry.contains('\r') || entry.contains('\0') {
            return Err("Некорректный путь модуля.".to_string());
        }
        // A path that is itself an option would be read as one more JVM flag.
        if entry.starts_with('-') {
            return Err("Путь модуля не может начинаться с дефиса.".to_string());
        }
    }
    // `-p` takes one argument; the separator is the platform's, like a classpath.
    let separator = if cfg!(windows) { ';' } else { ':' };
    Ok(vec!["-p".to_string(), module_path.join(&separator.to_string())])
}

/// Builds the `-DlegacyClassPath` option for the modular loaders.
///
/// The value is the same classpath the launcher already validated for `-cp`,
/// which is why it is accepted as one string here instead of a list: it has
/// passed `build_java_command`'s checks (no separator inside an entry, no
/// control characters).
pub fn legacy_class_path_arg(classpath: &str) -> Result<String, String> {
    if classpath.is_empty() {
        return Err("Пустой classpath.".to_string());
    }
    if classpath.contains(['\n', '\r', '\0']) {
        return Err("Некорректный classpath.".to_string());
    }
    Ok(format!("-DlegacyClassPath={classpath}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fabric_and_quilt_get_no_extra_flags() {
        // The whole point of keeping this per-family: a Fabric pack must not
        // suddenly receive `--add-opens`, because those flags were the reason
        // the launcher refused to launch Forge at all.
        for loader in [LoaderChoice::Fabric, LoaderChoice::Quilt] {
            assert_eq!(LoaderFamily::of(loader), LoaderFamily::Classpath);
            assert!(loader_jvm_args(LoaderFamily::of(loader)).is_empty());
        }
    }

    #[test]
    fn modular_loaders_get_module_flags() {
        for loader in [LoaderChoice::Forge, LoaderChoice::NeoForge] {
            let args = loader_jvm_args(LoaderFamily::of(loader));
            assert!(args.contains(&"--add-opens".to_string()), "{loader:?}");
            assert!(args.contains(&"--add-exports".to_string()), "{loader:?}");
            assert!(args.contains(&"--add-modules".to_string()), "{loader:?}");
            assert!(
                args.iter()
                    .any(|a| a.starts_with("-DlegacyClassPath=") || a.starts_with("-DignoreList"))
            );
            // Every flag value is a single token: the JVM reads one argument.
            for value in args.iter().filter(|a| a.starts_with("java.")) {
                assert!(!value.contains(' '), "flag value split: {value}");
                assert!(value.ends_with("=ALL-UNNAMED"), "{value}");
            }
        }
    }

    #[test]
    fn no_flag_can_inject_an_agent_or_a_class_path() {
        // The set is closed. If someone adds a member later, this test is the
        // reminder that `-javaagent`, `-agentlib` and `-cp` are not allowed in
        // it: the launcher owns those, and the manifest ban exists for a reason.
        for loader in [LoaderChoice::Forge, LoaderChoice::NeoForge] {
            for arg in loader_jvm_args(LoaderFamily::of(loader)) {
                let lower = arg.to_ascii_lowercase();
                for banned in ["-javaagent", "-agentlib", "-agentpath", "-xbootclasspath"] {
                    assert!(!lower.starts_with(banned), "{arg} must not be in the set");
                }
                assert_ne!(lower, "-cp");
                assert_ne!(lower, "-classpath");
                assert!(!arg.contains('\n') && !arg.contains('\0'));
            }
        }
    }

    #[test]
    fn module_path_is_one_argument_and_rejects_options() {
        let args = module_path_args(&["a.jar".to_string(), "b.jar".to_string()]).unwrap();
        assert_eq!(args[0], "-p");
        assert_eq!(args.len(), 2, "the JVM takes one -p argument");
        assert!(args[1].contains("a.jar"));
        // A path that starts with a dash would be read as another option.
        assert!(module_path_args(&["-Xmx4G".to_string()]).is_err());
        assert!(module_path_args(&["".to_string()]).is_err());
        assert!(module_path_args(&["a\nb".to_string()]).is_err());
        // No modules is not an error: vanilla-shaped packs have no module path.
        assert!(module_path_args(&[]).unwrap().is_empty());
    }

    #[test]
    fn legacy_class_path_carries_the_validated_classpath() {
        let arg = legacy_class_path_arg("client.jar;libs/a.jar").unwrap();
        assert_eq!(arg, "-DlegacyClassPath=client.jar;libs/a.jar");
        assert!(legacy_class_path_arg("").is_err());
        assert!(legacy_class_path_arg("a\nb").is_err());
    }
}
