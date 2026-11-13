//! Keyword scan of resource packs, plus the list of files a pack owns.
//!
//! Two jobs, both before launch:
//!
//! 1. **Who else is in `game/resourcepacks`.** `pack-state.json` lists what the
//!    provider published. A file in that folder which is not on the list was put
//!    there by the player or by something else — the cheap, hard half of the
//!    anticheat, because it needs no opinion about names.
//! 2. **What is inside those packs.** A pack can be supplied *by* the provider
//!    and still contain `xray` in a model name, or the player can unpack the
//!    provider's pack, edit it and repack it under the same name. Neither shows
//!    up in (1), and both are what this scans for.
//!
//! What is deliberately *not* here:
//!
//! - **No image decoding.** Reading pixels to decide whether a texture looks
//!   like an xray overlay is an opinion, not a check: it fires on legitimate
//!   shaders and misses a renamed overlay. Names and text inside the ZIP are
//!   what a cheat pack cannot avoid.
//! - **No deleting.** A hit is reported. The caller stops the launch and asks
//!   the player, because a false positive that deletes a pack is worse than one
//!   that blocks a launch.
//! - **No unbounded reading.** Entry count, per-entry and total budgets match
//!   the extractor's limits, so a crafted pack cannot turn "check the pack"
//!   into a memory exhaustion.
use super::error::{LineError, LineResult};
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::Path;

/// Keywords compiled into the launcher. One per line, `#` starts a comment.
pub const CHEAT_WORDS: &str = include_str!("cheats.txt");

/// A pack cannot have more entries than the installer is willing to extract.
pub const MAX_ENTRIES: usize = 50_000;
/// Text files inside a pack are read up to this size each…
pub const MAX_TEXT_BYTES: u64 = 256 * 1024;
/// …and no more than this in total across one pack.
pub const MAX_TOTAL_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// A pack larger than this is not opened at all (the archive limit is 4 GiB;
/// resource packs are megabytes, so anything near this is not a resource pack).
pub const MAX_PACK_BYTES: u64 = 512 * 1024 * 1024;
/// No single entry may claim to be larger than this when decompressed.
pub const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

/// What a scan found. Sorted and deduplicated so a report is stable.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Findings {
    /// `path` relative to `game/`, then the entry, then the word.
    pub hits: Vec<Hit>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hit {
    /// Pack file relative to `game/`, e.g. `resourcepacks/xray-ultimate.zip`.
    pub pack: String,
    /// Entry inside the pack, or `""` when the hit is the pack's own name.
    pub entry: String,
    /// The keyword that matched, lowercased.
    pub keyword: String,
}

impl Findings {
    pub fn is_clean(&self) -> bool {
        self.hits.is_empty()
    }

    /// Human-readable list for the block screen and the log: at most `limit`
    /// lines, so a pack with a thousand hits does not become a wall of text.
    pub fn summary(&self, limit: usize) -> String {
        let mut lines: Vec<String> = self
            .hits
            .iter()
            .take(limit)
            .map(|hit| {
                if hit.entry.is_empty() {
                    format!("{} ({})", hit.pack, hit.keyword)
                } else {
                    format!("{}: {} ({})", hit.pack, hit.entry, hit.keyword)
                }
            })
            .collect();
        if self.hits.len() > limit {
            lines.push(format!("… ещё {}", self.hits.len() - limit));
        }
        lines.join("; ")
    }
}

/// The keyword list, parsed once. `#` comments and blank lines are skipped;
/// everything is lowercased because matching is case-insensitive.
pub fn keywords(extra: &[String]) -> Vec<String> {
    let mut words: BTreeSet<String> = CHEAT_WORDS
        .lines()
        .map(|line| line.split('#').next().unwrap_or("").trim().to_lowercase())
        .filter(|word| !word.is_empty() && word.len() <= 40)
        .collect();
    for word in extra {
        let word = word.trim().to_lowercase();
        // A provider may add words; it cannot remove the built-in ones (that is
        // why this is a union, not a replacement) and it cannot add a fragment
        // so short it would match everything.
        if word.len() >= 3 && word.len() <= 40 {
            words.insert(word);
        }
    }
    words.into_iter().collect()
}

/// Does `text` contain `keyword` as a word, not as a substring?
///
/// `xray` must match `xray`, `XRay`, `xray_ultimate` and `xray-overlay`, and
/// must not match `xrayed_note` or `pixray`. Rust's own rule does the work: a
/// keyword is a "word" bounded by anything that is not a letter or digit.
pub fn contains_word(text: &str, keyword: &str) -> bool {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let needle = keyword.as_bytes();
    let is_word_byte = |byte: u8| byte.is_ascii_alphanumeric();
    let mut from = 0usize;
    while let Some(at) = lower[from..].find(keyword) {
        let start = from + at;
        let end = start + keyword.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
        if from >= lower.len() {
            break;
        }
    }
    let _ = needle;
    false
}

/// Files under `game/resourcepacks` that the pack does not own.
///
/// `owned` are the paths from `pack-state.json`, game-relative. Directories are
/// not returned; only files. A pack present on disk but absent from `owned` is
/// exactly the "nobody published this" case.
pub fn foreign_packs(game: &Path, owned: &[String]) -> LineResult<Vec<String>> {
    let dir = game.join("resourcepacks");
    let Ok(entries) = fs::read_dir(&dir) else {
        // No folder: nothing installed, nothing foreign. Not an error: a fresh
        // instance has no resource packs.
        return Ok(Vec::new());
    };
    let owned: BTreeSet<&str> = owned.iter().map(String::as_str).collect();
    let mut foreign = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| LineError::io(&e))?;
        let path = entry.path();
        let kind = fs::symlink_metadata(&path)
            .map_err(|e| LineError::io(&e))?
            .file_type();
        // A symlink here is as suspicious as a foreign file, and following it
        // would let a link decide what we read.
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = format!("resourcepacks/{name}");
        if kind.is_file() && !owned.contains(relative.as_str()) {
            foreign.push(relative);
        } else if kind.is_symlink() {
            foreign.push(relative);
        }
    }
    foreign.sort();
    Ok(foreign)
}

