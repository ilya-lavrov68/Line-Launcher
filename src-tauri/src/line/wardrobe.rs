//! Wardrobe: read and replace the account skin through provider endpoints.
//!
//! The provider owns storage and the account binding. The launcher only
//! validates the PNG locally and forwards it under the existing bearer session,
//! so no second credential or upload token is introduced. Endpoints are
//! HTTPS-only and direct-only — a redirect never receives the access token.
use super::config::{validate_https, WardrobeConfig};
use super::error::{ErrorCode, LineError, LineResult};
use super::http;
use super::state::LineState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// A 64x64 RGBA skin is ~1 KiB compressed; 256 KiB leaves room for detail while
/// still refusing anything that is not really a skin texture.
pub const MAX_SKIN_BYTES: usize = 256 * 1024;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkinModel {
    Classic,
    Slim,
}

impl SkinModel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Classic => "classic",
            Self::Slim => "slim",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinState {
    pub model: SkinModel,
    pub texture_url: String,
}

#[derive(Deserialize)]
struct ProviderSkin {
    model: SkinModel,
    texture_url: String,
}

/// Validate the PNG header without a decoder dependency: real signature, an
/// IHDR that is exactly 13 bytes, and the dimensions Minecraft accepts.
/// Returns the parsed width/height.
pub fn validate_skin_png(bytes: &[u8]) -> LineResult<(u32, u32)> {
    if bytes.len() < 33 {
        return Err(LineError::input("Файл слишком мал для скина."));
    }
    if bytes.len() > MAX_SKIN_BYTES {
        return Err(LineError::input(
            "Скин больше 256 КБ. Используйте текстуру 64×64 или 64×32.",
        ));
    }
    if bytes[..8] != PNG_SIGNATURE {
        return Err(LineError::input("Нужен файл PNG."));
    }
    if &bytes[12..16] != b"IHDR" {
        return Err(LineError::input("В PNG отсутствует заголовок IHDR."));
    }
    let length = u32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    if length != 13 {
        return Err(LineError::input("Некорректный заголовок PNG."));
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width != 64 || !(height == 64 || height == 32) {
        return Err(LineError::input(
            "Размер скина должен быть 64×64 или 64×32 пикселя.",
        ));
    }
    // The game's PNG reader is libpng and accepts every 8-bit colour type, so
    // the launcher refuses only what it genuinely cannot decode:
    //  - palette (3) is an ordinary PNG and common in skins exported by older
    //    editors; transparency arrives through the optional tRNS chunk.
    //    Refusing it was a false negative that rejected good textures;
    //  - greyscale (0) and greyscale+alpha (4) cannot become an RGBA texture,
    //    and Minecraft does not accept them either;
    //  - 16-bit channels (depth 16) lose precision and are not accepted.
    let depth = bytes[24];
    let colour = bytes[25];
    if depth != 8 || !matches!(colour, 2 | 3 | 6) {
        return Err(LineError::input(
            "Скин должен быть PNG с глубиной 8 бит: RGB, RGBA или палитровый.",
        ));
    }
    if bytes[28] != 0 {
        return Err(LineError::input("Чересстрочный PNG не поддерживается."));
    }
    Ok((width, height))
}

fn parse_skin(bytes: &[u8]) -> LineResult<SkinState> {
    let parsed: ProviderSkin = serde_json::from_slice(bytes).map_err(|_| {
        LineError::new(
            ErrorCode::InvalidInput,
            "Провайдер вернул некорректные данные скина.",
            false,
        )
    })?;
    // The texture URL crosses into an <img>; hold it to the same HTTPS rule as
    // every other provider-supplied URL.
    validate_https(&parsed.texture_url)?;
    Ok(SkinState {
        model: parsed.model,
        texture_url: parsed.texture_url,
    })
}

fn auth_error(error: LineError) -> LineError {
    match error.http_status {
        Some(401 | 403) => LineError::new(
            ErrorCode::AuthRequired,
            "Сессия провайдера отклонена. Войдите повторно.",
            false,
        ),
        _ => error,
    }
}

/// The project's wardrobe endpoints, or a message that explains skins stay
/// local. Kept in one place so read/upload/reset cannot disagree.
fn account_wardrobe(config: &super::config::LineConfig) -> LineResult<&WardrobeConfig> {
    config.provider.wardrobe.as_ref().ok_or_else(|| {
        LineError::input("Проект не настроил гардероб. Скин сохранён локально и применится в игре.")
    })
}

/// The account's current skin, or None when unset (provider answers 404).
/// The wardrobe belongs to the project account, so there is no server id.
#[tauri::command]
pub async fn get_skin(state: State<'_, LineState>) -> LineResult<Option<SkinState>> {
    let (_, config) = state.fresh_config()?;
    let wardrobe = account_wardrobe(&config)?;
    let session = state.session()?;
    let url = validate_https(&wardrobe.skin_url)?;
    let token = session.secret_token();
    let response = http::get_bearer(&state.http, &url, &token).await?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    let mut response = http::success(response).map_err(auth_error)?;
    let bytes = http::read_limited(&mut response, 16 * 1024).await?;
    Ok(Some(parse_skin(&bytes)?))
}

/// The single upload path, used by the automatic sync. Validation, HTTPS rules
/// and bearer handling live here so nothing can drift.
pub async fn push_skin(
    model: SkinModel,
    png: Vec<u8>,
    state: &State<'_, LineState>,
) -> LineResult<SkinState> {
    validate_skin_png(&png)?;
    let (_, config) = state.fresh_config()?;
    let wardrobe = account_wardrobe(&config)?;
    let session = state.session()?;
    let url = validate_https(&wardrobe.skin_upload_url)?;
    let token = session.secret_token();
    let mut response = http::send_bearer_bytes(
        &state.http,
        reqwest::Method::POST,
        &url,
        &token,
        "image/png",
        Some(("X-Skin-Model", model.as_str())),
        png,
    )
    .await
    .map_err(auth_error)?;
    let bytes = http::read_limited(&mut response, 16 * 1024).await?;
    parse_skin(&bytes)
}

/// Clears the account's custom skin. Called by the automatic sync when the
/// player picks the standard look; there is no manual upload/reset command.
pub async fn reset_skin(state: &State<'_, LineState>) -> LineResult<()> {
    let (_, config) = state.fresh_config()?;
    let wardrobe = account_wardrobe(&config)?;
    let session = state.session()?;
    let url = validate_https(&wardrobe.skin_upload_url)?;
    let token = session.secret_token();
    let mut response = http::send_bearer_bytes(
        &state.http,
        reqwest::Method::DELETE,
        &url,
        &token,
        "application/json",
        None,
        Vec::new(),
    )
    .await
    .map_err(auth_error)?;
    // A reset may answer 204 with no body; drain bounded either way.
    let _ = http::read_limited(&mut response, 16 * 1024).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal PNG header with a chosen size/depth/colour type.
    fn header(width: u32, height: u32, depth: u8, colour: u8, interlace: u8) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.push(depth);
        bytes.push(colour);
        bytes.extend_from_slice(&[0, 0, interlace]);
        bytes.extend_from_slice(&[0; 16]);
        bytes
    }

    #[test]
    fn accepts_both_minecraft_skin_sizes() {
        assert_eq!(
            validate_skin_png(&header(64, 64, 8, 6, 0)).unwrap(),
            (64, 64)
        );
        assert_eq!(
            validate_skin_png(&header(64, 32, 8, 6, 0)).unwrap(),
            (64, 32)
        );
        assert!(validate_skin_png(&header(64, 64, 8, 2, 0)).is_ok());
        // Palette PNGs (with or without tRNS) are valid skins — this was the
        // false negative that rejected a plain 64x64 texture.
        assert!(validate_skin_png(&header(64, 64, 8, 3, 0)).is_ok());
        assert!(validate_skin_png(&header(64, 32, 8, 3, 0)).is_ok());
    }

    #[test]
    fn rejects_wrong_dimensions_depth_and_interlace() {
        for (w, h) in [(32, 32), (64, 63), (128, 128), (0, 64), (64, 0)] {
            assert!(
                validate_skin_png(&header(w, h, 8, 6, 0)).is_err(),
                "accepted {w}x{h}"
            );
        }
        assert!(validate_skin_png(&header(64, 64, 16, 6, 0)).is_err());
        // Greyscale and greyscale+alpha cannot be turned into an RGBA skin.
        assert!(validate_skin_png(&header(64, 64, 8, 0, 0)).is_err());
        assert!(validate_skin_png(&header(64, 64, 8, 4, 0)).is_err());
        assert!(validate_skin_png(&header(64, 64, 8, 6, 1)).is_err());
    }

    #[test]
    fn rejects_non_png_and_oversize() {
        assert!(validate_skin_png(b"").is_err());
        assert!(validate_skin_png(&[0u8; 64]).is_err());
        let mut fake = header(64, 64, 8, 6, 0);
        fake[0] = b'G';
        assert!(validate_skin_png(&fake).is_err());
        let mut no_ihdr = header(64, 64, 8, 6, 0);
        no_ihdr[12] = b'X';
        assert!(validate_skin_png(&no_ihdr).is_err());
        let huge = vec![0u8; MAX_SKIN_BYTES + 1];
        assert!(validate_skin_png(&huge).is_err());
    }

    #[test]
    fn texture_url_must_be_https() {
        let bad = br#"{"model":"slim","texture_url":"http://example.test/s.png"}"#;
        assert!(parse_skin(bad).is_err());
        let good = br#"{"model":"slim","texture_url":"https://example.test/s.png"}"#;
        let parsed = parse_skin(good).unwrap();
        assert_eq!(parsed.model, SkinModel::Slim);
        assert_eq!(parsed.model.as_str(), "slim");
    }
}
