// The keyword matcher is the part of the anticheat that decides what a player
// sees. It is small, pure, and easy to get subtly wrong ("xray" firing on
// "pixray", or missing "XRay_Ultimate.zip"), so its rules are pinned here as
// vectors. `resourcepack.rs` implements the same rule; the mirror test below
// keeps the two from drifting apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const rust = readFileSync(
  path.join(ROOT, "src-tauri/src/line/resourcepack.rs"),
  "utf8",
);
const words = readFileSync(
  path.join(ROOT, "src-tauri/src/line/cheats.txt"),
  "utf8",
);

/** The Rust rule, ported: a keyword matches on word boundaries. */
function containsWord(text: string, keyword: string): boolean {
  const lower = text.toLowerCase();
  const isWord = (ch: string | undefined) => !!ch && /[a-z0-9]/.test(ch);
  let from = 0;
  while (from <= lower.length) {
    const at = lower.indexOf(keyword, from);
    if (at < 0) return false;
    const before = at === 0 ? undefined : lower[at - 1];
    const after = lower[at + keyword.length];
    if (!isWord(before) && !isWord(after)) return true;
    from = at + 1;
  }
  return false;
}

test("a keyword matches words, not fragments", () => {
  for (const [text, word, expected] of [
    ["xray", "xray", true],
    ["XRay", "xray", true],
    ["xray_ultimate", "xray", true],
    ["Xray-Ultimate-1.21.zip", "xray", true],
    ["assets/xray/overlay.json", "xray", true],
    ["pixray", "xray", false],
    ["xrayed_note", "xray", false],
    ["myxraypack", "xray", false],
    ["freecam", "freecam", true],
    ["free_cam", "freecam", false],
    ["free-cam", "free-cam", true],
    ["freecam", "free-cam", false],
    ["fullbright", "fullbright", true],
    ["full_bright", "fullbright", false],
  ] as const) {
    assert.equal(containsWord(text, word), expected, `${text} / ${word}`);
  }
});

test("the shipped word list is clean data, not prose", () => {
  const parsed = words
    .split("\n")
    .map((line) => line.split("#")[0].trim().toLowerCase())
    .filter(Boolean);
  assert.ok(parsed.length >= 20, `only ${parsed.length} keywords`);
  // Duplicates make the report list the same hit twice, which looks like a bug
  // in the scanner rather than in the list.
  assert.equal(new Set(parsed).size, parsed.length, "duplicate keyword");
  for (const word of parsed) {
    // No generic word that would fire on ordinary packs. These are the ones
    // that actually showed up as false positives while writing this list.
    assert.ok(
      !["free", "speed", "auto", "hack", "mod", "client", "gui"].includes(word),
      word,
    );
    assert.equal(word, word.trim());
    assert.ok(
      word.length >= 4 || word === "esp",
      `too short to be safe: ${word}`,
    );
  }
  // Every category the docs promise is present.
  for (const word of [
    "xray",
    "freecam",
    "noclip",
    "fullbright",
    "killaura",
    "aimbot",
  ]) {
    assert.ok(parsed.includes(word), `missing ${word}`);
  }
});

test("the Rust matcher is the function the vectors describe", () => {
  // Light structural checks: the rules above are only meaningful if the Rust
  // side really is boundary matching over a lowercased copy and does not, say,
  // use `contains` directly.
  const body = rust.slice(
    rust.indexOf("pub fn contains_word"),
    rust.indexOf("/// Files under `game/resourcepacks`"),
  );
  assert.match(body, /to_lowercase\(\)/);
  assert.match(body, /is_ascii_alphanumeric\(\)/);
  assert.match(body, /before_ok && after_ok/);
  assert.ok(
    !/\.contains\(keyword\)/.test(body),
    "must not use a plain substring search",
  );
});

test("a provider may add words but cannot remove the built-in ones", () => {
  const kernel = rust.slice(
    rust.indexOf("pub fn keywords"),
    rust.indexOf("pub fn contains_word"),
  );
  // Union, not replacement: the built-in list is collected first and extras are
  // inserted into the same set.
  assert.match(kernel, /CHEAT_WORDS/);
  assert.match(kernel, /words\.insert\(word\)/);
  assert.match(kernel, /word\.len\(\) >= 3/);
});

test("the scan reads text entries and skips images", () => {
  const body = rust.slice(rust.indexOf("pub fn reads_text"));
  for (const ext of [".json", ".mcmeta", ".txt", ".lang"]) {
    assert.ok(body.includes(ext), `reads_text misses ${ext}`);
  }
  assert.ok(!body.includes(".png"), "PNG must not be read: no image heuristic");
  // And the scan is bounded, like the installer it sits next to.
  for (const constant of [
    "MAX_ENTRIES",
    "MAX_TEXT_BYTES",
    "MAX_TOTAL_TEXT_BYTES",
    "MAX_PACK_BYTES",
  ]) {
    assert.ok(rust.includes(`pub const ${constant}`), `missing ${constant}`);
  }
});

