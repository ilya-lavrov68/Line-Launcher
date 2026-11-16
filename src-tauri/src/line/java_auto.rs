//! Automatic Windows Java installation from Eclipse Adoptium release assets.
//! Metadata is public, HTTPS-only and scoped to the official repository. The
//! archive is bounded, SHA-256 checked, safely extracted and verified before use.
use super::error::{ErrorCode, LineError, LineResult};
use super::{install, integrity, java, pack, storage};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;
const MAX_METADATA: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
struct Asset {
    url: String,
    size: u64,
    sha256: String,
}

fn select_asset(body: &[u8], major: u16) -> LineResult<Asset> {
    if !matches!(major, 8 | 17 | 21 | 25) {
        return Err(LineError::new(
            ErrorCode::UnsupportedVersion,
            "Автоматическая установка этой версии Java пока не поддерживается.",
            false,
        ));
    }
    let invalid = || {
        LineError::new(
            ErrorCode::Integrity,
            "Сервер Java вернул некорректные данные выпуска.",
            true,
        )
    };
    let release: serde_json::Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(invalid)?;
    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(invalid)?;
    let prefix = format!("OpenJDK{major}U-jre_x64_windows_hotspot_");
    let matching: Vec<_> = assets
        .iter()
        .filter(|asset| {
            asset
                .get("name")
                .and_then(|v| v.as_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".zip"))
        })
        .collect();
    if matching.len() != 1 {
        return Err(invalid());
    }
    let item = matching[0];
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(invalid)?;
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(invalid());
    }
    let size = item
        .get("size")
        .and_then(|v| v.as_u64())
        .filter(|n| *n > 0 && *n <= MAX_DOWNLOAD)
        .ok_or_else(invalid)?;
    let sha256 = item
        .get("digest")
        .and_then(|v| v.as_str())
        .and_then(|v| v.strip_prefix("sha256:"))
        .filter(|v| integrity::valid_sha256(v))
        .ok_or_else(invalid)?
        .to_string();
    let raw = item
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .ok_or_else(invalid)?;
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    let expected_prefix = format!("/adoptium/temurin{major}-binaries/releases/download/");
    let segments: Vec<_> = url.path_segments().ok_or_else(invalid)?.collect();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with(&expected_prefix)
        || segments.len() != 6
        || segments[5] != name
    {
        return Err(invalid());
    }
    // The release tag has a restricted character set; compare its URL-encoded
    // form to avoid accepting an unrelated release asset.
    if tag.is_empty()
        || !tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+'))
    {
        return Err(invalid());
    }
    let mut expected = url::Url::parse("https://github.com/").map_err(|_| invalid())?;
    expected
        .path_segments_mut()
        .map_err(|_| invalid())?
        .extend([
            "adoptium",
            &format!("temurin{major}-binaries"),
            "releases",
            "download",
            tag,
            name,
        ]);
    if expected.path().replace("%2B", "+").replace("%2b", "+")
        != url.path().replace("%2B", "+").replace("%2b", "+")
    {
        return Err(invalid());
    }
    Ok(Asset {
        url: raw.to_string(),
        size,
        sha256,
    })
}

// Keep the existing TLS classification, but do not call the Adoptium source
// "the provider" or expose URLs, server bodies, or filesystem paths.
fn java_network_error(error: &reqwest::Error) -> LineError {
    let original = LineError::network(error);
    let message = if error.is_timeout() {
        "Сервер Java (Adoptium) не ответил вовремя. Повторите попытку."
    } else if original.code == ErrorCode::TlsUntrusted {
        "Не удалось проверить сертификат сервера Java (Adoptium). Проверьте системные сертификаты."
    } else if error.is_connect() {
        "Не удалось подключиться к серверу Java (Adoptium). Проверьте соединение и повторите."
    } else {
        "Не удалось скачать Java (Adoptium). Повторите попытку."
    };
    LineError::new(original.code, message, original.retryable)
}

