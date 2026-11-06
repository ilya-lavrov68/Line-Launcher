use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidInput,
    UnsupportedVersion,
    Network,
    HttpStatus,
    InvalidCredentials,
    AccountExists,
    RateLimited,
    AuthRequired,
    JavaRequired,
    Integrity,
    UnsafeArchive,
    Storage,
    DiskSpace,
    Busy,
    Cancelled,
    Internal,
}

/// Public, deliberately non-sensitive error DTO. Never serialize reqwest errors,
/// response bodies, passwords, access tokens, signed URLs or local paths.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl LineError {
    pub fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            http_status: None,
        }
    }

    pub fn input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message, false)
    }

    pub fn storage() -> Self {
        Self::new(
            ErrorCode::Storage,
            "Не удалось сохранить файлы. Проверьте доступ к диску.",
            true,
        )
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

    pub fn http(status: u16) -> Self {
        let (code, message, retryable) = match status {
            401 | 403 => (
                ErrorCode::InvalidCredentials,
                "Логин или пароль отклонены сервером.",
                false,
            ),
            409 => (
                ErrorCode::AccountExists,
                "Этот логин уже зарегистрирован.",
                false,
            ),
            429 => (
                ErrorCode::RateLimited,
                "Слишком много запросов. Попробуйте позже.",
                true,
            ),
            404 | 410 => (
                ErrorCode::HttpStatus,
                "Ресурс провайдера больше недоступен.",
                false,
            ),
            408 | 500 | 502 | 503 | 504 => (
                ErrorCode::HttpStatus,
                "Сервер временно недоступен. Попробуйте позже.",
                true,
            ),
            _ => (ErrorCode::HttpStatus, "Провайдер отклонил запрос.", false),
        };
        Self {
            http_status: Some(status),
            ..Self::new(code, message, retryable)
        }
    }

    pub fn network(error: &reqwest::Error) -> Self {
        Self::new(
            ErrorCode::Network,
            if error.is_timeout() {
                "Провайдер не ответил вовремя. Попробуйте позже."
            } else {
                "Не удалось соединиться с провайдером. Проверьте подключение."
            },
            true,
        )
    }
}

impl fmt::Display for LineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LineError {}
pub type LineResult<T> = Result<T, LineError>;
