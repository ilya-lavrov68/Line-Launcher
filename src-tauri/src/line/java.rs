//! Discover a local Java runtime, or verify an explicit player-selected path.
//! Candidates are executed with `-version` before use; only absolute executable
//! files are accepted. Provider JSON never supplies a path. Symlinks are resolved once and the target must still be a
//! regular `java` executable. Callers determine version compatibility: provider
//! manifest launches require an exact major; Minecraft mode supports explicit
//! newer JVM overrides while automatic discovery still uses the requested major.
use super::error::{ErrorCode, LineError, LineResult};
use std::collections::HashSet;
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

/// `canonicalize` on Windows returns `\\?\C:\...`. Java's launcher and
/// some JDK tools do not accept that verbatim-drive spelling. Strip only this
/// prefix; real UNC paths and volume GUID paths keep their original meaning.
pub fn process_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\'
        {
            return PathBuf::from(rest);
        }
    }
    path
}

/// Accept java.exe itself, a JDK/JRE home, or the bin directory containing it.
pub fn validate_path(raw: &str) -> LineResult<PathBuf> {
    let trimmed = raw.trim();
    let value = trimmed
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(trimmed);
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(LineError::input("Некорректный путь к Java."));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(LineError::input(
            "Укажите полный путь к java.exe или папке JDK.",
        ));
    }
    if path
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(java_name()))
    {
        return Ok(path);
    }
    if path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
    {
        return Ok(path.join(java_name()));
    }
    Ok(path.join("bin").join(java_name()))
}

fn executable(path: &Path) -> Option<PathBuf> {
    let path = process_path(std::fs::canonicalize(path).ok()?);
    if !path
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case(java_name())
    {
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
            continue;
        }
        let mut parts = version.split(['.', '-', '_', '+']);
        let Some(first) = parts.next().and_then(|v| v.parse::<u16>().ok()) else {
            continue;
        };
        let major = if first == 1 {
            match parts.next().and_then(|v| v.parse::<u16>().ok()) {
                Some(major) => major,
                None => continue,
            }
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
    probe_detailed(path).await.ok()
}

/// Fixed diagnostics, never raw process output (it can contain local paths).
async fn probe_detailed(path: PathBuf) -> Result<JavaRuntime, String> {
    if !path.is_absolute() {
        return Err(String::from("Нужен полный путь к java.exe."));
    }
    let path = executable(&path).ok_or_else(|| {
        String::from("Не удалось открыть java.exe. Проверьте путь, права доступа и антивирус.")
    })?;
    let mut command = tokio::process::Command::new(&path);
    command
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        format!(
        "Java найдена, но ОС не разрешила её запустить (код {:?}). Проверьте права и антивирус.",
        error.raw_os_error(),
    )
    })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| String::from("Java не открыла stdout."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| String::from("Java не открыла stderr."))?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut bounded_out = (&mut stdout).take(64 * 1024 + 1);
    let mut bounded_err = (&mut stderr).take(64 * 1024 + 1);
    let work = async {
        tokio::try_join!(
            bounded_out.read_to_end(&mut out),
            bounded_err.read_to_end(&mut err)
        )?;
        child.wait().await
    };
    let status = match tokio::time::timeout(Duration::from_secs(10), work).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => return Err(String::from("Не удалось прочитать ответ java -version.")),
        Err(_) => {
            let _ = child.kill().await;
            return Err(String::from("java -version не ответила за 10 секунд."));
        }
    };
    if !status.success() {
        return Err(format!(
            "java -version завершилась с кодом {:?}. Проверьте установку JDK.",
            status.code()
        ));
    }
    if out.len() + err.len() > 64 * 1024 {
        return Err(String::from("java -version вернула слишком большой ответ."));
    }
    // Older JDKs write to stderr; wrappers/newer runtimes may use stdout.
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    let (major, version) = parse_java_version(&text).ok_or_else(|| {
        String::from(
            "Java запустилась, но не сообщила поддерживаемую версию. Поддерживаются Java 8–26.",
        )
    })?;
    Ok(JavaRuntime {
        path,
        major,
        version,
    })
}

/// Explicit selection is still executed and verified in Rust, never trusted as
/// a bare string. Accepts the executable, its bin directory, or a JDK home.
pub async fn inspect_path(raw: &str) -> LineResult<JavaRuntime> {
    let path = validate_path(raw)?;
    probe_detailed(path)
        .await
        .map_err(|message| LineError::new(ErrorCode::JavaRequired, message, false))
}

