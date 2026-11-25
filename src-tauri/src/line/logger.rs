//! Launcher logging: what the app itself did, in a file a player can send.
//!
//! The game's own output already lands in `instances/<id>/logs/launch.log`, but
//! that is the game talking. Nothing recorded the launcher: a failed sign-in
//! left a red line in the window and nothing at all on disk, which is exactly
//! what made the first demo support round unanswerable. This module is that
//! missing half.
//!
//! Layout — `launcher_logs/` sits next to `instances/`, so one folder holds
//! everything a support request needs:
//!
//! ```text
//! <app-data>/
//!   instances/<id>/…            game data, unchanged
//!   launcher_logs/
//!     launcher-2026-11-13.log   today
//!     launcher-2026-11-12.log   … retained for 30 days, then pruned
//! ```
//!
//! Four rules the rest of the app can rely on:
//!
//! 1. **No secrets.** Values are written through [`Field`], whose only
//!    free-form constructor is [`Field::text`], and which redacts anything that
//!    looks like a credential. A token cannot reach a log line by accident,
//!    because passing one is not expressible: there is no `Display` path that
//!    writes a raw string into a line.
//! 2. **The log survives the crash it describes.** Writes go straight to the
//!    file handle and are flushed per record; there is no buffer to lose.
//! 3. **A broken log never breaks the launcher.** Every public function returns
//!    `()`. A read-only disk costs a log line, not a sign-in.
//! 4. **Age-retained.** One file per day; files older than [`RETENTION_DAYS`]
//!    are pruned. A record is truncated at [`MAX_LINE_BYTES`] so one
//!    pathological error cannot fill the disk.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Directory name, next to `instances/`.
pub const DIR: &str = "launcher_logs";
/// Keep log files for this many days; prune by file age, not by file count.
pub const RETENTION_DAYS: u64 = 30;
/// A single record is truncated here. Support does not need a megabyte of
/// message, and a loop that logs an error can otherwise fill a disk.
pub const MAX_LINE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// Which part of the launcher wrote the record. A closed set: support filters
/// by it, and a free-form tag would make that filter useless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    App,
    Config,
    Auth,
    Install,
    Launch,
    Skin,
    Settings,
}

impl Area {
    fn as_str(self) -> &'static str {
        match self {
            Area::App => "app",
            Area::Config => "config",
            Area::Auth => "auth",
            Area::Install => "install",
            Area::Launch => "launch",
            Area::Skin => "skin",
            Area::Settings => "settings",
        }
    }
}

/// One `key=value` pair of a record.
///
/// The type exists to make "log the token" a compile error rather than a review
/// comment: [`Field::text`] is the only constructor that accepts a `String`, and
/// it scrubs anything shaped like a credential before the value is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    key: &'static str,
    value: String,
}

impl Field {
    /// A short, safe value (a state name, a server id, a code).
    pub fn text(key: &'static str, value: impl AsRef<str>) -> Self {
        Self {
            key,
            value: scrub(value.as_ref()),
        }
    }

    /// A number. Never needs scrubbing.
    pub fn num(key: &'static str, value: u64) -> Self {
        Self {
            key,
            value: value.to_string(),
        }
    }

    /// A boolean, spelled the way every other launcher spells it in a log.
    pub fn flag(key: &'static str, value: bool) -> Self {
        Self {
            key,
            value: if value { "true" } else { "false" }.to_owned(),
        }
    }

    /// A value that must never appear in the log, kept for symmetry so callers
    /// can say "this was present" without writing it.
    pub fn secret(key: &'static str) -> Self {
        Self {
            key,
            value: REDACTED.to_owned(),
        }
    }
}

const REDACTED: &str = "***";

/// Replace anything that looks like a credential.
///
/// The log is written by us, so this is defence in depth, not the primary
/// control: the primary control is [`Field`]. It catches the realistic
/// mistakes — a bearer header pasted into a message, a signed URL, a
/// `token=…` fragment copied out of an error string.
pub fn scrub(value: &str) -> String {
    let mut text = value.replace(['\n', '\r'], " ");
    for marker in [
        "Bearer ",
        "bearer ",
        "token=",
        "access_token=",
        "session_secret=",
        "password=",
        "ticket=",
    ] {
        // Continue after the replacement: searching from the start again would
        // rediscover the same marker forever, including after redaction.
        let mut cursor = 0;
        while let Some(offset) = text[cursor..].find(marker) {
            let start = cursor + offset + marker.len();
            let end = text[start..]
                .find([' ', '&', '"', '\'', ',', '}'])
                .map(|offset| start + offset)
                .unwrap_or(text.len());
            if end == start {
                cursor = start;
            } else {
                text.replace_range(start..end, REDACTED);
                cursor = start + REDACTED.len();
            }
        }
    }
    text
}