async fn read_metadata(response: &mut reqwest::Response) -> LineResult<Vec<u8>> {
    let too_large = || {
        LineError::new(
            ErrorCode::Integrity,
            "Ответ сервера Java слишком большой.",
            false,
        )
    };
    if response
        .content_length()
        .is_some_and(|size| size > MAX_METADATA as u64)
    {
        return Err(too_large());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| java_network_error(&e))? {
        if data.len().saturating_add(chunk.len()) > MAX_METADATA {
            return Err(too_large());
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

fn status_error(status: reqwest::StatusCode) -> LineError {
    let mut error = LineError::new(
        ErrorCode::HttpStatus,
        format!(
            "Не удалось загрузить Java (Adoptium): сервер ответил HTTP {}. Повторите попытку позже.",
            status.as_u16()
        ),
        true,
    );
    error.http_status = Some(status.as_u16());
    error
}

fn client() -> LineResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("LineLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() >= 5
                || url.scheme() != "https"
                || url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
                || !matches!(
                    url.host_str(),
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.error("untrusted Java download redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| java_network_error(&e))
}

async fn cached(target: &Path, major: u16) -> Option<PathBuf> {
    if !storage::is_real_dir(target) {
        return None;
    }
    let target = target.to_path_buf();
    let checked = tokio::task::spawn_blocking(move || {
        let marker = std::fs::read(target.join(integrity::COMPLETE_MARKER)).ok()?;
        if marker.len() > 1024 {
            return None;
        }
        let rel = std::str::from_utf8(&marker).ok()?;
        let path = pack::checked_game_path(&target, rel, false).ok()?;
        let report = integrity::scan(&target).ok()?;
        if !report.is_clean() {
            return None;
        }
        Some(path)
    })
    .await
    .ok()??;
    let runtime = java::inspect_path(&checked.to_string_lossy()).await.ok()?;
    (runtime.major == major).then_some(runtime.path)
}

/// Install a private Java 8/17/21/25 JRE on Windows x64. Other platforms keep
/// the existing Mojang path; the caller decides when this implementation fits.
pub async fn install_windows_x64(
    dir: &Path,
    major: u16,
    progress: impl Fn(u64, Option<u64>) + Send + Sync,
) -> LineResult<PathBuf> {
    let base = pack::checked_game_path(dir, "line-java/.probe", true)?
        .parent()
        .ok_or_else(LineError::storage)?
        .to_path_buf();
    let lock = Arc::new(storage::InstallLock::acquire(&base)?);
    let target = base.join(format!("temurin-{major}-windows-x64"));
    if let Some(path) = cached(&target, major).await {
        return Ok(path);
    }
    progress(0, None);
    let client = client()?;
    let metadata_url =
        format!("https://api.github.com/repos/adoptium/temurin{major}-binaries/releases/latest");
    let mut response = client
        .get(metadata_url)
        .send()
        .await
        .map_err(|e| java_network_error(&e))?;
    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }
    let asset = select_asset(&read_metadata(&mut response).await?, major)?;
    let mut response = client
        .get(&asset.url)
        .send()
        .await
        .map_err(|e| java_network_error(&e))?;
    if !response.status().is_success() {
        return Err(status_error(response.status()));
    }
    if response.content_length().is_some_and(|n| n != asset.size) {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Размер архива Java не совпадает с метаданными.",
            true,
        ));
    }
    let temp = Arc::new(tempfile::tempdir_in(&base).map_err(|e| LineError::io(&e))?);
    let zip_path = temp.path().join("java.zip");
    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .map_err(|e| LineError::io(&e))?;
    let mut sha = Sha256::new();
    let mut received = 0u64;
    let mut last_report = std::time::Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|e| java_network_error(&e))? {
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(LineError::storage)?;
        if received > asset.size {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Архив Java превышает ожидаемый размер.",
                false,
            ));
        }
        sha.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| LineError::io(&e))?;
        if last_report.elapsed() >= Duration::from_millis(100) || received == asset.size {
            progress(received, Some(asset.size));
            last_report = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(|e| LineError::io(&e))?;
    drop(file);
    if received != asset.size || format!("{:x}", sha.finalize()) != asset.sha256 {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Архив Java не прошёл проверку целостности. Повторите попытку.",
            true,
        ));
    }
    progress(0, None);
    let staging = temp.path().join("runtime");
    let extract_path = zip_path.clone();
    let extract_dest = staging.clone();
    // Extraction is not cancelled when its awaiter is dropped. Keep both the
    // temporary directory and its installation lock until the worker exits.
    let worker_temp = Arc::clone(&temp);
    let worker_lock = Arc::clone(&lock);
    let index = tokio::task::spawn_blocking(move || {
        let _worker_temp = worker_temp;
        let _worker_lock = worker_lock;
        // Apply a much smaller cap than general modpacks before extraction.
        let file = std::fs::File::open(&extract_path).map_err(|e| LineError::io(&e))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|_| LineError::new(ErrorCode::Integrity, "Архив Java повреждён.", true))?;
        if archive.is_empty() || archive.len() > 10_000 {
            return Err(LineError::new(
                ErrorCode::UnsafeArchive,
                "Слишком много файлов в архиве Java.",
                false,
            ));
        }
        let mut total = 0u64;
        for i in 0..archive.len() {
            let entry = archive
                .by_index_raw(i)
                .map_err(|_| LineError::new(ErrorCode::Integrity, "Архив Java повреждён.", true))?;
            total = total
                .checked_add(entry.size())
                .ok_or_else(LineError::storage)?;
            if total > 1024 * 1024 * 1024 {
                return Err(LineError::new(
                    ErrorCode::UnsafeArchive,
                    "Архив Java слишком большой после распаковки.",
                    false,
                ));
            }
        }
        drop(archive);
        install::extract_verified_zip(
            &extract_path,
            &extract_dest,
            None,
            &AtomicBool::new(false),
            |_| {},
        )
    })
    .await
    .map_err(|_| LineError::new(ErrorCode::Internal, "Не удалось распаковать Java.", true))??;
    let paths: Vec<_> = index
        .files
        .iter()
        .filter(|f| f.path.ends_with("/bin/java.exe"))
        .collect();
    if paths.len() != 1 {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "В архиве Java не найден исполняемый файл.",
            false,
        ));
    }
    let relative = paths[0].path.clone();
    let executable = pack::checked_game_path(&staging, &relative, false)?;
    let runtime = java::inspect_path(&executable.to_string_lossy()).await?;
    if runtime.major != major {
        return Err(LineError::new(
            ErrorCode::Integrity,
            "Скачана неподходящая версия Java.",
            false,
        ));
    }
    integrity::write_index(&staging, &index)?;
    storage::atomic_write(
        &staging.join(integrity::COMPLETE_MARKER),
        relative.as_bytes(),
    )?;
    if std::fs::symlink_metadata(&target).is_ok() {
        if !storage::is_real_dir(&target) {
            return Err(LineError::new(
                ErrorCode::Integrity,
                "Папка Java не является обычным каталогом.",
                false,
            ));
        }
        storage::remove_dir_if_present(&target)?;
    }
    std::fs::rename(&staging, &target).map_err(|e| LineError::io(&e))?;
    Ok(java::process_path(target.join(relative)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metadata(url: &str, digest: &str) -> Vec<u8> {
        serde_json::json!({"tag_name":"jdk-17.0.1+1", "assets":[{"name":"OpenJDK17U-jre_x64_windows_hotspot_17.0.1_1.zip", "size": 123, "digest":digest, "browser_download_url":url}]}).to_string().into_bytes()
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    #[ignore = "downloads and executes the official Java 17 JRE"]
    async fn downloads_java_17_and_reuses_verified_install() {
        let root = tempfile::tempdir().unwrap();
        let first = install_windows_x64(root.path(), 17, |_, _| {})
            .await
            .unwrap();
        assert_eq!(
            java::inspect_path(&first.to_string_lossy())
                .await
                .unwrap()
                .major,
            17
        );
        let second = install_windows_x64(root.path(), 17, |_, _| {
            panic!("verified Java should not download again")
        })
        .await
        .unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn asset_must_be_official_bounded_and_hash_pinned() {
        let good = "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.1_1.zip";
        let sha = format!("sha256:{}", "a".repeat(64));
        assert_eq!(select_asset(&metadata(good, &sha), 17).unwrap().size, 123);
        assert!(select_asset(
            &metadata(&good.replace("github.com", "evil.example"), &sha),
            17
        )
        .is_err());
        assert!(select_asset(&metadata(good, "sha256:bad"), 17).is_err());
        assert!(select_asset(&metadata(good, &sha), 21).is_err());
        assert!(select_asset(
            &metadata(&good.replace("jdk-17.0.1%2B1", "jdk-17.0.2%2B1"), &sha),
            17
        )
        .is_err());
        assert!(select_asset(&metadata(&good.replace("https://", "http://"), &sha), 17).is_err());
        let mut duplicate: serde_json::Value =
            serde_json::from_slice(&metadata(good, &sha)).unwrap();
        let first = duplicate["assets"][0].clone();
        duplicate["assets"].as_array_mut().unwrap().push(first);
        assert!(select_asset(&serde_json::to_vec(&duplicate).unwrap(), 17).is_err());
    }
}
