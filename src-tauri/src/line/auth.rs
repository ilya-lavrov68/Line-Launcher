use super::error::{ErrorCode, LineError, LineResult};
use super::http;
use super::state::{AuthSessionInfo, LineState, ProviderSession};
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub server_id: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
struct ProviderRequest<'a> {
    username: &'a str,
    password: &'a str,
    server_id: &'a str,
}

#[derive(Deserialize)]
struct ProviderResponse {
    access_token: String,
    expires_in: u64,
    username: Option<String>,
}

async fn authenticate(
    state: &LineState,
    request: AuthRequest,
    register: bool,
) -> LineResult<AuthSessionInfo> {
    let password = Zeroizing::new(request.password);
    if request.username.len() < 3
        || request.username.len() > 32
        || !request
            .username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(LineError::input(
            "Логин: 3–32 латинских буквы, цифры или символ подчёркивания.",
        ));
    }
    if password.is_empty() || password.len() > 1024 {
        return Err(LineError::input("Некорректная длина пароля."));
    }
    if register && password.chars().count() < 8 {
        return Err(LineError::input(
            "Пароль должен содержать не менее 8 символов.",
        ));
    }
    let generation = state.generation();
    let (_, config) = state.fresh_config()?;
    let server = config.server(&request.server_id)?;
    let endpoint = if register {
        server
            .auth
            .register_url
            .as_ref()
            .ok_or_else(|| LineError::input("Регистрация отключена провайдером."))?
    } else {
        &server.auth.login_url
    };
    let url = super::config::validate_https(endpoint)?;
    // Never put this body (or provider response) in logs/errors/events.
    let body = ProviderRequest {
        username: &request.username,
        password: &password,
        server_id: &server.id,
    };
    let mut response = http::post_json(&state.http, &url, &body).await?;
    let bytes = Zeroizing::new(http::read_limited(&mut response, 16 * 1024).await?);
    let provider: ProviderResponse = serde_json::from_slice(&bytes).map_err(|_| {
        LineError::new(
            ErrorCode::Internal,
            "API провайдера не соответствует контракту авторизации.",
            false,
        )
    })?;
    let token = Zeroizing::new(provider.access_token);
    if token.is_empty()
        || token.len() > 8192
        || token.chars().any(char::is_control)
        || !(1..=86_400).contains(&provider.expires_in)
    {
        return Err(LineError::new(
            ErrorCode::Internal,
            "API провайдера вернул некорректную сессию.",
            false,
        ));
    }
    let username = provider
        .username
        .unwrap_or_else(|| request.username.clone());
    if username.len() > 64 || username.chars().any(char::is_control) {
        return Err(LineError::new(
            ErrorCode::Internal,
            "API провайдера вернул некорректное имя игрока.",
            false,
        ));
    }
    let session = ProviderSession::new((*token).clone(), username, provider.expires_in);
    state.save_session(server.id.clone(), session, generation)
}

#[tauri::command]
pub async fn line_login(
    request: AuthRequest,
    state: State<'_, LineState>,
) -> LineResult<AuthSessionInfo> {
    authenticate(&state, request, false).await
}

#[tauri::command]
pub async fn line_register(
    request: AuthRequest,
    state: State<'_, LineState>,
) -> LineResult<AuthSessionInfo> {
    authenticate(&state, request, true).await
}

#[tauri::command]
pub async fn line_logout(server_id: String, state: State<'_, LineState>) -> LineResult<()> {
    state.logout(&server_id)
}
