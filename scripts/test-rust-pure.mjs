// Executes the launcher's dependency-free Rust logic with a plain `rustc --test`
// build. It does NOT replace `cargo test`: crates.io dependencies (tauri, serde,
// reqwest, zip, tokio…) are not compiled here. Its purpose is to run the real
// security-critical functions — and their real unit tests — on machines where
// the full crate graph cannot be fetched.
//
//   node scripts/test-rust-pure.mjs            # uses `rustc` from PATH
//   RUSTC=/path/to/rustc node scripts/test-rust-pure.mjs
//
// Function bodies are copied verbatim from src-tauri/src/line/*.rs; only the
// error type is replaced by a behaviour-identical shim (the real one derives
// serde::Serialize and maps reqwest errors). If an item disappears or its shape
// changes, this script fails instead of silently testing less.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const line = path.join(root, "src-tauri", "src", "line");
const rustc = process.env.RUSTC || "rustc";
// Optional overrides for toolchains assembled outside rustup (CI uses plain rustc).
const extraArgs = [
  ...(process.env.RUSTC_SYSROOT
    ? ["--sysroot", process.env.RUSTC_SYSROOT]
    : []),
  ...(process.env.RUSTC_FLAGS ? process.env.RUSTC_FLAGS.split(" ") : []),
];

/**
 * Copy a top-level (or `mod tests`) item verbatim. rustfmt guarantees the closing
 * brace sits on its own line at the item's indentation, so no Rust parser is
 * needed and string literals containing braces cannot confuse the scan.
 */
function item(file, signature, { optional = false } = {}) {
  const text = readFileSync(path.join(line, file), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith(signature));
  if (start < 0) {
    if (optional) return "";
    throw new Error(`${file}: item not found: ${signature}`);
  }
  // Single-line items (tuple structs, type aliases) end at their own line.
  if (lines[start].trimEnd().endsWith(";")) return lines[start];
  const indent = lines[start].length - lines[start].trimStart().length;
  const closing = " ".repeat(indent) + "}";
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === closing) {
      return lines.slice(start, i + 1).join("\n");
    }
  }
  throw new Error(`${file}: unterminated item: ${signature}`);
}

/** Same, plus the attributes immediately above the item (derives, cfg, test). */
function attributed(file, signature, options) {
  const text = readFileSync(path.join(line, file), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith(signature));
  if (start < 0 && options?.optional) return "";
  if (start < 0) throw new Error(`${file}: item not found: ${signature}`);
  let first = start;
  while (first > 0) {
    const previous = lines[first - 1].trimStart();
    if (previous.startsWith("#[") || previous.startsWith("///")) first -= 1;
    else break;
  }
  const body = item(file, signature, options);
  return [...lines.slice(first, start), body].join("\n");
}

// The real error module derives Serialize and converts reqwest errors; neither
// is available without crates.io. Codes, messages and constructors are kept.
const shim = `
#![allow(dead_code)]
#![allow(unused_imports)]
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidInput, UnsupportedVersion, Network, HttpStatus, InvalidCredentials,
    AccountExists, RateLimited, AuthRequired, JavaRequired, Integrity,
    UnsafeArchive, Storage, DiskSpace, Busy, Cancelled, Internal,
}

#[derive(Debug, Clone)]
pub struct LineError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub http_status: Option<u16>,
}

impl LineError {
    pub fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self { code, message: message.into(), retryable, http_status: None }
    }
    pub fn input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message, false)
    }
    pub fn storage() -> Self {
        Self::new(ErrorCode::Storage, "Не удалось сохранить файлы. Проверьте доступ к диску.", true)
    }
    pub fn io(error: &std::io::Error) -> Self {
        if matches!(error.kind(), std::io::ErrorKind::StorageFull)
            || matches!(error.raw_os_error(), Some(28 | 39 | 112))
        {
            Self::new(ErrorCode::DiskSpace, "Недостаточно места на диске.", false)
        } else {
            Self::storage()
        }
    }
}
pub type LineResult<T> = Result<T, LineError>;
`;

// `install_tests.rs` lives in a child module and refers to its parent.
const installTestPrelude = "";
const items = [
  attributed("config.rs", "pub fn validate_slug("),
  attributed("install.rs", "pub fn safe_entry_path("),
  attributed("java.rs", "pub fn parse_java_version("),
  attributed("launch.rs", "pub struct LaunchSpec {"),
  attributed("launch.rs", "pub fn optimal_heap_mb("),
  attributed("launch.rs", "pub fn build_java_command("),
  attributed("launch.rs", "pub fn verified_game_dir("),
  attributed("storage.rs", "pub fn server_dir("),
  attributed("storage.rs", "pub fn create_private_dir("),
  attributed("storage.rs", "pub fn sync_directory("),
  attributed("storage.rs", "pub struct InstallLock("),
  attributed("storage.rs", "impl InstallLock {"),
  attributed("storage.rs", "impl Drop for InstallLock {"),
  attributed("storage.rs", "pub fn remove_dir_if_present("),
  attributed("storage.rs", "pub fn is_real_dir("),
  attributed("storage.rs", "pub fn is_real_file("),
  attributed("launch_manifest.rs", "fn invalid("),
  attributed("launch_manifest.rs", "fn validate_main_class("),
  attributed("launch_manifest.rs", "fn resolve_relative("),
  attributed("launch_manifest.rs", "fn relative_dir("),
  attributed("rollback.rs", "fn valid_sha("),
];

