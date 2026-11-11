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
  // Palette PNGs are ordinary skins (they were wrongly refused and a plain
  // 64x64 texture from an older editor could not be uploaded at all).
  assert.equal(validateSkinFile(png(64, 64, 8, 3)), null, "palette PNG");
  assert.equal(validateSkinFile(png(64, 32, 8, 3)), null, "legacy palette PNG");
  assert.match(validateSkinFile(png(64, 64, 16)) ?? "", /8 бит/);
  // Greyscale cannot become an RGBA texture, and Minecraft refuses it too.
  assert.match(validateSkinFile(png(64, 64, 8, 0)) ?? "", /8 бит/);
  assert.match(validateSkinFile(png(64, 64, 8, 4)) ?? "", /8 бит/);
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
  // The wardrobe is account-wide: one texture for every server in the project.
  const wardrobe = config.provider.wardrobe;
  assert.ok(wardrobe, "the example project must expose a wardrobe");
  assert.equal(new URL(wardrobe.skin_url).protocol, "https:");
  assert.equal(new URL(wardrobe.skin_upload_url).protocol, "https:");
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
  // The labels moved into the catalogue with the four-language interface; the
  // test now checks the component really names its buttons, and the catalogue
  // test checks the names exist in every language.
  for (const key of ["window.minimize", "window.close", "window.maximize"]) {
    assert.ok(
      titleBar.includes(`t("${key}")`),
      `caption button ${key} is unnamed`,
    );
  }
});

// --- Branding rule: tokens only, no bespoke palette ------------------------

