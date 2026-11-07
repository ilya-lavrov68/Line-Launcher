// Browser smoke test for the React orchestration layer.
//
//   npm run dev                       # in another terminal
//   node scripts/ui-smoke.mjs
//
// playwright-core is a devDependency and downloads no browser. An installed
// Chrome/Edge is detected automatically; otherwise:
//   npx playwright-core install chromium     # or set CHROMIUM_PATH=/path/to/chrome
//
// Environment:
//   BASE_URL       default http://127.0.0.1:5173
//   CHROMIUM_PATH  explicit browser binary
//   SMOKE_OUT      screenshot directory (default: .smoke, gitignored)
//
// A test-only Tauri IPC stub is injected with addInitScript. No stub code ships
// in the app: this validates React state machines and event filtering only, not
// Rust commands, network security or filesystem safety.
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserHelp, findBrowser } from "./lib/find-browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, process.env.SMOKE_OUT || ".smoke");
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5173";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core не установлен. Выполните: npm ci");
  process.exit(2);
}

const config = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(path.join(root, "examples/config.json"), "utf8"),
);
config.provider.name = "Plus In Plus Demo";
// The shipped example points at cdn.example.com, which only exercises the
// fallback. Give the first server real bytes so the loaded path is covered too.
const artPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
config.servers[0].icon_url = artPng;
config.servers[0].banner_url = artPng;
config.servers[0].auth.launch_ticket_url =
  "https://auth.example.com/v1/launcher/ticket";
config.servers[0].auth.session_exchange_url =
  "https://auth.example.com/v1/launcher/exchange";
config.servers.push({
  ...config.servers[0],
  id: "creative",
  name: "Creative",
  description: "Творческий режим для строительства и экспериментов.",
  version: "2026.11.2",
});

