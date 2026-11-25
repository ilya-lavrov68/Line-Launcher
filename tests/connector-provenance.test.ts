import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("Connector cache is checked against a scanned release and never globally allowed", () => {
  const mc = read("src-tauri/src/line/minecraft.rs");
  const connector = read("src-tauri/src/line/connector.rs");
  const launch = read("src-tauri/src/line/launch.rs");
  assert.ok(
    mc.indexOf("integrity::scan(&release)") <
      mc.indexOf("scan_packs_with_verified_nested("),
  );
  assert.ok(
    mc.indexOf("scan_packs_with_verified_nested(") <
      mc.indexOf("drop(release_lease)"),
  );
  assert.match(mc, /let scan_preparation = Arc::clone\(&preparation\)/);
  assert.match(mc, /let scan_lease = Arc::clone\(&release_lease\)/);
  assert.match(connector, /Sha256::digest\(&bytes\)/);
  assert.match(connector, /json\.get\("jars"\)/);
  assert.match(connector, /actual == format!/);
  assert.match(launch, /check_live_mods_with\(game, owned, \|relative\|/);
  assert.match(launch, /actual_sha == \*sha256 && actual_size == \*size/);
  assert.match(launch, /indexed_path = format!\("\{prefix\}\{relative\}"\)/);
  assert.match(launch, /sha256 == entry\.sha256 && size == entry\.size/);
});

test("Minecraft preflight uses the same verified nested-JAR proof as launch", () => {
  const launch = read("src-tauri/src/line/launch.rs");
  const check = launch.slice(
    launch.indexOf("pub async fn check_resource_packs("),
    launch.indexOf(
      "#[cfg(test)]",
      launch.indexOf("pub async fn check_resource_packs("),
    ),
  );
  const minecraft = read("src-tauri/src/line/minecraft.rs");
  assert.match(check, /LaunchMode::Minecraft/);
  assert.match(check, /check_minecraft_mod_provenance\(/);
  assert.match(check, /detected\.prefix/);
  assert.match(minecraft, /scan_packs_with_verified_nested\(/);
  assert.match(launch, /check_minecraft_mod_provenance\(/);
  assert.match(
    launch,
    /matches_verified_nested\(\s*game,\s*index,\s*prefix,\s*relative/,
  );
  assert.match(minecraft, /unproved_mods = Some\(scan\.unproved\)/);
});

test("nested-JAR proof has a bounded generator-independent fallback", () => {
  const rust = read("src-tauri/src/line/connector.rs");
  assert.match(rust, /for parent in &index\.files/);
  assert.match(
    rust,
    /matches_parent\(game, index, prefix, relative, path, name, checked\)/,
  );
  assert.match(rust, /MAX_PARENT_CANDIDATES/);
  assert.match(rust, /MAX_PARENT_SCAN_BYTES/);
  assert.match(rust, /MAX_NESTED_SCAN_BYTES/);
  assert.match(rust, /MAX_SCANNED_ENTRIES/);
});
