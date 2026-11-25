// Regenerate the interface screenshots used by README.md.
//
//   npm run dev            # in another terminal
//   npm run screenshots
//
// The images are real renders of the real components, driven by a test-only
// Tauri IPC stub and the demo provider from examples/config.json. Artwork is
// authored in scripts/lib/demo-art.mjs (abstract vector design, no external
// image hosts) so the documentation matches the reference provider.
//
// Captures are staged and published only when the whole gallery succeeds.
// The transient connecting screen is not part of the gallery.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { browserHelp, findBrowser } from "./lib/find-browser.mjs";
import { demoBannerDataUrl, demoIconDataUrl } from "./lib/demo-art.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs/images");
const evidenceManifestPath = path.join(root, "docs/visual-evidence.json");
const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
// Kept in sync with scripts/render-screens.mjs: both writers must agree, or a
// regeneration with the other tool silently reintroduces mixed sizes.
const SHOT_WIDTH = 1920;
const SHOT_HEIGHT = 1080;
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5173";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core не установлен. Выполните: npm ci");
  process.exit(2);
}

const config = JSON.parse(
  readFileSync(path.join(root, "examples/config.json"), "utf8"),
);
config.provider.name = "Plus In Plus Demo";
config.provider.telemetry_url = "https://demo.plusinplus.ru/line/telemetry";
config.provider.privacy_url = "https://demo.plusinplus.ru/privacy";

// Use the same authored vector artwork as the reference provider. Keeping one
// source of truth prevents the README screenshots from drifting into a separate
// visual language or falling back to generic gradient placeholders.
const artThemes = ["survival", "skyblock", "creative"];

// The demo config ships without launch endpoints. Enable them so the screenshots
// show the real play state rather than "Запуск не настроен".
config.servers[0].auth = {
  launch_ticket_url: "https://auth.example.com/v1/launcher/ticket",
  session_exchange_url: "https://auth.example.com/v1/launcher/exchange",
};

// Exercise the real Minecraft panel as well as the provider-game dock.
config.servers[1] = {
  ...config.servers[1],
  launch_mode: "minecraft",
  server_address: "play.example.org",
  minecraft_version: "1.21.1",
};

config.servers = config.servers.map((server, index) => {
  const theme = artThemes[index % artThemes.length];
  return {
    ...server,
    banner_url: demoBannerDataUrl(theme),
    icon_url: demoIconDataUrl(theme),
    status_url: "https://demo.plusinplus.ru/line/status",
  };
});

