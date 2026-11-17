//! Read-only hardware facts that explain a machine resetting under load.
//!
//! ## Why this exists
//!
//! A player pressed «Запуск без сервера» (the button that used to be called
//! «Тестовый режим»), and the PC came back up in the firmware setup screen. That
//! is never something a launcher can cause: a process that has no administrator
//! rights cannot write boot configuration, and nothing in this crate calls
//! `bcdedit`, `msconfig`, `reg`, `shutdown`, `wmic` or anything that elevates.
//! The button's whole effect is to drop the `--quickPlay*`/`--server` arguments
//! so Minecraft opens the main menu instead of joining a server (see
//! `minecraft_core::remove_automatic_joins`).
//!
//! What *can* bring a machine up in the firmware instead of at the boot loader
//! is a reset that happened before the OS could log it: an unstable memory
//! profile, a marginal power supply, or a boot order that no longer finds the
//! drive. The launcher can at least put the evidence in the diagnostics bundle
//! so the player (or the person helping them) is not guessing.
//!
//! ## What this module is allowed to do
//!
//! Exactly one thing on Windows: run `wevtutil qe System` and read the result.
//! It is a **read-only query**, it runs without elevation, it is bounded, and it
//! filters for the three event ids that describe an unexpected reset. No
//! `wmic`, no PowerShell, no `bcdedit`, nothing that writes. On other platforms
//! it returns `None` and the section is absent from the bundle.
//!
//! ## The three event ids
//!
//! - **41** `Kernel-Power` — the machine lost power or was reset without a clean
//!   shutdown. The classic signature of a PSU/overclock fault.
//! - **1001** `BugCheck` — a blue screen was recorded. Distinguishes a crash
//!   from a hard reset: a machine that only ever logs 41 and never 1001 is being
//!   reset below the OS, which is exactly the BIOS/overclock territory.
//! - **6008** `EventLog` — "the previous shutdown was unexpected".
//!
//! The count matters more than any single entry: one over a year is a power cut,
//! ten over a week is a machine that needs its memory profile relaxed.

#[cfg(windows)]
use std::process::Command;

/// One `wevtutil` line, trimmed for the bundle: no more than this many resets
/// are ever printed, and no line is longer than this.
const MAX_EVENTS: usize = 8;
const MAX_LINE: usize = 200;

/// What the bundle reports about the last unexpected resets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetHistory {
    /// `41`, `1001`, `6008` → how many times the system logged it.
    pub counts: Vec<(u32, u32)>,
    /// The newest events, newest first, already stripped of localisation noise.
    pub recent: Vec<String>,
}

impl ResetHistory {
    /// True when the machine recorded resets but never a blue screen — the
    /// signature of a hard reset below the OS (power, memory profile, thermal).
    pub fn looks_like_hard_resets(&self) -> bool {
        let kernel41 = self
            .counts
            .iter()
            .any(|(id, count)| *id == 41 && *count > 0);
        let bugcheck = self
            .counts
            .iter()
            .any(|(id, count)| *id == 1001 && *count > 0);
        kernel41 && !bugcheck
    }

