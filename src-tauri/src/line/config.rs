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

/// One account per project. The player signs in once and reaches every server
/// this provider lists, so credentials and the skin belong to the provider, not
/// to an individual server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountAuth {
    pub login_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub register_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub auth: AccountAuth,
    /// Account-wide wardrobe. Absent = the project has no skin API and skins
    /// stay local-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wardrobe: Option<WardrobeConfig>,
    /// Where this project's players write when something is wrong.
    ///
    /// Optional on purpose. A provider without a support desk still gets the
    /// publisher's «Отправить по Email»; a provider *with* one gets an extra
    /// «Связаться с провайдером» that opens a draft to this address. It is a
    /// plain mail address, not a URL: the launcher builds the `mailto:` itself,
    /// so a config cannot hand it a different protocol to launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_email: Option<String>,
}

/// Per-server game-join endpoints. These stay on the server because a launch
/// ticket authorises joining that specific server, not the account.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LaunchAuth {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_ticket_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_exchange_url: Option<String>,
}

/// Where the server's game archive lives.
///
/// A provider publishes a new build by putting a new ZIP at the same address:
/// one link, nothing else to fill in. The launcher reads what it needs while
/// downloading — the SHA-256 it computes is the release's identity, and the
/// sizes it measures are the ones it checks the archive against.
///
/// The three integrity fields stay accepted so a provider who *does* want to pin
/// an exact archive can still say so. They are optional now, because requiring
/// them asked the person editing the config to run a checksum tool and count
/// bytes for a file they had just uploaded, which is exactly the "долго и
/// муторно" this replaces. A pinned value is still enforced byte for byte —
/// dropping it from the required set must not weaken a config that provides it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Distribution {
    pub url: String,
    /// Optional. When present the archive must hash to exactly this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Optional. When present the download must be exactly this long.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Optional. When present extraction must produce exactly this many bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unpacked_size_bytes: Option<u64>,
}

impl Distribution {
    /// The archive this record describes, once its pinned fields are known.
    ///
    /// Callers that need all four values (the installer) resolve them first:
    /// either from `pack.json`, from the pinned config, or from the download
    /// itself. Keeping that resolution in one place is what lets the config
    /// carry a bare URL without every consumer growing a branch.
    pub fn pinned(&self) -> (Option<&str>, Option<u64>, Option<u64>) {
        (
            self.sha256.as_deref(),
            self.size_bytes,
            self.unpacked_size_bytes,
        )
    }
}

/// Optional wardrobe endpoints. Both must be present together so a provider
/// cannot advertise an upload target the launcher can never read back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WardrobeConfig {
    /// GET with bearer session -> { model, texture_url }, or 404 when unset.
    pub skin_url: String,
    /// POST raw PNG with bearer session and `X-Skin-Model`; DELETE resets.
    pub skin_upload_url: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    /// Missing endpoints keep launch disabled; they never imply offline.
    #[default]
    Ticket,
    /// A provider-owned local pack: project account, no per-server ticket/IPC.
    Offline,
    /// The server is a real Minecraft server joined through `mc-launcher-core`
    /// rather than through the provider's ZIP + ticket pipeline. It is an
    /// explicit opt-in, never inferred: a config that does not say `minecraft`
    /// behaves exactly as it did before this variant existed, so a provider
    /// upgrading the launcher cannot accidentally start downloading Mojang
    /// assets or launch a vanilla client at its players.
    Minecraft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Square mark. `logo_url` is still accepted from older provider configs.
    #[serde(default, alias = "logo_url", skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// Wide hero image for the server card and detail header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub banner_url: Option<String>,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minecraft_version: Option<String>,
    #[serde(default)]
    pub launch_mode: LaunchMode,
    /// Host or host:port the client joins immediately after launch. Required by
    /// the Minecraft mode; provider ZIP packs may omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_address: Option<String>,
    #[serde(default)]
    pub auth: LaunchAuth,
    /// `pack.json` beside the archive: { schema_version, url, sha256,
    /// size_bytes, unpacked_size_bytes }. When present it, not the pinned
    /// distribution below, decides whether the pack changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_manifest_url: Option<String>,
    /// Fallback/bootstrap description of the same archive. Still required so
    /// older configs and the ticket flow keep working unchanged.
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

