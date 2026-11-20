//! Quarantine for mod files whose provenance the launcher cannot prove.
//!
//! ## The problem this solves
//!
//! Before this module, an extra JAR in `mods/` stopped the launch with
//! «Уберите его и повторите запуск». That is correct for a file the player
//! dropped in, and useless for one a mod generated: Connector, for instance,
//! writes transformed JARs at runtime, and they are neither in the release nor
//! provably derived from it. The player cannot delete them (the mod recreates
//! them) and cannot prove them (the launcher is the only thing that could).
//!
//! ## What it does, and what it refuses to do
//!
//! It **moves** the named files into a quarantine directory under the instance,
//! keeping their relative path, and writes a manifest that records where each
//! one came from. Nothing is deleted, so a wrong guess is recoverable. The game
//! then launches without them.
//!
//! The rules that keep this from becoming a hole:
//!
//! * The launcher never quarantines on its own. `quarantine()` is called only
//!   from an explicit, revision-bound player decision; the scan that found the
//!   files only *reports* them.
//! * Only files that are **not** in the release index are eligible. A file the
//!   provider published is never moved, whatever the player clicks — otherwise
//!   "quarantine" would be a way to bypass the integrity check.
//! * Only `mods/**.jar` is eligible. Resource packs, configs, worlds and the
//!   release bookkeeping are out of scope; the anti-cheat design treats
//!   resource packs as a separate, word-based check.
//! * No symlinks, junctions or non-regular files. Moving a link would move
//!   whatever it points at, outside the instance.
//! * Restore puts a file back only if the destination is free; it never
//!   overwrites a release file that appeared in the meantime.
//!
//! ## Dependency-free on purpose
//!
//! The decision logic — which paths are eligible, what the manifest records,
//! whether a restore is safe — is plain `std` so `scripts/test-rust-pure.mjs`
//! runs its real tests. The filesystem moves themselves live here too, behind
//! small functions the caller drives; nothing in this module spawns a process
//! or reads the network.

use super::pack::checked_game_path;
use super::storage::is_real_file;
use std::fs;
use std::path::{Path, PathBuf};

/// Directory, relative to the instance root, holding quarantined files.
pub const QUARANTINE_DIR: &str = "quarantine";
/// Manifest inside `QUARANTINE_DIR` describing what was moved and from where.
pub const QUARANTINE_MANIFEST: &str = "quarantine.json";
/// One quarantine batch cannot exceed this many files: a runaway mod that
/// generates thousands of artifacts must not turn a consent prompt into a
/// filesystem-scale operation nobody read.
pub const MAX_QUARANTINE_FILES: usize = 512;
/// Each file is bounded too; a 4 GB "jar" is not something the player can
/// meaningfully approve in a dialog.
pub const MAX_QUARANTINE_FILE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuarantineError {
    /// The path is not a `mods` JAR, or not a safe relative path at all.
    NotEligible(String),
    /// The file is part of the verified release; it may never be moved.
    Published(String),
    /// Too many files or a file too large for one batch.
    TooLarge(String),
    /// The source is not a regular file (symlink, directory, missing).
    NotRegular(String),
    /// The destination already holds a file, so a restore would overwrite.
    Conflict(String),
}

impl QuarantineError {
    /// Player-facing text. One sentence, says what to do, never a raw OS error.
    pub fn message(&self) -> String {
        match self {
            Self::NotEligible(path) => format!(
                "Файл {path} нельзя поместить в карантин: карантин принимает только моды из папки mods."
            ),
            Self::Published(path) => format!(
                "Файл {path} входит в поставленную сборку. Его нельзя убрать в карантин — восстановите сборку."
            ),
            Self::TooLarge(path) => format!(
                "Файл {path} слишком велик для карантина или файлов в пачке больше {MAX_QUARANTINE_FILES}. Разберите папку mods вручную."
            ),
            Self::NotRegular(path) => format!(
                "Файл {path} отсутствует, является ссылкой или каталогом. Карантин переносит только обычные файлы."
            ),
            Self::Conflict(path) => format!(
                "Файл {path} уже есть на месте назначения. Уберите его вручную, чтобы не потерять данные."
            ),
        }
    }
}

