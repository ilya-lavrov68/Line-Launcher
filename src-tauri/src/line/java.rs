//! Discover a local Java runtime. Provider JSON and WebView never supply a path.
//! Candidates are executed with `-version` before use; only absolute executable
//! files are accepted. Symlinks are resolved once and the target must still be a
//! regular `java` executable. The selected major must match the manifest.
use super::error::{ErrorCode, LineError, LineResult};
use std::collections::HashSet;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaRuntime {
    pub path: PathBuf,
    pub major: u16,
    pub version: String,
}

fn java_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

fn executable(path: &Path) -> Option<PathBuf> {
    // JAVA_HOME/bin/java and /usr/bin/java are commonly symlinks. Resolve once,
    // then execute the resolved regular file instead of re-walking a mutable link.
    let path = std::fs::canonicalize(path).ok()?;
    if path.file_name()? != java_name() {
        return None;
    }
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(path)
}

/// Parse both modern (`21.0.5`) and legacy (`1.8.0_432`) Oracle version lines.
pub fn parse_java_version(output: &str) -> Option<(u16, String)> {
    for line in output.lines() {
        let Some(rest) = line.split("version \"").nth(1) else {
            continue;
        };
        let Some(version) = rest.split('"').next() else {
            continue;
        };
        if version.is_empty() || version.len() > 64 || version.chars().any(char::is_control) {
            return None;
        }
        let mut parts = version.split(['.', '-', '_', '+']);
        let first = parts.next()?.parse::<u16>().ok()?;
        let major = if first == 1 {
            parts.next()?.parse::<u16>().ok()?
        } else {
            first
        };
        if (8..=26).contains(&major) {
            return Some((major, version.to_owned()));
        }
    }
    None
}

async fn probe(path: PathBuf) -> Option<JavaRuntime> {
    if !path.is_absolute() {
        return None;
    }
    let path = executable(&path)?;
    let mut command = tokio::process::Command::new(&path);
    command
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let work = async {
        let (a, b) = tokio::try_join!(
            (&mut stdout).take(64 * 1024 + 1).read_to_end(&mut out),
            (&mut stderr).take(64 * 1024 + 1).read_to_end(&mut err),
        )?;
        let _ = (a, b);
        child.wait().await
    };
    let status = match tokio::time::timeout(Duration::from_secs(10), work).await {
        Ok(Ok(status)) => status,
        _ => {
            let _ = child.kill().await;
            return None;
        }
    };
    if !status.success() || out.len() + err.len() > 64 * 1024 {
        return None;
    }
    let text = String::from_utf8_lossy(&err);
    let (major, version) = parse_java_version(&text)?;
    Some(JavaRuntime {
        path,
        major,
        version,
    })
}

fn candidates(required_major: u16) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.trim().is_empty() {
            roots.push(PathBuf::from(home));
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            roots.push(dir);
        }
    }
    #[cfg(windows)]
    {
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(variable) {
                for vendor in ["Java", "Eclipse Adoptium", "Microsoft", "BellSoft", "Zulu"] {
                    roots.push(PathBuf::from(&base).join(vendor));
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join("Library/Java/JavaVirtualMachines"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        roots.push(PathBuf::from("/usr/lib/jvm"));
        roots.push(PathBuf::from("/usr/java"));
        roots.push(PathBuf::from("/opt/java"));
        if let Ok(home) = std::env::var("HOME") {
            roots.push(PathBuf::from(home).join(".sdkman/candidates/java"));
            roots.push(PathBuf::from(home).join(".jdks"));
        }
    }
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let direct = if root.file_name().is_some_and(|n| n == java_name()) {
            root.clone()
        } else {
            root.join("bin").join(java_name())
        };
        if seen.insert(direct.clone()) {
            paths.push(direct);
        }
        // One level of vendor/JDK directories; no recursive scan of the disk.
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path().join("bin").join(java_name());
                if seen.insert(path.clone()) {
                    paths.push(path);
                }
                #[cfg(target_os = "macos")]
                {
                    let path = entry.path().join("Contents/Home/bin").join(java_name());
                    if seen.insert(path.clone()) {
                        paths.push(path);
                    }
                }
            }
        }
    }
    // Bound accidental/malicious PATH expansion; never scan the whole disk.
    paths.truncate(256);
    // Prefer an exact major match, then deterministic PATH/JAVA_HOME order.
    paths.sort_by_key(|path| {
        let text = path.to_string_lossy().to_lowercase();
        let exact = text.contains(&format!("jdk-{required_major}"))
            || text.contains(&format!("java-{required_major}"))
            || text.contains(&format!("jre-{required_major}"));
        !exact
    });
    paths
}

pub async fn discover(required_major: u16) -> LineResult<JavaRuntime> {
    if !(8..=26).contains(&required_major) {
        return Err(LineError::input("Неподдерживаемая версия Java."));
    }
    for path in candidates(required_major) {
        if let Some(runtime) = probe(path).await {
            if runtime.major == required_major {
                return Ok(runtime);
            }
        }
    }
    Err(LineError::new(
        ErrorCode::JavaRequired,
        format!("Нужна Java {required_major}. Установите её или задайте JAVA_HOME."),
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_legacy_and_modern_java() {
        assert_eq!(
            parse_java_version("openjdk version \"1.8.0_432\"\n"),
            Some((8, "1.8.0_432".into()))
        );
        assert_eq!(
            parse_java_version("openjdk version \"21.0.5\" 2024-10-15\n"),
            Some((21, "21.0.5".into()))
        );
        assert_eq!(parse_java_version("not java"), None);
        assert_eq!(
            parse_java_version("openjdk version \"25.0.2\" 2026-01-20\n"),
            Some((25, "25.0.2".into()))
        );
        assert_eq!(parse_java_version("openjdk version \"27\"\n"), None);
        assert_eq!(parse_java_version("openjdk version \"1.7.0_80\"\n"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probes_real_executable_and_resolves_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let real = bin.join("java");
        std::fs::write(&real, "#!/bin/sh\necho 'openjdk version \"21.0.5\"' >&2\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = temp.path().join("java");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let runtime = probe(link).await.unwrap();
        assert_eq!(runtime.major, 21);
        assert_eq!(runtime.path, std::fs::canonicalize(real).unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_non_executable_and_wrong_name() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("java");
        std::fs::write(&path, b"not executable").unwrap();
        assert!(probe(path).await.is_none());
        let path = temp.path().join("not-java");
        std::fs::write(&path, b"#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(probe(path).await.is_none());
    }
}