/** A valid 64x64 skin texture, so the wardrobe previews render real silhouettes. */
function skinPng(tint) {
  const size = 64;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 4;
      // Head/torso/limb blocks get slightly different shading.
      const shade = y < 16 ? 1 : y < 32 ? 0.82 : 0.66;
      raw[at] = Math.round(tint[0] * shade);
      raw[at + 1] = Math.round(tint[1] * shade);
      raw[at + 2] = Math.round(tint[2] * shade);
      raw[at + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k += 1) {
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, body, out]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const skins = [
  { name: "Зимний", tint: [120, 170, 225], model: "classic" },
  { name: "Рабочий", tint: [200, 140, 90], model: "slim" },
  { name: "Праздничный", tint: [180, 120, 210], model: "classic" },
].map((skin, index) => {
  const bytes = skinPng(skin.tint);
  return {
    entry: {
      id: String(index + 1).padStart(64, "0"),
      name: skin.name,
      model: skin.model,
      width: 64,
      height: 64,
      sizeBytes: bytes.length,
      addedAt: Date.now() - index * 86_400_000,
    },
    bytes: [...bytes],
  };
});

const baked = readFileSync(
  path.join(root, "src/brand/provider.generated.ts"),
  "utf8",
);
const configured = /configUrl:\s*"https:/.test(baked);

mkdirSync(outDir, { recursive: true });
try {
  await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(
    `Dev-сервер недоступен по адресу ${baseUrl}.\nЗапустите: npm run dev`,
  );
  process.exit(2);
}

const launchOptions = { headless: true };
const found = findBrowser();
if (found) launchOptions.executablePath = found.path;

let browser;
try {
  browser = await chromium.launch(launchOptions);
} catch (error) {
  console.error(`${error.message}\n\n${browserHelp()}`);
  process.exit(2);
}

/**
 * Screenshot-only shim. Chromium renders WebGL on Swiftshader in CI, and
 * hazeglow refuses software renderers by design, so without this the gallery
 * would document a state no real player sees. Reversing the check here is the
 * same trick a GPU-backed machine performs — it changes the renderer's name,
 * not the app.
 */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|lavapipe|basic render|software/i;

const staging = mkdtempSync(path.join(outDir, ".capture-"));
const captured = [];
const guidebookFramesRoot = path.join(staging, "guidebook-frames");
mkdirSync(guidebookFramesRoot, { recursive: true });
const guidebookManifest = {};
let guideCursor = { x: 2, y: SHOT_HEIGHT - 2, visible: false, pressed: false };
let guideCursorMounted = false;
const page = await browser.newPage({
  // One size for every image, matching scripts/render-screens.mjs. The README
  // gallery looked broken when it mixed 480, 860, 1000 and 1060 tall pictures.
  viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
  reducedMotion: "reduce",
  deviceScaleFactor: 1,
  // The gallery documents the primary language; see the note in ui-smoke.
  locale: "ru-RU",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const installed = {
  serverId: config.servers[0].id,
  sha256: config.servers[0].distribution.sha256,
  version: config.servers[0].version,
  installedAt: Date.now() - 3_600_000,
  alreadyInstalled: true,
};

await page.addInitScript(
  ({ config, skins, installed, configured, software }) => {
    // Present the software rasteriser as a normal GPU. Scope: screenshots only.
    //
    // Both spellings of the question have to be answered: `RENDERER` returns a
    // generic "WebKit WebGL", while `UNMASKED_RENDERER_WEBGL` returns the
    // actual "SwiftShader" — and hazeglow decides on the unmasked one. Patching
    // only RENDERER left every gallery image with the CSS colour field and no
    // shader, which is not what a player with a GPU sees.
    const describe = WebGL2RenderingContext.prototype.getParameter;
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    WebGL2RenderingContext.prototype.getParameter = function (parameter) {
      const value = describe.call(this, parameter);
      const asked =
        parameter === this.RENDERER ||
        parameter === UNMASKED_RENDERER_WEBGL ||
        parameter === this.UNMASKED_RENDERER_WEBGL;
      if (
        asked &&
        typeof value === "string" &&
        new RegExp(software, "i").test(value)
      ) {
        return "Line Screenshot Renderer";
      }
      return value;
    };
    window.isTauri = true;
    window.__callbacks = new Map();
    window.__cid = 1;
    // Keep the short welcome screen stable long enough for cold, software
    // rendering, then the script advances it explicitly. This affects only the
    // screenshot fixture.
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (handler, delay, ...args) =>
      nativeSetTimeout(handler, delay === 1900 ? 120_000 : delay, ...args);
    window.__events = new Map();
    window.__guideCheckBuildCalls = 0;
    window.__session = null;
    window.__installed = installed;
    window.__library = {
      skins: skins.map((s) => s.entry),
      active: skins[0].entry.id,
      // Already accepted by the provider: the status shows the settled state.
      synced: skins[0].entry.id,
    };
    const bytes = Object.fromEntries(skins.map((s) => [s.entry.id, s.bytes]));
    // Same convention the wardrobe thumbnails use: a texture becomes a blob URL.
    // The 3D viewer cannot fetch a texture it cannot decode, and the fake backend
    // below hands out raw bytes, not URLs.
    window.__textureUrl = (id) =>
      `data:image/png;base64,${btoa(String.fromCharCode(...bytes[id]))}`;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event, id) => window.__events.delete(id),
    };
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        windows: [{ label: "main" }],
      },
      transformCallback: (cb) => {
        const id = window.__cid++;
        window.__callbacks.set(id, cb);
        return id;
      },
      invoke: async (cmd, args) => {
        if (cmd === "plugin:event|listen") {
          const id = window.__cid++;
          window.__events.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        if (cmd === "plugin:event|unlisten") return null;
        if (cmd === "get_cached_config")
          return configured
            ? null
            : {
                config,
                sourceUrl: "https://demo.plusinplus.ru/line/config.json",
                fetchedAt: Date.now(),
                fromCache: true,
                stale: false,
              };
        if (cmd === "fetch_line_config") {
          return {
            config,
            sourceUrl: args.url,
            fetchedAt: Date.now(),
            fromCache: false,
            stale: false,
          };
        }
        if (cmd === "get_settings")
          return {
            settings: {
              heapMb: 4096,
              javaPath: null,
              // The sidebar is a 48px icon rail; the gallery documents the
              // default the first run actually opens with.
              sidebarCollapsed: true,
              afterLaunch: "minimize",
              onboardingCompleted: false,
              telemetryConsent: false,
              // Capture the unified server directory and opaque panels. The
              // animated backdrop remains visible around panels in solid mode.
              backdrop: "copper",
              workspace: "solid",
              windowWidth: 1280,
              windowHeight: 860,
              windowMaximized: false,
            },
            heapCeilingMb: 12288,
            suggestedHeapMb: 8192,
            totalMemoryMb: 16384,
          };
        if (cmd === "save_settings")
          return {
            settings: args.settings,
            heapCeilingMb: 12288,
            suggestedHeapMb: 8192,
            totalMemoryMb: 16384,
          };
        if (cmd === "list_java_runtimes")
          return [
            {
              path: "/usr/lib/jvm/java-21-openjdk/bin/java",
              major: 21,
              version: "21.0.5",
            },
            {
              path: "/usr/lib/jvm/java-17-openjdk/bin/java",
              major: 17,
              version: "17.0.13",
            },
          ];
        if (cmd === "list_skin_library")
          return { library: window.__library, limit: 64 };
        if (cmd === "read_skin_texture") {
          // `bytes` is serialised into this script as plain arrays on purpose:
          // the real command returns `number[]` (see `read_skin_texture` in
          // Rust), and the profile screen turns it into a Blob. Turning it into
          // anything richer here would stop testing the path the app uses.
          const raw = bytes[args.id];
          return Array.isArray(raw) ? raw : [];
        }
        // Mirrors Rust: the account wears the texture it last accepted.
        const remoteSkin = () => {
          const id = window.__library.synced;
          if (!window.__session || !id) return null;
          const entry = window.__library.skins.find((s) => s.id === id);
          if (!entry) return null;
          return {
            model: entry.model,
            textureUrl: `data:image/png;base64,${btoa(
              String.fromCharCode(...bytes[id]),
            )}`,
          };
        };
        if (cmd === "get_skin") return remoteSkin();
        if (cmd === "set_active_skin") {
          window.__library.active = args.id ?? null;
          return { library: window.__library, limit: 64 };
        }
        if (cmd === "sync_active_skin") {
          if (window.__library.active === window.__library.synced)
            return { status: "unchanged", skin: null };
          window.__library.synced = window.__library.active;
          return { status: "synced", skin: remoteSkin() };
        }
        if (cmd === "forget_synced_skin") {
          window.__library.synced = null;
          return { library: window.__library, limit: 64 };
        }
        if (cmd === "line_session") return window.__session;
        if (cmd === "get_installed_build")
          return args.serverId === installed.serverId
            ? window.__installed
            : null;
        if (cmd === "ensure_fresh_config") return null;
        if (cmd === "check_build") {
          window.__guideCheckBuildCalls += 1;
          return { checked: 42, missing: [], changed: [], foreign: [] };
        }
        if (cmd === "check_resource_packs")
          return { findings: [], foreign: [], unproved: [] };
        if (cmd === "mc_status")
          return {
            instanceId: args.instanceId,
            phase: "idle",
            versionId: "1.21.1",
            startedAt: null,
            exitCode: null,
            message: null,
          };
        if (cmd === "get_server_status")
          return {
            online: true,
            playersOnline: 24,
            playersMax: 120,
            latencyMs: 34,
          };
        if (cmd === "get_game_status")
          return { serverId: args.serverId, revision: 1, phase: "idle" };
        if (cmd === "list_release_history")
          return {
            serverId: args.serverId,
            releases: window.__installed ? [window.__installed, installed] : [],
          };
        if (cmd === "line_login" || cmd === "line_register") {
          window.__session = {
            username: args.request?.username ?? "Player_1",
            expiresAt: Date.now() + 86_400_000,
          };
          return window.__session;
        }
        return null;
      },
    };
  },
  { config, skins, installed, configured, software: SOFTWARE_RENDERER.source },
);

