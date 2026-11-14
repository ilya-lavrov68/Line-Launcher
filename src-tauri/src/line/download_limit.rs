//! Shared, live bandwidth limiter for launcher-owned pack downloads.
//! The Minecraft runtime/loader library uses its own network client and is not
//! covered. A single bucket is shared across all parallel pack file requests.
use super::error::{ErrorCode, LineError, LineResult};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::download_bucket::Bucket;

struct Limiter {
    bytes_per_second: AtomicU64,
    bucket: Mutex<Bucket>,
}

fn global() -> &'static Limiter {
    static LIMITER: OnceLock<Limiter> = OnceLock::new();
    LIMITER.get_or_init(|| Limiter {
        bytes_per_second: AtomicU64::new(0),
        bucket: Mutex::new(Bucket::new()),
    })
}

/// Zero disables the cap. Applies immediately to active downloads.
pub fn set_limit_kib(kib: u32) {
    global()
        .bytes_per_second
        .store(u64::from(kib) * 1024, Ordering::Release);
}

/// Pace bytes received from a network stream, with cancellation checks even at
/// very low rates. No mutex is held across an await.
pub async fn acquire(mut bytes: usize, cancel: &AtomicBool) -> LineResult<()> {
    while bytes > 0 {
        if cancel.load(Ordering::SeqCst) {
            return Err(LineError::new(
                ErrorCode::Cancelled,
                "Установка отменена.",
                false,
            ));
        }
        let rate = global().bytes_per_second.load(Ordering::Acquire);
        if rate == 0 {
            return Ok(());
        }
        let granted = global()
            .bucket
            .lock()
            .map_err(|_| LineError::storage())?
            .take(rate, bytes, Instant::now());
        bytes -= granted;
        if bytes > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    Ok(())
}
