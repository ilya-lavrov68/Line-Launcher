use super::error::{ErrorCode, LineError, LineResult};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use url::Url;

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_CONFIG_BYTES: usize = 1024 * 1024;
pub const MAX_SERVERS: usize = 100;
pub const MAX_ARCHIVE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_UNPACKED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub const MAX_ZIP_ENTRIES: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthConfig {
    pub login_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub register_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_ticket_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_exchange_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Distribution {
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub unpacked_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minecraft_version: Option<String>,
    pub auth: AuthConfig,
    pub distribution: Distribution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineConfig {
    pub schema_version: u32,
    pub min_launcher_version: String,
    pub provider: Provider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_ttl_seconds: Option<u64>,
    #[serde(default)]
    pub required_features: Vec<String>,
    pub servers: Vec<Server>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub config: LineConfig,
    pub source_url: String,
    pub fetched_at: u64,
    pub from_cache: bool,
    pub stale: bool,
}

pub fn validate_slug(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        stem.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    ) {
        return false;
    }
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

pub fn validate_https(raw: &str) -> LineResult<Url> {
    let invalid =
        || LineError::input("Разрешены только HTTPS-ссылки без встроенных учётных данных.");
    if raw.len() > 2048 {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default().is_none()
    {
        return Err(invalid());
    }
    Ok(url)
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

impl LineConfig {
    /// Additive unknown JSON fields are allowed. Unknown REQUIRED features are not.
    /// Version/schema errors must never trigger an unsafe compatibility fallback.
    pub fn validate(&self, launcher_version: &str) -> LineResult<()> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(LineError::new(
                ErrorCode::UnsupportedVersion,
                "Этот формат конфигурации не поддерживается. Обновите Line Launcher.",
                false,
            ));
        }
        let minimum = Version::parse(&self.min_launcher_version).map_err(|_| {
            LineError::input("min_launcher_version должен быть корректной SemVer-версией.")
        })?;
        let current = Version::parse(launcher_version)
            .map_err(|_| LineError::new(ErrorCode::Internal, "Ошибка версии приложения.", false))?;
        if current < minimum {
            return Err(LineError::new(
                ErrorCode::UnsupportedVersion,
                "Провайдер требует более новую версию Line Launcher.",
                false,
            ));
        }
        if self.required_features.iter().any(|f| {
            !matches!(
                f.as_str(),
                "custom-auth-v1" | "zip-sha256-v1" | "launch-manifest-v1" | "private-ipc-v1"
            )
        }) {
            return Err(LineError::new(
                ErrorCode::UnsupportedVersion,
                "Конфигурация требует возможности, которых нет в этой версии лаунчера.",
                false,
            ));
        }
        if !validate_slug(&self.provider.id) || !text(&self.provider.name, 100) {
            return Err(LineError::input("Некорректные данные провайдера."));
        }
        if let Some(url) = &self.provider.logo_url {
            validate_https(url)?;
        }
        if self.servers.is_empty() || self.servers.len() > MAX_SERVERS {
            return Err(LineError::input(
                "Конфигурация должна содержать от 1 до 100 серверов.",
            ));
        }
        if let Some(ttl) = self.cache_ttl_seconds {
            if !(60..=86_400).contains(&ttl) {
                return Err(LineError::input(
                    "cache_ttl_seconds должен быть в диапазоне 60–86400.",
                ));
            }
        }
        let mut ids = HashSet::new();
        for server in &self.servers {
            if !validate_slug(&server.id) || !ids.insert(&server.id) {
                return Err(LineError::input(
                    "Идентификаторы серверов должны быть уникальными безопасными slug.",
                ));
            }
            if !text(&server.name, 100)
                || !text(&server.description, 1000)
                || !text(&server.version, 64)
                || server
                    .minecraft_version
                    .as_ref()
                    .is_some_and(|v| !text(v, 64))
            {
                return Err(LineError::input(
                    "Некорректное название, описание или версия сервера.",
                ));
            }
            if let Some(url) = &server.logo_url {
                validate_https(url)?;
            }
            validate_https(&server.auth.login_url)?;
            if let Some(url) = &server.auth.register_url {
                validate_https(url)?;
            }
            match (
                &server.auth.launch_ticket_url,
                &server.auth.session_exchange_url,
            ) {
                (Some(ticket), Some(exchange)) => {
                    validate_https(ticket)?;
                    validate_https(exchange)?;
                }
                (None, None) => {}
                _ => {
                    return Err(LineError::input(
                        "launch_ticket_url и session_exchange_url должны быть заданы вместе.",
                    ))
                }
            }
            let dist = &server.distribution;
            validate_https(&dist.url)?;
            if dist.sha256.len() != 64
                || !dist
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(LineError::input(
                    "distribution.sha256 должен содержать 64 шестнадцатеричных символа.",
                ));
            }
            if dist.size_bytes == 0
                || dist.size_bytes > MAX_ARCHIVE_BYTES
                || dist.unpacked_size_bytes == 0
                || dist.unpacked_size_bytes > MAX_UNPACKED_BYTES
            {
                return Err(LineError::input(
                    "Размер сборки отсутствует или превышает лимиты лаунчера.",
                ));
            }
        }
        Ok(())
    }

    pub fn ttl_seconds(&self) -> u64 {
        self.cache_ttl_seconds.unwrap_or(300)
    }

    pub fn server(&self, id: &str) -> LineResult<&Server> {
        self.servers.iter().find(|s| s.id == id).ok_or_else(|| {
            LineError::input("Сервер больше не представлен в конфигурации провайдера.")
        })
    }
}

pub fn parse_config(bytes: &[u8], launcher_version: &str) -> LineResult<LineConfig> {
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(LineError::input("Конфигурация превышает лимит 1 МиБ."));
    }
    let config: LineConfig = serde_json::from_slice(bytes).map_err(|_| {
        LineError::input("Некорректный config.json: проверьте обязательные поля и типы.")
    })?;
    config.validate(launcher_version)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> LineConfig {
        serde_json::from_str(include_str!("../../../examples/config.json")).unwrap()
    }

    #[test]
    fn accepts_example() {
        config().validate("0.1.0").unwrap();
    }

    #[test]
    fn semver_is_not_compared_lexicographically() {
        let mut c = config();
        c.min_launcher_version = "0.10.0".into();
        assert!(c.validate("0.9.0").is_err());
        assert!(c.validate("0.10.0").is_ok());
        c.min_launcher_version = "0.2.0-rc.1".into();
        assert!(c.validate("0.2.0").is_ok());
        assert!(c.validate("0.2.0-beta.9").is_err());
    }

    #[test]
    fn unknown_optional_fields_are_compatible_but_capabilities_are_not() {
        let mut value: serde_json::Value = serde_json::to_value(config()).unwrap();
        value["future_optional_field"] = true.into();
        let c: LineConfig = serde_json::from_value(value.clone()).unwrap();
        c.validate("0.1.0").unwrap();
        value["required_features"] = serde_json::json!(["unknown-v2"]);
        let c: LineConfig = serde_json::from_value(value).unwrap();
        assert_eq!(
            c.validate("0.1.0").unwrap_err().code,
            ErrorCode::UnsupportedVersion
        );
    }

    #[test]
    fn rejects_unsafe_urls_ids_hashes_and_duplicates() {
        for url in [
            "http://example.com/config",
            "file:///etc/passwd",
            "https://user:pass@example.com/a",
            "https://example.com/a#fragment",
        ] {
            assert!(validate_https(url).is_err());
        }
        for id in [
            "../escape",
            "a/b",
            "a\\b",
            "",
            "-leading",
            "with.dot",
            "con",
        ] {
            let mut c = config();
            c.servers[0].id = id.into();
            assert!(c.validate("0.1.0").is_err());
        }
        let mut c = config();
        c.servers[0].distribution.sha256 = "ABC".into();
        assert!(c.validate("0.1.0").is_err());
        let mut c = config();
        let duplicate = c.servers[0].clone();
        c.servers.push(duplicate);
        assert!(c.validate("0.1.0").is_err());
    }

    #[test]
    fn rejects_new_schema_without_fallback() {
        let mut c = config();
        c.schema_version = 2;
        assert_eq!(
            c.validate("0.1.0").unwrap_err().code,
            ErrorCode::UnsupportedVersion
        );
    }
}