test("the new chrome uses semantic tokens, never hardcoded colours", () => {
  for (const file of [
    "src/components/line/TitleBar.tsx",
    "src/components/line/SideNav.tsx",
    "src/components/line/SettingsScreen.tsx",
    "src/components/line/WardrobeScreen.tsx",
    "src/components/line/ServerDetail.tsx",
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
    "src/components/line/ServerActionPanel.tsx",
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

test("the wardrobe is reachable without a session, provider API or network", () => {
  const nav = read("src/components/line/SideNav.tsx");
  // The nav entry must not be gated at all: local history works signed out.
  assert.doesNotMatch(nav, /disabled:\s*!wardrobeAvailable/);
  assert.doesNotMatch(nav, /wardrobeAvailable/);

  const shell = read("src/components/line/LineLauncher.tsx");
  // No guard may bounce the player out of the section or swallow the click.
  assert.doesNotMatch(shell, /section === "wardrobe" && !wardrobeAvailable/);
  assert.doesNotMatch(
    shell,
    /section === "wardrobe" && selected && session &&/,
    "the screen must render with no server and no session",
  );
  assert.match(shell, /canSync=\{canSyncSkin\}/);

  const screen = read("src/components/line/WardrobeScreen.tsx");
  assert.match(screen, /lineApi\.setActiveSkin\(/);
  // The library loads unconditionally, not behind canSync.
  const start = screen.indexOf("void lineApi\n      .skinLibrary()");
  assert.ok(start > 0, "library must load on mount");
  const libraryEffect = screen.slice(
    start,
    screen.indexOf("}, [canSync, accountKey"),
  );
  assert.ok(libraryEffect.length > 0, "the mount effect must be found");
  assert.doesNotMatch(
    libraryEffect,
    /if \(!canSync\) return|if \(!serverId|if \(!username/,
    "loading local history must not require an account",
  );
  // Only the upload itself is gated, and a failure must not break local use.
  const autoSync = screen.slice(
    screen.indexOf("const autoSync ="),
    screen.indexOf("useEffect(() => {", screen.indexOf("const autoSync =")),
  );
  assert.ok(autoSync.length > 0, "autoSync must exist");
  assert.match(autoSync, /if \(!canSync\) return;/);
  assert.match(autoSync, /setSync\("failed"\)/);
  assert.doesNotMatch(autoSync, /setSnapshot\(null\)|setError\(/);
});

test("the active skin uploads itself, and history stays local", () => {
  const library = read("src-tauri/src/line/skin_library.rs");
  const sync = library.slice(library.indexOf("pub async fn sync_active_skin("));
  // Only the active texture is sent, never the shelf.
  assert.match(sync, /plan_sync\(/);
  assert.match(sync, /push_skin\(/);
  assert.doesNotMatch(sync, /for .* in .*skins/, "no bulk upload");
  // Idempotent, and serialized so a stale upload cannot win the marker.
  assert.match(library, /library\.active == library\.synced/);
  assert.match(sync, /state\.skin_sync\.lock\(\)\.await/);
  // The marker is written only after the provider answered, and the id comes
  // from that same successful call — not from the plan before it ran.
  const uploadArm = sync.slice(
    sync.indexOf("SyncPlan::Upload(entry, bytes) => {"),
    sync.indexOf("};", sync.indexOf("SyncPlan::Upload(entry, bytes) => {")),
  );
  assert.match(
    uploadArm,
    /let skin = super::wardrobe::push_skin\(entry\.model, bytes, &state\)\.await\?;\s*\(Some\(entry\.id\), Some\(skin\)\)/,
    "the uploaded id must be derived from the awaited upload result",
  );
  assert.ok(
    sync.indexOf("push_skin(") < sync.indexOf("library.synced = id"),
    "the uploaded marker must follow a successful upload",
  );
  // Selecting a texture stays purely local: the sync is a separate step.
  const setActive = library.slice(
    library.indexOf("pub async fn set_active_skin("),
    library.indexOf("enum SyncAction {"),
  );
  assert.ok(setActive.length > 0, "set_active_skin must exist");
  assert.doesNotMatch(setActive, /push_skin|reqwest|session\(\)/);
  // Capacity is refused on add, not silently pruned: history is the point.
  // (read_index may still bound a hand-edited file — that is not the add path.)
  const add = library.slice(
    library.indexOf("pub async fn add_skin_to_library("),
    library.indexOf("pub async fn rename_skin("),
  );
  assert.ok(add.length > 0, "add command must exist");
  assert.match(add, /ensure_capacity\(/);
  assert.doesNotMatch(add, /\.truncate\(|\.pop\(\)|\.remove\(0\)/);
});

test("there is no manual send button: the sync runs by itself", () => {
  const screen = read("src/components/line/WardrobeScreen.tsx");
  assert.doesNotMatch(screen, /Отправить на сервер|Сбросить на стандартный/);
  assert.doesNotMatch(screen, /uploadSkin|resetSkin/);
  // Mounting the screen with an unsynced choice triggers the upload.
  assert.match(screen, /value\.library\.active !== value\.library\.synced/);
  // Every local change that affects the worn look re-syncs automatically.
  for (const fn of [
    "async function save(",
    "async function activate(",
    "async function remove(",
  ]) {
    const at = screen.indexOf(fn);
    assert.ok(at > 0, `${fn} must exist`);
    const body = screen.slice(at, screen.indexOf("\n  }", at));
    assert.match(body, /autoSync\(\)/, `${fn} must sync without a button`);
  }
  // The mount effect must not depend on a callback identity: an inline arrow
  // from the shell would re-run it on every render and loop the library read.
  const autoSyncDeps = screen.slice(
    screen.indexOf("const autoSync ="),
    screen.indexOf("useEffect(() => {", screen.indexOf("const autoSync =")),
  );
  assert.match(autoSyncDeps, /\}, \[canSync\]\);/);
  // The background sync must NOT sign the player out when it fails.
  //
  // It used to call `onAuthRequired()` on any AUTH_REQUIRED, and that handler
  // clears the session — so opening the wardrobe logged the player out whenever
  // the provider rejected the upload, taking the whole screen with it while
  // they were in the middle of picking a skin. The failure is reported in the
  // sync status instead; a genuine expiry is caught by the next action the
  // player actually initiates.
  assert.doesNotMatch(screen, /authRequired\.current\?\.\(\)/);
  const autoSyncBody = screen
    .slice(
      screen.indexOf("const autoSync ="),
      screen.indexOf("useEffect(() => {", screen.indexOf("const autoSync =")),
    )
    // Strip comments: the explanation of why it no longer calls the handler
    // naturally contains the handler's name.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(autoSyncBody, /onAuthRequired|authRequired/);
  // An idempotent sync carries no skin: it must not erase the known one.
  assert.match(
    screen,
    /if \(result\.status === "synced"\) setRemote\(result\.skin\)/,
  );
  // The player sees a status, not an action. The status text lives in the
  // catalogue, so the screen is checked for the key and the catalogue for the
  // sentence — a translated interface still has to say this.
  assert.match(screen, /t\("wardrobe\.syncing"\)/);
  assert.match(screen, /t\("wardrobe\.syncedAuto"/);
  // Manual upload commands are gone from the whole IPC surface.
  const commands = read("src-tauri/src/lib.rs");
  assert.doesNotMatch(commands, /upload_skin|wardrobe::reset_skin/);
  assert.match(commands, /sync_active_skin/);
  assert.match(commands, /forget_synced_skin/);
  const api = read("src/lib/line/api.ts");
  assert.doesNotMatch(api, /uploadSkin|resetSkin/);
});

test("one account per project unlocks every server", () => {
  const api = read("src/lib/line/api.ts");
  assert.match(api, /logout: \(\) =>/);
  assert.match(api, /"line_session"/);
  assert.match(api, /setActiveSkin: \(id: string \| null\)/);
  assert.doesNotMatch(api, /serverId, model|\{ serverId, username/);

  const auth = read("src-tauri/src/line/auth.rs");
  const request = auth.slice(
    auth.indexOf("pub struct AuthRequest {"),
    auth.indexOf("pub async fn"),
  );
  assert.ok(request.length > 0, "AuthRequest must exist");
  assert.doesNotMatch(request, /server_id/);
  assert.match(auth, /provider\.auth/);

  const state = read("src-tauri/src/line/state.rs");
  assert.match(state, /session: Option<ProviderSession>/);
  assert.doesNotMatch(state, /sessions: HashMap/);

  const shell = read("src/components/line/LineLauncher.tsx");
  assert.match(
    shell,
    /lineApi\.authenticate\(mode, \{ username, password \}\)/,
  );
  // The sign-in page is a real page, before the server list: it covers the
  // whole window instead of sitting in a panel of the shell.
  assert.match(shell, /screen === "account"/);
  assert.match(shell, /<SignInScreen/);
  assert.match(shell, /const gateSignIn =/);
  // Opening a server must not ask for credentials again.
  const select = shell.slice(
    shell.indexOf("function selectServer("),
    shell.indexOf("async function authenticate("),
  );
  assert.ok(select.length > 0, "selectServer must exist");
  assert.doesNotMatch(select, /setSession\(null\)|AuthForm/);
  assert.doesNotMatch(shell, /<AuthForm/);
  // Signing out is available and account-wide.
  assert.match(shell, /await lineApi\.logout\(\)/);
  assert.match(shell, /onLogout=\{/);
});

// Regression: `Option` has no `retain`. This compiled nowhere locally (the pure
// harness skipped it, CI was unavailable) and broke the first real `cargo run`
// on Windows. The rule now lives in helpers the harness compiles and tests.
test("skin index slots are repaired by compiled helpers, not Option::retain", () => {
  const library = read("src-tauri/src/line/skin_library.rs");
  assert.doesNotMatch(library, /\.(active|synced)\.retain\(/);
  for (const helper of [
    "keep_slot",
    "prune_library",
    "forget_skin",
    "texture_path",
  ]) {
    assert.match(library, new RegExp(`fn ${helper}\\(`));
    // Must stay inside the subset that `npm run test:rust` actually compiles.
    assert.ok(
      read("scripts/test-rust-pure.mjs").includes(`fn ${helper}("`),
      `${helper} is no longer compiled by the pure Rust harness`,
    );
  }
  assert.match(library, /prune_library\(&mut library\);/);
  assert.match(library, /forget_skin\(&mut library, &id\);/);
});

test("the extractor keeps the entry path alive for the integrity index", () => {
  const install = read("src-tauri/src/line/install.rs");
  // `staging.join(relative)` moved the PathBuf and broke the index write.
  assert.match(install, /let target = staging\.join\(&relative\);/);
  assert.match(install, /path: relative\.to_string_lossy\(\)/);
});

// ─────────────────────────────────────────── after-launch behaviour & tray ──

test("the after-launch setting offers exactly the behaviours a player needs", () => {
  const types = read("src/types/line.ts");
  const settings = read("src-tauri/src/line/settings.rs");
  const screen = read("src/components/line/SettingsScreen.tsx");

  // The three the request asked for, plus "keep", which is what the launcher
  // did before this setting existed and has to stay reachable.
  for (const value of ["tray", "minimize", "close", "keep"]) {
    assert.match(types, new RegExp(`"${value}"`), `missing ${value} in TS`);
    assert.match(
      settings,
      new RegExp(`^\\s*${value[0].toUpperCase()}${value.slice(1)},`, "m"),
      `missing ${value[0].toUpperCase()}${value.slice(1)} in Rust`,
    );
  }
  // The order in the select is the order of intent: hide, minimise, close,
  // stay. Rust's default cannot move: an existing settings.json must keep
  // working without a migration.
  assert.match(settings, /#\[default\]\s*\n\s*Keep/);
  assert.ok(
    screen.indexOf('value: "tray"') < screen.indexOf('value: "minimize"') &&
      screen.indexOf('value: "minimize"') < screen.indexOf('value: "close"') &&
      screen.indexOf('value: "close"') < screen.indexOf('value: "keep"'),
    "the select must be ordered tray → minimize → close → keep",
  );
});

test("launching into the tray hides the window, and the tray can bring it back", () => {
  const launcher = read("src/components/line/LineLauncher.tsx");
  const windowLib = read("src/lib/line/window.ts");
  const tray = read("src-tauri/src/line/tray.rs");

  // `hide()` is the difference between the tray and a minimised window: the
  // taskbar entry has to disappear, not just the pixels.
  assert.match(windowLib, /export async function hideWindow/);
  assert.match(windowLib, /win\.hide\(\)/);
  assert.match(launcher, /behaviour === "tray"/);
  assert.match(launcher, /hideWindow\(\)/);

  // The tray itself: one icon, open + quit, left click restores.
  assert.match(tray, /TrayIconBuilder/);
  assert.match(tray, /"line-tray"/);
  assert.match(tray, /"open"/);
  assert.match(tray, /"quit"/);
  assert.match(tray, /unminimize/);
  assert.match(tray, /set_focus/);
  // A tray that cannot be created must not abort startup — the window then
  // simply stays visible, which is a worse experience but a working launcher.
  assert.match(read("src-tauri/src/lib.rs"), /eprintln!\("\[tray\]/);
});

test("the launcher comes back by itself when the game exits or fails", () => {
  const launcher = read("src/components/line/LineLauncher.tsx");
  // Both terminal phases restore, so the promise does not depend on which
  // after-launch behaviour was chosen. A crash is when it matters most.
  assert.match(launcher, /phase === "exited"/);
  assert.match(launcher, /phase === "failed"/);
  assert.match(launcher, /void restoreWindow\(\)/);
  const windowLib = read("src/lib/line/window.ts");
  for (const call of ["unminimize", "show", "setFocus"]) {
    assert.match(
      windowLib,
      new RegExp(`${call}\\(\\)`),
      `restore must call ${call}`,
    );
  }
});

// ───────────────────────────────────────────────────────────── backdrops ──

test("backdrop themes ship a persisted, validated choice", () => {
  const settings = read("src-tauri/src/line/settings.rs");
  const types = read("src/types/line.ts");
  const launcher = read("src/components/line/LineLauncher.tsx");
  const picker = read("src/components/line/BackdropPicker.tsx");

  // Unknown ids must degrade to the default rather than blank the window: the
  // id is stored as a plain string and resolved by `backdropTheme`.
  assert.match(settings, /pub backdrop: Option<String>/);
  assert.match(settings, /backdrop: None/);
  assert.match(types, /backdrop\?: string \| null/);
  assert.match(launcher, /themeId=\{settings\?\.settings\.backdrop/);

  // The chooser is in settings, and it is a radio group, not a row of buttons:
  // exactly one of a known set is selected.
  assert.match(picker, /role="radiogroup"/);
  assert.match(picker, /role="radio"/);
  assert.match(picker, /aria-checked/);
  assert.ok(
    read("src/components/line/SettingsScreen.tsx").includes("<BackdropPicker"),
    "the picker has to be reachable from settings",
  );

  // Every theme carries its own swatch and its own veil. The swatches are
  // literals now, taken from each theme's own palette: the themes no longer
  // come from one shared helper, they come from the generator.
  const backdrops = read("src/lib/line/backdrops.ts");
  const swatches = backdrops.match(/swatch: \["#/g)?.length ?? 0;
  assert.ok(swatches >= 10, `expected a swatch per theme, found ${swatches}`);
  const shades = backdrops.match(/shade: 0\./g)?.length ?? 0;
  assert.ok(shades >= 10, `expected a shade per theme, found ${shades}`);
});

test("the account page shows the active skin in 3D and falls back flat", () => {
  const profile = read("src/components/line/ProfileScreen.tsx");
  const viewer = read("src/components/line/SkinViewer3D.tsx");
  const nav = read("src/components/line/SideNav.tsx");
  const pkg = readJson("package.json") as {
    dependencies: Record<string, string>;
  };

  // A real viewer, not a picture of one.
  assert.ok(pkg.dependencies.skinview3d, "skinview3d must be a dependency");
  assert.match(viewer, /await import\("skinview3d"\)/);
  assert.match(viewer, /new SkinViewer\(/);
  assert.match(viewer, /dispose\(\)/);
  // three.js is heavy; the servers screen must not download it.
  assert.doesNotMatch(profile, /from "skinview3d"/);

  // No WebGL, no CORS, no texture → the flat preview, never an empty box.
  assert.match(viewer, /SkinPreview/);
  assert.match(viewer, /data-line-skin-viewer/);

  // The skin shown is the one the wardrobe made active.
  assert.match(profile, /lineApi\.skinLibrary\(\)/);
  assert.match(profile, /lineApi\.skinTexture\(/);
  // …and its object URL is released, or every refresh leaks a texture.
  assert.match(profile, /URL\.revokeObjectURL/);

  // Reachable from the rail, not hidden behind a menu.
  assert.match(nav, /id: "account"/);
});

test("opening the wardrobe never signs the player out", () => {
  const screen = read("src/components/line/WardrobeScreen.tsx");

  // The background sync runs by itself on mount. It used to call
  // `onAuthRequired()` on any AUTH_REQUIRED, and that handler clears the
  // session — so the first rejection from the provider logged the player out
  // while they were looking at their skins, with the whole screen replaced by
  // the sign-in page. Reproduced against the reference provider with an
  // upload that answers 401: session lost, screen gone.
  const sync = screen
    .slice(
      screen.indexOf("const autoSync ="),
      screen.indexOf("useEffect(() => {", screen.indexOf("const autoSync =")),
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(sync, /authRequired/);
  assert.doesNotMatch(sync, /onAuthRequired/);
  // The failure is still reported — the sync status line shows it.
  assert.match(sync, /setSync\("failed"\)/);
  assert.match(sync, /setSyncError\(errorMessage\(cause\)\)/);
});

test("the close button's hover glyph does not disappear into its own fill", () => {
  const bar = read("src/components/line/TitleBar.tsx");
  const close = bar.slice(
    bar.lastIndexOf(
      "<Button",
      bar.indexOf("onClick={() => void closeWindow()}"),
    ),
  );
  const button = close.slice(0, close.indexOf("</Button>"));

  // Rest state is the same grey as minimise and maximise — that was never the
  // complaint.
  const classes = (button.match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/);
  assert.ok(classes.includes("text-muted-foreground"), "rest glyph stays grey");
  assert.ok(!classes.includes("text-destructive"), "rest glyph is not red");
  // Hover is the solid red fill that was reported as too dim. It fills from
  // `destructive-strong`, not `destructive`: the latter is the error-text
  // colour, and at 0.66 lightness it read as pale coral once it covered a
  // whole 44×36 square.
  assert.match(button, /hover:bg-destructive-strong/);
  assert.match(button, /hover:text-destructive-foreground/);

  // The glyph on that fill was `--destructive-foreground: oklch(0.72 0.19 22)`
  // — #ff696d, a red a shade lighter than the #f84a54 fill under it, contrast
  // 1.23:1. The ✕ was painted red-on-red, so the square read as one flat dim
  // smudge instead of a red button with a symbol on it. This token has exactly
  // one consumer — this button — so it is checked here.
  //
  // It must stay *red*: the button is meant to read red as a whole, and a
  // white cross on a red square is a different design. What it needs is
  // distance in lightness from the fill while the hue holds.
  const css = read("src/index.css");
  const token = css.match(
    /--destructive-foreground:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/,
  );
  assert.ok(token, "--destructive-foreground must be an oklch triple");
  const glyphL = Number(token[1]);
  const glyphC = Number(token[2]);
  const glyphH = Number(token[3]);
  assert.ok(
    glyphC >= 0.14,
    `the hover glyph must still be red, got chroma ${glyphC}`,
  );
  assert.ok(
    glyphL < 0.85,
    `a near-white glyph was rejected as pink, got lightness ${glyphL}`,
  );
  assert.ok(
    Math.abs(glyphH - 25) <= 8,
    `it must stay on the same red hue, got ${glyphH}`,
  );

  // The fill it sits on: saturated, deep, and far enough from the glyph that
  // the ✕ never blends into its own background again.
  const fill = css.match(
    /--destructive-strong:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/,
  );
  assert.ok(fill, "--destructive-strong must be an oklch triple");
  const fillL = Number(fill[1]);
  const fillChroma = Number(fill[2]);
  assert.ok(
    fillChroma >= 0.22,
    `the fill must stay saturated, got chroma ${fillChroma}`,
  );
  assert.ok(fillL <= 0.58, `the fill must be deep, got lightness ${fillL}`);
  // Perceptually the two must be far apart: the old pair was 0.72 vs 0.66 in
  // lightness at nearly the same chroma, which is why it disappeared.
  assert.ok(
    glyphL - fillL >= 0.18,
    `glyph and fill are ${glyphL - fillL} apart in lightness`,
  );
  assert.ok(
    glyphC - fillChroma <= 0.02,
    "the glyph must not be more saturated than the fill",
  );
  // And the button colour must not leak into error text.
  assert.match(css, /--line-error:\s*var\(--destructive\)/);
});

test("backdrops are dim enough to read on, and none of them stands still", () => {
  const source = read("src/lib/line/backdrops.ts");
  const shades = [...source.matchAll(/^\s*shade: ([\d.]+),/gm)].map((m) =>
    Number(m[1]),
  );
  const speeds = [...source.matchAll(/^\s*speed: ([\d.]+),/gm)].map((m) =>
    Number(m[1]),
  );
  const motions = [...source.matchAll(/^\s*motion: "(\w+)",/gm)].map(
    (m) => m[1],
  );
  assert.equal(shades.length, 12);
  assert.equal(speeds.length, 12);
  assert.equal(motions.length, 12);

  // The panels are translucent, so the backdrop is not decoration behind
  // glass — it is behind the text. At 0.26–0.46 the bright themes lifted the
  // title bar and the body copy enough to make a flat interface glow.
  for (const shade of shades) {
    assert.ok(
      shade >= 0.42 && shade <= 0.62,
      `shade ${shade} outside 0.42–0.62`,
    );
  }

  // All twelve used to run `drift` at 1.1: slow enough to read as a still
  // image, and identical in behaviour, so twelve palettes behaved as one
  // gradient. They now spread across hazeglow's three motions and run faster.
  assert.equal(new Set(motions).size, 3);
  for (const motion of motions) {
    assert.ok(
      ["flow", "breathe", "drift"].includes(motion),
      `unknown motion ${motion}`,
    );
  }
  for (const speed of speeds) {
    assert.ok(speed >= 2 && speed <= 3, `speed ${speed} outside 2–3`);
  }
  assert.ok(new Set(speeds).size >= 6, "speeds should differ between themes");
});

test("a missing Java runtime list does not blank the settings screen", () => {
  // Found while auditing: `list_java_runtimes` returning null made
  // `list.some(...)` throw, React unmounted the tree, and the settings page
  // became a black window with no message. The command is typed as an array,
  // which is exactly why the guard belongs at the call site — the UI must not
  // depend on a backend version it does not control.
  const settings = read("src/components/line/SettingsScreen.tsx");
  assert.match(
    settings,
    /const list = \(await lineApi\.javaRuntimes\(\)\) \?\? \[\];/,
    "the runtime list must be normalised before use",
  );
  assert.match(settings, /!list\.some\(/);
});
