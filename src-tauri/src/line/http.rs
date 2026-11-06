use super::config::validate_https;
use super::error::{ErrorCode, LineError, LineResult};
use reqwest::{header, Response};
use url::Url;

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
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    LineError::input("Провайдер вернул некорректное перенаправление.")
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
