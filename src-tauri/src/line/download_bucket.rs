//! Pure token bucket shared by parallel pack downloads.
use std::time::Instant;
#[derive(Debug)]
pub struct Bucket {
    tokens: f64,
    updated: Instant,
    rate: u64,
}

impl Bucket {
    pub fn new() -> Self {
        Self {
            tokens: 0.0,
            updated: Instant::now(),
            rate: 0,
        }
    }

    pub fn take(&mut self, rate: u64, wanted: usize, now: Instant) -> usize {
        if self.rate != rate {
            self.tokens = 0.0;
            self.updated = now;
            self.rate = rate;
        }
        let elapsed = now.saturating_duration_since(self.updated).as_secs_f64();
        // Limit the burst to 100 ms, so short files cannot exceed the limit by
        // megabytes after a long idle period. At least one byte is possible.
        let capacity = (rate as f64 / 10.0).max(1.0);
        self.tokens = (self.tokens + elapsed * rate as f64).min(capacity);
        self.updated = now;
        let granted = (self.tokens as usize).min(wanted);
        self.tokens -= granted as f64;
        granted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn bucket_is_shared_bounded_and_resets_when_rate_changes() {
        let start = Instant::now();
        let mut bucket = Bucket {
            tokens: 0.0,
            updated: start,
            rate: 1000,
        };
        assert_eq!(
            bucket.take(1000, 500, start + Duration::from_millis(50)),
            50
        );
        assert_eq!(bucket.take(1000, 500, start + Duration::from_millis(50)), 0);
        assert_eq!(bucket.take(1000, 500, start + Duration::from_secs(3)), 100);
        assert_eq!(bucket.take(2000, 500, start + Duration::from_secs(4)), 0);
        assert_eq!(
            bucket.take(2000, 500, start + Duration::from_millis(4050)),
            100
        );
    }
}
