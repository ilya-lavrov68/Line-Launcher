import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("Connector cache is checked against a scanned release and never globally allowed", () => {
  const mc = read("src-tauri/src/line/minecraft.rs");
  const connector = read("src-tauri/src/line/connector.rs");
  const launch = read("src-tauri/src/line/launch.rs");
  assert.ok(mc.indexOf("integrity::scan(&release)") < mc.indexOf("matches_verified_nested("));
  assert.ok(mc.indexOf("matches_verified_nested(") < mc.indexOf("drop(release_lease)"));
  assert.match(mc, /let scan_preparation = Arc::clone\(&preparation\)/);
  assert.match(mc, /let scan_lease = Arc::clone\(&release_lease\)/);
  assert.match(connector, /Sha256::digest\(&bytes\)/);
  assert.match(connector, /json\.get\("jars"\)/);
  assert.match(connector, /actual == format!/);
  assert.match(launch, /check_live_mods_with\(game, owned, \|_\| Ok\(false\)\)/);
});
