// Boot-path smoke: the launcher must connect exactly once on startup.
//
// Why this exists: React StrictMode mounts, cleans up and mounts again. A shared
// `mounted` ref is set back to true by the second run, so the first run's promise
// still passed its guard and the launcher fetched the provider config twice.
// That is invisible in a manual click-through but doubles startup traffic and
// can race two config publishes. This asserts the invariant in a real browser.
//
//   npm run dev            # in another terminal
//   npm run test:boot
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { browserHelp, findBrowser } from "./lib/find-browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures += 1;
};

/**
 * @param cached snapshot returned by get_cached_config, or null for a cold start
 * @param delay  ms the cached-config IPC takes, so StrictMode's remount lands
 *               while the first promise is still pending
 */
async function boot(cached, delay) {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 800 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ config, cached, delay }) => {
      window.isTauri = true;
      window.__calls = [];
      window.__callbacks = new Map();
      window.__cid = 1;
      window.__events = new Map();
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
          if (cmd === "plugin:event|listen") {
            const id = window.__cid++;
            window.__events.set(id, {
              event: args.event,
              handler: args.handler,
            });
            return id;
          }
          if (cmd === "plugin:event|unlisten") return null;
          if (cmd === "get_cached_config") {
            await new Promise((resolve) => setTimeout(resolve, delay));
            return cached;
          }
          if (cmd === "fetch_line_config")
            return {
              config,
              sourceUrl: args.url,
              fetchedAt: Date.now(),
              fromCache: false,
              stale: false,
            };
          if (cmd === "get_settings")
            return {
              settings: {
                heapMb: 4096,
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
          if (cmd === "list_java_runtimes") return [];
          if (cmd === "list_skin_library")
            return {
              library: { skins: [], active: null, synced: null },
              limit: 64,
            };
          if (cmd === "get_installed_build") return null;
          return null;
        },
      };
    },
    { config, cached, delay },
  );
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  // Let any duplicate in-flight request land before counting.
  await page.waitForTimeout(600);
  const calls = await page.evaluate(() =>
    window.__calls
      .filter((c) => c[0] === "fetch_line_config")
      .map((c) => c[1].url),
  );
  const settingsReads = await page.evaluate(
    () => window.__calls.filter((c) => c[0] === "get_settings").length,
  );
  await page.close();
  return { calls, settingsReads, errors };
}

const cachedSnapshot = {
  config,
  sourceUrl: "https://cached.example.com/config.json",
  fetchedAt: Date.now() - 60_000,
  fromCache: true,
  stale: false,
};

// A warm start revalidates the cached address — exactly once.
{
  const { calls, errors } = await boot(cachedSnapshot, 250);
  check(
    calls.length === 1,
    `a warm start must revalidate once, got ${calls.length}: ${calls.join(", ")}`,
  );
  check(
    calls[0] === cachedSnapshot.sourceUrl,
    "the cached address is the one revalidated",
  );
  check(errors.length === 0, `warm start page errors: ${errors.join("; ")}`);
}

// A cold start with no baked provider waits for the player instead of fetching.
{
  const { calls, errors } = await boot(null, 250);
  check(
    calls.length === 0,
    `a cold start must not fetch on its own, got ${calls.length}`,
  );
  check(errors.length === 0, `cold start page errors: ${errors.join("; ")}`);
}

// An instant cache read must not duplicate either (the other interleaving).
{
  const { calls } = await boot(cachedSnapshot, 0);
  check(
    calls.length === 1,
    `an instant cache read must revalidate once, got ${calls.length}`,
  );
}

await browser.close();
if (failures > 0) {
  console.error(`Boot smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("Boot smoke: passed (single connect on startup, 0 page errors)");