async function shot(name) {
  // Every screenshot is the same viewport, so the gallery has one aspect ratio.
  // Content taller than 800px is what the app itself scrolls; capturing the
  // full scroll height is what produced the uneven images this replaced.
  await page.setViewportSize({ width: SHOT_WIDTH, height: SHOT_HEIGHT });
  // Obsy's animated background never settles; freeze it for a stable image.
  await page.mouse.move(SHOT_WIDTH - 10, SHOT_HEIGHT - 10);
  await page.waitForTimeout(350);
  const file = path.join(staging, `line-${name}.png`);
  await page.screenshot({
    path: file,
    animations: "disabled",
    timeout: 120_000,
  });
  const size = await page.evaluate(() => [
    window.innerWidth,
    window.innerHeight,
  ]);
  if (size[0] !== SHOT_WIDTH || size[1] !== SHOT_HEIGHT) {
    throw new Error(
      `viewport drifted to ${size.join("x")} while capturing ${name}`,
    );
  }
  captured.push(`line-${name}.png`);
  console.log(`staged line-${name}.png`);
}

async function mountGuideCursor() {
  if (guideCursorMounted) return;
  await page.evaluate(() => {
    const pointer = document.createElement("div");
    pointer.setAttribute("aria-hidden", "true");
    pointer.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "z-index:2147483647",
      "width:24px",
      "height:32px",
      "pointer-events:none",
      "opacity:0",
      "transform:translate3d(-40px,-40px,0)",
      "transform-origin:1px 1px",
      "will-change:transform,opacity",
    ].join(";");
    pointer.innerHTML = `<svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"><path d="M2 1v24l6.3-6.1 4.2 10 4.1-1.8-4.2-9.8H21L2 1Z" fill="#fffdf6" stroke="#171a20" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
    document.documentElement.append(pointer);
    window.__lineGuideCursor = (x, y, visible, pressed) => {
      pointer.style.opacity = visible ? "1" : "0";
      pointer.style.transform = `translate3d(${x}px,${y}px,0) scale(${pressed ? 0.92 : 1})`;
    };
  });
  guideCursorMounted = true;
}

async function setGuideCursor(x, y, visible = true, pressed = false) {
  await page.evaluate(
    ({ x, y, visible, pressed }) =>
      window.__lineGuideCursor?.(x, y, visible, pressed),
    { x, y, visible, pressed },
  );
  guideCursor = { x, y, visible, pressed };
}

async function recordGuidebookChapter(name, scenario) {
  const framesDir = path.join(guidebookFramesRoot, name);
  mkdirSync(framesDir, { recursive: true });
  const frames = [];
  let frameIndex = 0;

  async function capture(durationMs = 50, animations = "disabled") {
    const file = path.join(
      framesDir,
      `${String(frameIndex++).padStart(4, "0")}.png`,
    );
    await page.screenshot({ path: file, animations, timeout: 120_000 });
    frames.push({ file, durationMs });
  }

  async function hold(durationMs = 650) {
    await capture(durationMs);
  }

  async function moveToPoint(x, y, durationMs = 700) {
    const from = guideCursor;
    const steps = Math.max(5, Math.ceil(durationMs / 140));
    const frameDuration = durationMs / steps;
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const eased = t * t * (3 - 2 * t);
      const nextX = from.x + (x - from.x) * eased;
      const nextY = from.y + (y - from.y) * eased;
      await page.mouse.move(nextX, nextY);
      await setGuideCursor(nextX, nextY, true, false);
      await capture(frameDuration);
    }
  }

  function pointIn(bounds, position = { x: 0.5, y: 0.5 }) {
    return {
      x: bounds.x + bounds.width * position.x,
      y: bounds.y + bounds.height * position.y,
    };
  }

  async function glide(locator, durationMs = 720, position) {
    const bounds = await locator.boundingBox();
    if (!bounds)
      throw new Error(`Cannot find guidebook interaction target: ${locator}`);
    const point = pointIn(bounds, position);
    await moveToPoint(point.x, point.y, durationMs);
  }

  async function click(locator, options = {}) {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error(`Cannot click guidebook target: ${locator}`);
    const { x, y } = pointIn(bounds, options.position);
    await page.mouse.move(x, y);
    await setGuideCursor(x, y, true, false);
    await page.mouse.down();
    await setGuideCursor(x, y, true, true);
    await capture(60);
    if (options.captureTransition) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    await page.mouse.up();
    await setGuideCursor(x, y, true, false);
    if (options.waitFor) await options.waitFor();
    if (options.settleMs) await page.waitForTimeout(options.settleMs);
    if (options.captureTransition) {
      // Capture CSS motion instead of forcing it to its end state. This is used
      // for the disclosure chevron so its rotation is visible in the GIF.
      for (let index = 0; index < 8; index += 1) {
        await page.waitForTimeout(25);
        await capture(25, "allow");
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
    }
    await hold(options.holdMs ?? 600);
  }

  async function typeText(text) {
    for (const character of text) {
      await page.keyboard.type(character);
      await capture(90);
    }
  }

  async function press(key) {
    await page.keyboard.press(key);
    await hold(250);
  }

  async function scrollBy(deltaY, { steps = 8, x = 900, y = 690 } = {}) {
    if (guideCursor.x !== x || guideCursor.y !== y) {
      await moveToPoint(x, y, 420);
    }
    const increment = deltaY / steps;
    for (let index = 0; index < steps; index += 1) {
      await page.mouse.wheel(0, increment);
      await capture(55);
    }
  }

  try {
    // The scripted pointer supplies the only motion in these captures. Keeping
    // the app's ambient background reduced prevents shimmer and cuts file size.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mountGuideCursor();
    await page.mouse.move(guideCursor.x, guideCursor.y);
    await setGuideCursor(guideCursor.x, guideCursor.y, false, false);
    await hold(650);
    await scenario({
      hold,
      glide,
      click,
      typeText,
      press,
      moveToPoint,
      scrollBy,
    });
    await moveToPoint(2, SHOT_HEIGHT - 2, 620);
    await setGuideCursor(2, SHOT_HEIGHT - 2, false, false);
    await hold(80);
    // Every chapter restores the state it began in. Reuse the real starting
    // frame for the final held frame so the infinite GIF has no visual seam.
    if (frames.length > 1) {
      copyFileSync(frames[0].file, frames[frames.length - 1].file);
    }
    guidebookManifest[name] = frames;
    console.log(`recorded ${name} (${frames.length} real-browser frames)`);
  } finally {
    await setGuideCursor(2, SHOT_HEIGHT - 2, false, false).catch(
      () => undefined,
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
  }
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  // First frame of a launch: the word is still being drawn. It only exists for
  // about 1.6s, so this is the one shot that cannot wait for its own target.
  await page.locator("[data-line-welcome]").waitFor({ timeout: 10_000 });
  // Wait for the word itself, not a fixed delay: the letters rise into place
  // and a screenshot taken too early catches an empty screen.
  await page
    .locator("[data-line-welcome] [aria-label='Welcome']")
    .waitFor({ timeout: 5_000 });
  // With reduced motion the word is fully visible immediately; an extra fixed
  // pause can outlive the deliberately short prologue on a cold browser.
  await shot("welcome");
  // Welcome is intentionally brief and may finish while a slow headless browser
  // encodes the first capture. Click through when the button is still present;
  // otherwise let the already-running welcome exit finish naturally.
  const welcomeContinue = page.getByRole("button", {
    name: "Продолжить",
    exact: true,
  });
  if (await welcomeContinue.isVisible().catch(() => false)) {
    await welcomeContinue.click({ timeout: 1200 }).catch(() => undefined);
  }
  await page.locator("[data-line-welcome]").waitFor({
    state: "detached",
    timeout: 10_000,
  });

  // The first-run wizard is a real page in the app, before authentication.
  // Capture its language, backdrop and motion choices from the reset settings.
  await page.locator("[data-line-first-run-setup]").waitFor();
  await shot("setup");
  await page.getByRole("button", { name: "Сохранить и продолжить" }).click();
  await page.getByRole("heading", { level: 1 }).waitFor();

  // The single sign-in gate: one account for the whole project, on a page of
  // its own — the provider's name is the heading, the card holds the form.
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.getByRole("button", { name: "Войти", exact: true }).waitFor();
  await shot("account");

  await page.getByLabel("Логин", { exact: true }).fill("Player_1");
  await page.getByLabel("Пароль", { exact: true }).fill("demo-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("tab", { name: "Найти сервер", exact: true }).click();
  await page
    .getByRole("heading", { name: "Найти сервер", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Позже — закрыть справочник" })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /Открыть сервер Survival/ }).waitFor();

  // Return once from a server so the directory captures its real
  // continue-playing hero, not the empty first-run state before a server has
  // ever been selected. This is still the live component and app state.
  const openSurvival = page.getByRole("button", {
    name: /Открыть сервер Survival/,
  });
  const playAction = page.getByRole("button", { name: "Играть", exact: true });
  // This card animates its hover surface and triggers SPA navigation. Send a
  // real pointer click directly so Playwright does not wait for a document load.
  await openSurvival.scrollIntoViewIfNeeded();
  const survivalBounds = await openSurvival.boundingBox();
  if (!survivalBounds) throw new Error("Survival card is not visible");
  await page.mouse.click(
    survivalBounds.x + survivalBounds.width / 2,
    survivalBounds.y + survivalBounds.height / 2,
  );
  await playAction.waitFor();
  await page
    .getByRole("button", { name: "Все серверы" })
    .click({ force: true });
  await page
    .getByRole("region", { name: "Последний выбранный сервер" })
    .waitFor();
  await shot("servers");

  // Record real, reversible navigation between the section rail and catalog.
  await recordGuidebookChapter("navigation", async ({ hold, glide, click }) => {
    await glide(page.getByRole("button", { name: "Гардероб", exact: true }));
    await click(page.getByRole("button", { name: "Гардероб", exact: true }), {
      waitFor: () =>
        page.getByRole("heading", { name: "Гардероб", exact: true }).waitFor(),
    });
    await glide(page.getByRole("button", { name: "Серверы", exact: true }));
    await click(page.getByRole("button", { name: "Серверы", exact: true }), {
      waitFor: () =>
        page
          .getByRole("region", { name: "Последний выбранный сервер" })
          .waitFor(),
    });
    await hold(650);
  });

  // The directory tutorial types into the real search field, opens a matching
  // card, and uses the actual Back control before clearing the query.
  await recordGuidebookChapter(
    "servers",
    async ({ glide, click, typeText, press }) => {
      const search = page.getByRole("searchbox", {
        name: "Найти сервер",
        exact: true,
      });
      await glide(search);
      await click(search, { holdMs: 180 });
      await typeText("Survival");
      const survivalCard = page.getByRole("button", {
        name: /Открыть сервер Survival/,
      });
      await survivalCard.waitFor();
      await glide(survivalCard);
      await click(survivalCard, {
        waitFor: () =>
          page
            .getByRole("button", { name: "Все серверы", exact: true })
            .waitFor(),
      });
      const back = page.getByRole("button", {
        name: "Все серверы",
        exact: true,
      });
      await glide(back);
      await click(back, {
        waitFor: () => search.waitFor(),
      });
      await glide(search);
      await click(search, { holdMs: 120 });
      await press("Control+A");
      await press("Backspace");
      await page
        .getByRole("button", { name: /Открыть сервер Survival/ })
        .waitFor();
    },
  );

  // Every server is already unlocked: no second login, straight to the build.
  await page.getByRole("button", { name: /Открыть сервер Survival/ }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).waitFor();
  await shot("server");
  const serverActionMenu = page.locator(
    '[data-testid="server-action-menu"] summary',
  );
  await serverActionMenu.click();
  await shot("server-actions");
  await serverActionMenu.click();

  // Seed the reversible re-check with its verified state. Re-running the
  // idempotent check leaves this same real result on screen for a seamless loop.
  await serverActionMenu.click();
  await page
    .getByRole("menuitem", { name: "Проверить сборку", exact: true })
    .click();
  await page
    .getByTestId("build-integrity-result")
    .waitFor({ state: "visible" });
  await recordGuidebookChapter("server-actions", async ({ glide, click }) => {
    const checkBuild = page.getByRole("menuitem", {
      name: "Проверить сборку",
      exact: true,
    });
    const menuTriggerPosition = { x: 0.18, y: 0.78 };
    await glide(serverActionMenu, 720, menuTriggerPosition);
    await click(serverActionMenu, {
      position: menuTriggerPosition,
      waitFor: () => page.getByRole("menu").waitFor(),
      captureTransition: true,
    });
    await glide(checkBuild);
    await click(checkBuild, {
      waitFor: async () => {
        await page.waitForFunction(() => window.__guideCheckBuildCalls >= 2);
        await page
          .getByTestId("build-integrity-result")
          .waitFor({ state: "visible" });
      },
      holdMs: 850,
    });
  });

  await page.getByRole("button", { name: "Все серверы" }).click();
  await page.getByRole("button", { name: /Открыть сервер SkyBlock/ }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).waitFor();
  await shot("minecraft");
  await page.locator('[data-testid="server-action-menu"] summary').click();
  await shot("minecraft-actions");
  await page.locator('[data-testid="server-action-menu"] summary').click();

  await page.getByRole("button", { name: "Гардероб", exact: true }).click();
  await page.getByRole("heading", { name: "Локальная история" }).waitFor();
  await shot("wardrobe");

  const workingSkin = page.getByRole("button", {
    name: "Сделать активным: Рабочий",
    exact: true,
  });
  const winterSkin = page.getByRole("button", {
    name: "Сделать активным: Зимний",
    exact: true,
  });
  await recordGuidebookChapter("wardrobe", async ({ glide, click }) => {
    await glide(workingSkin);
    await click(workingSkin, {
      waitFor: () =>
        page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Сделать активным: Рабочий"]')
              ?.getAttribute("aria-pressed") === "true",
        ),
      holdMs: 800,
    });
    await glide(winterSkin);
    await click(winterSkin, {
      waitFor: () =>
        page.waitForFunction(
          () =>
            document
              .querySelector('[aria-label="Сделать активным: Рабочий"]')
              ?.getAttribute("aria-pressed") === "false",
        ),
      holdMs: 800,
    });
    // The success notice is transient component state. Switching sections and
    // returning is a real action that restores the clean initial screen for the
    // next loop without hiding or synthesizing the message.
    const settingsNav = page.getByRole("button", {
      name: "Настройки",
      exact: true,
    });
    const wardrobeNav = page.getByRole("button", {
      name: "Гардероб",
      exact: true,
    });
    await glide(settingsNav);
    await click(settingsNav, {
      waitFor: () =>
        page.getByRole("heading", { name: "Настройки", exact: true }).waitFor(),
    });
    await glide(wardrobeNav);
    await click(wardrobeNav, {
      waitFor: () =>
        page.getByRole("heading", { name: "Гардероб", exact: true }).waitFor(),
    });
    await page.getByRole("heading", { name: "Локальная история" }).waitFor();
  });

  // The account page and its 3D viewer. skinview3d loads lazily and draws a
  // frame or two after its dynamic import resolves, so the wait is on the
  // viewer's own state attribute, not a fixed timeout.
  await page.getByLabel("Аккаунт", { exact: true }).click();
  await page.getByRole("heading", { name: "Аккаунт", level: 2 }).waitFor();
  await page
    .locator('[data-line-skin-viewer]:not([data-line-skin-viewer="loading"])')
    .waitFor({ timeout: 20_000 });
  await shot("profile");

  const profileStatistics = page
    .locator("details")
    .filter({ hasText: "Статистика сервера" });
  const statisticsSummary = profileStatistics.locator("summary");
  await recordGuidebookChapter(
    "account",
    async ({ glide, click, scrollBy }) => {
      await scrollBy(520, { steps: 10, x: 950, y: 690 });
      await glide(statisticsSummary);
      await click(statisticsSummary, {
        waitFor: () =>
          page.waitForFunction(
            ({ text, open }) =>
              Array.from(document.querySelectorAll("details")).some(
                (element) =>
                  element.textContent?.includes(text) && element.open === open,
              ),
            { text: "Статистика сервера", open: true },
          ),
        holdMs: 800,
      });
      await glide(statisticsSummary);
      await click(statisticsSummary, {
        waitFor: () =>
          page.waitForFunction(
            ({ text, open }) =>
              Array.from(document.querySelectorAll("details")).some(
                (element) =>
                  element.textContent?.includes(text) && element.open === open,
              ),
            { text: "Статистика сервера", open: false },
          ),
        holdMs: 500,
      });
      await scrollBy(-520, { steps: 10, x: 950, y: 690 });
    },
  );

  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("heading", { name: "Память игры" }).waitFor();
  await shot("settings");

  const downloadLimit = page.getByRole("combobox", {
    name: "Скорость загрузки сборок",
    exact: true,
  });
  const oneMiB = page.getByRole("option", { name: "1 MiB/s", exact: true });
  const unlimited = page.getByRole("option", {
    name: "Без ограничения",
    exact: true,
  });
  await recordGuidebookChapter("settings", async ({ glide, click }) => {
    await glide(downloadLimit);
    await click(downloadLimit, {
      waitFor: () => page.getByRole("listbox").waitFor(),
      holdMs: 250,
    });
    await glide(oneMiB);
    await click(oneMiB, {
      waitFor: () =>
        page.waitForFunction(() =>
          document
            .querySelector('[aria-label="Скорость загрузки сборок"]')
            ?.textContent?.includes("1 MiB/s"),
        ),
      holdMs: 700,
    });
    await glide(downloadLimit);
    await click(downloadLimit, {
      waitFor: () => page.getByRole("listbox").waitFor(),
      holdMs: 200,
    });
    await glide(unlimited);
    await click(unlimited, {
      waitFor: () =>
        page.waitForFunction(() =>
          document
            .querySelector('[aria-label="Скорость загрузки сборок"]')
            ?.textContent?.includes("Без ограничения"),
        ),
      holdMs: 650,
    });
  });

  // The workspace finish lives in the Appearance category, not the default
  // Performance panel. Open that category before scrolling to the section; the
  // old capture waited for a heading that could never become visible.
  await page.locator('[data-settings-category="appearance"]').click();
  const workspaceHeading = page.getByRole("heading", {
    level: 3,
    name: "Рабочая зона",
  });
  await workspaceHeading.evaluate((element) =>
    element.scrollIntoView({ block: "start", behavior: "instant" }),
  );
  await page.getByRole("radiogroup", { name: "Рабочая зона" }).waitFor();
  await shot("workspace");
  await page.locator('[data-settings-category="privacy"]').click();
  await page.locator('[data-settings-panel="privacy"]').waitFor();
  await shot("privacy");

  if (errors.length > 0) {
    console.error("page errors:", errors);
    process.exitCode = 1;
  } else {
    const expectedChapters = [
      "navigation",
      "servers",
      "server-actions",
      "wardrobe",
      "account",
      "settings",
    ];
    if (expectedChapters.some((name) => !guidebookManifest[name])) {
      throw new Error(
        "Incomplete guidebook recording; existing GIFs were not replaced",
      );
    }
    const manifestPath = path.join(staging, "guidebook-frames.json");
    writeFileSync(manifestPath, JSON.stringify(guidebookManifest), "utf8");
    const generated = spawnSync(
      "python3",
      [
        path.join(root, "scripts/generate-guidebook-gifs.py"),
        "--manifest",
        manifestPath,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (generated.error) throw generated.error;
    if (generated.status !== 0) {
      throw new Error(
        `Guidebook GIF generation failed with exit code ${generated.status}`,
      );
    }

    // Reopen the actual guidebook only after the new poster/GIF assets exist,
    // so the committed browser screenshot shows the current reduced-motion state.
    await page.getByTestId("guidebook-replay").click();
    await page.getByRole("dialog").waitFor();
    await page
      .getByRole("heading", { name: "Справочник игрока", exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: "Найти сервер", exact: true })
      .waitFor();
    await page
      .locator('[role="dialog"] img')
      .evaluate((image) => image instanceof HTMLImageElement && image.decode());
    await shot("guidebook");

    const expected = [
      "welcome",
      "setup",
      "account",
      "guidebook",
      "servers",
      "server",
      "server-actions",
      "minecraft",
      "minecraft-actions",
      "wardrobe",
      "profile",
      "settings",
      "workspace",
      "privacy",
    ].map((name) => `line-${name}.png`);
    if (
      captured.length !== expected.length ||
      expected.some((file) => !captured.includes(file))
    ) {
      throw new Error(
        "Incomplete screenshot gallery; existing images were not replaced",
      );
    }
    for (const file of captured)
      renameSync(path.join(staging, file), path.join(outDir, file));
    // This transient screenshot was often stale when the template was unconfigured.
    rmSync(path.join(outDir, "line-connecting.png"), { force: true });

    const screenshotHashes = Object.fromEntries(
      expected.map((file) => [
        `docs/images/${file}`,
        sha256(path.join(outDir, file)),
      ]),
    );
    const guidebookHashes = Object.fromEntries(
      expectedChapters.map((chapter) => [
        chapter,
        {
          gif: `public/guidebook/${chapter}.gif`,
          gifSha256: sha256(path.join(root, `public/guidebook/${chapter}.gif`)),
          poster: `public/guidebook/${chapter}.png`,
          posterSha256: sha256(
            path.join(root, `public/guidebook/${chapter}.png`),
          ),
        },
      ]),
    );
    const generatedOn =
      process.env.VISUAL_EVIDENCE_DATE ?? new Date().toISOString().slice(0, 10);
    writeFileSync(
      evidenceManifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedOn,
          browser: await browser.version(),
          screenshotCount: expected.length,
          screenshots: screenshotHashes,
          guidebookChapterCount: expectedChapters.length,
          guidebook: guidebookHashes,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const readmePath = path.join(root, "README.md");
    const readme = readFileSync(readmePath, "utf8");
    const refreshNote = [
      "<!-- visual-evidence-refresh:start -->",
      `Полный набор скриншотов и GIF перегенерирован **${generatedOn}** ([контрольные суммы](docs/visual-evidence.json)).`,
      "<!-- visual-evidence-refresh:end -->",
    ].join("\n");
    const refreshedReadme = readme.replace(
      /<!-- visual-evidence-refresh:start -->[\s\S]*?<!-- visual-evidence-refresh:end -->/,
      refreshNote,
    );
    if (
      refreshedReadme === readme &&
      !readme.includes("visual-evidence-refresh:start")
    ) {
      throw new Error(
        "README.md is missing the visual-evidence refresh marker",
      );
    }
    writeFileSync(readmePath, refreshedReadme, "utf8");
    console.log(
      `Published ${captured.length} screenshots and ${expectedChapters.length} GIF chapters (0 page errors)`,
    );
  }
} catch (error) {
  await page
    .screenshot({ path: path.join(root, ".smoke/screenshots-failure.png") })
    .catch(() => {});
  console.error(error);
  console.error("page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  rmSync(staging, { recursive: true, force: true });
}
