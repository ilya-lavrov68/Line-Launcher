import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { BASE_WINDOW, renderTauriOverlay } from "../scripts/brand-config.ts";
import type { BrandConfig } from "../branding/brand.types.ts";
import {
  MAX_SKIN_BYTES,
  isLegacySkin,
  readPngHeader,
  skinLayout,
  validateSkinFile,
} from "../src/lib/line/skin.ts";
import { LINE_SUPPORTED_FEATURES, type LineConfig } from "../src/types/line.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel));

/** Build a PNG header with the given IHDR fields, like the Rust test helper. */
function png(
  width: number,
  height: number,
  depth = 8,
  colour = 6,
  interlace = 0,
): Uint8Array {
  const bytes = new Uint8Array(49);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = depth;
  bytes[25] = colour;
  bytes[28] = interlace;
  return bytes;
}

// --- Skin geometry ---------------------------------------------------------

test("classic uses 4px arms and slim uses 3px", () => {
  const classic = skinLayout("classic");
  const slim = skinLayout("slim");
  const classicArm = classic.find((r) => r.sx === 44 && r.sy === 20);
  const slimArm = slim.find((r) => r.sx === 44 && r.sy === 20);
  assert.equal(classicArm?.sw, 4);
  assert.equal(slimArm?.sw, 3);
  // A narrower arm must not leave a gap next to the torso.
  assert.equal(classicArm!.dx + classicArm!.sw, 4);
  assert.equal(slimArm!.dx + slimArm!.sw, 4);
});

test("the overlay layer is painted after the base layer", () => {
  const rects = skinLayout("classic");
  const baseHead = rects.findIndex((r) => r.sx === 8 && r.sy === 8);
  const hatHead = rects.findIndex((r) => r.sx === 40 && r.sy === 8);
  assert.ok(baseHead >= 0 && hatHead > baseHead, "hat must cover the head");
  // Every base region is drawn before any overlay region.
  const firstOverlay = rects.findIndex((r) => r.sy >= 36 || r.sx === 40);
  assert.ok(firstOverlay > 0);
  for (const rect of rects.slice(firstOverlay)) {
    assert.ok(rect.sy >= 36 || rect.sx === 40 || rect.sx === 52);
  }
});

test("a legacy 64x32 texture mirrors the right limbs and has no overlay", () => {
  const legacy = skinLayout("classic", true);
  assert.equal(legacy.length, 6);
  assert.equal(legacy.filter((r) => r.flip).length, 2);
  assert.ok(!legacy.some((r) => r.sy >= 36), "no second layer before 1.8");
  // The silhouette still spans the full 16px width.
  const right = legacy.find((r) => r.flip && r.dy === 8);
  assert.equal(right?.dx, 12);
});

test("every rectangle stays inside the texture and the silhouette", () => {
  for (const model of ["classic", "slim"] as const) {
    for (const legacy of [false, true]) {
      for (const r of skinLayout(model, legacy)) {
        assert.ok(r.sx >= 0 && r.sx + r.sw <= 64, `source x out of range`);
        assert.ok(
          r.sy + r.sh <= (legacy ? 64 : 64),
          `source y out of range: ${JSON.stringify(r)}`,
        );
        assert.ok(r.dx >= 0 && r.dx + r.sw <= 16, "destination x overflow");
        assert.ok(r.dy >= 0 && r.dy + r.sh <= 32, "destination y overflow");
      }
    }
  }
});

// --- Client-side PNG validation mirrors Rust -------------------------------

test("the client accepts exactly the sizes and formats Rust accepts", () => {
  assert.equal(validateSkinFile(png(64, 64)), null);
  assert.equal(validateSkinFile(png(64, 32)), null);
  assert.equal(validateSkinFile(png(64, 64, 8, 2)), null);
  for (const [w, h] of [
    [32, 32],
    [64, 63],
    [128, 128],
    [0, 64],
  ]) {
    assert.match(
      validateSkinFile(png(w, h)) ?? "",
      /64×64|64×32/,
      `accepted ${w}x${h}`,
    );
  }
  assert.match(validateSkinFile(png(64, 64, 16)) ?? "", /8 бит/);
  assert.match(validateSkinFile(png(64, 64, 8, 3)) ?? "", /8 бит/);
  assert.match(validateSkinFile(png(64, 64, 8, 6, 1)) ?? "", /Чересстрочный/);
});

test("non-PNG, empty and oversized files are rejected before upload", () => {
  assert.match(validateSkinFile(new Uint8Array(0)) ?? "", /пуст/);
  assert.match(validateSkinFile(new Uint8Array(64)) ?? "", /PNG/);
  const notPng = png(64, 64);
  notPng[0] = 0x47;
  assert.match(validateSkinFile(notPng) ?? "", /PNG/);
  assert.match(
    validateSkinFile(new Uint8Array(MAX_SKIN_BYTES + 1)) ?? "",
    /256 КБ/,
  );
});

