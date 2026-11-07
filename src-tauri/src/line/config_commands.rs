use super::config::{parse_config, ConfigSnapshot, LineConfig, MAX_CONFIG_BYTES};
use super::error::{ErrorCode, LineError, LineResult};
use super::state::{epoch_millis, LineState};
use super::storage::atomic_write;
use super::{http, LAUNCHER_VERSION};
use reqwest::header::{HeaderMap, IF_NONE_MATCH};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
struct CacheEnvelope {
    source_url: String,
    fetched_at: u64,
    etag: Option<String>,
    config: LineConfig,
}

/// Shared with the settings screen so "clear cache" removes exactly this file.
pub fn cache_file_path(app: &AppHandle) -> LineResult<PathBuf> {
    cache_path(app)
}

fn cache_path(app: &AppHandle) -> LineResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?
        .join("config-cache.json"))
}

fn read_cache(app: &AppHandle) -> LineResult<Option<CacheEnvelope>> {
    let path = cache_path(app)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(LineError::io(&e)),
    };
    if bytes.len() > MAX_CONFIG_BYTES + 4096 {
        return Err(LineError::input("Повреждённый кэш конфигурации."));
    }
    let envelope: CacheEnvelope = serde_json::from_slice(&bytes)
        .map_err(|_| LineError::input("Повреждённый кэш конфигурации."))?;
    // Validate cached data exactly like network data. A cached incompatible
    // config is not a fallback for an incompatible network response.
    envelope.config.validate(LAUNCHER_VERSION)?;
    super::config::validate_https(&envelope.source_url)?;
    Ok(Some(envelope))
}

fn snapshot(envelope: CacheEnvelope, from_cache: bool) -> ConfigSnapshot {
    let stale = epoch_millis().saturating_sub(envelope.fetched_at)
        > envelope.config.ttl_seconds().saturating_mul(1000);
    ConfigSnapshot {
        config: envelope.config,
        source_url: envelope.source_url,
        fetched_at: envelope.fetched_at,
        from_cache,
        stale,
    }
}

fn save_cache(app: &AppHandle, envelope: &CacheEnvelope) -> LineResult<()> {
    let bytes = serde_json::to_vec(envelope).map_err(|_| LineError::storage())?;
    atomic_write(&cache_path(app)?, &bytes)
}

/// Treat malformed/incompatible cache as a cache miss, not as an offline fallback.
/// A subsequent network fetch can repair it. Filesystem errors remain actionable.
fn read_recoverable_cache(app: &AppHandle) -> LineResult<Option<CacheEnvelope>> {
    match read_cache(app) {
        Ok(cache) => Ok(cache),
        Err(error)
            if matches!(
                error.code,
                ErrorCode::InvalidInput | ErrorCode::UnsupportedVersion
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn get_cached_config(
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<Option<ConfigSnapshot>> {
    let app_for_io = app.clone();
    let cached = tauri::async_runtime::spawn_blocking(move || read_recoverable_cache(&app_for_io))
        .await
        .map_err(|_| LineError::storage())??;
    if let Some(envelope) = cached {
        let _publish = state.config_publish.lock().await;
        state.set_config(
            envelope.source_url.clone(),
            envelope.config.clone(),
            envelope.fetched_at,
        )?;
        Ok(Some(snapshot(envelope, true)))
    } else {
        Ok(None)
    }
}

/// Fetch and validate a provider config. `force` bypasses TTL, not validation.
/// On transport/5xx failures only, return the last valid cache marked stale.
#[tauri::command]
pub async fn fetch_line_config(
    url: String,
    force: Option<bool>,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<ConfigSnapshot> {
    let normalized = super::config::validate_https(&url)?.to_string();
    let _publish = state.config_publish.lock().await;
    let cache_app = app.clone();
    let cached = tauri::async_runtime::spawn_blocking(move || read_recoverable_cache(&cache_app))
        .await
        .map_err(|_| LineError::storage())??;
    let matching = cached.filter(|c| c.source_url == normalized);
    if force != Some(true) {
        if let Some(cache) = matching.clone() {
            let snap = snapshot(cache, true);
            if !snap.stale {
                state.set_config(
                    snap.source_url.clone(),
                    snap.config.clone(),
                    snap.fetched_at,
                )?;
                return Ok(snap);
            }
        }
    }
    let mut headers = HeaderMap::new();
    if let Some(etag) = matching.as_ref().and_then(|c| c.etag.as_deref()) {
        if let Ok(value) = etag.parse() {
            headers.insert(IF_NONE_MATCH, value);
        }
    }
    let fetched = async {
        let response = http::get(&state.http, &normalized, headers).await?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            let mut cache = matching.clone().ok_or_else(|| {
                LineError::input("Сервер вернул 304 без сохранённой конфигурации.")
            })?;
            cache.config.validate(LAUNCHER_VERSION)?;
            cache.fetched_at = epoch_millis();
            return Ok(cache);
        }
        let status = response.status();
        if !status.is_success() {
            // Drop the undrained response; never buffer an arbitrary provider error.
            return Err(LineError::http(status.as_u16()));
        }
        let mut response = response;
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let bytes = http::read_limited(&mut response, MAX_CONFIG_BYTES).await?;
        let config = parse_config(&bytes, LAUNCHER_VERSION)?;
        Ok(CacheEnvelope {
            source_url: normalized.clone(),
            fetched_at: epoch_millis(),
            etag,
            config,
        })
    }
    .await;

    let envelope = match fetched {
        Ok(envelope) => envelope,
        Err(error) => {
            let transport_failure = error.code == ErrorCode::Network
                || (error.code == ErrorCode::HttpStatus && error.retryable);
            if transport_failure {
                if let Some(cache) = matching {
                    let snap = snapshot(cache, true);
                    state.set_config(
                        snap.source_url.clone(),
                        snap.config.clone(),
                        snap.fetched_at,
                    )?;
                    return Ok(snap);
                }
            }
            return Err(error);
        }
    };
    // Cache write failure must not prevent using a valid, freshly fetched config.
    let cache_app = app.clone();
    let cache_envelope = envelope.clone();
    let _ =
        tauri::async_runtime::spawn_blocking(move || save_cache(&cache_app, &cache_envelope)).await;
    state.set_config(
        envelope.source_url.clone(),
        envelope.config.clone(),
        envelope.fetched_at,
    )?;
    Ok(snapshot(envelope, false))
}