/// Is this relative path a candidate at all?
///
/// `mods/…` and `.jar` only, and the same normalisation the release scan uses.
/// The check is deliberately narrow: widening it later is a decision to make
/// with the anti-cheat document open, not a detail to slip into a helper.
pub fn is_eligible_path(relative: &str) -> bool {
    let normalised = relative.replace('\\', "/");
    normalised.starts_with("mods/")
        && !normalised.ends_with('/')
        && normalised.to_ascii_lowercase().ends_with(".jar")
        // `mods/../x.jar` would escape the directory it claims to be in.
        && !normalised.split('/').any(|part| part == ".." || part.is_empty())
}

/// Splits a requested batch into what may be moved and why the rest may not.
///
/// `published` is the release index. A path there is refused with
/// `Published`, not with `NotEligible`: the two mean different things to the
/// player, and conflating them would tell someone their own build shipped a
/// virus.
pub fn plan(
    requested: &[String],
    published: &std::collections::HashSet<String>,
) -> (Vec<String>, Vec<QuarantineError>) {
    let mut accepted = Vec::new();
    let mut refused = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in requested {
        let key = path.replace('\\', "/").to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        if published.contains(path) {
            refused.push(QuarantineError::Published(path.clone()));
            continue;
        }
        if !is_eligible_path(path) {
            refused.push(QuarantineError::NotEligible(path.clone()));
            continue;
        }
        if accepted.len() >= MAX_QUARANTINE_FILES {
            refused.push(QuarantineError::TooLarge(path.clone()));
            continue;
        }
        accepted.push(path.clone());
    }
    (accepted, refused)
}

/// What the manifest records for one moved file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MovedFile {
    /// Path inside the game directory, e.g. `mods/foo.jar`.
    pub relative: String,
    /// Size at the moment of the move; the restore refuses a different file.
    pub size: u64,
    /// SHA-256 of the bytes as they were moved. Not a proof of authorship —
    /// a record, so the player can tell whether the same thing came back.
    pub sha256: String,
}

/// Where a quarantined file lives, relative to the instance root.
pub fn quarantine_path(relative: &str) -> PathBuf {
    Path::new(QUARANTINE_DIR).join(relative)
}

/// Moves one file into quarantine and returns what it recorded.
///
/// The caller must already have run `plan`; this function re-checks the two
/// conditions that a stale decision could invalidate (the file is still a
/// regular file, the destination is still free) but does not re-read the
/// release index, because the caller holds the lock that makes it stable.
pub fn quarantine_file(
    instance: &Path,
    game_dir: &Path,
    relative: &str,
) -> Result<MovedFile, QuarantineError> {
    if !is_eligible_path(relative) {
        return Err(QuarantineError::NotEligible(relative.to_string()));
    }
    let source = checked_game_path(game_dir, relative, false)
        .map_err(|_| QuarantineError::NotEligible(relative.to_string()))?;
    if !is_real_file(&source) {
        return Err(QuarantineError::NotRegular(relative.to_string()));
    }
    let metadata = fs::symlink_metadata(&source)
        .map_err(|_| QuarantineError::NotRegular(relative.to_string()))?;
    let size = metadata.len();
    if size > MAX_QUARANTINE_FILE_BYTES {
        return Err(QuarantineError::TooLarge(relative.to_string()));
    }
    let target = instance.join(quarantine_path(relative));
    if fs::symlink_metadata(&target).is_ok() {
        return Err(QuarantineError::Conflict(relative.to_string()));
    }
    if let Some(parent) = target.parent() {
        super::storage::create_private_dir(parent)
            .map_err(|_| QuarantineError::NotRegular(relative.to_string()))?;
    }
    // `hash_file` returns the digest *and* the size it actually read, which is
    // the authoritative size: the file may have been rewritten between the
    // metadata call and the hash.
    let (sha256, size) = super::integrity::hash_file(&source)
        .map_err(|_| QuarantineError::NotRegular(relative.to_string()))?;
    if size > MAX_QUARANTINE_FILE_BYTES {
        return Err(QuarantineError::TooLarge(relative.to_string()));
    }
    fs::rename(&source, &target).map_err(|_| QuarantineError::NotRegular(relative.to_string()))?;
    Ok(MovedFile {
        relative: relative.to_string(),
        size,
        sha256,
    })
}