test("the legacy flag comes from the header, not the file name", () => {
  assert.equal(isLegacySkin(readPngHeader(png(64, 32))!), true);
  assert.equal(isLegacySkin(readPngHeader(png(64, 64))!), false);
  assert.equal(readPngHeader(new Uint8Array(10)), null);
});

test("the byte cap matches the Rust constant", () => {
  const rust = read("src-tauri/src/line/wardrobe.rs");
  const match = /MAX_SKIN_BYTES: usize = (\d+) \* 1024/.exec(rust);
  assert.ok(match, "Rust cap must stay discoverable");
  assert.equal(MAX_SKIN_BYTES, Number(match[1]) * 1024);
});

// --- Provider config contract ---------------------------------------------

test("the example ships several servers, each with its own artwork", () => {
  const config = readJson("examples/config.json") as LineConfig;
  assert.ok(config.servers.length >= 2, "must demonstrate a multi-server list");
  const ids = config.servers.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "slugs must be unique");
  for (const server of config.servers) {
    for (const url of [server.icon_url, server.banner_url]) {
      assert.ok(url, `${server.id} must show icon and banner usage`);
      assert.equal(new URL(url).protocol, "https:");
    }
  }
  // Artwork differs per server, otherwise the example proves nothing.
  assert.notEqual(config.servers[0].banner_url, config.servers[1].banner_url);
});

test("wardrobe endpoints are paired and advertised as a feature", () => {
  const config = readJson("examples/config.json") as LineConfig;
  const withWardrobe = config.servers.filter((s) => s.wardrobe);
  assert.ok(withWardrobe.length > 0);
  for (const server of withWardrobe) {
    assert.equal(new URL(server.wardrobe!.skin_url).protocol, "https:");
    assert.equal(new URL(server.wardrobe!.skin_upload_url).protocol, "https:");
  }
  assert.ok(config.required_features?.includes("skin-upload-v1"));
  assert.ok(
    (LINE_SUPPORTED_FEATURES as readonly string[]).includes("skin-upload-v1"),
    "the launcher must declare the feature it implements",
  );
  const rust = read("src-tauri/src/line/config.rs");
  assert.match(rust, /"skin-upload-v1"/);
  // Rust must validate both URLs, not just accept them.
  assert.match(rust, /validate_https\(&wardrobe\.skin_url\)/);
  assert.match(rust, /validate_https\(&wardrobe\.skin_upload_url\)/);
});

test("the legacy logo_url is still accepted and normalized to icon_url", () => {
  const rust = read("src-tauri/src/line/config.rs");
  assert.match(rust, /alias = "logo_url"/);
  const card = read("src/components/line/ServerCard.tsx");
  assert.match(card, /iconUrl/);
  const list = read("src/components/line/ServerList.tsx");
  assert.match(list, /server\.icon_url \?\? server\.logo_url/);
});

// --- Custom frame must survive the branding overlay ------------------------

test("BASE_WINDOW mirrors tauri.conf.json so branding cannot drop it", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  const window = conf.app.windows[0];
  for (const [key, value] of Object.entries(BASE_WINDOW)) {
    assert.deepEqual(window[key], value, `tauri.conf.json ${key} drifted`);
  }
  assert.equal(
    window.decorations,
    false,
    "the custom frame needs no native one",
  );
});

test("the generated overlay keeps geometry and decorations", () => {
  const brand = readJson("branding/line.brand.json") as BrandConfig;
  const overlay = JSON.parse(renderTauriOverlay(brand, true));
  const merged = overlay.app.windows[0];
  // RFC 7386 replaces arrays: the overlay must carry the whole window object.
  assert.equal(merged.decorations, false);
  assert.equal(merged.width, BASE_WINDOW.width);
  assert.equal(merged.minWidth, BASE_WINDOW.minWidth);
  assert.equal(merged.label, "main");
  assert.equal(merged.title, brand.product.window_title);
});

test("the title bar can actually control the window", () => {
  const caps = readJson("src-tauri/capabilities/default.json");
  for (const permission of [
    "core:window:allow-start-dragging",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
  ]) {
    assert.ok(caps.permissions.includes(permission), `missing ${permission}`);
  }
  const titleBar = read("src/components/line/TitleBar.tsx");
  assert.match(titleBar, /data-tauri-drag-region/);
  for (const label of ["Свернуть окно", "Закрыть окно"]) {
    assert.ok(titleBar.includes(label), `caption button ${label} is unnamed`);
  }
});

// --- Branding rule: tokens only, no bespoke palette ------------------------

test("the new chrome uses semantic tokens, never hardcoded colours", () => {
  for (const file of [
    "src/components/line/TitleBar.tsx",
    "src/components/line/SideNav.tsx",
    "src/components/line/SettingsScreen.tsx",
    "src/components/line/WardrobeScreen.tsx",
    "src/components/line/ServerBanner.tsx",
    "src/components/line/SkinPreview.tsx",
  ]) {
    const src = read(file);
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(src),
      `${file} hardcodes a hex colour instead of an Obsy token`,
    );
    assert.ok(
      !/\b(?:oklch|hsl|rgb)a?\(/.test(src),
      `${file} hardcodes a colour function`,
    );
  }
});