fn candidates(required_major: u16) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if !home.trim().is_empty() {
            roots.push(PathBuf::from(home.trim().trim_matches('"')));
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            roots.push(dir);
        }
    }
    #[cfg(windows)]
    {
        for variable in [
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "LOCALAPPDATA",
        ] {
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
            roots.push(PathBuf::from(&home).join(".sdkman/candidates/java"));
            roots.push(PathBuf::from(home).join(".jdks"));
        }
    }
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        push_java_candidates(&root, &mut paths, &mut seen);
    }
    // Prefer an exact major match, then deterministic PATH/JAVA_HOME order.
    paths.sort_by_key(|path| {
        let text = path.to_string_lossy().to_lowercase();
        let exact = text.contains(&format!("jdk-{required_major}"))
            || text.contains(&format!("java-{required_major}"))
            || text.contains(&format!("jre-{required_major}"));
        !exact
    });
    paths.truncate(256);
    paths
}

/// JAVA_HOME is a home, PATH usually contains <home>/bin, and vendor roots
/// contain <jdk>/bin. The old code only tried root/bin/java, so a perfectly
/// working java.exe on PATH was invisible to the launcher but visible to doctor.
fn push_java_candidates(root: &Path, paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    let mut push = |path: PathBuf| {
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    };
    if root
        .file_name()
        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(java_name()))
    {
        push(root.to_path_buf());
    } else if root
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
    {
        push(root.join(java_name()));
    } else {
        push(root.join("bin").join(java_name()));
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            push(entry.path().join("bin").join(java_name()));
            #[cfg(target_os = "macos")]
            push(entry.path().join("Contents/Home/bin").join(java_name()));
        }
    }
}

/// Every executable Java runtime the launcher can find, for the settings
/// picker. Bounded like `discover`: candidates come from PATH/JAVA_HOME and the
/// usual install roots, never from provider JSON or the WebView.
pub async fn list_runtimes() -> Vec<JavaRuntime> {
    let mut found: Vec<JavaRuntime> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    // Major 0 keeps the deterministic ordering without an exact-match bias.
    for path in candidates(0) {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Some(real) = executable(&path) else {
            continue;
        };
        if !seen.insert(real) {
            continue;
        }
        let Ok(Some(runtime)) = tokio::time::timeout(remaining, probe(path)).await else {
            continue;
        };
        {
            if (8..=26).contains(&runtime.major) && !found.iter().any(|r| r.path == runtime.path) {
                found.push(runtime);
            }
        }
        if found.len() >= 32 {
            break;
        }
    }
    found.sort_by(|a, b| b.major.cmp(&a.major).then(a.path.cmp(&b.path)));
    found
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

    #[test]
    fn path_bin_directory_finds_java_without_doubling_bin() {
        let home = if cfg!(windows) {
            PathBuf::from(r"C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot")
        } else {
            PathBuf::from("/opt/jdk-25")
        };
        let mut paths = Vec::new();
        let mut seen = HashSet::new();
        push_java_candidates(&home.join("bin"), &mut paths, &mut seen);
        assert!(paths.contains(&home.join("bin").join(java_name())));
        assert!(!paths.contains(&home.join("bin").join("bin").join(java_name())));
        assert_eq!(
            validate_path(home.to_str().unwrap()).unwrap(),
            home.join("bin").join(java_name())
        );
        assert_eq!(
            validate_path(home.join("bin").to_str().unwrap()).unwrap(),
            home.join("bin").join(java_name())
        );
        assert!(validate_path("relative/java").is_err());
        assert!(validate_path("").is_err());
    }

    #[test]
    fn verbatim_drive_prefix_is_removed_but_unc_is_preserved() {
        let sep = char::from(92);
        let prefix = format!("{sep}{sep}?{sep}");
        let drive = format!("{prefix}C:{sep}Java{sep}bin{sep}java.exe");
        assert_eq!(
            process_path(PathBuf::from(&drive)),
            PathBuf::from(drive[prefix.len()..].to_string())
        );
        let unc = format!("{prefix}UNC{sep}server{sep}java.exe");
        assert_eq!(process_path(PathBuf::from(&unc)), PathBuf::from(unc));
    }

    #[test]
    fn version_banners_do_not_hide_a_valid_version() {
        assert_eq!(
            parse_java_version("Picked up JAVA_TOOL_OPTIONS: -Dx=y\nopenjdk version \"25.0.3\"\n")
                .unwrap()
                .0,
            25
        );
        assert_eq!(
            parse_java_version("openjdk version \"bad\"\nopenjdk version \"21.0.5\"\n")
                .unwrap()
                .0,
            21
        );
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