    /// The paragraph the diagnostics bundle prints. Empty when nothing was
    /// recorded, so a healthy machine does not get a scary-looking section.
    pub fn describe(&self) -> Option<String> {
        if self.recent.is_empty() {
            return None;
        }
        let counts = self
            .counts
            .iter()
            .filter(|(_, count)| *count > 0)
            .map(|(id, count)| format!("{id}×{count}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut out = String::from("Неожиданные перезагрузки (журнал System): ");
        out.push_str(&counts);
        if self.looks_like_hard_resets() {
            out.push_str(
                ". Есть сброс без синего экрана — это питание, профиль памяти \
                 (XMP/EXPO) или перегрев, а не ошибка лаунчера.",
            );
        }
        out.push('\n');
        for line in &self.recent {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
        Some(out)
    }
}

/// Query the System log. Returns `None` off Windows, or when the query fails —
/// a missing diagnostic must never turn into a failed support report.
pub fn reset_history() -> Option<ResetHistory> {
    #[cfg(windows)]
    {
        query_windows()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Read the last unexpected resets without elevated rights.
///
/// `wevtutil` is part of Windows itself and its output is parsed loosely: this
/// looks for the event id and the timestamp, and never fails on a line it does
/// not understand, because the text is localised.
#[cfg(windows)]
fn query_windows() -> Option<ResetHistory> {
    const QUERY: &str = "*[System[(EventID=41 or EventID=1001 or EventID=6008)]]";
    let output = quiet_command("wevtutil")
        .args(["qe", "System", &format!("/q:{QUERY}"), "/f:text", "/rd:true", "/c:40"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(parse(&text))
}

/// Split `wevtutil /f:text` output into event ids, timestamps and counts.
///
/// The format is one `Event[<n>]:` block per event, then `  Log Name: …`,
/// `  Date: …` and `  Event ID: 41`. Parsed by prefix rather than by position,
/// because the date format follows the system locale. Pure, so it is tested on
/// every platform.
pub fn parse(text: &str) -> ResetHistory {
    let mut counts: Vec<(u32, u32)> = Vec::new();
    let mut recent: Vec<String> = Vec::new();
    let mut date: Option<String> = None;
    let mut id: Option<u32> = None;

    /// Close the block being read. A free function rather than a closure: it
    /// borrows two accumulators mutably, and keeping that borrow out of the loop
    /// body is one less thing for the compiler (and a reader) to reason about.
    fn flush(
        counts: &mut Vec<(u32, u32)>,
        recent: &mut Vec<String>,
        date: &mut Option<String>,
        id: &mut Option<u32>,
    ) {
        let Some(event_id) = id.take() else {
            *date = None;
            return;
        };
        match counts.iter_mut().find(|(known, _)| *known == event_id) {
            Some((_, count)) => *count += 1,
            None => counts.push((event_id, 1)),
        }
        if recent.len() < MAX_EVENTS {
            let when = date.take().unwrap_or_else(|| "дата неизвестна".into());
            let kind = match event_id {
                41 => "сброс без корректного завершения",
                1001 => "синий экран",
                6008 => "неожиданное завершение работы",
                _ => "событие",
            };
            let line = format!("{when} — {kind} ({event_id})");
            recent.push(line.chars().take(MAX_LINE).collect());
        }
        *date = None;
    }

    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("Event[") {
            flush(&mut counts, &mut recent, &mut date, &mut id);
            continue;
        }
        if let Some(value) = line.strip_prefix("Date:") {
            date = Some(value.trim().to_owned());
        } else if let Some(value) = line.strip_prefix("Event ID:") {
            id = value.trim().parse::<u32>().ok();
        }
    }
    flush(&mut counts, &mut recent, &mut date, &mut id);
    ResetHistory { counts, recent }
}

/// A `Command` that never flashes a console window.
///
/// The launcher is a GUI process, but on Windows a child process created from it
/// still gets a console unless `CREATE_NO_WINDOW` is set — a black window
/// appearing over the game while diagnostics run is exactly the kind of thing
/// this release is removing.
#[cfg(windows)]
fn quiet_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Re-exported so the diagnostics renderer can call it without cfg branches of
/// its own.
pub fn section() -> Option<String> {
    reset_history()?.describe()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
Event[0]:
  Log Name: System
  Source: Microsoft-Windows-Kernel-Power
  Date: 2026-11-14T21:03:41.120
  Event ID: 41
  Level: Critical
  Description: The system has rebooted without cleanly shutting down first.

Event[1]:
  Log Name: System
  Source: Microsoft-Windows-Kernel-Power
  Date: 2026-11-13T18:44:02.001
  Event ID: 41
  Level: Critical

Event[2]:
  Log Name: System
  Source: Microsoft-Windows-BugCheck
  Date: 2026-10-02T09:11:55.500
  Event ID: 1001
  Level: Information
";

    #[test]
    fn counts_events_and_keeps_them_newest_first() {
        let history = parse(SAMPLE);
        assert_eq!(history.counts, vec![(41, 2), (1001, 1)]);
        assert_eq!(history.recent.len(), 3);
        assert!(history.recent[0].starts_with("2026-11-14T21:03:41"));
        assert!(history.recent[0].contains("(41)"));
        assert!(history.recent[2].contains("синий экран"));
    }

    #[test]
    fn resets_without_a_bugcheck_are_named_as_hardware() {
        let history = ResetHistory {
            counts: vec![(41, 3)],
            recent: vec!["2026-11-14T21:03:41 — сброс без корректного завершения (41)".into()],
        };
        assert!(history.looks_like_hard_resets());
        let text = history.describe().unwrap();
        assert!(text.contains("XMP/EXPO"));
        assert!(text.contains("41×3"));
    }

    #[test]
    fn a_bugcheck_is_not_called_a_hardware_fault() {
        let history = ResetHistory {
            counts: vec![(41, 1), (1001, 1)],
            recent: vec!["x".into()],
        };
        assert!(!history.looks_like_hard_resets());
        assert!(!history.describe().unwrap().contains("XMP/EXPO"));
    }

    #[test]
    fn an_empty_log_produces_no_section() {
        let history = parse("");
        assert!(history.counts.is_empty());
        assert!(history.recent.is_empty());
        assert!(history.describe().is_none());
        assert!(section().is_none() || !section().unwrap().is_empty());
    }

    #[test]
    fn a_truncated_last_block_still_counts() {
        // `wevtutil` output cut mid-event (a killed pipe) must not lose the id.
        let history = parse("Event[0]:\n  Date: 2026-01-01T00:00:00\n  Event ID: 6008\n");
        assert_eq!(history.counts, vec![(6008, 1)]);
        assert!(history.recent[0].contains("неожиданное завершение"));
    }
}