/// Puts a quarantined file back, refusing to overwrite anything.
///
/// This is the half that makes the feature safe to offer: a player who accepted
/// the prompt by mistake loses nothing.
pub fn restore_file(
    instance: &Path,
    game_dir: &Path,
    entry: &MovedFile,
) -> Result<(), QuarantineError> {
    let stored = instance.join(quarantine_path(&entry.relative));
    if !is_real_file(&stored) {
        return Err(QuarantineError::NotRegular(entry.relative.clone()));
    }
    let destination = checked_game_path(game_dir, &entry.relative, false)
        .map_err(|_| QuarantineError::NotEligible(entry.relative.clone()))?;
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(QuarantineError::Conflict(entry.relative.clone()));
    }
    let size = fs::symlink_metadata(&stored)
        .map_err(|_| QuarantineError::NotRegular(entry.relative.clone()))?
        .len();
    if size != entry.size {
        return Err(QuarantineError::Conflict(entry.relative.clone()));
    }
    if let Some(parent) = destination.parent() {
        super::storage::create_private_dir(parent)
            .map_err(|_| QuarantineError::NotRegular(entry.relative.clone()))?;
    }
    fs::rename(&stored, &destination)
        .map_err(|_| QuarantineError::NotRegular(entry.relative.clone()))?;
    // The directory is left behind rather than removed: another batch may have
    // written into it, and pruning a shared path is not this function's job.
    Ok(())
}

/// Serialises the manifest. Kept as a plain text format so a player can read
/// and edit it, and so a future version can parse it without serde.
pub fn render_manifest(entries: &[MovedFile]) -> String {
    let mut lines = Vec::with_capacity(entries.len() + 1);
    lines.push("# Files moved to quarantine by Line Launcher.".to_string());
    lines.push("# relative\tsize\tsha256".to_string());
    for entry in entries {
        lines.push(format!(
            "{}\t{}\t{}",
            entry.relative, entry.size, entry.sha256
        ));
    }
    lines.join("\n") + "\n"
}

