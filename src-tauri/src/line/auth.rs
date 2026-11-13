use super::error::{ErrorCode, LineError, LineResult};
use super::logger::{self, Area, Field};
use super::http;
use super::state::{AuthSessionInfo, LineState, ProviderSession};
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
struct ProviderRequest<'a> {
    username: &'a str,
    password: &'a str,
}

#[derive(Deserialize)]
struct ProviderResponse {
    access_token: String,
    expires_in: u64,
    username: Option<String>,
}

async fn authenticate_inner(
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
    // One account for the whole project: the endpoint comes from the provider,
    // and the session it returns unlocks every server in this config.
    let endpoint = if register {
        config
            .provider
            .auth
            .register_url
            .as_ref()
            .ok_or_else(|| LineError::input("Регистрация отключена провайдером."))?
    } else {
        &config.provider.auth.login_url
    };
    let url = super::config::validate_https(endpoint)?;
    // Never put this body (or provider response) in logs/errors/events.
    let body = ProviderRequest {
        username: &request.username,
        password: &password,
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
    state.save_session(session, generation)
}

/// Sign-in, with every failure recorded.
///
/// `authenticate_inner` is the real function: it returns on the first `?`, which
/// is exactly right for the caller and exactly wrong for support, because a `?`
/// leaves no trace. This wrapper is the trace — one record per call, either the
/// outcome or the stage that stopped it.
///
/// The message is the launcher's own fixed sentence, never a provider body, and
/// the password is not in scope here at all: it was zeroized inside the inner
/// call.
async fn authenticate(
    state: &LineState,
    request: AuthRequest,
    register: bool,
) -> LineResult<AuthSessionInfo> {
    let user = request.username.clone();
    let result = authenticate_inner(state, request, register).await;
    match &result {
        Ok(info) => logger::info(
            Area::Auth,
            if register { "register ok" } else { "login ok" },
            &[Field::text("user", &info.username)],
        ),
        Err(error) => logger::error(
            Area::Auth,
            if register {
                "register failed"
            } else {
                "login failed"
            },
            &[
                Field::text("user", &user),
                Field::text("stage", stage_of(error)),
                Field::text("code", format!("{:?}", error.code)),
                Field::flag("retryable", error.retryable),
                Field::text("msg", error.message.clone()),
            ],
        ),
    }
    result
}

/// Which part of the sign-in gave up.
///
/// Derived from the error itself rather than threaded through as an argument,
/// so a new `?` cannot forget to name its stage: anything that is not one of the
/// known shapes is reported as `provider`, which is where every network, TLS
/// and HTTP-status failure comes from.
fn stage_of(error: &LineError) -> &'static str {
    match error.code {
        ErrorCode::InvalidInput => "input",
        ErrorCode::Network | ErrorCode::TlsUntrusted | ErrorCode::HttpStatus => "provider",
        ErrorCode::InvalidCredentials | ErrorCode::AccountExists | ErrorCode::RateLimited => {
            "provider"
        }
        ErrorCode::AuthRequired => "session",
        ErrorCode::Busy => "store",
        _ => "response",
    }
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

/// Restores the account after a WebView reload without asking for a password.
/// Returns None when signed out or expired; never returns the token.
#[tauri::command]
pub async fn line_session(state: State<'_, LineState>) -> LineResult<Option<AuthSessionInfo>> {
    state.session_info()
}

#[tauri::command]
pub async fn line_logout(state: State<'_, LineState>) -> LineResult<()> {
    state.logout()
}
