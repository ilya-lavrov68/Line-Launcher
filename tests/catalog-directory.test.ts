import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("the catalog has one compact directory layout, not a view switch", () => {
  const list = read("src/components/line/ServerList.tsx");
  const card = read("src/components/line/ServerCard.tsx");

  assert.match(
    list,
    /role="list"[\s\S]*?aria-label=\{t\("catalog\.servers"\)\}/,
  );
  assert.match(list, /targets\.map\(\(group\) =>/);
  assert.match(list, /group\.servers\.map\(\(server\) =>/);
  assert.doesNotMatch(
    list,
    /HarmonyCatalog|catalog\.grid|catalog\.harmony|onViewChange|view ===/,
  );
  assert.match(card, /min-h-\[6\.5rem\]/);
  assert.match(card, /width=\{1600\}\s+height=\{400\}/);
  assert.match(card, /aria-label=\{t\("servers\.open", \{ name \}\)\}/);
});

test("legacy catalog view settings load harmlessly and are dropped on the next save", () => {
  const rust = read("src-tauri/src/line/settings.rs");
  const types = read("src/types/line.ts");
  const launcher = read("src/components/line/LineLauncher.tsx");

  assert.match(
    rust,
    /legacy_catalog_view_settings_are_ignored_and_removed_on_save/,
  );
  assert.doesNotMatch(rust, /pub catalog_view:/);
  assert.doesNotMatch(types, /CatalogView|catalogView/);
  assert.doesNotMatch(launcher, /changeCatalogView|catalogView/);
});

test("personal server groups and drag targets remain available in the directory", () => {
  const list = read("src/components/line/ServerList.tsx");
  const section = read("src/lib/line/server-layout.ts");

  assert.match(list, /data-section-id=\{group\.id\}/);
  assert.match(list, /data-server-drag=\{server\.id\}/);
  assert.match(list, /moveServerToSection\(/);
  assert.match(list, /<AddSectionButton/);
  assert.match(section, /export function moveServerToSection/);
});

test("demo and screenshot banners share authored abstract graphic artwork", () => {
  const artwork = read("scripts/lib/demo-art.mjs");
  const screenshots = read("scripts/screenshots.mjs");
  const provider = read("examples/provider/build-pack.mjs");

  assert.match(artwork, /pattern id="grid"/);
  assert.match(artwork, /pattern id="grain"/);
  assert.match(artwork, /survival:[\s\S]*?skyblock:[\s\S]*?creative:/);
  assert.doesNotMatch(artwork, /linearGradient|<image\b|<text\b|<tspan\b/);
  assert.match(screenshots, /demoBannerDataUrl/);
  assert.match(screenshots, /demoIconDataUrl/);
  assert.match(provider, /demoBannerSvg/);
  assert.match(provider, /demoIconSvg/);
});