/// Append one record. Never fails: a launcher that cannot write its log still
/// has to sign players in.
pub fn log(level: Level, area: Area, message: &str, fields: &[Field]) {
    let Some(writer) = writer() else {
        return;
    };
    let _ = writer.write(level, area, message, fields);
}

pub fn info(area: Area, message: &str, fields: &[Field]) {
    log(Level::Info, area, message, fields);
}

pub fn warn(area: Area, message: &str, fields: &[Field]) {
    log(Level::Warn, area, message, fields);
}

pub fn error(area: Area, message: &str, fields: &[Field]) {
    log(Level::Error, area, message, fields);
}

static WRITER: OnceLock<Option<Writer>> = OnceLock::new();

/// Point the logger at a directory. Called once from `run()`, with the
/// app-data path Tauri resolved. A second call is ignored: the first directory
/// wins, so a stray call cannot scatter one session across two files.
pub fn init(root: PathBuf) {
    let _ = WRITER.set(Writer::open(root));
}

fn writer() -> Option<&'static Writer> {
    WRITER.get().and_then(|slot| slot.as_ref())
}

struct Writer {
    dir: PathBuf,
    file: Mutex<Option<(String, File)>>,
}

impl Writer {
    fn open(root: PathBuf) -> Option<Self> {
        let dir = root.join(DIR);
        if let Err(error) = fs::create_dir_all(&dir) {
            // Nowhere to report it: the log is the report.
            eprintln!("[line] launcher_logs unavailable: {error}");
            return None;
        }
        prune(&dir);
        Some(Self {
            dir,
            file: Mutex::new(None),
        })
    }

    fn write(&self, level: Level, area: Area, message: &str, fields: &[Field]) -> Option<()> {
        let day = utc_day();
        let mut guard = self.file.lock().ok()?;
        // Rotate on the first record of a new day, and reopen if the handle was
        // lost (a file deleted underneath us by a cleaner).
        let reopen = match guard.as_ref() {
            Some((current, _)) => current != &day,
            None => true,
        };
        if reopen {
            let path = self.dir.join(format!("launcher-{day}.log"));
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok()?;
            *guard = Some((day.clone(), file));
        }
        let (_, file) = guard.as_mut()?;
        let line = format_line(level, area, message, fields);
        file.write_all(line.as_bytes()).ok()?;
        // The log is the evidence for a crash, so it is on disk before the
        // record is considered written.
        let _ = file.flush();
        drop(guard);
        prune(&self.dir);
        Some(())
    }
}

/// One record as a single line. Key=value rather than JSON: the file has to be
/// readable by a player and greppable by a person, and a support engineer
/// copies it into a message as-is.
fn format_line(level: Level, area: Area, message: &str, fields: &[Field]) -> String {
    let mut line = format!(
        "{} {:<5} {:<8} {}",
        timestamp(),
        level.as_str(),
        area.as_str(),
        scrub(message)
    );
    for field in fields {
        line.push(' ');
        line.push_str(field.key);
        line.push('=');
        line.push_str(&field.value);
    }
    line.push('\n');
    if line.len() > MAX_LINE_BYTES {
        // Truncate on a char boundary; a split UTF-8 sequence would make the
        // file invalid for the very tools meant to read it.
        let mut cut = MAX_LINE_BYTES - 2;
        while cut > 0 && !line.is_char_boundary(cut) {
            cut -= 1;
        }
        line.truncate(cut);
        line.push('\n');
    }
    line
}

/// RFC 3339 in UTC, second precision, from the system clock.
///
/// Deliberately dependency-free: the launcher already ships no date crate, and
/// a support log does not need calendar arithmetic beyond y/m/d.
fn timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn utc_day() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Days since the Unix epoch to a civil date, Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// Remove only our daily log files whose actual modification time is older
/// than the retention window. The count of files is not capped; a busy month
/// keeps every day it needs, while stale logs are deleted on startup and after
/// each write.
fn prune(dir: &Path) {
    let age = std::time::Duration::from_secs(RETENTION_DAYS * 24 * 60 * 60);
    let Some(cutoff) = SystemTime::now().checked_sub(age) else {
        return;
    };
    prune_before(dir, cutoff);
}

fn prune_before(dir: &Path, cutoff: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let is_ours = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_log_name);
        if !is_ours {
            continue;
        }
        let old = fs::symlink_metadata(&path)
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified < cutoff);
        if old {
            let _ = fs::remove_file(path);
        }
    }
}

