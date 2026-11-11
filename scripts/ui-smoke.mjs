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
// Exercise the explicit provider-pack offline path in the real UI as well.
config.servers[1].launch_mode = "offline";
delete config.servers[1].auth;
config.required_features.push("offline-launch-v1");
// The shipped example points at cdn.example.com, which only exercises the
// fallback. Give the first server real bytes so the loaded path is covered too.
const artPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
config.servers[0].icon_url = artPng;
config.servers[0].banner_url = artPng;
config.servers[0].auth = {
  launch_ticket_url: "https://auth.example.com/v1/launcher/ticket",
  session_exchange_url: "https://auth.example.com/v1/launcher/exchange",
};
config.servers.push({
  ...config.servers[0],
  id: "creative",
  name: "Creative",
  description: "Творческий режим для строительства и экспериментов.",
  version: "2026.11.2",
});

/** Minimal valid 64x64 RGBA PNG, built with node:zlib (no extra dependency). */
function skinPng(tint = 90) {
  const size = 64;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const at = row + 1 + x * 4;
      raw[at] = tint;
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
// A different texture, so content-addressing stores two entries instead of one.
const secondSkinBytes = skinPng(200);

mkdirSync(outDir, { recursive: true });
// --hide-scrollbars is a Playwright default; keeping it would hide the custom
// scrollbar this suite asserts on.
const launchOptions = {
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
};
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
  // The launcher follows the system language until a language is chosen, and
  // this suite asserts Russian labels. Without a locale Chromium reports
  // en-US and the first run would come up in English.
  locale: "ru-RU",
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
    window.__failConfigOnce = true;
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
        if (cmd === "list_java_runtimes") return window.__javaRuntimes || [];
        if (cmd === "probe_java_path") {
          const runtime = { path: args.path, major: 25, version: "25.0.3" };
          window.__javaRuntimes = [runtime];
          return runtime;
        }
        if (cmd === "clear_config_cache") return true;
        // Local skin library. Independent of session/provider on purpose.
        window.__library ||= { skins: [], active: null, synced: null };
        const librarySnapshot = () => ({
          library: JSON.parse(JSON.stringify(window.__library)),
          limit: 64,
        });
        if (cmd === "list_skin_library") return librarySnapshot();
        if (cmd === "add_skin_to_library") {
          // Content-addressed in Rust; a stable fake digest is enough here.
          let hash = 0;
          for (const byte of args.png) hash = (hash * 31 + byte) >>> 0;
          const id = hash.toString(16).padStart(8, "0").repeat(8);
          window.__library.skins = window.__library.skins.filter(
            (s) => s.id !== id,
          );
          window.__library.skins.unshift({
            id,
            name: args.name,
            model: args.model,
            width: 64,
            height: 64,
            sizeBytes: args.png.length,
            addedAt: Date.now(),
          });
          window.__libraryBytes ||= {};
          window.__libraryBytes[id] = args.png;
          return librarySnapshot();
        }
        if (cmd === "rename_skin") {
          const skin = window.__library.skins.find((s) => s.id === args.id);
          if (skin) skin.name = args.name;
          return librarySnapshot();
        }
        if (cmd === "delete_skin_from_library") {
          window.__library.skins = window.__library.skins.filter(
            (s) => s.id !== args.id,
          );
          if (window.__library.active === args.id)
            window.__library.active = null;
          if (window.__library.synced === args.id)
            window.__library.synced = null;
          return librarySnapshot();
        }
        if (cmd === "read_skin_texture")
          return (window.__libraryBytes || {})[args.id] || [];
        if (cmd === "set_active_skin") {
          window.__library.active = args.id;
          return librarySnapshot();
        }
        // Mirrors Rust: active == synced means nothing is sent.
        if (cmd === "sync_active_skin") {
          const id = window.__library.active;
          if (id === window.__library.synced)
            return { status: "unchanged", skin: null };
          if (id === null) {
            window.__skin = null;
            window.__library.synced = null;
            return { status: "synced", skin: null };
          }
          const entry = window.__library.skins.find((s) => s.id === id);
          window.__skin = {
            model: entry.model,
            textureUrl: "data:image/png;base64," + window.__skinPng,
          };
          // Counts real uploads, not IPC calls: an idempotent sync sends nothing.
          window.__uploads = (window.__uploads || 0) + 1;
          window.__library.synced = id;
          return { status: "synced", skin: window.__skin };
        }
        if (cmd === "forget_synced_skin") {
          window.__library.synced = null;
          return librarySnapshot();
        }
        if (cmd === "get_skin") return window.__skin || null;
        if (cmd === "get_cached_config") return null;
        if (cmd === "fetch_line_config" && window.__failConfigOnce) {
          window.__failConfigOnce = false;
          throw {
            code: "NETWORK",
            message:
              "Не удалось соединиться с провайдером. Проверьте адрес и что сервер запущен.",
            retryable: true,
          };
        }
        if (cmd === "fetch_line_config") {
          // Keep the loading state observable; an instant resolve races the
          // screen's exit animation and measures the wrong element.
          await new Promise((resolve) => setTimeout(resolve, 400));
          return {
            config,
            sourceUrl: args.url,
            fetchedAt: Date.now(),
            fromCache: false,
            stale: false,
          };
        }
        if (cmd === "get_installed_build")
          return window.__builds?.[args.serverId] || null;
        if (cmd === "get_game_status")
          return {
            serverId: args.serverId,
            revision: window.__revision,
            phase: "idle",
          };
        if (cmd === "list_release_history")
          return {
            serverId: args.serverId,
            releases: window.__builds?.[args.serverId]
              ? [window.__builds[args.serverId]]
              : [],
          };
        if (cmd === "launch_game") {
          if (window.__expireSession) {
            window.__expireSession = false;
            window.__session = null;
            throw {
              code: "AUTH_REQUIRED",
              message: "Войдите в аккаунт проекта.",
              retryable: false,
            };
          }
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
        if (cmd === "line_login" || cmd === "line_register") {
          window.__session = {
            username: args.request.username,
            expiresAt: Date.now() + 3_600_000,
          };
          return window.__session;
        }
        if (cmd === "line_session") return window.__session || null;
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
          // The receipt must carry the sha of the server that was installed:
          // stamping server 0's digest on every build made the second server
          // open in «Доступно обновление» and never offer «Играть».
          window.__installed = {
            serverId: args.serverId,
            version: "2026.11.1",
            sha256: config.servers.find((s) => s.id === args.serverId)
              .distribution.sha256,
            installedAt: Date.now(),
            alreadyInstalled: false,
          };
          window.__builds ||= {};
          window.__builds[args.serverId] = window.__installed;
          return window.__installed;
        }
        if (cmd === "line_logout") {
          window.__session = null;
          return null;
        }
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
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  // The greeting runs once, before anything else, and hands over on its own.
  await page.locator("[data-line-welcome]").waitFor({ timeout: 10_000 });
  await page
    .locator("[data-line-welcome] [aria-label='Welcome']")
    .waitFor({ timeout: 5_000 });
  await page.locator("[data-line-welcome]").waitFor({
    state: "detached",
    timeout: 10_000,
  });
  check(
    !(await page.locator("[data-line-welcome]").count()),
    "the greeting stayed on screen after its timer",
  );
  await page
    .getByLabel("Адрес конфигурации")
    .fill("https://provider.example.com/config.json");
  // Regression: submitting used to clear the error block, shrinking the centred
  // card and throwing the button up, then back down when the error returned.
  // Measure the three states the player actually sees: idle, error, loading.
  const submitY = async () =>
    Math.round(
      (
        await page
          .getByRole("button", {
            name: /Подключить провайдера|Проверяем конфигурацию/,
          })
          .boundingBox()
      ).y,
    );
  const idleY = await submitY();

  // First attempt fails: the error must appear without moving the button.
  await page.getByRole("button", { name: "Подключить провайдера" }).click();
  await page.getByRole("alert").waitFor();
  const errorY = await submitY();

  // Second attempt clears the error while loading — the original 24px jump.
  await page.getByRole("button", { name: "Подключить провайдера" }).click();
  await page.getByRole("button", { name: "Проверяем конфигурацию…" }).waitFor();
  const loadingY = await submitY();
  check(
    Math.max(idleY, errorY, loadingY) - Math.min(idleY, errorY, loadingY) <= 1,
    `the submit button moved: idle=${idleY} error=${errorY} loading=${loadingY}`,
  );

  // One account for the whole project: the sign-in gate comes before any server.
  await page.getByRole("heading", { name: "Plus In Plus Demo" }).waitFor();
  await page
    .getByText("Один вход — все серверы проекта.", { exact: false })
    .waitFor();
  check(
    !(await page.getByRole("button", { name: /^Открыть сервер/ }).count()),
    "the server list appeared before the single sign-in",
  );

  // Signing in once, with no server selected at all.
  await page
    .getByText("Один вход — все серверы проекта.", { exact: false })
    .waitFor();
  await page.getByRole("tab", { name: "Регистрация" }).click();
  await page.getByRole("tab", { name: "Вход" }).click();
  await page.getByLabel("Логин", { exact: true }).fill("Player_1");
  await page.getByLabel("Пароль", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Открыть сервер Survival" }).waitFor();
  const login = await page.evaluate(() => {
    const call = window.__calls.find((c) => c[0] === "line_login");
    return {
      keys: Object.keys(call?.[1]?.request ?? {})
        .sort()
        .join(","),
      restored: window.__calls.some((c) => c[0] === "line_session"),
      forgotten: window.__calls.some((c) => c[0] === "forget_synced_skin"),
    };
  });
  check(
    login.keys === "password,username",
    `login must not carry a server id: ${login.keys}`,
  );
  check(login.restored, "the shell never asked the backend for the session");
  check(login.forgotten, "signing in must reset the uploaded-skin marker");
  await shot("account");

  // The mark is tinted through a CSS mask. Vite inlines the SVG as a data: URL
  // with single quotes inside; an unquoted url(...) is dropped by the CSS parser
  // and the mark degrades to a solid block. Assert the mask really applies.
  const mark = await page.evaluate(() => {
    const span = document.querySelector(
      'header [data-line-brand-mark="tinted"]',
    );
    if (span) {
      const cs = getComputedStyle(span);
      return { kind: "mask", mask: cs.maskImage || cs.webkitMaskImage };
    }
    const img = document.querySelector('header [data-line-brand-mark="image"]');
    if (img)
      return { kind: "image", loaded: img.complete && img.naturalWidth > 0 };
    return null;
  });
  if (mark?.kind === "mask") {
    check(
      mark.mask && mark.mask !== "none",
      "brand mark mask was dropped by the CSS parser (solid block instead of a logo)",
    );
  } else if (mark?.kind === "image") {
    check(mark.loaded, "the colour brand mark did not load");
  }

  // Custom scrollbar: the pill must be drawn by ::-webkit-scrollbar. Setting
  // scrollbar-width in Chromium disables those pseudo-elements entirely, so
  // assert the standard property is NOT forcing the stock bar back.
  const scrollbar = await page.evaluate(() => {
    const main = document.querySelector("main");
    const cs = getComputedStyle(main);
    const thumb = getComputedStyle(main, "::-webkit-scrollbar-thumb");
    return {
      standard: cs.scrollbarWidth,
      radius: thumb.borderTopLeftRadius,
      clip: thumb.backgroundClip,
      colour: thumb.backgroundColor,
    };
  });
  check(
    scrollbar.standard === "auto",
    "scrollbar-width is set in Chromium, which disables the custom pill",
  );
  check(
    parseFloat(scrollbar.radius) > 0 || scrollbar.radius.includes("9999"),
    `the scrollbar thumb is not a pill: radius=${scrollbar.radius}`,
  );
  check(
    scrollbar.clip === "content-box",
    "the thumb needs background-clip:content-box for its inset",
  );

  // Custom title bar: the caption buttons must actually reach the window plugin.
  // The labels come from the catalogue now, so they are the short window verbs
  // rather than the old "…окно" phase.
  // `exact` matters now that the window verb and the sidebar verb are both
  // "Свернуть": the caption buttons are the short ones, the rail's are
  // "Свернуть меню".
  for (const label of ["Свернуть", "Развернуть"]) {
    const button = page.getByRole("button", { name: label, exact: true });
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
  await page.getByRole("button", { name: "Повторить поиск Java" }).waitFor();
  const sectionIcons = await page
    .locator('[data-line-icon="section"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const cs = getComputedStyle(node);
        return {
          background: cs.backgroundColor,
          border: cs.borderTopWidth,
          width: node.getBoundingClientRect().width,
        };
      }),
    );
  // Six sections now: language, memory, backdrop, Java, window behaviour and
  // the configuration cache. Language is first, above memory.
  check(
    sectionIcons.length === 6 &&
      sectionIcons.every(
        (icon) =>
          icon.background === "rgba(0, 0, 0, 0)" &&
          icon.border === "0px" &&
          icon.width >= 20,
      ),
    `section icons are still framed or too small: ${JSON.stringify(sectionIcons)}`,
  );
  check(
    !(await page
      .getByText("Java не найдена. Установите JDK", { exact: false })
      .count()),
    "an empty automatic search still claims the installed JDK is absent",
  );
  const javaPath =
    "C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.3.9-hotspot\\bin\\java.exe";
  await page
    .getByLabel("Или укажите установленную Java вручную")
    .fill(javaPath);
  await page
    .getByRole("button", { name: "Проверить и выбрать", exact: true })
    .click();
  await page
    .getByText("Java 25 (25.0.3) проверена и выбрана", { exact: false })
    .waitFor();
  const manualJava = await page.evaluate(() => ({
    probed: window.__calls.some((c) => c[0] === "probe_java_path"),
    saved: window.__calls.some(
      (c) =>
        c[0] === "save_settings" &&
        c[1].settings.javaPath?.includes("jdk-25.0.3.9-hotspot"),
    ),
  }));
  check(
    manualJava.probed && manualJava.saved,
    "manual Java path was not verified and persisted",
  );
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
    settingsText.includes("Оставить как есть"),
    "after-launch select lost its label",
  );
  check(
    !(await page.getByLabel(/JVM|аргументы/i).count()),
    "settings must not expose arbitrary JVM arguments",
  );
  // The wardrobe is local-first. Signing in is a full-window page now, so this
  // runs after it — but the property under test is unchanged: a local upload
  // must reach the library without a selected server, and the automatic
  // provider sync is a separate, signed-in-only step that the account page
  // drives on its own (see canSync in LineLauncher).
  await page.getByRole("button", { name: "Гардероб" }).click();
  await page.getByRole("heading", { name: "Гардероб" }).waitFor();
  check(
    await page
      .getByRole("heading", { name: "Добавить скин", exact: true })
      .evaluate((node) => node.parentElement.querySelector("svg") === null),
    "the non-interactive plus icon is still beside the upload heading",
  );
  check(
    await page.getByText("История пуста.", { exact: false }).isVisible(),
    "the local library did not render",
  );
  await shot("wardrobe-empty");
  await page.locator("#skin-file").setInputFiles({
    name: "local.png",
    mimeType: "image/png",
    buffer: skinBytes,
  });
  await page.getByRole("button", { name: "В историю" }).click();
  await page.getByText("активный", { exact: false }).first().waitFor();
  const savedLocally = await page.evaluate(() => ({
    added: window.__calls.some((c) => c[0] === "add_skin_to_library"),
    count: window.__library.skins.length,
  }));
  check(savedLocally.added, "the skin never reached the local library");
  check(savedLocally.count === 1, "the skin was not kept in history");
  await shot("wardrobe-local-history");

  // The demo project does publish wardrobe endpoints, so signing in turns the
  // automatic sync on: the skin that was only local a moment ago goes to the
  // account. That is the difference between "works offline" and "works signed
  // in", and it used to be impossible to test because the wardrobe was gated.
  const synced = await page.evaluate(() =>
    window.__calls.some(
      (c) => c[0] === "upload_skin" || c[0] === "sync_active_skin",
    ),
  );
  check(
    synced,
    "signing in with wardrobe endpoints must sync the local skin to the account",
  );
  const logoTiles = await page
    .locator("main [data-line-icon]")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const cs = getComputedStyle(node);
        return (
          cs.backgroundColor === "rgba(0, 0, 0, 0)" &&
          cs.borderTopWidth === "0px"
        );
      }),
    );
  check(
    logoTiles.length >= 2 && logoTiles.every(Boolean),
    "provider logos still have a framed background tile",
  );
  await shot("servers");

  // There is one design and nothing that swaps it: no attribute the window
  // writes, no control in the shell, no leftover preference in storage. The
  // alternatives were all removed on purpose, so each one coming back is a
  // regression this smoke test has to catch.
  check(
    (await page.evaluate(() => document.documentElement.dataset.theme)) ===
      undefined,
    "the window still scopes a design attribute",
  );
  check(
    !(await page.getByRole("button", { name: /Сменить оформление/ }).count()),
    "the window still exposes a design switch",
  );
  check(
    (await page.evaluate(() => localStorage.getItem("line.theme"))) === null,
    "a design preference is being written",
  );

  // Back from the server screen lands on a catalogue with exactly one card per
  // server and no second «Открыть сервер <name>» shortcut anywhere. The
  // «Текущий сервер» rail that used to sit above the catalogue was removed: on
  // a screen that already lists every server, it repeated one card and its
  // Back to the catalogue: the wardrobe block above left the rail on its own
  // section, and every assertion below is about the server list.
  await page.getByRole("button", { name: "Серверы", exact: true }).click();
  await page
    .getByRole("button", { name: /^Открыть сервер/ })
    .first()
    .waitFor();

  // action, so it is a regression if it comes back.
  check(
    (await page.getByRole("region", { name: "Текущий сервер" }).count()) === 0,
    "the catalogue rail duplicated the server card again",
  );
  check(
    (await page.getByRole("button", { name: /^Открыть сервер/ }).count()) ===
      (await page.getByText(/^Minecraft 1\./).count()),
    "the catalogue gained a shortcut that is not a server card",
  );

  await page.getByRole("button", { name: "Открыть сервер Survival" }).click();
  // No second login on the server screen.
  check(
    !(await page
      .getByText("Один вход — все серверы проекта.", { exact: false })
      .count()),
    "the server screen asked for credentials again",
  );
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
  // The dock reports the same single next step instead of a second control.
  await page
    .getByRole("region", { name: "Survival" })
    .getByRole("button", { name: "Установить сборку" })
    .waitFor();
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

  // Explicit offline mode enables play without ticket endpoints. Missing mode
  // remains disabled (covered by the contract tests and Demo Showcase).
  //
  // The design switch this block used to click no longer exists: the look is a
  // build-time choice, so exercising it here would only test a control the
  // shipped window does not have. The dock is asserted instead.
  await page.getByRole("region", { name: "Survival" }).waitFor();
  await shot("server-detail-line");

  await page.getByRole("button", { name: "Все серверы", exact: true }).click();
  await page.getByRole("button", { name: "Открыть сервер SkyBlock" }).click();
  await page.getByRole("button", { name: "Установить сборку" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).waitFor();
  check(
    await page.getByText("Офлайн-сборка", { exact: false }).first().isVisible(),
    "offline launch is not explained in the UI",
  );
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await page.getByRole("button", { name: "Остановить игру" }).waitFor();
  check(
    await page.evaluate(() =>
      window.__calls.some(
        (c) => c[0] === "launch_game" && c[1].serverId === "skyblock",
      ),
    ),
    "offline server did not reach the launch command",
  );
  await page.getByRole("button", { name: "Остановить игру" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).waitFor();

  // Wardrobe after login: history persists and the active skin uploads itself.
  await page.getByRole("button", { name: "Гардероб" }).click();
  await page.getByRole("heading", { name: "Гардероб" }).waitFor();
  check(
    (await page.evaluate(() => window.__library.skins.length)) === 1,
    "history added while signed out was lost after login",
  );
  // The texture chosen while signed out is pushed automatically on sign-in.
  await page
    .getByRole("status")
    .filter({ hasText: "отправлен автоматически" })
    .waitFor();
  const firstSync = await page.evaluate(() => {
    const calls = window.__calls.filter((c) => c[0] === "sync_active_skin");
    return {
      uploads: window.__uploads || 0,
      keys: Object.keys(calls[0]?.[1] ?? {}).join(","),
      synced: window.__library.synced,
      active: window.__library.active,
    };
  });
  check(firstSync.uploads === 1, `expected one upload: ${firstSync.uploads}`);
  check(firstSync.keys === "", "the automatic sync must not name a server");
  check(
    firstSync.synced === firstSync.active && firstSync.active !== null,
    "the uploaded marker does not match the active skin",
  );

  // Re-opening the screen must not re-upload: the sync is idempotent.
  await page.getByRole("button", { name: "Серверы", exact: true }).click();
  await page.getByRole("button", { name: "Гардероб" }).click();
  await page.getByRole("heading", { name: "Гардероб" }).waitFor();
  // The controls stay disabled until the local index is read; interacting any
  // earlier is a race, not a product bug.
  await page.waitForFunction(() => {
    const input = document.querySelector("#skin-file");
    return input && !input.disabled;
  });
  check(
    (await page.evaluate(
      () => window.__calls.filter((c) => c[0] === "sync_active_skin").length,
    )) === 1,
    "re-opening the wardrobe re-uploaded an unchanged skin",
  );

  // Add a second texture so "active" is a real choice, not the only option.
  await page.locator("#skin-file").setInputFiles({
    name: "second.png",
    mimeType: "image/png",
    buffer: secondSkinBytes,
  });
  await page.getByLabel("Название").fill("Второй");
  await page.getByRole("button", { name: "В историю" }).click();
  await page.getByText("Второй", { exact: true }).waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "«Второй» отправлен автоматически" })
    .waitFor();
  await shot("wardrobe");
  check(
    (await page.evaluate(() => window.__uploads || 0)) === 2,
    "saving a new active skin did not upload it automatically",
  );

  // Re-adding the same texture is content-addressed: nothing changes on the
  // account. Regression: an "unchanged" result used to wipe the known remote
  // skin and report the standard look while the account still wore the texture.
  await page.locator("#skin-file").setInputFiles({
    name: "second.png",
    mimeType: "image/png",
    buffer: secondSkinBytes,
  });
  await page.getByLabel("Название").fill("Второй");
  await page.getByRole("button", { name: "В историю" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "отправлен автоматически" })
    .waitFor();
  const unchanged = await page.evaluate(() => ({
    text: document.querySelector("main").innerText,
    uploads: window.__uploads || 0,
    history: window.__library.skins.length,
  }));
  check(
    unchanged.uploads === 2,
    `an unchanged skin was uploaded again: ${unchanged.uploads} uploads`,
  );
  check(unchanged.history === 2, "the same texture was stored twice");
  // The account keeps wearing what it wore: the model line must still name the
  // uploaded texture's model, not fall back to «стандартная» because an
  // «unchanged» result carries no skin payload.
  check(
    unchanged.text.includes("Модель: classic") &&
      !unchanged.text.includes("Модель: стандартная"),
    "an idempotent sync forgot what the account is wearing",
  );

  // Choosing another texture uploads it too — there is no send button.
  check(
    !(await page.getByRole("button", { name: /Отправить на сервер/ }).count()),
    "the manual send button is still in the wardrobe",
  );
  await page
    .locator('button[aria-label^="Сделать активным:"]:not([disabled])')
    .first()
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Активный скин изменён" })
    .waitFor();
  const afterChoose = await page.evaluate(() => ({
    uploads: window.__uploads || 0,
    synced: window.__library.synced,
    active: window.__library.active,
    history: window.__library.skins.length,
  }));
  check(
    afterChoose.uploads === 3,
    "choosing a skin did not sync automatically",
  );
  check(
    afterChoose.synced === afterChoose.active,
    "the chosen skin was not confirmed as uploaded",
  );
  check(afterChoose.history === 2, "syncing must not clear local history");

  // The standard look is a choice too: it clears the account skin by itself.
  await page.getByRole("button", { name: "Выбрать стандартный скин" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "На сервере стандартный скин" })
    .waitFor();
  const reset = await page.evaluate(() => ({
    skin: window.__skin,
    active: window.__library.active,
    history: window.__library.skins.length,
  }));
  check(reset.skin === null, "the standard look was not pushed to the account");
  check(reset.active === null, "the standard look is not the active choice");
  check(reset.history === 2, "resetting must not delete local history");

  // Deleting from history is local and immediate.
  await page
    .getByRole("button", { name: /^Удалить из истории:/ })
    .first()
    .click();
  await page.getByRole("status").filter({ hasText: "удалён" }).waitFor();
  check(
    (await page.evaluate(() => window.__library.skins.length)) === 1,
    "deleting from history did not reach the backend",
  );

  // A wrong-sized PNG must be rejected in the UI, without touching the library.
  const before = await page.evaluate(
    () => window.__calls.filter((c) => c[0] === "add_skin_to_library").length,
  );
  await page.locator("#skin-file").setInputFiles({
    name: "bad.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a png at all"),
  });
  await page.getByRole("alert").filter({ hasText: "PNG" }).waitFor();
  const after = await page.evaluate(
    () => window.__calls.filter((c) => c[0] === "add_skin_to_library").length,
  );
  check(after === before, "an invalid PNG reached the local library");

  // Signing out is account-wide and re-arms the automatic sync for the next
  // account: the previous player's "already uploaded" marker must not survive.
  await page
    .locator('button[aria-label^="Сделать активным:"]:not([disabled])')
    .first()
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "отправлен автоматически" })
    .waitFor();
  const beforeLogout = await page.evaluate(() => window.__uploads || 0);
  // The rail no longer carries the account or a logout button: the account has
  // its own page, and signing out lives there with the rest of the account
  // controls. Same action, one place.
  await page.getByRole("button", { name: "Аккаунт", exact: true }).click();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page
    .getByText("Один вход — все серверы проекта.", { exact: false })
    .waitFor();
  const signedOut = await page.evaluate(() => ({
    logoutKeys: Object.keys(
      window.__calls.find((c) => c[0] === "line_logout")?.[1] ?? {},
    ).join(","),
    forgot: window.__calls.filter((c) => c[0] === "forget_synced_skin").length,
    synced: window.__library.synced,
    servers: [...document.querySelectorAll("main button")].some((b) =>
      (b.getAttribute("aria-label") || "").startsWith("Открыть сервер"),
    ),
  }));
  check(signedOut.logoutKeys === "", "logout must not be per-server");
  check(
    signedOut.forgot >= 2,
    "signing out did not forget the uploaded marker",
  );
  check(signedOut.synced === null, "the uploaded marker survived sign-out");
  check(!signedOut.servers, "the server list stayed open after signing out");

  await page.getByLabel("Логин", { exact: true }).fill("Player_2");
  await page.getByLabel("Пароль", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Открыть сервер Survival" }).waitFor();
  await page.getByRole("button", { name: "Гардероб" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "отправлен автоматически" })
    .waitFor();
  check(
    (await page.evaluate(() => window.__uploads || 0)) > beforeLogout,
    "a new account inherited the previous player's uploaded marker",
  );
  await page.getByRole("button", { name: "Серверы", exact: true }).click();

  // An expired account must send the player back to the single sign-in screen,
  // not leave a dead «Играть» button on the server page.
  await page.evaluate(() => {
    window.__expireSession = true;
  });
  await page.getByRole("button", { name: "Открыть сервер Survival" }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).click();
  await page
    .getByText("Один вход — все серверы проекта.", { exact: false })
    .waitFor();
  check(
    await page
      .getByRole("alert")
      .filter({ hasText: "Сессия истекла" })
      .isVisible(),
    "an expired session did not explain itself on the sign-in screen",
  );
  await page.getByLabel("Логин", { exact: true }).fill("Player_2");
  await page.getByLabel("Пароль", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: "Открыть сервер Survival" }).waitFor();

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

  // ── Four languages, switched live ────────────────────────────────────────
  //
  // "Ничего не должно быть криво" is a layout claim, so it is measured: every
  // language is applied through the real picker, and anything that clips its
  // own content horizontally is reported with the offending text. German and
  // French are the long ones — if a label was going to wrap out of shape, this
  // is where it would.
  await page.getByRole("button", { name: "Настройки" }).click();
  await page.getByText("Память игры", { exact: true }).waitFor();

  const clippings = async () =>
    page.evaluate(() => {
      const bad = [];
      for (const node of document.querySelectorAll("[data-line-settings] *")) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") break;
        if (style.overflowX !== "visible") continue; // explicit scrollers are fine
        if (node.clientWidth === 0) continue;
        if (node.scrollWidth - node.clientWidth <= 1) continue;
        const text = (node.textContent ?? "").trim();
        if (!text) continue;
        // Name the widest child too: the culprit is usually one level in.
        let widest = null;
        for (const child of node.children) {
          if (child.scrollWidth - node.clientWidth > 1) {
            widest = {
              tag: child.tagName.toLowerCase(),
              cls: (child.className ?? "").toString().slice(0, 70),
              text: (child.textContent ?? "").trim().slice(0, 40),
              sw: child.scrollWidth,
            };
            break;
          }
        }
        bad.push({
          tag: node.tagName.toLowerCase(),
          cls: (node.className ?? "").toString().slice(0, 80),
          text: text.slice(0, 40),
          sw: node.scrollWidth,
          cw: node.clientWidth,
          widest,
        });
      }
      return bad;
    });

  const languages = [
    ["Deutsch", "Sprache"],
    ["Français", "Langue"],
    ["English", "Language"],
    ["Русский", "Язык"],
  ];
  for (const [label, heading] of languages) {
    const trigger = page.locator("#setting-language");
    await trigger.click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await page.getByText(heading, { exact: true }).first().waitFor();
    // The switch is synchronous: no network, no reload, the same DOM.
    const stillHere = await page
      .getByText("Память игры", { exact: false })
      .count();
    const clipped = await clippings();
    // One image per language, kept next to the run: the German settings screen
    // is the widest the interface ever gets, so it is the one worth looking at.
    await shot(`i18n-${label.toLowerCase()}`).catch(() => {});
    check(
      clipped.length === 0,
      `${label}: settings text overflows its box: ${JSON.stringify(clipped).slice(0, 300)}`,
    );
    check(
      label === "Русский" ? stillHere > 0 : stillHere === 0,
      `${label}: the switch did not replace the previous language's text`,
    );
  }

  // Back to Russian for the rest of the suite and for the stored setting.
  await page.locator("#setting-language").click();
  await page.getByRole("option", { name: "Русский", exact: true }).click();
  await page.getByText("Настройки", { exact: true }).first().waitFor();

  const languageCalls = await page.evaluate(() =>
    window.__calls
      .filter((c) => c[0] === "save_settings")
      .map((c) => c[1]?.settings?.language ?? null),
  );
  check(
    languageCalls.filter(Boolean).length >= 4,
    `the language was not persisted on every switch: ${JSON.stringify(languageCalls)}`,
  );

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
    "line_session",
    "forget_synced_skin",
    "line_logout",
    "list_skin_library",
    "add_skin_to_library",
    "read_skin_texture",
    "set_active_skin",
    "sync_active_skin",
    "delete_skin_from_library",
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
