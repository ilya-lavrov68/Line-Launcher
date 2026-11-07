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

/**
 * Copy a serde data type but drop only the serde plumbing. The field list stays
 * verbatim, so a renamed/removed field still breaks this harness instead of
 * drifting away from what the crate actually serialises.
 */
function plain(file, signature) {
  return attributed(file, signature)
    .replace(/^\s*#\[serde\([^\n]*\)\]\n/gm, "")
    .replace(/^\s*#\[derive\(([^\n]*)\)\]\s*$/gm, (_m, list) => {
      const kept = list
        .split(",")
        .map((part) => part.trim())
        .filter(
          (part) => part && part !== "Serialize" && part !== "Deserialize",
        );
      return kept.length ? `#[derive(${kept.join(", ")})]` : "";
    });
}

// The real error module derives Serialize and converts reqwest errors; neither
// is available without crates.io. Codes, messages and constructors are kept.
const shim = `
#![allow(dead_code)]
#![allow(unused_imports)]
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidInput, UnsupportedVersion, Network, TlsUntrusted, HttpStatus, InvalidCredentials,
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
  attributed("launch.rs", "pub const MIN_HEAP_MB:"),
  attributed("launch.rs", "pub const MAX_HEAP_MB:"),
  attributed("launch.rs", "pub fn heap_ceiling("),
  attributed("launch.rs", "pub fn validate_heap("),
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
  attributed("error.rs", "pub fn classify_network_chain("),
  attributed("wardrobe.rs", "pub const MAX_SKIN_BYTES:"),
  attributed("wardrobe.rs", "const PNG_SIGNATURE:"),
  attributed("wardrobe.rs", "pub fn validate_skin_png("),
  attributed("dev_ca.rs", "pub fn candidate_paths("),
  attributed("install.rs", "fn has_path_conflict("),
  plain("wardrobe.rs", "pub enum SkinModel {"),
  plain("skin_library.rs", "pub const MAX_LIBRARY_SKINS:"),
  plain("skin_library.rs", "const MAX_NAME_CHARS:"),
  plain("skin_library.rs", "pub struct SkinEntry {"),
  plain("skin_library.rs", "pub struct SkinLibrary {"),
  attributed("skin_library.rs", "pub fn valid_skin_id("),
  attributed("skin_library.rs", "pub fn normalize_name("),
  attributed("skin_library.rs", "pub fn ensure_capacity("),
  plain("skin_library.rs", "enum SyncAction {"),
  attributed("skin_library.rs", "fn sync_action("),
];

// Real unit tests, copied from the crate so expectations have one source of truth.
const tests = [
  installTestPrelude,
  attributed("install_tests.rs", "fn rejects_cross_platform_zip_slip_and_ads("),
  attributed("java.rs", "fn parses_legacy_and_modern_java("),
  attributed("launch.rs", "fn abs("),
  attributed("launch.rs", "fn spec()"),
  attributed(
    "launch.rs",
    "fn command_contains_channel_not_secret_and_automatic_heap(",
  ),
  attributed(
    "launch.rs",
    "fn rejects_agent_injection_and_small_host_memory_is_bounded(",
  ),
  attributed("wardrobe.rs", "fn header("),
  attributed("wardrobe.rs", "fn accepts_both_minecraft_skin_sizes("),
  attributed("wardrobe.rs", "fn rejects_wrong_dimensions_depth_and_interlace("),
  attributed("wardrobe.rs", "fn rejects_non_png_and_oversize("),
  attributed("skin_library.rs", "fn only_lowercase_sha256_is_a_valid_id("),
  attributed(
    "skin_library.rs",
    "fn names_are_trimmed_bounded_and_control_free(",
  ),
  attributed(
    "skin_library.rs",
    "fn capacity_refuses_new_skins_but_allows_duplicates(",
  ),
  attributed(
    "skin_library.rs",
    "fn automatic_sync_is_idempotent_and_resets_the_standard_look(",
  ),
  attributed(
    "skin_library.rs",
    "fn an_unconfirmed_or_forgotten_upload_is_retried_not_skipped(",
  ),
];

// Extra coverage for helpers whose crate tests need serde/tempfile/zip.
const harnessTests = `
#[test]
fn harness_zip_path_conflicts_are_order_independent() {
    // Keys are normalized with a backslash separator; build it from its code
    // point so this harness needs no escaped literals.
    let sep = char::from(92).to_string();
    let set = |items: &[&str]| {
        items.iter().map(|s| s.replace('/', &sep)).collect::<std::collections::HashSet<String>>()
    };
    let empty = set(&[]);
    // "mods" as a file plus anything below it must fail in both scan orders.
    assert!(has_path_conflict(&set(&["mods", "mods/a.jar"]), &empty));
    assert!(has_path_conflict(&set(&["mods/a.jar", "mods"]), &empty));
    // Deep ancestors, not just the immediate parent.
    assert!(has_path_conflict(&set(&["mods", "mods/lib/a.jar"]), &empty));
    // Same path declared as both file and directory.
    assert!(has_path_conflict(&set(&["mods"]), &set(&["mods"])));
    // Legitimate trees and sibling prefixes must pass.
    assert!(!has_path_conflict(&set(&["mods/a.jar", "config/b.txt"]), &set(&["mods", "config"])));
    assert!(!has_path_conflict(&set(&["mods", "mods2/a.jar"]), &empty));
}
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
fn harness_tls_failure_is_not_reported_as_a_connectivity_problem() {
    // The real chain rustls produces for the reference provider's self-signed
    // cert. It must not say "check your connection".
    let chain = "error sending request for url (https://127.0.0.1:8443/config.json)\nclient error (Connect)\ninvalid peer certificate: UnknownIssuer\n";
    let (code, message) = classify_network_chain(chain, false);
    assert_eq!(code, ErrorCode::TlsUntrusted);
    assert!(message.contains("сертификат"));
    assert!(!message.contains("подключение"));
    // The path to the fix must be in the message.
    assert!(message.contains("3.2"));
}