/// `launcher-YYYY-MM-DD.log`, and nothing else.
pub fn is_log_name(name: &str) -> bool {
    let Some(stem) = name.strip_prefix("launcher-") else {
        return false;
    };
    let Some(stem) = stem.strip_suffix(".log") else {
        return false;
    };
    let bytes = stem.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        };
        if !ok {
            return false;
        }
    }
    // Range-check the calendar parts; `2026-99-99.log` is not ours.
    let part = |range: std::ops::Range<usize>| stem[range].parse::<u32>().ok();
    match (part(0..4), part(5..7), part(8..10)) {
        (Some(year), Some(month), Some(day)) => {
            (2000..=9999).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)
        }
        _ => false,
    }
}

/// Every log file, newest first — what the «Скопировать диагностику» and
/// «Открыть папку» commands work from.
pub fn log_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_log_name)
        })
        .collect();
    files.sort();
    files.reverse();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bearer_token_never_reaches_a_line() {
        let field = Field::text("detail", "GET failed: Authorization: Bearer abc123.def");
        assert!(!field.value.contains("abc123.def"));
        assert!(field.value.contains(REDACTED));
        let message = scrub("token=deadbeef&user=player");
        assert!(!message.contains("deadbeef"));
        assert!(message.contains("user=player"));
    }

    #[test]
    fn scrub_handles_repeated_empty_and_previously_redacted_values() {
        assert_eq!(
            scrub("ж token=one&token=&token=two Bearer abc bearer xyz"),
            "ж token=***&token=&token=*** Bearer *** bearer ***"
        );
        assert_eq!(scrub("token=***"), "token=***");
        assert_eq!(
            scrub("access_token=secret&ticket=last"),
            "access_token=***&ticket=***"
        );
        assert_eq!(scrub("nothing to hide"), "nothing to hide");
    }

    #[test]
    fn a_secret_field_is_always_redacted() {
        assert_eq!(Field::secret("access_token").value, REDACTED);
    }

    #[test]
    fn newlines_cannot_forge_a_record() {
        let field = Field::text("detail", "first\n2026-01-01T00:00:00.000Z INFO auth forged");
        assert!(!field.value.contains('\n'));
        assert!(!format_line(Level::Info, Area::Auth, "ok", &[field]).contains("\n\n"));
    }

    #[test]
    fn a_line_is_bounded_and_stays_valid_utf8() {
        let long = "ж".repeat(MAX_LINE_BYTES);
        let line = format_line(Level::Error, Area::App, &long, &[]);
        assert!(line.len() <= MAX_LINE_BYTES);
        assert!(std::str::from_utf8(line.as_bytes()).is_ok());
    }

    #[test]
    fn a_record_carries_level_area_and_fields() {
        let line = format_line(
            Level::Error,
            Area::Auth,
            "sign-in failed",
            &[Field::text("code", "INTERNAL"), Field::num("http", 200)],
        );
        assert!(line.contains(" ERROR "));
        assert!(line.contains(" auth "));
        assert!(line.contains("sign-in failed"));
        assert!(line.contains("code=INTERNAL"));
        assert!(line.contains("http=200"));
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn only_our_own_files_are_pruned() {
        assert!(is_log_name("launcher-2026-11-13.log"));
        assert!(!is_log_name("launcher-2026-11-13.log.bak"));
        assert!(!is_log_name("launcher-notes.log"));
        assert!(!is_log_name("crash-2026-11-13.log"));
        assert!(!is_log_name("launcher-2026-99-13.log"));
        assert!(!is_log_name("launcher-2026-11-13.txt"));
    }

    #[test]
    fn pruning_uses_age_and_never_limits_the_number_of_recent_daily_files() {
        let dir = tempfile::tempdir().unwrap();
        let cutoff = UNIX_EPOCH + std::time::Duration::from_secs(2_000_000_000);
        let old = dir.path().join("launcher-2020-01-01.log");
        let recent_a = dir.path().join("launcher-2020-01-02.log");
        let recent_b = dir.path().join("launcher-2020-01-03.log");
        let unrelated = dir.path().join("notes.log");
        for path in [&old, &recent_a, &recent_b, &unrelated] {
            fs::write(path, "log").unwrap();
        }
        let set_modified = |path: &Path, modified| {
            File::open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
        };
        set_modified(&old, cutoff - std::time::Duration::from_secs(1));
        set_modified(&recent_a, cutoff + std::time::Duration::from_secs(1));
        set_modified(&recent_b, cutoff + std::time::Duration::from_secs(2));
        set_modified(&unrelated, cutoff - std::time::Duration::from_secs(1));

        prune_before(dir.path(), cutoff);

        assert!(!old.exists());
        assert!(recent_a.exists());
        assert!(recent_b.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn dates_round_trip_against_known_epochs() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_770), (2026, 11, 13));
        assert_eq!(civil_from_days(20_769), (2026, 11, 12));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // leap year
        assert_eq!(civil_from_days(-1), (1969, 12, 31)); // before the epoch
        assert_eq!(civil_from_days(11_016), (2000, 2, 29)); // 400-year rule
    }
}
