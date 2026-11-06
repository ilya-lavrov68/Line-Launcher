//! DEVELOPMENT ONLY — compiled in just with `--features dev-provider-ca`.
//!
//! The reference provider (`examples/provider/`) serves HTTPS with a self-signed
//! certificate. The launcher deliberately never disables certificate
//! verification, so that provider is rejected out of the box.
//!
//! This module adds *one* extra trust anchor to this process only, via
//! `ClientBuilder::add_root_certificate`. It does not touch the OS trust store,
//! needs no administrator rights, and keeps every public root in place. The
//! feature is not enabled by default and must never be enabled in a distributed
//! build: a shipped launcher that trusts a repo-local CA could be used to
//! man-in-the-middle pack downloads and auth tokens.
use super::error::{ErrorCode, LineError, LineResult};
use std::path::{Path, PathBuf};

/// Path to a PEM certificate (or bundle) to trust for this process.
pub const ENV_VAR: &str = "LINE_DEV_CA_CERT";

fn bad_request(message: impl Into<String>) -> LineError {
    LineError::new(ErrorCode::InvalidInput, message, false)
}

/// Roots to try for a relative `LINE_DEV_CA_CERT`, in priority order.
///
/// `tauri dev` calls `set_current_dir(dirs.tauri)` (tauri-cli `src/dev.rs`), so the
/// app runs with `src-tauri/` as its working directory and a repo-relative
/// `.provider/tls.crt` would otherwise resolve to `src-tauri/.provider/tls.crt`
/// and fail. `CARGO_MANIFEST_DIR` is baked in at compile time, which is
/// acceptable because this feature must never ship. Absolute paths are used
/// as-is so nothing can silently redirect them.
pub fn candidate_paths(raw: &str, cwd: Option<&Path>, manifest_dir: &Path) -> Vec<PathBuf> {
    let requested = Path::new(raw.trim());
    if requested.is_absolute() {
        return vec![requested.to_path_buf()];
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(cwd) = cwd {
        roots.push(cwd.to_path_buf());
    }
    roots.push(manifest_dir.to_path_buf());
    if let Some(parent) = manifest_dir.parent() {
        roots.push(parent.to_path_buf());
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let joined = root.join(requested);
        if !out.contains(&joined) {
            out.push(joined);
        }
    }
    out
}

pub fn apply(builder: reqwest::ClientBuilder) -> LineResult<reqwest::ClientBuilder> {
    let raw = match std::env::var(ENV_VAR) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!(
                "[line] dev-provider-ca compiled in, but {ENV_VAR} is unset — trust store unchanged."
            );
            return Ok(builder);
        }
    };

    // reqwest's rustls platform verifier cannot take extra roots on macOS:
    // ClientBuilder::build() would fail with an opaque "could not load extra
    // certs". Fail early with something actionable instead.
    if cfg!(target_os = "macos") {
        return Err(bad_request(
            "dev-provider-ca не поддерживается на macOS: добавьте .provider/tls.crt в System keychain (docs/RUNBOOK.md, раздел 3.2).",
        ));
    }

    let cwd = std::env::current_dir().ok();
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = candidate_paths(&raw, cwd.as_deref(), manifest_dir);

    let mut loaded: Option<(PathBuf, Vec<u8>)> = None;
    for candidate in &candidates {
        if let Ok(bytes) = std::fs::read(candidate) {
            loaded = Some((candidate.clone(), bytes));
            break;
        }
    }
    let (resolved, pem) = match loaded {
        Some(pair) => pair,
        None => {
            // Local paths go to the developer's console, never into the error
            // DTO that crosses the IPC boundary.
            eprintln!("[line] {ENV_VAR}={raw:?} could not be read. Tried:");
            for candidate in &candidates {
                eprintln!("[line]   {}", candidate.display());
            }
            return Err(bad_request(format!(
                "Не удалось прочитать {ENV_VAR}. Укажите абсолютный путь к .provider/tls.crt; список проверенных путей — в консоли."
            )));
        }
    };

    let certs = reqwest::Certificate::from_pem_bundle(&pem).map_err(|_| {
        bad_request(format!(
            "{ENV_VAR} должен указывать на сертификат в формате PEM."
        ))
    })?;
    if certs.is_empty() {
        return Err(bad_request(format!(
            "{ENV_VAR}: в файле нет ни одного сертификата."
        )));
    }

    let count = certs.len();
    let mut builder = builder;
    for cert in certs {
        builder = builder.add_root_certificate(cert);
    }
    // Loud on purpose: this must never be mistaken for a normal run.
    eprintln!(
        "[line] WARNING: dev-provider-ca active — trusting {count} extra root(s) from {}. Development only, never ship this build.",
        resolved.display()
    );
    Ok(builder)
}
