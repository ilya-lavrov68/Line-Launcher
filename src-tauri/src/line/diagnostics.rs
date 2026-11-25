//! The diagnostic bundle: one file a player sends and a provider can act on.
//!
//! Two buttons in Settings use this: «Скопировать диагностику» puts the full
//! bundle on the clipboard; «Отправить по Email» opens a draft with it when the
//! encoded URL is small enough, otherwise the draft tells the player how to
//! paste the full copied bundle.
//!
//! What goes in, and why:
//!
//! | Part | Why support needs it |
//! |---|---|
//! | version, OS, arch | every report starts by ruling out "old build" |
//! | provider id, config url | which project, and whether the address is right |
//! | session state | "signed out" and "expired" are different bugs |
//! | paths | where `launcher_logs/` and `instances/` actually are on this PC |
//! | the last records | the actual failure |
//!
//! What never goes in: tokens, tickets, passwords, the skin texture, or the
//! contents of the player's instance folders. [`super::logger::scrub`] runs over
//! every line that came from a log file, and the summary fields are built here
//! from values the launcher already chose to expose.
//!
//! The bundle is deliberately plain text. A provider pastes it into a ticket; a
//! player can read it before sending and see there is nothing personal in it.

use super::logger::{self, Field, MAX_LINE_BYTES};
use super::state::LineState;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Everything the bundle needs, gathered by the caller.
///
/// A struct rather than a pile of arguments so a new field is one place to add
/// and one place to test, and so the renderer stays a pure function.
pub struct Summary<'a> {
    pub launcher_version: &'a str,
    pub os: &'a str,
    pub arch: &'a str,
    /// `<app-data>` — where `launcher_logs/` and `instances/` live.
    pub data_dir: &'a Path,
    /// The provider's id from its config, when a config has been loaded.
    pub provider_id: Option<&'a str>,
    /// The config address this build is pointed at.
    pub config_url: Option<&'a str>,
    /// Whether a session exists, and under which name. Never the token.
    pub session_user: Option<&'a str>,
    /// `instances/<id>` directories present on disk, for install reports.
    pub instances: &'a [String],
}

/// Render the bundle. Pure: no clock beyond one timestamp, no I/O.
pub fn render(summary: &Summary<'_>, log_tail: &[String]) -> String {
    let mut out = String::with_capacity(4096);
    out.push_str("Line Launcher — диагностика\n");
    out.push_str("Отправляется в поддержку проекта. Пароля и токенов здесь нет.\n");
    out.push('\n');
    out.push_str("[окружение]\n");
    out.push_str(&format!("version={}\n", summary.launcher_version));
    out.push_str(&format!("os={} arch={}\n", summary.os, summary.arch));
    out.push_str(&format!("utc={}\n", iso_now()));
    out.push_str(&format!("data_dir={}\n", summary.data_dir.display()));
    out.push_str(&format!(
        "launcher_logs={}\n",
        summary.data_dir.join(logger::DIR).display()
    ));
    out.push('\n');
    out.push_str("[провайдер]\n");
    match summary.provider_id {
        Some(id) => out.push_str(&format!("provider_id={}\n", logger::scrub(id))),
        None => out.push_str("provider_id=—\n"),
    }
    match summary.config_url {
        Some(url) => out.push_str(&format!("config_url={}\n", logger::scrub(url))),
        None => out.push_str("config_url=—\n"),
    }
    out.push_str(&format!(
        "session={}\n",
        match summary.session_user {
            Some(user) => format!("signed_in as {}", logger::scrub(user)),
            None => "signed_out".to_owned(),
        }
    ));
    out.push('\n');
    out.push_str("[сборки]\n");
    if summary.instances.is_empty() {
        out.push_str("instances=—\n");
    } else {
        for id in summary.instances {
            out.push_str(&format!("instance={}\n", logger::scrub(id)));
        }
    }
    out.push('\n');
    out.push_str(&format!(
        "[логи: launcher за последние {} дней; игровые launch.log]\n",
        logger::RETENTION_DAYS
    ));
    if log_tail.is_empty() {
        out.push_str("(логи пусты — лаунчер ещё ничего не записал или игровых журналов нет)\n");
    } else {
        for line in log_tail {
            out.push_str(&sanitize_line(line));
            out.push('\n');
        }
    }
    out
}

/// `mailto:` for the provider's own support address.
///
/// The subject and body are percent-encoded by the caller's URL encoder; this
/// function only decides the *shape*, which is the part that has to be right:
/// no recipient means `mailto:?subject=…` is valid, but a provider without an
/// address should not get a dead button — the UI hides it instead.
pub fn mailto(address: Option<&str>, subject: &str, body: &str) -> Option<String> {
    let address = address?.trim();
    if address.is_empty() {
        return None;
    }
    Some(format!(
        "mailto:{}?subject={}&body={}",
        percent_encode(address),
        percent_encode(subject),
        percent_encode(body)
    ))
}

