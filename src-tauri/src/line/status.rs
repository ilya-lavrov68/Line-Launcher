//! Provider-owned live status endpoint. Failures remain distinct from offline.
use super::config::validate_https;
use super::error::{ErrorCode, LineError, LineResult};
use super::http;
use super::state::LineState;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderStatus {
    online: bool,
    #[serde(default)]
    players_online: Option<u32>,
    #[serde(default)]
    players_max: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub online: bool,
    pub players_online: Option<u32>,
    pub players_max: Option<u32>,
    /// HTTP round-trip time to the configured status endpoint, not game latency.
    pub latency_ms: u64,
}

#[tauri::command]
pub async fn get_server_status(
    server_id: String,
    state: State<'_, LineState>,
) -> LineResult<LiveStatus> {
    let (_, config) = state.fresh_config()?;
    let server = config.server(&server_id)?;
    let raw_url = server.status_url.as_deref().ok_or_else(|| {
        LineError::new(ErrorCode::Input, "Статус сервера не настроен.", false)
    })?;
    let url = validate_https(raw_url)?;
    let start = Instant::now();
    let response = http::get(&state.http, url.as_str(), reqwest::header::HeaderMap::new()).await?;
    let mut response = http::success(response)?;
    let bytes = http::read_limited(&mut response, 16 * 1024).await?;
    let status: ProviderStatus = serde_json::from_slice(&bytes).map_err(|_| {
        LineError::new(
            ErrorCode::Input,
            "Провайдер вернул некорректный статус сервера.",
            false,
        )
    })?;
    if status.players_online.zip(status.players_max).is_some_and(|(online, max)| online > max) {
        return Err(LineError::new(
            ErrorCode::Input,
            "Провайдер вернул некорректное число игроков.",
            false,
        ));
    }
    Ok(LiveStatus {
        online: status.online,
        players_online: status.players_online,
        players_max: status.players_max,
        latency_ms: start.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}
