//! Optional, consent-gated minimal provider telemetry.
use super::config::validate_https;
use super::error::LineResult;
use super::state::LineState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Login,
    Register,
    Install,
    Prepare,
    Launch,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Failure,
    Cancelled,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventRequest {
    pub stage: Stage,
    pub duration_ms: u64,
    #[serde(default)]
    pub data_bytes: u64,
    pub outcome: Outcome,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    launcher_version: &'static str,
    os: &'static str,
    stage: Stage,
    duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_bytes: Option<u64>,
    outcome: Outcome,
}

/// Sends an allowlisted event only when both HTTPS endpoints and explicit local
/// consent are present. Endpoint failures are intentionally non-fatal.
#[tauri::command]
pub async fn send_provider_telemetry(
    request: EventRequest,
    app: AppHandle,
    state: State<'_, LineState>,
) -> LineResult<bool> {
    if request.duration_ms > 7 * 24 * 60 * 60 * 1000 {
        return Ok(false);
    }
    let settings = super::settings::load(&app, super::settings::total_memory());
    if !settings.telemetry_consent {
        return Ok(false);
    }
    let Ok((_, config)) = state.fresh_config() else {
        return Ok(false);
    };
    let (Some(endpoint), Some(_privacy)) = (
        config.provider.telemetry_url.as_deref(),
        config.provider.privacy_url.as_deref(),
    ) else {
        return Ok(false);
    };
    let Ok(url) = validate_https(endpoint) else {
        return Ok(false);
    };
    let payload = EventPayload {
        launcher_version: super::LAUNCHER_VERSION,
        os: std::env::consts::OS,
        stage: request.stage,
        duration_ms: request.duration_ms,
        data_bytes: (request.data_bytes > 0).then_some(request.data_bytes),
        outcome: request.outcome,
    };
    let sent = state
        .http
        .post(url)
        .timeout(std::time::Duration::from_secs(4))
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&payload)
        .send()
        .await
        .is_ok_and(|response| response.status().is_success());
    Ok(sent)
}