/// RFC 3986 percent-encoding, minus the characters `mailto:` does not need.
///
/// Hand-rolled on purpose: `url::form_urlencoded` turns a space into `+`, which
/// mail clients show literally, and the `url` crate is not otherwise needed on
/// this path.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'@' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Scrub one launcher or Minecraft output line before it leaves the machine.
/// The bundle keeps every line in the retention window, but individual lines
/// remain bounded and likely credential-bearing game-log lines are omitted.
pub fn sanitize_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    const SENSITIVE_MARKERS: &[&str] = &[
        "access_token",
        "accesstoken",
        "client_token",
        "clienttoken",
        "refresh_token",
        "refreshtoken",
        "session_secret",
        "session_token",
        "sessiontoken",
        "session_id",
        "sessionid",
        "authorization",
        "bearer ",
        "password",
        "ticket",
        "xsts",
        "userproperties",
        "cookie",
        "credential",
        "api_key",
        "apikey",
        "signature",
        "secret",
        "token",
    ];
    if SENSITIVE_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return "[строка скрыта: возможные учётные данные]".to_owned();
    }

    let line = logger::scrub(line);
    if line.len() <= MAX_LINE_BYTES {
        return line;
    }
    let mut cut = MAX_LINE_BYTES;
    while cut > 0 && !line.is_char_boundary(cut) {
        cut -= 1;
    }
    line[..cut].to_owned()
}

/// The session line, without the session. Shared by the bundle and the log so
/// the two can never disagree about whether the player is signed in.
pub fn session_field(state: &LineState) -> Field {
    match state.session_info() {
        Ok(Some(info)) => Field::text("user", info.username),
        _ => Field::text("user", "signed_out"),
    }
}

fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let (year, month, day) = civil((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Same algorithm as `logger::civil_from_days`; kept here so the renderer does
/// not depend on the logger being initialised.
fn civil(days: i64) -> (i64, u32, u32) {
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

#[cfg(test)]
mod tests {
    use super::super::LAUNCHER_VERSION;
    use super::*;
    use std::path::PathBuf;

    fn summary<'a>(data_dir: &'a Path, user: Option<&'a str>) -> Summary<'a> {
        Summary {
            launcher_version: LAUNCHER_VERSION,
            os: "windows",
            arch: "x86_64",
            data_dir,
            provider_id: Some("line-demo"),
            config_url: Some("https://127.0.0.1:8443/config.json"),
            session_user: user,
            instances: &[],
        }
    }

    #[test]
    fn the_bundle_names_the_paths_a_provider_will_ask_for() {
        let dir = PathBuf::from("C:/Users/p/AppData/Roaming/studio.plusinplus.line-launcher");
        let text = render(&summary(&dir, None), &[]);
        assert!(text.contains("launcher_logs="));
        assert!(text.contains("launcher_logs"));
        assert!(text.contains("provider_id=line-demo"));
        assert!(text.contains("session=signed_out"));
        assert!(text.contains("[логи: launcher за последние 30 дней; игровые launch.log]"));
    }

    #[test]
    fn a_signed_in_bundle_shows_the_name_and_never_the_token() {
        let dir = PathBuf::from("/tmp/x");
        let text = render(&summary(&dir, Some("Player_1")), &[]);
        assert!(text.contains("signed_in as Player_1"));
        assert!(!text.contains("access_token"));
    }

    #[test]
    fn the_report_keeps_every_line_but_redacts_token_like_game_output() {
        let dir = PathBuf::from("/tmp/x");
        let lines = (0..1_000)
            .map(|i| format!("record {i}"))
            .collect::<Vec<_>>();
        let text = render(&summary(&dir, None), &lines);
        assert!(text.contains("record 0"));
        assert!(text.contains("record 999"));

        let secret = "Launching with --accessToken very-secret-value";
        let hidden = sanitize_line(secret);
        assert!(!hidden.contains("very-secret-value"));
        assert!(hidden.contains("скрыта"));
        let report = render(&summary(&dir, None), &[secret.to_owned()]);
        assert!(!report.contains("very-secret-value"));
        assert!(report.contains("строка скрыта"));
        assert_eq!(
            sanitize_line("ordinary diagnostic line"),
            "ordinary diagnostic line"
        );
    }

    #[test]
    fn a_mailto_body_cannot_break_the_url() {
        let url = mailto(
            Some("help@example.com"),
            "Диагностика Line",
            "line1\nline2 & more",
        )
        .unwrap();
        assert!(url.starts_with("mailto:help@example.com?subject="));
        assert!(!url.contains('\n'));
        assert!(!url.contains(' '));
        assert!(url.contains("%0A"));
        assert!(url.contains("%26"));
    }

    #[test]
    fn no_address_means_no_button() {
        assert!(mailto(None, "x", "y").is_none());
        assert!(mailto(Some("   "), "x", "y").is_none());
    }

    #[test]
    fn encoding_leaves_an_address_readable() {
        assert_eq!(percent_encode("help@example.com"), "help@example.com");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("ж"), "%D0%B6");
    }
}