// Real unit tests, copied from the crate so expectations have one source of truth.
const tests = [
  installTestPrelude,
  attributed("install_tests.rs", "fn rejects_cross_platform_zip_slip_and_ads("),
  attributed("java.rs", "fn parses_legacy_and_modern_java("),
  attributed("launch.rs", "fn spec()"),
  attributed(
    "launch.rs",
    "fn command_contains_channel_not_secret_and_automatic_heap(",
  ),
  attributed(
    "launch.rs",
    "fn rejects_agent_injection_and_small_host_memory_is_bounded(",
  ),
];

// Extra coverage for helpers whose crate tests need serde/tempfile/zip.
const harnessTests = `
#[test]
fn harness_server_dir_rejects_traversal_and_device_names() {
    let root = Path::new("/data");
    assert_eq!(server_dir(root, "survival").unwrap(), PathBuf::from("/data/instances/survival"));
    for id in ["../escape", "a/b", "a\\\\b", "", "-leading", "with.dot", "con", "LPT1", "nul"] {
        assert!(server_dir(root, id).is_err(), "accepted {id}");
    }
}

#[test]
fn harness_classpath_separator_cannot_split_an_entry() {
    let mut s = spec();
    let separator = if cfg!(windows) { ";" } else { ":" };
    s.classpath = vec![PathBuf::from(format!("/game/a{separator}/evil.jar"))];
    assert!(build_java_command(&s).is_err());
}

#[test]
fn harness_manifest_paths_walk_every_component() {
    let dir = std::env::temp_dir().join(format!("line-pure-{}", std::process::id()));
    let release = dir.join("release");
    std::fs::create_dir_all(release.join("libs")).unwrap();
    std::fs::write(release.join("libs/client.jar"), b"jar").unwrap();
    assert!(resolve_relative(&release, "libs/client.jar", false).is_ok());
    assert!(resolve_relative(&release, "libs", true).is_ok());
    // A file used as a directory, a missing file and traversal all fail.
    assert!(resolve_relative(&release, "libs/client.jar/evil", false).is_err());
    assert!(resolve_relative(&release, "libs/missing.jar", false).is_err());
    assert!(resolve_relative(&release, "../evil.jar", false).is_err());
    #[cfg(unix)]
    {
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("evil.jar"), b"jar").unwrap();
        std::os::unix::fs::symlink(&outside, release.join("link")).unwrap();
        assert!(resolve_relative(&release, "link/evil.jar", false).is_err());
        assert!(!is_real_dir(&release.join("link")));
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn harness_install_lock_is_exclusive_and_recoverable() {
    let dir = std::env::temp_dir().join(format!("line-pure-lock-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    {
        let _lock = InstallLock::acquire(&dir).unwrap();
        assert_eq!(InstallLock::acquire(&dir).err().unwrap().code, ErrorCode::Busy);
    }
    let _again = InstallLock::acquire(&dir).unwrap();
    assert!(dir.join(".install.lock").exists());
    drop(_again);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn harness_main_class_and_sha_validation() {
    assert!(validate_main_class("net.minecraft.client.main.Main"));
    for bad in ["", ".Main", "Main.", "a..b", "-javaagent:evil", "a.b.1c", "a/b"] {
        assert!(!validate_main_class(bad), "accepted {bad}");
    }
    assert!(valid_sha(&"a".repeat(64)));
    assert!(!valid_sha(&"A".repeat(64)));
    assert!(!valid_sha(&"a".repeat(63)));
}
`;

const source = [
  shim,
  ...items,
  "#[cfg(test)]\nmod tests {\nuse super::*;\n",
  ...tests,
  harnessTests,
  "}",
]
  .join("\n\n")
  // The crate refers to sibling modules; the harness is a single flat module.
  .replace(/super::super::config::/g, "")
  .replace(/super::config::/g, "")
  .replace(/super::storage::/g, "")
  .replace(/super::error::/g, "")
  .replace(/crate::line::storage::/g, "");

const tmp = mkdtempSync(path.join(os.tmpdir(), "line-rust-pure-"));
try {
  const file = path.join(tmp, "harness.rs");
  const binary = path.join(
    tmp,
    process.platform === "win32" ? "harness.exe" : "harness",
  );
  writeFileSync(file, source);
  const build = spawnSync(
    rustc,
    ["--edition", "2021", "--test", "-O", ...extraArgs, "-o", binary, file],
    { encoding: "utf8" },
  );
  if (build.error || build.status !== 0) {
    console.error(build.stderr || String(build.error));
    throw new Error(
      "rustc failed. Install Rust stable or set RUSTC=/path/to/rustc.",
    );
  }
  if (build.stderr.trim()) console.error(build.stderr.trim());
  const run = spawnSync(binary, ["--test-threads=1"], { encoding: "utf8" });
  process.stdout.write(run.stdout || "");
  if (run.status !== 0) {
    process.stderr.write(run.stderr || "");
    process.exit(run.status ?? 1);
  }
  console.log(
    "Pure Rust logic: passed (subset — full `cargo test` is still required)",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