#[test]
fn harness_tls_markers_cover_expiry_hostname_and_schannel() {
    for chain in [
        "invalid peer certificate: Expired",
        "invalid peer certificate: NotValidForName",
        "invalid peer certificate: CertificateExpired",
        "unable to get local issuer certificate",
        "self-signed certificate",
        "The certificate chain was issued by an authority that is not trusted (0x800B0109)",
        "INVALID PEER CERTIFICATE: UNKNOWNISSUER",
    ] {
        assert_eq!(
            classify_network_chain(chain, false).0,
            ErrorCode::TlsUntrusted,
            "missed {chain}"
        );
    }
}

#[test]
fn harness_localized_os_error_under_an_english_wrapper_still_classifies() {
    // rustls keeps its own wrapper text in English regardless of OS locale.
    let chain = "invalid peer certificate: Other(Цепочка сертификатов выдана центром, не являющимся доверенным)";
    assert_eq!(classify_network_chain(chain, false).0, ErrorCode::TlsUntrusted);
}

#[test]
fn harness_timeout_wins_and_stays_retryable() {
    let (code, message) = classify_network_chain("invalid peer certificate: UnknownIssuer", true);
    assert_eq!(code, ErrorCode::Network);
    assert!(message.contains("вовремя"));
}

#[test]
fn harness_refused_connection_asks_to_check_the_server() {
    for chain in [
        "client error (Connect)\ntcp connect error: Connection refused (os error 111)",
        "tcp connect error: os error 10061",
        "dns error: failed to lookup address information",
    ] {
        let (code, message) = classify_network_chain(chain, false);
        assert_eq!(code, ErrorCode::Network);
        assert!(message.contains("запущен"), "wrong message for {chain}");
    }
}

#[test]
fn harness_unrecognized_chain_keeps_the_generic_message() {
    for chain in ["", "something went wrong", "certificate", "peer closed"] {
        let (code, message) = classify_network_chain(chain, false);
        assert_eq!(code, ErrorCode::Network);
        assert!(message.contains("Проверьте подключение"), "wrong for {chain}");
    }
}