test("findings are reported, never acted on", () => {
  // The module has no deletion path at all: a false positive must not cost the
  // player a file. Deletion lives in the UI flow, per file, after a choice.
  assert.ok(
    !/remove_file|remove_dir/.test(rust),
    "resourcepack.rs must not delete anything",
  );
});

const launchRust = readFileSync(
  path.join(ROOT, "src-tauri/src/line/launch.rs"),
  "utf8",
);
const configRust = readFileSync(
  path.join(ROOT, "src-tauri/src/line/config.rs"),
  "utf8",
);

test("the pack check runs before Java exists, not after", () => {
  // The whole point of blocking is that the process never starts. Ordering is
  // what a unit test of the scanner cannot see, so it is asserted here.
  const body = launchRust.slice(launchRust.indexOf("pub async fn launch_game"));
  const scan = body.indexOf("scan_packs(");
  const spawn = body.indexOf(".spawn()");
  assert.ok(scan > 0, "launch_game must call scan_packs");
  assert.ok(spawn > 0, "launch_game must spawn the game");
  assert.ok(scan < spawn, "scan_packs must run before the spawn");
  // And a hit must return before the spawn, with a published Blocked phase.
  const blocked = body.indexOf("GamePhase::Blocked");
  assert.ok(
    blocked > 0 && blocked < spawn,
    "Blocked must be published before spawn",
  );
  // The decision has to be the scan's answer. `if true` in its place would keep
  // every string above and still launch a pack that just failed the check.
  const scanBody = launchRust.slice(
    launchRust.indexOf("pub fn scan_packs"),
    launchRust.indexOf("pub async fn launch_game"),
  );
  assert.match(
    scanBody,
    /let blocked = if findings\.is_clean\(\) \{\s*None\s*\} else \{\s*Some\(/,
    "the block must be decided by the findings",
  );
  // And launch_game must consult it: a `Some(message)` that nobody checks is
  // the same as no check at all.
  assert.match(body, /if let Some\(message\) = scan\.blocked/);
});

test("a disabled keyword scan cannot disable the foreign-file check", () => {
  // The switch exists for packs whose text legitimately says "xray". It must not
  // become "turn off the anticheat": the release-side check keeps running.
  const body = launchRust.slice(
    launchRust.indexOf("pub fn scan_packs"),
    launchRust.indexOf("pub async fn launch_game"),
  );
  const offBranch = body.slice(body.indexOf("if !settings.scan_resourcepacks"));
  assert.match(offBranch, /foreign_packs|scan_all/);
  assert.ok(
    offBranch.indexOf("scan_all") < offBranch.indexOf("return Ok"),
    "the foreign check must run before the early return",
  );
});

test("the anticheat block is optional and its limits are enforced", () => {
  assert.match(configRust, /pub struct Anticheat/);
  assert.match(configRust, /scan_resourcepacks: bool/);
  assert.match(configRust, /extra_keywords: Vec<String>/);
  assert.match(configRust, /allow: Vec<String>/);
  // A config that predates this field keeps working: no anticheat block at all.
  assert.match(configRust, /pub anticheat: Option<Anticheat>/);
  // Bounds: a provider cannot ship a thousand-word list or a bad hash.
  assert.match(configRust, /anticheat\.extra_keywords\.len\(\) > 64/);
  assert.match(configRust, /anticheat\.allow\.len\(\) > 256/);
  assert.match(configRust, /valid_sha256\(hash\)/);
});

test("default settings enable keyword checks and owned packs are scanned", () => {
  assert.match(configRust, /impl Default for Anticheat\s*\{/);
  assert.match(configRust, /scan_resourcepacks:\s*true/);
  const scan = rust.slice(
    rust.indexOf("pub fn scan_all("),
    rust.indexOf("pub struct ForeignPack"),
  );
  assert.match(scan, /foreign_packs\(game, &\[\]\)/);
  assert.match(scan, /foreign_paths\.contains\(&relative\)/);
  assert.match(scan, /scan_pack\(&relative, &path, &words\)/);
});

test("pack check reports missing installs and renders structured errors", async () => {
  const { toLineError } = await import("../src/types/line.ts");
  const error = {
    code: "INVALID_INPUT",
    message: "Сборка отсутствует",
    retryable: false,
  };
  assert.equal(toLineError(error).message, "Сборка отсутствует");
  assert.notEqual(
    toLineError({ unexpected: true }, "Ошибка").message,
    "[object Object]",
  );
  const detail = readFileSync(
    path.join(ROOT, "src/components/line/ServerDetail.tsx"),
    "utf8",
  );
  const panel = detail.slice(detail.indexOf("export function PackCheckPanel"));
  assert.match(panel, /setError\(errorMessage\(cause\)\)/);
  assert.doesNotMatch(panel, /String\(cause\)/);
  const launch = readFileSync(
    path.join(ROOT, "src-tauri/src/line/launch.rs"),
    "utf8",
  );
  const command = launch.slice(
    launch.indexOf("pub async fn check_resource_packs"),
    launch.indexOf("#[cfg(test)]"),
  );
  assert.ok(
    command.indexOf("require_pack_check_install") <
      command.indexOf("instance_game_dir"),
  );
});
