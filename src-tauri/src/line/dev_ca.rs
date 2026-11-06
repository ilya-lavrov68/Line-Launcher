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
use std::path::Path;

/// Path to a PEM certificate (or bundle) to trust for this process.
pub const ENV_VAR: &str = "LINE_DEV_CA_CERT";

fn bad_request(message: impl Into<String>) -> LineError {
    LineError::new(ErrorCode::InvalidInput, message, false)
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

    let path = Path::new(raw.trim());
    let pem = std::fs::read(path).map_err(|_| {
        bad_request(format!(
            "Не удалось прочитать {ENV_VAR}: файл сертификата недоступен."
        ))
    })?;
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
        "[line] WARNING: dev-provider-ca active — trusting {count} extra root(s) from {ENV_VAR}. Development only, never ship this build."
    );
    Ok(builder)
}
