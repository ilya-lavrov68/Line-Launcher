//! Blocking HTTP helpers with the crate user agent.

use std::{thread, time::Duration};

use reqwest::blocking::{Client, Response};

use crate::{LauncherError, Result};

const NEOFORGE_MAVEN_HOST: &str = "maven.neoforged.net";
const NEOFORGE_FALLBACK_HOST: &str = "maven.creeperhost.net";
const MAX_ATTEMPTS_PER_HOST: usize = 3;

/// Returns the user agent used by crate-managed HTTP requests.
pub fn user_agent() -> String {
    format!("mc-launcher-core/{}", env!("CARGO_PKG_VERSION"))
}

/// Builds a blocking reqwest client with bounded connection and request times.
///
/// # Errors
///
/// Returns [`crate::LauncherError`] if the client cannot be constructed.
pub fn client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent(user_agent())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(90))
        .build()?)
}

/// Returns an official NeoForge-recommended Maven fallback for supported URLs.
///
/// NeoForged's own website recommends `https://maven.creeperhost.net` when its
/// Maven is temporarily unavailable. Restrict this rewrite to HTTPS release
/// artifacts on the exact NeoForge host; never redirect arbitrary URLs.
pub fn fallback_urls(url: &str) -> Vec<String> {
    let Ok(parsed) = url::Url::parse(url) else {
        return vec![url.to_string()];
    };
    if parsed.scheme() != "https"
        || parsed.host_str() != Some(NEOFORGE_MAVEN_HOST)
        || !parsed.path().starts_with("/releases/")
    {
        return vec![url.to_string()];
    }

    // CreeperHost exposes the NeoForged `/releases` repository at its root.
    let mirror_path = parsed
        .path()
        .strip_prefix("/releases")
        .unwrap_or(parsed.path())
        .to_owned();
    let mut fallback = parsed;
    if fallback.set_host(Some(NEOFORGE_FALLBACK_HOST)).is_err() {
        return vec![url.to_string()];
    }
    fallback.set_path(&mirror_path);
    let fallback = fallback.to_string();
    if fallback == url {
        vec![url.to_string()]
    } else {
        vec![url.to_string(), fallback]
    }
}

/// Sends a GET request, retrying transient failures before trying the trusted
/// fallback (where applicable). Not-found and access-denied responses are not
/// retried or redirected, so a bad version cannot be disguised as a network
/// outage.
pub fn get_response_with_client(client: &Client, url: &str) -> Result<Response> {
    let candidates = fallback_urls(url);
    let has_fallback = candidates.len() > 1;
    let mut last_error = None;

    for (candidate_index, candidate) in candidates.iter().enumerate() {
        for attempt in 0..MAX_ATTEMPTS_PER_HOST {
            match client.get(candidate).send() {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let error = response.error_for_status().expect_err("non-success status");
                    let retryable = is_retryable(&error);
                    last_error = Some(LauncherError::Network { source: error });
                    if !retryable {
                        return Err(last_error.expect("error was just stored"));
                    }
                }
                Err(error) => {
                    let retryable = is_retryable(&error);
                    last_error = Some(LauncherError::Network { source: error });
                    if !retryable {
                        return Err(last_error.expect("error was just stored"));
                    }
                }
            }

            if attempt + 1 < MAX_ATTEMPTS_PER_HOST {
                let delay = if attempt == 0 { 350 } else { 900 };
                thread::sleep(Duration::from_millis(delay));
            }
        }

        // A fallback is only attempted after a transient failure at the origin.
        // If there is no trusted fallback, return the original failure.
        if candidate_index == 0 && !has_fallback {
            break;
        }
    }

    Err(last_error.expect("at least one GET attempt was made"))
}

pub fn is_retryable(error: &reqwest::Error) -> bool {
    if error.is_timeout() || error.is_connect() {
        return true;
    }
    matches!(error.status().map(|status| status.as_u16()), Some(429 | 500..=599))
}

/// Fetches a URL as text.
///
/// # Errors
///
/// Returns [`crate::LauncherError`] if the request fails, returns an error
/// status, or the body cannot be decoded as text.
pub fn get_text(url: &str) -> Result<String> {
    Ok(get_response_with_client(&client()?, url)?.text()?)
}

/// Fetches a URL and decodes the JSON body.
///
/// # Errors
///
/// Returns [`crate::LauncherError`] if the request fails, returns an error
/// status, or the body cannot be decoded as `T`.
pub fn get_json<T>(url: &str) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    Ok(get_response_with_client(&client()?, url)?.json()?)
}

#[cfg(test)]
mod tests {
    use super::fallback_urls;

    #[test]
    fn neoforge_release_urls_get_exactly_the_official_fallback() {
        assert_eq!(
            fallback_urls("https://maven.neoforged.net/releases/net/neoforged/neoforge/x/a.jar"),
            [
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/x/a.jar",
                "https://maven.creeperhost.net/net/neoforged/neoforge/x/a.jar",
            ]
        );
    }

    #[test]
    fn unrelated_hosts_and_non_release_paths_are_never_rewritten() {
        for url in [
            "https://example.com/releases/a.jar",
            "http://maven.neoforged.net/releases/a.jar",
            "https://maven.neoforged.net/api/maven/versions/releases/",
        ] {
            assert_eq!(fallback_urls(url), [url]);
        }
    }
}