test("the standalone logo is transparent and its tint mode is detected", () => {
  const svg = read("branding/assets/logo.svg");
  assert.ok(!/<rect[^>]*fill=/.test(svg), "the mark must have no background");
  assert.match(svg, /viewBox=/);
  const brand = readJson("branding/line.brand.json") as BrandConfig;
  assert.ok(brand.assets?.logo, "a standalone logo file must be configured");

  // Both modes are valid: monochrome art is tinted through a mask, colour art
  // keeps its own fills. The generator must classify whichever is shipped, so
  // swapping the file cannot silently render a solid block or a stale tint.
  const tinted = /\bcurrentColor\b/i.test(svg);
  const generated = read("src/brand/generated.ts");
  assert.ok(
    generated.includes(`logoTinted: ${tinted}`),
    `logoTinted must be ${tinted} for the shipped artwork`,
  );
  const mark = read("src/components/line/BrandMark.tsx");
  assert.match(mark, /maskImage/, "the tinted path must survive");
  assert.match(mark, /bg-primary/);
  assert.match(mark, /<img/, "the colour path must survive");
  // An unquoted url() is dropped by the CSS parser when Vite inlines the SVG.
  assert.match(mark, /url\("/, "the mask URL must stay quoted");
});

test("navigation keeps every target reachable when collapsed", () => {
  const nav = read("src/components/line/SideNav.tsx");
  // Icon-only mode still needs accessible names and the license credit.
  assert.match(nav, /aria-label=\{item\.label\}/);
  assert.match(nav, /aria-current/);
  assert.match(nav, /aria-expanded/);
  assert.match(nav, /Attribution/);
  assert.match(nav, /useReducedMotion/);
});

// --- Layout stability and chrome ------------------------------------------

test("submit buttons keep a reserved message slot so they cannot jump", () => {
  for (const file of [
    "src/components/line/ConfigUrlInput.tsx",
    "src/components/line/AuthForm.tsx",
  ]) {
    const src = read(file);
    // Mounting/unmounting the error changed the card height and, because the
    // card is centred, moved the submit button on every attempt.
    assert.match(
      src,
      /aria-live="polite"/,
      `${file} lost its live message slot`,
    );
    assert.match(
      src,
      /min-h-\d+/,
      `${file} must reserve height for the message`,
    );
  }
  // The shared Button already provides press feedback; a second bespoke
  // transform fought it and made the press feel like a jump.
  for (const file of [
    "src/components/line/ConfigUrlInput.tsx",
    "src/components/line/AuthForm.tsx",
    "src/components/line/LaunchControls.tsx",
    "src/components/line/LineLauncher.tsx",
  ]) {
    assert.ok(
      !/active:scale-/.test(read(file)),
      `${file} re-introduces a bespoke press transform`,
    );
  }
});

test("the scrollbar pill is token-driven and not disabled by the standard props", () => {
  const css = read("src/index.css");
  assert.match(css, /::-webkit-scrollbar-thumb/);
  assert.match(css, /background-clip:\s*content-box/);
  assert.match(css, /var\(--foreground\)/);
  assert.match(css, /var\(--primary\)/);
  // Setting scrollbar-width/color unconditionally makes Chromium ignore
  // ::-webkit-scrollbar entirely, which silently restores the stock bar.
  const standard = /scrollbar-width:\s*thin/;
  assert.match(css, standard);
  const guard = css.indexOf("@supports not selector(::-webkit-scrollbar)");
  assert.ok(guard >= 0, "the standard properties must be gated to Firefox");
  assert.ok(
    guard < css.search(standard),
    "scrollbar-width must sit inside the @supports guard",
  );
  // No hardcoded colours: every preset must restyle the thumb.
  const block = css.slice(
    css.indexOf("::-webkit-scrollbar"),
    css.indexOf("/* Base UI"),
  );
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(block),
    "the scrollbar hardcodes a colour",
  );
  // Reduced motion must also stop the thumb transition.
  assert.match(
    css,
    /prefers-reduced-motion[\s\S]*::-webkit-scrollbar-thumb[\s\S]*transition:\s*none/,
  );
});

test("the unavailable wardrobe explains itself and stays reachable", () => {
  const nav = read("src/components/line/SideNav.tsx");
  // A disabled button gets pointer-events:none, so a native title never shows.
  // Assert the prop itself, not the word: a comment mentioning it would
  // otherwise let the regression through (verified by mutation).
  assert.match(nav, /focusableWhenDisabled=\{/);
  assert.match(nav, /TooltipTrigger/);
  assert.match(nav, /opacity-50/, "it must still look inactive");
  const shell = read("src/components/line/LineLauncher.tsx");
  assert.match(shell, /TooltipProvider/);
  // One generic hint left players guessing; each prerequisite is named.
  assert.match(shell, /wardrobeHint/);
  for (const reason of [
    "подключите провайдера",
    "Откройте сервер",
    "не настроил гардероб",
    "Войдите в аккаунт",
  ]) {
    assert.ok(shell.includes(reason), `missing wardrobe reason: ${reason}`);
  }
});