/** Minimal valid 64x64 RGBA PNG, built with node:zlib (no extra dependency). */
function skinPng() {
  const size = 64;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const at = row + 1 + x * 4;
      raw[at] = 90;
      raw[at + 1] = 140;
      raw[at + 2] = 200;
      raw[at + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const out = Buffer.alloc(4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, body, out]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const skinBytes = skinPng();

mkdirSync(outDir, { recursive: true });
const launchOptions = { headless: true };
const found = findBrowser();
if (found) {
  launchOptions.executablePath = found.path;
  console.log(`Browser: ${found.via} (${found.path})`);
}

// Fail with a usable message instead of a raw connect stack when the dev server
// is not running — the most common way to invoke this script.
try {
  await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
} catch {
  console.error(
    `Dev-сервер недоступен по адресу ${baseUrl}.\n` +
      "Запустите в другом терминале:  npm run dev\n" +
      "Другой адрес:                 BASE_URL=http://127.0.0.1:5173 npm run test:ui",
  );
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch(launchOptions);
} catch (error) {
  console.error(`${error.message}\n\n${browserHelp()}`);
  process.exit(2);
}
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  // Obsy's animated gradient never settles; screenshots must disable motion.
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.addInitScript(
  ({ config, skinPng }) => {
    window.__skinPng = skinPng;
    window.isTauri = true;
    window.__callbacks = new Map();
    window.__cid = 1;
    window.__eid = 1;
    // eventId -> { event, handler }; Tauri unlistens by event id, not handler id.
    window.__events = new Map();
    window.__calls = [];
    window.__revision = 0;
    window.__emit = (event, payload) => {
      for (const [id, listener] of window.__events) {
        if (listener.event === event)
          window.__callbacks.get(listener.handler)({ event, id, payload });
      }
    };
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
        window.__calls.push([cmd, args]);
        if (cmd === "plugin:window|is_maximized") return false;
        if (cmd === "plugin:window|inner_size")
          return { type: "Logical", width: 1100, height: 720 };
        if (
          cmd === "plugin:window|minimize" ||
          cmd === "plugin:window|toggle_maximize" ||
          cmd === "plugin:window|unmaximize" ||
          cmd === "plugin:window|set_size"
        )
          return null;
        if (cmd === "get_settings")
          return {
            settings: {
              heapMb: null,
              javaPath: null,
              sidebarCollapsed: false,
              afterLaunch: "keep",
              windowWidth: 1100,
              windowHeight: 720,
              windowMaximized: false,
            },
            heapCeilingMb: 8192,
            suggestedHeapMb: 4096,
            totalMemoryMb: 16384,
          };
        if (cmd === "save_settings")
          return {
            settings: args.settings,
            heapCeilingMb: 8192,
            suggestedHeapMb: 4096,
            totalMemoryMb: 16384,
          };
        if (cmd === "list_java_runtimes")
          return [{ path: "/usr/bin/java", major: 21, version: "21.0.5" }];
        if (cmd === "clear_config_cache") return true;
        if (cmd === "get_skin") return window.__skin || null;
        if (cmd === "upload_skin") {
          window.__skin = {
            model: args.model,
            textureUrl: "data:image/png;base64," + window.__skinPng,
          };
          return window.__skin;
        }
        if (cmd === "reset_skin") {
          window.__skin = null;
          return null;
        }
        if (cmd === "get_cached_config") return null;
        if (cmd === "fetch_line_config")
          return {
            config,
            sourceUrl: args.url,
            fetchedAt: Date.now(),
            fromCache: false,
            stale: false,
          };
        if (cmd === "get_installed_build") return window.__installed || null;
        if (cmd === "get_game_status")
          return {
            serverId: args.serverId,
            revision: window.__revision,
            phase: "idle",
          };
        if (cmd === "list_release_history")
          return {
            serverId: args.serverId,
            releases: window.__installed ? [window.__installed] : [],
          };
        if (cmd === "launch_game") {
          const status = {
            serverId: args.serverId,
            revision: ++window.__revision,
            phase: "running",
            sha256: window.__installed.sha256,
            startedAt: Date.now(),
          };
          window.__lastStatus = status;
          return status;
        }
        if (cmd === "stop_game") {
          window.__emit("line://game-status", {
            serverId: args.serverId,
            revision: ++window.__revision,
            phase: "exited",
            exitCode: 0,
          });
          // A reordered, older "running" event must not resurrect the game.
          window.__emit("line://game-status", window.__lastStatus);
          return true;
        }
        if (cmd === "line_login" || cmd === "line_register")
          return {
            serverId: args.request.serverId,
            username: args.request.username,
            expiresAt: Date.now() + 3_600_000,
          };
        if (cmd === "plugin:event|listen") {
          const id = window.__eid++;
          window.__events.set(id, { event: args.event, handler: args.handler });
          return id;
        }
        if (cmd === "plugin:event|unlisten") {
          window.__events.delete(args.eventId);
          return null;
        }
        if (cmd === "download_and_extract_zip") {
          const emit = (phase, percent) =>
            window.__emit("line://install-progress", {
              operationId: args.operationId,
              serverId: args.serverId,
              phase,
              percent,
              receivedBytes: Math.round(percent * 10485.76),
              totalBytes: 1_048_576,
              extractedBytes: phase === "extracting" ? percent * 20971 : 0,
              unpackedBytes: 2_097_152,
            });
          emit("downloading", 10);
          await new Promise((r) => setTimeout(r, 120));
          emit("downloading", 70);
          await new Promise((r) => setTimeout(r, 120));
          emit("extracting", 85);
          await new Promise((r) => setTimeout(r, 120));
          emit("completed", 100);
          window.__installed = {
            serverId: args.serverId,
            version: "2026.11.1",
            sha256: config.servers[0].distribution.sha256,
            installedAt: Date.now(),
            alreadyInstalled: false,
          };
          return window.__installed;
        }
        if (cmd === "line_logout") return null;
        throw new Error(`unexpected command: ${cmd}`);
      },
    };
  },
  { config, skinPng: skinBytes.toString("base64") },
);

