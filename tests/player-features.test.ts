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
  assert.match(titleBar, /actions\?: React\.ReactNode/);
  assert.match(titleBar, /data-window-actions/);
  assert.match(titleBar, /aria-label=\{t\("window\.actions"\)\}/);
  // Window actions and every native caption use translated accessible names.
  for (const key of [
    "window.minimize",
    "window.close",
    "window.maximize",
    "window.actions",
  ]) {
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
  assert.match(
    css,
    /::-webkit-scrollbar-track:vertical\s*\{\s*margin-block:\s*12px/,
  );
  assert.match(
    css,
    /::-webkit-scrollbar-track:horizontal\s*\{\s*margin-inline:\s*12px/,
  );
  assert.match(css, /border:\s*4px solid transparent/);
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

/**
 * The sign-in page covers the whole window, so nothing inside the shell is
 * reachable until the player has an account. The wardrobe used to be documented
 * as working "without signing in", which was true only while a startup bug left
 * the shell unlocked with no session — the same bug that stranded players with
 * no way to sign out. The documentation now says what the code does.
 */
test("docs no longer promise a signed-out route into the wardrobe", () => {
  const places = [
    "README.md",
    "docs/START.md",
    "docs/DEMO.md",
    "docs/RUNBOOK.md",
    "docs/ARCHITECTURE.md",
  ];
  // Sentence-level, not a character window: the claim is made in prose that
  // wraps across lines, and a fixed-width regex misses it as soon as the
  // wording moves. Any sentence that mentions the wardrobe or skins *and*
  // promises "без входа" is the promise this test exists to keep out.
  for (const rel of places) {
    const text = read(rel).replace(/\s+/g, " ");
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (!/без входа/i.test(sentence)) continue;
      assert.doesNotMatch(
        sentence,
        /гардероб|скин/i,
        `${rel} still promises a wardrobe or skins without signing in: ${sentence.trim()}`,
      );
    }
  }
});

test("the wardrobe is local-first and needs no server or provider API", () => {
  const nav = read("src/components/line/SideNav.tsx");
  // The entry is not gated by a feature flag: whether the section can be reached
  // at all is decided by the sign-in page, which covers the whole window until
  // the player has an account. What must not happen is a second, per-feature
  // gate on the nav item.
  assert.doesNotMatch(nav, /disabled:\s*!wardrobeAvailable/);
  assert.doesNotMatch(nav, /wardrobeAvailable/);

  const shell = read("src/components/line/LineLauncher.tsx");
  // No guard may bounce the player out of the section or swallow the click.
  assert.doesNotMatch(shell, /section === "wardrobe" && !wardrobeAvailable/);
  assert.doesNotMatch(
    shell,
    /section === "wardrobe" && selected && session &&/,
    "the screen must render with no selected server, and without its own session guard",
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
  assert.match(shell, /const signedOut =/);
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

/**
 * Being signed out must lock the shell, whatever screen the launcher is on.
 *
 * The gate used to be raised by `screen === "account"` alone. Every path that
 * named another screen while signed out therefore left the shell live: the
 * cached startup did it (fixed in the previous change), and a failed config
 * fetch still did — `loadConfig` correctly falls back to "config" so the player
 * can retry, but the rail, the wardrobe and the account entry stayed clickable
 * next to it. The account entry answered "You are not signed in." and offered
 * nothing to do about it.
 *
 * The rule is now the session, not the screen. The exemptions are an unconfigured release and a dev template before its first
 * provider is connected: neither has anything to authenticate against.
 */
test("a signed-out launcher locks the shell on every screen", () => {
  const shell = read("src/components/line/LineLauncher.tsx");

  assert.match(
    shell,
    /const signedOut =\s*introDone &&\s*!session &&\s*mode !== "unconfigured" &&\s*!\(mode === "dev-url" && !snapshot\)/,
    "the lock must be derived from the session",
  );
  // The page is raised by the session, not by the screen name; see the test
  // below for the door that the screen-shaped rule left open.
  assert.match(
    shell,
    /const signedOut =\s*introDone &&\s*!session &&\s*mode !== "unconfigured" &&\s*!\(mode === "dev-url" && !snapshot\)/,
    "the sign-in page is raised by the absence of a session",
  );
  // The page itself: shown whenever the player is signed out, with the shell
  // behind it hidden. It must not wait for a snapshot — a failed fetch is
  // exactly when a player needs the sign-in page most.
  const page = shell.slice(
    shell.indexOf('<AnimatePresence mode="wait" initial={false}>'),
    shell.indexOf("<AnimatePresence>"),
  );
  assert.match(page, /{signedOut \? \(/, "the page is keyed to the session");
  assert.match(page, /<SignInScreen/, "the page is the sign-in screen");
  assert.doesNotMatch(
    page,
    /signedOut && snapshot/,
    "the page must not require a config snapshot",
  );
  // Every shell visibility decision follows the lock, not the screen.
  for (const prop of ["aria-hidden", "inert"]) {
    assert.match(
      shell,
      // Formatted JSX may wrap between `{prop}=` and the expression.
      new RegExp(`${prop}=\\s*{shellLocked \\? true : undefined}`),
      `the shell's ${prop} must follow the lock`,
    );
  }
  assert.match(shell, /shellLocked && "pointer-events-none opacity-0"/);
  assert.match(
    shell,
    /const shellLocked = signedOut \|\| !introDone/,
    "the shell stays hidden during the greeting too",
  );
  // Nothing may re-introduce a screen-shaped gate.
  assert.doesNotMatch(
    shell,
    /gateSignIn \|\| !introDone/,
    "the shell must not be shown or hidden by the screen name",
  );
});

test("a build with no provider keeps its own screen instead of a sign-in box", () => {
  const shell = read("src/components/line/LineLauncher.tsx");
  // Unconfigured is the one state with no provider to sign in to; gating it
  // would show a password field that can never succeed.
  assert.match(
    shell,
    /const signedOut =\s*introDone &&\s*!session &&\s*mode !== "unconfigured" &&\s*!\(mode === "dev-url" && !snapshot\)/,
  );
  assert.match(shell, /mode === "unconfigured" \? \(/);
});

/**
 * The cached-config branch of startup must not name a screen before it knows
 * whether there is a session.
 *
 * The session lives in Rust memory and is always empty on a fresh process, so
 * the cache can only tell us what the provider is — never who the player is.
 * Naming "servers" there opened an unlocked catalogue on every launch after the
 * first, and when the follow-up fetch failed nothing corrected it: the launcher
 * sat signed out but interactive, and the only way out was "Переподключиться",
 * because the account page needs a session to draw its logout button.
 */
test("a cached startup asks for the session before naming a screen", () => {
  const shell = read("src/components/line/LineLauncher.tsx");

  // The effect that reads the cache, up to the end of its run.
  const start = shell.indexOf(".cachedConfig()");
  assert.ok(start > -1, "the cached-config effect exists");
  const branch = shell.slice(start, shell.indexOf("}, [loadConfig])", start));
  assert.ok(branch.length > 0, "the cached-config branch was found");

  const sessionAt = branch.indexOf("await lineApi.session()");
  assert.ok(
    sessionAt > -1,
    "the cache branch must ask the backend for the session",
  );

  // Every screen named in this branch has to come after that question.
  const named: number[] = [];
  // Any `setScreen(...)` counts, including the ternary that derives the answer.
  const re = /setScreen\(/g;
  for (let m = re.exec(branch); m; m = re.exec(branch)) named.push(m.index);
  assert.ok(named.length > 0, "the branch names a screen");
  for (const at of named) {
    assert.ok(
      at > sessionAt,
      "a screen is named before the session is known — that is the bug",
    );
  }

  // The specific shape of the fix: the screen follows the answer.
  assert.match(
    branch,
    /setScreen\(current \? "servers" : "account"\)/,
    "the screen is derived from the session answer",
  );
  // And the catalogue is never named unconditionally.
  assert.doesNotMatch(
    branch,
    /setSnapshot\(cached\);\s*setScreen\("servers"\)/,
    "a cached config alone must not open the catalogue",
  );
});

test("a failed config fetch lands on a screen that can retry", () => {
  const shell = read("src/components/line/LineLauncher.tsx");
  const start = shell.indexOf("const loadConfig = useCallback(");
  assert.ok(start > -1);
  const body = shell.slice(start, shell.indexOf("}, []);", start));

  const catchAt = body.indexOf("} catch (cause) {");
  assert.ok(catchAt > -1, "loadConfig has a catch branch");
  const catchBody = body.slice(catchAt, body.indexOf("} finally {"));

  // Without this the screen stays whatever the caller set before the fetch,
  // which on a cached startup was the unlocked catalogue.
  assert.match(
    catchBody,
    /setScreen\("config"\)/,
    "a failed fetch must fall back to the connecting screen",
  );
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

test("profile logout requires an explicit confirmation", () => {
  const profile = read("src/components/line/ProfileScreen.tsx");
  assert.match(profile, /setLogoutOpen\(true\)/);
  assert.match(profile, /AlertDialogPrimitive\.Root/);
  assert.match(profile, /open=\{logoutOpen\}/);
  assert.match(profile, /profile\.logoutConfirmTitle/);
  assert.match(profile, /common\.cancel/);
  assert.match(profile, /onLogout\(\)/);
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

test("account and wardrobe pages use their canvas width without blank card stretch", () => {
  const profile = read("src/components/line/ProfileScreen.tsx");
  const wardrobe = read("src/components/line/WardrobeScreen.tsx");
  assert.match(
    profile,
    /grid items-start gap-4 sm:grid-cols-\[minmax\(0,1fr\)_320px\]/,
  );
  assert.match(wardrobe, /mx-auto flex w-full max-w-3xl flex-col gap-4/);
  assert.match(
    wardrobe,
    /sm:grid-cols-\[minmax\(0,0\.9fr\)_minmax\(0,1\.1fr\)\]/,
  );
});

test("profile viewer is user-driven and server stats remain an honest empty shell", () => {
  const profile = read("src/components/line/ProfileScreen.tsx");
  const viewer = read("src/components/line/SkinViewer3D.tsx");
  assert.match(profile, /viewerPose.*"walk"/);
  assert.match(profile, /\["walk", "wave", "manual"\]/);
  assert.match(profile, /profile\.viewer\.\$\{pose\}/);
  assert.match(viewer, /viewer\.autoRotate = false/);
  assert.match(profile, /profile\.statistics\.empty/);
  assert.match(profile, /\["blocks", "mobs", "players", "deaths"\]/);
  assert.match(profile, /\["minecraft", "mods"\]/);
  assert.match(profile, /profile\.advancements\.\$\{group\}/);
  assert.doesNotMatch(
    profile,
    /profileData|fetchServerProfile|serverProfile\(/,
  );
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

test("the close button is neutral at rest and reveals red on hover or focus", () => {
  const bar = read("src/components/line/TitleBar.tsx");
  const close = bar.slice(
    bar.lastIndexOf(
      "<Button",
      bar.indexOf("onClick={() => void closeWindow()}"),
    ),
  );
  const button = close.slice(0, close.indexOf("</Button>"));
  assert.doesNotMatch(button, /(?:^|\s)bg-destructive-strong(?:\s|$)/);
  assert.match(button, /text-muted-foreground/);
  assert.match(button, /hover:!bg-destructive-strong/);
  assert.match(button, /hover:text-destructive-foreground/);
  assert.match(button, /focus-visible:!bg-destructive-strong/);
  assert.match(button, /focus-visible:text-destructive-foreground/);

  const css = read("src/index.css");
  assert.match(css, /--destructive-strong:\s*oklch\(0\.58 0\.24 27\)/);
  assert.match(css, /--destructive-foreground:\s*#fff/);
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
  const grains = [...source.matchAll(/^\s*grain: ([\d.]+),/gm)].map((m) =>
    Number(m[1]),
  );
  const animationCenters = [
    ...source.matchAll(/^\s*center: \[([\d.]+), ([\d.]+)\],/gm),
  ].map((match) => [Number(match[1]), Number(match[2])]);
  const motions = [...source.matchAll(/^\s*motion: "(\w+)",/gm)].map(
    (m) => m[1],
  );
  assert.equal(shades.length, 12);
  assert.equal(speeds.length, 12);
  assert.equal(grains.length, 12);
  assert.equal(animationCenters.length, 12);
  assert.equal(motions.length, 12);
  assert.equal(grains.filter((grain) => grain === 0.52).length, 11);
  assert.equal(grains.filter((grain) => grain === 0.443).length, 1);
  assert.ok(
    animationCenters.every(([x]) => x >= 0.16 && x <= 0.24),
    "the animated fields should cluster around the sidebar-to-content seam",
  );

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

test("auto RAM persists in place and has a no-reload regression guard", () => {
  const settings = read("src/components/line/SettingsScreen.tsx");
  const switchBlock = settings.slice(
    settings.indexOf('id="heap-auto"'),
    settings.indexOf("</Switch>", settings.indexOf('id="heap-auto"')),
  );
  assert.match(switchBlock, /onCheckedChange=/);
  assert.doesNotMatch(settings, /<form\b/);

  const commit = settings.slice(
    settings.indexOf("async function commitHeap("),
    settings.indexOf(
      "async function clearCache(",
      settings.indexOf("async function commitHeap("),
    ),
  );
  assert.match(
    commit,
    /await persist\(\{ \.\.\.settings, heapMb: automatic \? null : value \}\)/,
  );
  assert.doesNotMatch(commit, /location\.reload|window\.location/);

  const smoke = read("scripts/ui-smoke.mjs");
  assert.match(smoke, /performance\.timeOrigin/);
  assert.match(smoke, /turning automatic heap off reloaded the page/);
  assert.match(smoke, /turning automatic heap on reloaded the page/);
});

test("the title-bar brand mark stays pinned in the compact rail corner", () => {
  const titleBar = read("src/components/line/TitleBar.tsx");
  assert.match(titleBar, /"justify-between gap-3 pr-1 select-none"/);
  assert.match(
    titleBar,
    /className="flex w-12 shrink-0 items-center justify-center"/,
  );
  assert.match(titleBar, /<BrandMark className="h-5 w-5 shrink-0" \/>/);
  assert.doesNotMatch(titleBar, /brand\.name|railWidth|collapsed/);
});

test("server catalog search and install filters drive both catalogue views", () => {
  const list = read("src/components/line/ServerList.tsx");
  assert.match(list, /type="search"/);
  assert.match(list, /aria-label=\{t\("catalog\.search"\)\}/);
  assert.match(list, /filterServerCatalog\(servers/);
  assert.match(list, /servers=\{visibleServers\}/);
  assert.match(list, /catalogFilter === filter/);
  assert.match(list, /hasCatalogFilter/);
  assert.match(list, /catalog\.resultCount/);
});

test("catalogue buttons and filters use the shared navbar corner radius", () => {
  const list = read("src/components/line/ServerList.tsx");
  assert.doesNotMatch(list, /data-catalog-header-actions/);
  assert.match(list, /rounded-lg border p-0\.5/);
  assert.match(list, /rounded-lg px-2 text-\[11px\] font-medium/);
  assert.match(list, /h-9 rounded-lg pl-9/);
  assert.doesNotMatch(
    list,
    /rounded-\[calc\(var\(--radius-control\)-2px\)\]|rounded-\[6px\]/,
  );
});

test("shared buttons, tabs and switches use the navbar corner radius", () => {
  const button = read("src/components/ui/button.tsx");
  const tabs = read("src/components/ui/tabs.tsx");
  const select = read("src/components/ui/select.tsx");
  const toggle = read("src/components/ui/switch.tsx");
  assert.match(button, /rounded-lg border border-transparent/);
  assert.doesNotMatch(button, /rounded-\[min\(var\(--radius-md\)/);
  assert.match(tabs, /gap-1\.5 rounded-lg border/);
  assert.match(select, /data-\[size=sm\]:rounded-lg/);
  assert.match(toggle, /items-center rounded-lg border/);
});

test("server details use a roomier responsive frame and handle motion and failed art", () => {
  const detail = read("src/components/line/ServerDetail.tsx");
  assert.match(detail, /max-w-3xl/);
  assert.match(detail, /useReducedMotion\(\)/);
  assert.match(detail, /reducedMotion \? false/);
  assert.match(detail, /onError=\{\(\) => setBannerFailed\(true\)\}/);
  assert.match(detail, /onError=\{\(\) => setIconFailed\(true\)\}/);
});

test("the active sidebar destination uses white ink without a tile fill", () => {
  const nav = read("src/components/line/SideNav.tsx");
  assert.match(nav, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(nav, /active\s*\?\s*"text-foreground hover:bg-transparent"/);
  assert.match(
    nav,
    /section === "settings"[\s\S]{0,90}\? "text-foreground hover:bg-transparent"/,
  );
  assert.doesNotMatch(nav, /bg-primary\/10 text-primary/);
});

test("grid server cards stand off the solid main panel", () => {
  const card = read("src/components/line/ServerCard.tsx");
  assert.match(card, /border-border\/50 bg-fill/);
  assert.match(card, /hover:bg-fill-strong\/85/);
  assert.doesNotMatch(card, /hover:border-transparent/);
});

test("collapsed sidebar buttons are direct centered flex items", () => {
  const nav = read("src/components/line/SideNav.tsx");
  assert.match(nav, /<Button\s+key=\{item\.id\}/);
  assert.match(nav, /if \(!item\.hint\) return button;/);
  assert.doesNotMatch(nav, /<div key=\{item\.id\}>\{button\}<\/div>/);

  const smoke = read("scripts/ui-smoke.mjs");
  assert.match(smoke, /buttons\.every\(\(button\) =>/);
  assert.match(smoke, /buttonRect\.left \+\s*buttonRect\.width \/ 2/);
});

test("the animated backdrop keeps its saturation lift across theme changes", () => {
  const launcher = read("src/components/line/LineLauncher.tsx");
  const css = read("src/index.css");
  const backdrop = read("src/components/line/AnimatedBackdrop.tsx");
  assert.match(launcher, /className="line-backdrop-saturation"/);
  assert.match(
    css,
    /\[data-line-backdrop\]\.line-backdrop-saturation\s*\{\s*filter: saturate\(1\.4\);/,
  );
  assert.match(backdrop, /exit=\{index < layers\.length - 1\}/);
  assert.match(backdrop, /opacity: exit \? 0 : shown \? 1 : 0/);
  assert.match(
    backdrop,
    /transitionDuration: reduced \? "0ms" : `\$\{CROSSFADE_MS\}ms`/,
  );
  const smoke = read("scripts/ui-smoke.mjs");
  assert.match(smoke, /backdropFilterBefore/);
  assert.match(smoke, /backdropFilterAfter/);
});

test("the sidebar is compact and uses Lucide icons with usable targets", () => {
  const nav = read("src/components/line/SideNav.tsx");
  assert.match(nav, /animate=\{\{ width: collapsed \? 48 : 184 \}\}/);
  assert.match(nav, /<Icon className="h-5 w-5 shrink-0"/);
  assert.match(nav, /<Settings className="h-5 w-5 shrink-0"/);
  assert.match(nav, /<Info className="h-5 w-5 shrink-0"/);
  assert.match(nav, /<ChevronLeft[\s\S]{0,150}h-5 w-5/);
  assert.match(nav, /collapsed\s*\?\s*"mx-auto h-9 w-9 justify-center px-0"/);
  assert.match(nav, /"h-10 w-full justify-start px-2\.5"/);
  const icons = read("src/components/ui/icons.tsx");
  assert.match(icons, /Shirt,[\s\S]*?from "lucide-react"/);
});