#[test]
fn harness_dev_ca_resolves_a_repo_relative_path_from_src_tauri() {
    // tauri dev chdirs into src-tauri, so cwd is the crate dir, not the repo.
    let manifest = Path::new("/repo/src-tauri");
    let cwd = Path::new("/repo/src-tauri");
    let paths = candidate_paths(".provider/tls.crt", Some(cwd), manifest);
    let wanted = PathBuf::from("/repo/.provider/tls.crt");
    assert!(paths.contains(&wanted), "repo root must be tried: {paths:?}");
    // cwd keeps priority so an explicit local file still wins.
    assert_eq!(paths[0], PathBuf::from("/repo/src-tauri/.provider/tls.crt"));
}

#[test]
fn harness_dev_ca_tries_the_repo_root_from_any_working_directory() {
    let manifest = Path::new("/repo/src-tauri");
    for cwd in [Path::new("/repo"), Path::new("/elsewhere")] {
        let paths = candidate_paths(".provider/tls.crt", Some(cwd), manifest);
        assert!(
            paths.contains(&PathBuf::from("/repo/.provider/tls.crt")),
            "failed for cwd {cwd:?}: {paths:?}"
        );
    }
    // No known cwd must still fall back to the manifest and its parent.
    let paths = candidate_paths(".provider/tls.crt", None, manifest);
    assert!(paths.contains(&PathBuf::from("/repo/.provider/tls.crt")));
}

#[test]
fn harness_dev_ca_never_redirects_an_absolute_path() {
    let manifest = Path::new("/repo/src-tauri");
    let absolute = if cfg!(windows) {
        String::from("C:") + &char::from(92).to_string() + "certs" + &char::from(92).to_string() + "dev.crt"
    } else {
        String::from("/etc/certs/dev.crt")
    };
    let paths = candidate_paths(&absolute, Some(Path::new("/repo")), manifest);
    assert_eq!(paths.len(), 1, "an absolute path must be used verbatim");
    assert_eq!(paths[0], PathBuf::from(&absolute));
}

#[test]
fn harness_dev_ca_trims_whitespace_and_deduplicates_roots() {
    let manifest = Path::new("/repo/src-tauri");
    // cwd == manifest must not produce the same candidate twice.
    let paths = candidate_paths("  .provider/tls.crt  ", Some(manifest), manifest);
    assert_eq!(paths.len(), 2, "expected crate dir + repo root: {paths:?}");
    assert_eq!(paths[0], PathBuf::from("/repo/src-tauri/.provider/tls.crt"));
    assert_eq!(paths[1], PathBuf::from("/repo/.provider/tls.crt"));
}

#[test]
fn harness_heap_ceiling_leaves_room_for_the_os() {
    let gib = 1024u64 * 1024 * 1024;
    assert_eq!(heap_ceiling(16 * gib), 12288);
    assert_eq!(heap_ceiling(64 * gib), MAX_HEAP_MB, "hard cap must hold");
    assert_eq!(heap_ceiling(4 * gib), 3072);
    // A tiny or bogus memory reading must never produce an unusable ceiling.
    assert_eq!(heap_ceiling(512 * 1024 * 1024), MIN_HEAP_MB);
    assert_eq!(heap_ceiling(0), MIN_HEAP_MB);
}

#[test]
fn harness_player_heap_is_rejected_not_clamped() {
    let gib = 1024u64 * 1024 * 1024;
    assert_eq!(validate_heap(4096, 16 * gib).unwrap(), 4096);
    assert!(validate_heap(512, 16 * gib).is_err(), "below the floor");
    assert!(validate_heap(13000, 16 * gib).is_err(), "above the ceiling");
    assert!(validate_heap(MAX_HEAP_MB, 2 * gib).is_err(), "above RAM share");
    let err = validate_heap(99999, 4 * gib).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert!(!err.retryable);
    // The automatic value must always be inside the selectable range.
    for gib_count in [2u64, 4, 8, 16, 32, 128] {
        let total = gib_count * gib;
        let auto = optimal_heap_mb(total);
        assert!(auto >= MIN_HEAP_MB);
        assert!(auto <= heap_ceiling(total), "auto heap exceeds the ceiling");
    }
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