const shot = (name) =>
  page.screenshot({
    path: path.join(outDir, `${name}.png`),
    fullPage: true,
    animations: "disabled",
    timeout: 60_000,
  });

function check(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page
    .getByLabel("Адрес конфигурации")
    .fill("https://provider.example.com/config.json");
  await page.getByRole("button", { name: "Подключить провайдера" }).click();
  await page.getByRole("heading", { name: "Plus In Plus Demo" }).waitFor();
  await shot("servers");

  // The mark is tinted through a CSS mask. Vite inlines the SVG as a data: URL
  // with single quotes inside; an unquoted url(...) is dropped by the CSS parser
  // and the mark degrades to a solid block. Assert the mask really applies.
  const mark = await page.evaluate(() => {
    const el = document.querySelector("header span[aria-hidden='true']");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { mask: cs.maskImage || cs.webkitMaskImage, bg: cs.backgroundColor };
  });
  if (mark) {
    check(
      mark.mask && mark.mask !== "none",
      "brand mark mask was dropped by the CSS parser (solid block instead of a logo)",
    );
  }

  // Custom title bar: the caption buttons must actually reach the window plugin.
  for (const label of ["Свернуть окно", "Развернуть окно"]) {
    const button = page.getByRole("button", { name: label });
    await button.waitFor();
    await button.click();
  }
  const windowCalls = await page.evaluate(() =>
    window.__calls
      .map((c) => c[0])
      .filter((c) => c.startsWith("plugin:window|")),
  );
  check(
    windowCalls.includes("plugin:window|minimize") &&
      windowCalls.includes("plugin:window|toggle_maximize"),
    `title bar did not drive the window: ${windowCalls.join(", ")}`,
  );

  // Sidebar collapse persists through the settings command and keeps names.
  await page.getByRole("button", { name: "Свернуть меню" }).click();
  const collapsed = await page.evaluate(() =>
    window.__calls.some(
      (c) =>
        c[0] === "save_settings" && c[1].settings.sidebarCollapsed === true,
    ),
  );
  check(collapsed, "collapsing the sidebar was not persisted");
  await page.getByRole("button", { name: "Серверы" }).waitFor();
  await page.getByRole("button", { name: "Развернуть меню" }).click();

  // Settings screen renders the safe controls, with no free-form JVM field.
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByText("Память игры", { exact: true }).waitFor();
  await shot("settings");
  // Base UI prints the raw value unless SelectValue formats it: "keep"/"auto"
  // in the trigger would be a regression, not a label.
  const settingsText = await page.locator("main").innerText();
  for (const raw of ["keep", "auto"]) {
    check(
      !new RegExp(`^\\s*${raw}\\s*$`, "m").test(settingsText),
      `a select shows the raw value "${raw}" instead of a human label`,
    );
  }
  check(
    settingsText.includes("Оставить окно открытым"),
    "after-launch select lost its label",
  );
  check(
    !(await page.getByLabel(/JVM|аргументы/i).count()),
    "settings must not expose arbitrary JVM arguments",
  );
  await page.getByRole("button", { name: "Серверы" }).click();

  await page.getByRole("button", { name: "Открыть сервер Survival" }).click();
  await page.getByText("Аккаунт провайдера", { exact: true }).waitFor();
  // Server artwork must render when it loads, not only fall back when it fails.
  const artwork = await page.evaluate(() =>
    [...document.querySelectorAll("main img")].map((img) => ({
      src: img.getAttribute("src")?.slice(0, 24),
      ok: img.complete && img.naturalWidth > 0,
    })),
  );
  check(
    artwork.length >= 2 && artwork.every((a) => a.ok),
    `server banner/icon did not render: ${JSON.stringify(artwork)}`,
  );
  await shot("server-detail");
  await page.getByRole("tab", { name: "Регистрация" }).click();
  await page.getByRole("tab", { name: "Вход" }).click();
  await page.getByLabel("Логин", { exact: true }).fill("Player_1");
  await page.getByLabel("Пароль", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Установить сборку" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).waitFor();
  await shot("installed");

  await page.getByRole("button", { name: "История сборок" }).click();
  await page.getByText("Текущая", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await page.getByRole("button", { name: "Остановить игру" }).waitFor();
  await page.getByRole("button", { name: "Остановить игру" }).click();
  // The terminal event must survive the deliberately reordered older event.
  await page.getByRole("button", { name: "Играть", exact: true }).waitFor();
  check(
    !(await page
      .getByRole("button", { name: "Остановить игру" })
      .isVisible()
      .catch(() => false)),
    "a reordered older event resurrected the running state",
  );

  // Wardrobe: a real file through the real validator, preview, upload and reset.
  await page.getByRole("button", { name: "Гардероб" }).click();
  await page.getByRole("heading", { name: "Гардероб" }).waitFor();
  await page.locator("#skin-file").setInputFiles({
    name: "skin.png",
    mimeType: "image/png",
    buffer: skinBytes,
  });
  await page.getByRole("button", { name: "Применить скин" }).waitFor();
  await shot("wardrobe");
  await page.getByRole("button", { name: "Применить скин" }).click();
  await page.getByRole("button", { name: "Сбросить на стандартный" }).waitFor();
  const upload = await page.evaluate(
    () => window.__calls.find((c) => c[0] === "upload_skin")?.[1] ?? null,
  );
  check(upload, "the skin was never uploaded");
  check(upload.model === "classic", "the chosen model was not sent");
  check(
    Array.isArray(upload.png) && upload.png.length > 33,
    "the PNG bytes were not sent to the backend",
  );
  await page.getByRole("button", { name: "Сбросить на стандартный" }).click();
  const reset = await page.evaluate(() =>
    window.__calls.some((c) => c[0] === "reset_skin"),
  );
  check(reset, "resetting the skin never reached the backend");

  // A wrong-sized PNG must be rejected in the UI, without an upload call.
  const before = await page.evaluate(
    () => window.__calls.filter((c) => c[0] === "upload_skin").length,
  );
  await page.locator("#skin-file").setInputFiles({
    name: "bad.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a png at all"),
  });
  await page.getByRole("alert").filter({ hasText: "PNG" }).waitFor();
  const after = await page.evaluate(
    () => window.__calls.filter((c) => c[0] === "upload_skin").length,
  );
  check(after === before, "an invalid PNG was sent to the provider");
  await page.getByRole("button", { name: "Серверы" }).click();

  // Mandatory licence credit stays visible and inside the viewport.
  for (const width of [375, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const credit = page.locator(
      '[data-line-attribution="footer"],[data-line-attribution="header"]',
    );
    await credit.waitFor({ state: "visible" });
    const text = await credit.innerText();
    for (const required of ["Line Launcher", "Plus In Plus", "|"]) {
      check(
        text.includes(required),
        `credit is missing ${required} at ${width}px`,
      );
    }
    const box = await credit.boundingBox();
    check(
      box && box.x >= 0 && box.x + box.width <= width + 1,
      `credit overflows the viewport at ${width}px`,
    );
  }

  const commands = await page.evaluate(() => window.__calls.map((c) => c[0]));
  for (const required of [
    "fetch_line_config",
    "line_login",
    "download_and_extract_zip",
    "list_release_history",
    "launch_game",
    "stop_game",
    "get_settings",
    "save_settings",
    "list_java_runtimes",
    "get_skin",
    "upload_skin",
    "reset_skin",
  ]) {
    check(commands.includes(required), `command was never called: ${required}`);
  }
  check(errors.length === 0, `page errors: ${errors.join("; ")}`);
  console.log(`UI smoke: passed (${commands.length} IPC calls, 0 page errors)`);
  console.log(`Screenshots: ${outDir}`);
} catch (error) {
  await shot("failure").catch(() => {});
  console.error(error);
  console.error("page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
