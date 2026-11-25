import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const http = read("src-tauri/vendor/mc-launcher-core/src/net/http.rs");
const download = read("src-tauri/vendor/mc-launcher-core/src/net/download.rs");
const installer = read("src-tauri/vendor/mc-launcher-core/src/install/loader.rs");

test("NeoForge fallback is limited to its HTTPS releases path and recommended host", () => {
  assert.match(http, /NEOFORGE_MAVEN_HOST: &str = "maven\.neoforged\.net"/);
  assert.match(http, /maven\.creeperhost\.net/);
  assert.match(http, /parsed\.scheme\(\) != "https"/);
  assert.match(http, /parsed\.host_str\(\) != Some\(NEOFORGE_MAVEN_HOST\)/);
  assert.match(http, /!parsed\.path\(\)\.starts_with\("\/releases\/"\)/);
  assert.match(http, /strip_prefix\("\/releases"\)/);
  assert.match(http, /Some\(429 \| 500\.\.=599\)/);
  assert.match(http, /fallback_urls\("https:\/\/maven\.neoforged\.net\/releases/);
  assert.match(http, /unrelated_hosts_and_non_release_paths_are_never_rewritten/);
});

test("NeoForge downloads retry, use an atomic temporary file and verify SHA-1", () => {
  assert.match(download, /for attempt in 0\.\.3/);
  assert.match(download, /fallback_urls\(&task\.url\)/);
  assert.match(download, /NamedTempFile::new_in\(parent\)/);
  assert.match(download, /sha1_file\(temporary\.path\(\)\)/);
  assert.match(download, /temporary\s*\.persist\(&task\.destination\)/);
});

test("NeoForge's installer receives the documented mirror; Forge does not", () => {
  assert.match(installer, /if invocation\.loader == LoaderKind::NeoForge/);
  assert.match(installer, /"--mirror"/);
  assert.match(installer, /"https:\/\/maven\.creeperhost\.net"/);
  assert.match(installer, /forge_does_not_receive_a_neoforge_mirror_argument/);
});