/// A plain mail address, deliberately stricter than RFC 5322.
///
/// The value ends up in a `mailto:` the launcher opens, so it must not be able
/// to smuggle a scheme, a query or a path: no spaces, no `?`, no `#`, no `&`,
/// exactly one `@`, and a dot in the domain. Anything fancier than that is not
/// a support address a launcher should dial.
pub fn valid_support_email(raw: &str) -> bool {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 254 || raw.trim() != raw {
        return false;
    }
    if raw
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || "?#&=%<>()[];:,\\\"'`".contains(c))
    {
        return false;
    }
    let mut parts = raw.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain.split('.').all(|label| !label.is_empty())
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
                "custom-auth-v1"
                    | "zip-sha256-v1"
                    | "launch-manifest-v1"
                    | "private-ipc-v1"
                    | "offline-launch-v1"
                    | "skin-upload-v1"
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
        validate_https(&self.provider.auth.login_url).map_err(|_| {
            LineError::input(
                "provider.auth.login_url обязателен: в лаунчере один аккаунт на проект.",
            )
        })?;
        if let Some(url) = &self.provider.auth.register_url {
            validate_https(url)?;
        }
        if let Some(wardrobe) = &self.provider.wardrobe {
            validate_https(&wardrobe.skin_url)?;
            validate_https(&wardrobe.skin_upload_url)?;
        }
        // Optional, but if present it has to be a mail address and not a URL:
        // the launcher turns it into `mailto:` itself.
        if let Some(address) = &self.provider.support_email {
            if !valid_support_email(address) {
                return Err(LineError::input(
                    "provider.support_email должен быть адресом электронной почты.",
                ));
            }
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
            if let Some(url) = &server.icon_url {
                validate_https(url)?;
            }
            if let Some(url) = &server.banner_url {
                validate_https(url)?;
            }
            if let Some(address) = &server.server_address {
                super::minecraft_core::validate_server_address(address)?;
            }
            if let Some(url) = &server.pack_manifest_url {
                validate_https(url)?;
            }
            if matches!(server.launch_mode, LaunchMode::Offline | LaunchMode::Minecraft)
                && (server.auth.launch_ticket_url.is_some()
                    || server.auth.session_exchange_url.is_some())
            {
                return Err(LineError::input(
                    "launch_mode=offline/minecraft несовместим с launch_ticket_url/session_exchange_url.",
                ));
            }
            // The Minecraft mode is the one branch that does not go through the
            // provider ZIP, so what it needs is checked here and nowhere else:
            // an address to join (validated above when present) and a version to
            // install. Failing at parse time turns a provider mistake into one
            // clear error instead of a button that cannot work.
            if server.launch_mode == LaunchMode::Minecraft {
                if server.server_address.is_none() {
                    return Err(LineError::input(
                        "launch_mode=minecraft требует server_address: лаунчер заходит на сервер сразу после запуска.",
                    ));
                }
                if server.minecraft_version.is_none() {
                    return Err(LineError::input(
                        "launch_mode=minecraft требует minecraft_version в конфиге сервера.",
                    ));
                }
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
            // A Minecraft-mode server installs from Mojang's own manifests, not
            // from a provider archive, so its distribution record is unused and
            // an empty placeholder must not fail validation. Everything else
            // still has to describe a real, bounded archive.
            if server.launch_mode == LaunchMode::Minecraft {
                continue;
            }
            let dist = &server.distribution;
            validate_https(&dist.url)?;
            // A bare link is the normal case now: the archive's own contents
            // become the reference as it downloads. Anything the provider *did*
            // pin is held to the same rules as before, so an optional field
            // cannot become a wrong one — a malformed digest or an absurd size
            // is still a config error, not a hint to ignore.
            if let Some(sha256) = &dist.sha256 {
                if sha256.len() != 64
                    || !sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(LineError::input(
                        "distribution.sha256 должен содержать 64 шестнадцатеричных символа.",
                    ));
                }
            }
            if dist.size_bytes.is_some_and(|bytes| {
                bytes == 0 || bytes > MAX_ARCHIVE_BYTES
            }) {
                return Err(LineError::input(
                    "distribution.size_bytes должен быть больше нуля и не больше 4 ГиБ.",
                ));
            }
            if dist.unpacked_size_bytes.is_some_and(|bytes| {
                bytes == 0 || bytes > MAX_UNPACKED_BYTES
            }) {
                return Err(LineError::input(
                    "distribution.unpacked_size_bytes должен быть больше нуля и не больше 16 ГиБ.",
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

    #[test]
    fn a_support_address_cannot_smuggle_a_scheme() {
        for good in [
            "help@example.com",
            "Help@Example.COM",
            "a.b+tag@sub.example.co.uk",
        ] {
            assert!(valid_support_email(good), "{good} should be accepted");
        }
        for bad in [
            "",
            "help@example",
            "@example.com",
            "help@@example.com",
            "help@exam ple.com",
            " user@example.com",
            "user@example.com ",
            "user@.com",
            "user@example..com",
            "help@example.com?subject=x",
            "help@example.com&bcc=evil@x.com",
            "javascript:alert(1)@x.com",
            "help@example.com#frag",
        ] {
            assert!(!valid_support_email(bad), "{bad} should be rejected");
        }
        // 64 local chars is the SMTP limit; 65 is not an address.
        assert!(valid_support_email(&format!("{}@example.com", "x".repeat(64))));
        assert!(!valid_support_email(&format!("{}@example.com", "x".repeat(65))));
    }

    #[test]
    fn an_optional_support_address_is_validated_when_present() {
        let mut cfg = config();
        cfg.provider.support_email = None;
        assert!(cfg.validate("0.10.0").is_ok());
        cfg.provider.support_email = Some("help@example.com".into());
        assert!(cfg.validate("0.10.0").is_ok());
        cfg.provider.support_email = Some("not an address".into());
        assert!(cfg.validate("0.10.0").is_err());
    }

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
        c.servers[0].distribution.sha256 = Some("ABC".into());
        assert!(c.validate("0.1.0").is_err());
        // A bare link is a complete distribution now: publishing a build is
        // "put a ZIP at a URL", and everything else is measured on download.
        let mut bare = config();
        bare.servers[0].distribution = Distribution {
            url: "https://example.com/pack.zip".into(),
            sha256: None,
            size_bytes: None,
            unpacked_size_bytes: None,
        };
        bare.validate("0.1.0").unwrap();
        // Pinning one field is still an all-or-nothing promise for that field.
        let mut wrong_size = config();
        wrong_size.servers[0].distribution.size_bytes = Some(0);
        assert!(wrong_size.validate("0.1.0").is_err());
        let mut c = config();
        let duplicate = c.servers[0].clone();
        c.servers.push(duplicate);
        assert!(c.validate("0.1.0").is_err());
    }

    #[test]
    fn offline_is_explicit_and_cannot_carry_ticket_endpoints() {
        let mut c = config();
        c.servers[0].launch_mode = LaunchMode::Offline;
        c.required_features.push("offline-launch-v1".into());
        c.validate("0.1.0").unwrap();
        c.servers[0].auth.launch_ticket_url = Some("https://example.com/ticket".into());
        assert!(c.validate("0.1.0").is_err());
        // Missing endpoints alone are still the disabled ticket mode, not offline.
        let plain: Server = serde_json::from_value(serde_json::json!({
            "id": "local", "name": "Local", "description": "Pack", "version": "1",
            "distribution": { "url": "https://example.com/pack.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size_bytes": 1, "unpacked_size_bytes": 1 }
        })).unwrap();
        assert_eq!(plain.launch_mode, LaunchMode::Ticket);
        assert!(serde_json::from_value::<Server>(serde_json::json!({
            "id": "local", "name": "Local", "description": "Pack", "version": "1", "launch_mode": "pirate",
            "distribution": { "url": "https://example.com/pack.zip", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size_bytes": 1, "unpacked_size_bytes": 1 }
        })).is_err());
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