/// Parses back what `render_manifest` wrote. Unparsable lines are skipped, not
/// guessed at: a half-written manifest must not restore the wrong file.
pub fn parse_manifest(text: &str) -> Vec<MovedFile> {
    let mut entries = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split('\t');
        let (Some(relative), Some(size), Some(sha256)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(size) = size.parse::<u64>() else {
            continue;
        };
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        if !is_eligible_path(relative) {
            continue;
        }
        entries.push(MovedFile {
            relative: relative.to_string(),
            size,
            sha256: sha256.to_ascii_lowercase(),
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn published(paths: &[&str]) -> std::collections::HashSet<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn only_mods_jars_are_eligible() {
        assert!(is_eligible_path("mods/foo.jar"));
        assert!(is_eligible_path("mods/.connector/temp/a$b.jar"));
        assert!(is_eligible_path("mods/sub/dir/x.JAR"));
        // Not a mod jar: configs, packs, worlds, bookkeeping.
        assert!(!is_eligible_path("config/foo.toml"));
        assert!(!is_eligible_path("resourcepacks/x.zip"));
        assert!(!is_eligible_path("mods/foo.txt"));
        assert!(!is_eligible_path("mods/foo.jar/"));
        assert!(!is_eligible_path("saves/mods/foo.jar"));
        // Traversal and empty segments.
        assert!(!is_eligible_path("mods/../evil.jar"));
        assert!(!is_eligible_path("mods//foo.jar"));
    }

    #[test]
    fn a_published_file_is_never_quarantined() {
        // The rule that keeps quarantine from becoming an integrity bypass:
        // the player may not "quarantine" the provider's own mod.
        let (accepted, refused) = plan(
            &["mods/release.jar".to_string()],
            &published(&["mods/release.jar"]),
        );
        assert!(accepted.is_empty());
        assert_eq!(
            refused,
            vec![QuarantineError::Published("mods/release.jar".into())]
        );
        // And the message does not accuse the provider.
        assert!(refused[0].message().contains("входит в поставленную сборку"));
    }

    #[test]
    fn plan_deduplicates_and_separates_reasons() {
        let (accepted, refused) = plan(
            &[
                "mods/a.jar".to_string(),
                "mods/a.jar".to_string(),
                "mods/b.jar".to_string(),
                "config/x.toml".to_string(),
                "mods/release.jar".to_string(),
            ],
            &published(&["mods/release.jar"]),
        );
        assert_eq!(accepted, vec!["mods/a.jar", "mods/b.jar"]);
        assert_eq!(refused.len(), 2);
        assert!(matches!(refused[0], QuarantineError::NotEligible(_)));
        assert!(matches!(refused[1], QuarantineError::Published(_)));
    }

    #[test]
    fn batches_are_bounded() {
        let many: Vec<String> = (0..MAX_QUARANTINE_FILES + 10)
            .map(|i| format!("mods/m{i}.jar"))
            .collect();
        let (accepted, refused) = plan(&many, &published(&[]));
        assert_eq!(accepted.len(), MAX_QUARANTINE_FILES);
        assert_eq!(refused.len(), 10);
        assert!(matches!(refused[0], QuarantineError::TooLarge(_)));
    }

    #[test]
    fn manifest_round_trips_and_ignores_junk() {
        let entries = vec![
            MovedFile {
                relative: "mods/a.jar".into(),
                size: 42,
                sha256: "a".repeat(64),
            },
            MovedFile {
                relative: "mods/.connector/temp/p$c.jar".into(),
                size: 7,
                sha256: "b".repeat(64),
            },
        ];
        let text = render_manifest(&entries);
        assert_eq!(parse_manifest(&text), entries);
        // A truncated line, a bad hash, a non-jar and a traversal attempt are
        // all skipped rather than guessed.
        let junk = format!(
            "{}\nbroken line\nmods/x.jar\t1\tnothex\nconfig/a.toml\t1\t{}\nmods/../e.jar\t1\t{}\n",
            text.trim_end(),
            "c".repeat(64),
            "d".repeat(64)
        );
        assert_eq!(parse_manifest(&junk), entries);
    }

    #[test]
    fn quarantine_path_keeps_the_relative_structure() {
        // Restoring relies on this: the source path is recoverable from the
        // stored path without a second lookup.
        let path = quarantine_path("mods/.connector/temp/a$b.jar");
        assert_eq!(
            path,
            Path::new("quarantine/mods/.connector/temp/a$b.jar")
        );
    }

    #[test]
    fn errors_say_what_to_do_and_never_leak_os_text() {
        for error in [
            QuarantineError::NotEligible("p".into()),
            QuarantineError::Published("p".into()),
            QuarantineError::TooLarge("p".into()),
            QuarantineError::NotRegular("p".into()),
            QuarantineError::Conflict("p".into()),
        ] {
            let message = error.message();
            assert!(!message.is_empty());
            assert!(!message.contains("os error"), "{message}");
            assert!(!message.contains("Errno"), "{message}");
            assert!(message.contains('p'), "{message}");
        }
    }
}
