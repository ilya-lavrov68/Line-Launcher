use super::config::validate_https;
use super::error::{ErrorCode, LineError, LineResult};
use reqwest::{header, Response};
use url::Url;

/// A 304 is cache validation, not a redirect: it deliberately has no Location.
fn is_followable_redirect(status: reqwest::StatusCode) -> bool {
    status.is_redirection() && status != reqwest::StatusCode::NOT_MODIFIED
}

/// Manual redirects prevent credentials leaking to a different origin and ensure
/// that every hop is HTTPS. Authorization is deliberately never forwarded.
pub async fn get(
    client: &reqwest::Client,
    raw_url: &str,
    headers: header::HeaderMap,
) -> LineResult<Response> {
    let mut url = validate_https(raw_url)?;
    for _ in 0..5 {
        let response = client
            .get(url.clone())
            .headers(headers.clone())
            .send()
            .await
            .map_err(|e| LineError::network(&e))?;
        if is_followable_redirect(response.status()) {
            let status = response.status().as_u16();
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    LineError::input(format!(
                        "Провайдер ответил HTTP {status} без корректного Location. Адрес config.json должен отдавать JSON напрямую; проверьте настройки сервера и proxy/VPN."
                    ))
                })?;
            url = validate_https(
                url.join(location)
                    .map_err(|_| {
                        LineError::input("Провайдер вернул некорректную ссылку перенаправления.")
                    })?
                    .as_str(),
            )?;
            continue;
        }
        return Ok(response);
    }
    Err(LineError::new(
        ErrorCode::Network,
        "Слишком много перенаправлений.",
        false,
    ))
}

pub async fn read_limited(response: &mut Response, limit: usize) -> LineResult<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(LineError::input(
            "Ответ провайдера превышает допустимый размер.",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| LineError::network(&e))? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(LineError::input(
                "Ответ провайдера превышает допустимый размер.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn success(response: Response) -> LineResult<Response> {
    let status = response.status();
    if status.is_success() {
        Ok(response)
    } else {
        Err(LineError::http(status.as_u16()))
    }
}

pub async fn post_json<T: serde::Serialize>(
    client: &reqwest::Client,
    url: &Url,
    body: &T,
) -> LineResult<Response> {
    // Auth endpoints are direct-only: a redirect must never receive a password.
    let response = client
        .post(url.clone())
        .timeout(std::time::Duration::from_secs(30))
        .header(header::ACCEPT, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| LineError::network(&e))?;
    success(response)
}

/// Direct-only bearer POST used for launch-ticket issuance. The provider access
/// token is never sent to the WebView or placed in a URL.
pub async fn post_bearer_json<T: serde::Serialize>(
    client: &reqwest::Client,
    url: &Url,
    token: &str,
    body: &T,
) -> LineResult<Response> {
    let bearer = zeroize::Zeroizing::new(format!("Bearer {token}"));
    let value = header::HeaderValue::from_str(&bearer)
        .map_err(|_| LineError::input("Некорректная сессия провайдера."))?;
    let response = client
        .post(url.clone())
        .timeout(std::time::Duration::from_secs(30))
        .header(header::ACCEPT, "application/json")
        .header(header::AUTHORIZATION, value)
        .json(body)
        .send()
        .await
        .map_err(|e| LineError::network(&e))?;
    success(response)
}

/// Direct-only bearer GET. Used by the wardrobe to read the current skin; a
/// redirect must never receive the provider access token.
pub async fn get_bearer(client: &reqwest::Client, url: &Url, token: &str) -> LineResult<Response> {
    validate_https(url.as_str())?;
    let bearer = zeroize::Zeroizing::new(format!("Bearer {token}"));
    let value = header::HeaderValue::from_str(&bearer)
        .map_err(|_| LineError::input("Некорректная сессия провайдера."))?;
    let response = client
        .get(url.clone())
        .timeout(std::time::Duration::from_secs(30))
        .header(header::ACCEPT, "application/json")
        .header(header::AUTHORIZATION, value)
        .send()
        .await
        .map_err(|e| LineError::network(&e))?;
    Ok(response)
}

/// Direct-only bearer request with an opaque binary body. Skin PNGs are uploaded
/// as `image/png` rather than multipart so no part boundary can be injected.
pub async fn send_bearer_bytes(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &Url,
    token: &str,
    content_type: &str,
    extra_header: Option<(&str, &str)>,
    body: Vec<u8>,
) -> LineResult<Response> {
    validate_https(url.as_str())?;
    let bearer = zeroize::Zeroizing::new(format!("Bearer {token}"));
    let value = header::HeaderValue::from_str(&bearer)
        .map_err(|_| LineError::input("Некорректная сессия провайдера."))?;
    let mut request = client
        .request(method, url.clone())
        .timeout(std::time::Duration::from_secs(60))
        .header(header::ACCEPT, "application/json")
        .header(header::AUTHORIZATION, value)
        .header(header::CONTENT_TYPE, content_type);
    if let Some((name, val)) = extra_header {
        request = request.header(name, val);
    }
    let response = request
        .body(body)
        .send()
        .await
        .map_err(|e| LineError::network(&e))?;
    success(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_modified_is_returned_to_cache_handler_not_followed() {
        assert!(!is_followable_redirect(reqwest::StatusCode::NOT_MODIFIED));
        assert!(is_followable_redirect(reqwest::StatusCode::FOUND));
        assert!(is_followable_redirect(
            reqwest::StatusCode::TEMPORARY_REDIRECT
        ));
        assert!(!is_followable_redirect(reqwest::StatusCode::OK));
    }
}
