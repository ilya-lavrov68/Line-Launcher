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
  ({ config }) => {
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
      transformCallback: (cb) => {
        const id = window.__cid++;
        window.__callbacks.set(id, cb);
        return id;
      },
      invoke: async (cmd, args) => {
        window.__calls.push([cmd, args]);
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
  { config },
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

  await page.getByRole("button", { name: "Открыть сервер Survival" }).click();
  await page.getByText("Аккаунт провайдера", { exact: true }).waitFor();
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
