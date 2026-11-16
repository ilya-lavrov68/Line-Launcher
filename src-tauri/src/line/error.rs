use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidInput,
    UnsupportedVersion,
    Network,
    TlsUntrusted,
    HttpStatus,
    InvalidCredentials,
    AccountExists,
    RateLimited,
    AuthRequired,
    JavaRequired,
    ConfirmationRequired,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zip_repair: Option<Box<super::zip_repair::ZipRepairPlan>>,
}

impl LineError {
    pub fn new(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            http_status: None,
            zip_repair: None,
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
        // Flatten the source chain for classification only. The text is never
        // serialized, logged or shown: it can contain URLs and host details.
        let mut chain = String::new();
        let mut current: Option<&dyn std::error::Error> = Some(error);
        while let Some(link) = current {
            if chain.len() > 4096 {
                break;
            }
            chain.push_str(&link.to_string());
            chain.push('\n');
            current = link.source();
        }
        let (code, message) = classify_network_chain(&chain, error.is_timeout());
        // An untrusted certificate will not fix itself on retry.
        Self::new(code, message, code == ErrorCode::Network)
    }
}

/// Maps a flattened error chain to a fixed, non-sensitive message.
///
/// Dependency-free on purpose so it can be unit-tested without reqwest. Matching
/// is done on the *wrapper* text produced by rustls/hyper ("invalid peer
/// certificate", "tcp connect error"), which stays English even when the OS
/// error underneath is localized. Anything unrecognized keeps the generic
/// message, so a wrong guess can only cost detail, never correctness.
pub fn classify_network_chain(chain: &str, is_timeout: bool) -> (ErrorCode, &'static str) {
    let chain = chain.to_lowercase();
    if is_timeout {
        return (
            ErrorCode::Network,
            "Провайдер не ответил вовремя. Попробуйте позже.",
        );
    }
    const TLS_MARKERS: &[&str] = &[
        "invalid peer certificate",
        "invalidcertificate",
        "unknown issuer",
        "unknownissuer",
        "notvalidforname",
        "certificate has expired",
        "certificate expired",
        "certexpired",
        "self signed certificate",
        "self-signed certificate",
        "certificate verify failed",
        "unable to get local issuer certificate",
        "bad certificate",
        "certificate unknown",
        "0x800b0109",
        "0x800b010a",
    ];
    if TLS_MARKERS.iter().any(|m| chain.contains(m)) {
        return (
            ErrorCode::TlsUntrusted,
            "Не удалось проверить сертификат провайдера. Для демо-провайдера разрешите доверие к его сертификату — docs/RUNBOOK.md, раздел 3.2.",
        );
    }
    const CONNECT_MARKERS: &[&str] = &[
        "tcp connect error",
        "connection refused",
        "connection reset",
        "connection closed",
        "dns error",
        "failed to lookup address",
        "no such host",
        "network is unreachable",
        "os error 10061",
        "os error 111",
    ];
    if CONNECT_MARKERS.iter().any(|m| chain.contains(m)) {
        return (
            ErrorCode::Network,
            "Не удалось соединиться с провайдером. Проверьте адрес и что сервер запущен.",
        );
    }
    (
        ErrorCode::Network,
        "Не удалось соединиться с провайдером. Проверьте подключение.",
    )
}

impl fmt::Display for LineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LineError {}
pub type LineResult<T> = Result<T, LineError>;