/// Scans one pack. `pack` is game-relative (used in the report), `path` is where
/// the bytes actually are.
pub fn scan_pack(pack: &str, path: &Path, words: &[String]) -> LineResult<Findings> {
    let mut findings = Findings::default();
    // The pack's own file name is the first thing a cheat cannot hide: a player
    // who drops in `Xray-Ultimate-1.21.zip` is not asked what is inside.
    let name = pack.rsplit('/').next().unwrap_or(pack);
    for word in words {
        if contains_word(name, word) {
            findings.hits.push(Hit {
                pack: pack.to_owned(),
                entry: String::new(),
                keyword: word.clone(),
            });
        }
    }

    let meta = fs::symlink_metadata(path).map_err(|e| LineError::io(&e))?;
    if !meta.file_type().is_file() {
        return Ok(findings);
    }
    if meta.len() > MAX_PACK_BYTES {
        // Not a resource pack by any measure. Reporting it as foreign is the
        // caller's job; here there is simply nothing to read.
        return Ok(findings);
    }
    let file = fs::File::open(path).map_err(|e| LineError::io(&e))?;
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(archive) => archive,
        // A pack that is not a ZIP (a folder, a `.disabled` text file) has no
        // entries to scan. Its name was already checked above.
        Err(_) => return Ok(findings),
    };
    if archive.len() > MAX_ENTRIES {
        findings.hits.push(Hit {
            pack: pack.to_owned(),
            entry: String::new(),
            keyword: "too-many-entries".to_owned(),
        });
        return Ok(findings);
    }

    let mut texts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| LineError::io(&e))?;
        let entry_name = entry.name().to_owned();
        for word in words {
            if contains_word(&entry_name, word) {
                findings.hits.push(Hit {
                    pack: pack.to_owned(),
                    entry: entry_name.clone(),
                    keyword: word.clone(),
                });
            }
        }
        if !reads_text(&entry_name) || entry.size() > MAX_TEXT_BYTES {
            continue;
        }
        let mut buffer = Vec::new();
        if entry
            .by_ref()
            .take(MAX_TEXT_BYTES)
            .read_to_end(&mut buffer)
            .is_err()
        {
            continue;
        }
        total = total.saturating_add(buffer.len() as u64);
        if total > MAX_TOTAL_TEXT_BYTES {
            break;
        }
        texts.push((entry_name, buffer));
    }
    for (entry_name, buffer) in texts {
        let text = String::from_utf8_lossy(&buffer);
        for word in words {
            if contains_word(&text, word) {
                findings.hits.push(Hit {
                    pack: pack.to_owned(),
                    entry: entry_name.clone(),
                    keyword: word.clone(),
                });
            }
        }
    }
    findings.hits.sort();
    findings.hits.dedup();
    Ok(findings)
}

/// Which entries are worth reading: JSON models, blockstates, language files and
/// pack metadata — the parts of a resource pack that are text. PNGs are skipped
/// on purpose (see the module comment).
pub fn reads_text(entry: &str) -> bool {
    let lower = entry.to_ascii_lowercase();
    lower.ends_with(".json")
        || lower.ends_with(".mcmeta")
        || lower.ends_with(".txt")
        || lower.ends_with(".lang")
        || lower.ends_with(".properties")
        || lower.ends_with(".toml")
        || lower.ends_with(".cfg")
}

/// Every pack under `game/resourcepacks`, whether or not the provider owns it,
/// unless it is listed in `allow` by sha256. `allow` is hashes, not names: an
/// exception by name is defeated by renaming the file.
pub fn scan_all(
    game: &Path,
    owned: &[String],
    allow: &[String],
    extra_words: &[String],
) -> LineResult<(Findings, Vec<ForeignPack>)> {
    let words = keywords(extra_words);
    let mut findings = Findings::default();
    let mut foreign = Vec::new();
    let foreign_paths: BTreeSet<String> = foreign_packs(game, owned)?.into_iter().collect();
    // An empty owned list enumerates every pack, including provider-owned packs.
    for relative in foreign_packs(game, &[])? {
        let path = game.join(&relative);
        let sha = file_sha256(&path)?;
        let allowed = allow.iter().any(|hash| hash.eq_ignore_ascii_case(&sha));
        if !allowed && foreign_paths.contains(&relative) {
            foreign.push(ForeignPack {
                path: relative.clone(),
                sha256: sha.clone(),
            });
        }
        if allowed {
            continue;
        }
        let scanned = scan_pack(&relative, &path, &words)?;
        findings.hits.extend(scanned.hits);
    }
    findings.hits.sort();
    findings.hits.dedup();
    Ok((findings, foreign))
}

/// A file in `game/resourcepacks` the provider did not publish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignPack {
    pub path: String,
    pub sha256: String,
}

fn file_sha256(path: &Path) -> LineResult<String> {
    use sha2::{Digest, Sha256};
    let metadata = fs::symlink_metadata(path).map_err(|e| LineError::io(&e))?;
    if !metadata.file_type().is_file() {
        return Err(LineError::input("Ресурс-пак является ссылкой или не является обычным файлом."));
    }
    if metadata.len() > MAX_PACK_BYTES {
        return Err(LineError::input("Ресурс-пак превышает допустимый размер."));
    }
    let mut file = fs::File::open(path).map_err(|e| LineError::io(&e))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| LineError::io(&e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
