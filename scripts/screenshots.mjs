// Regenerate the interface screenshots used by README.md.
//
//   npm run dev            # in another terminal
//   npm run screenshots
//
// The images are real renders of the real components, driven by a test-only
// Tauri IPC stub and the demo provider from examples/config.json. Artwork is
// generated here (gradients, not the 1x1 red pixel the smoke suite uses) so the
// documentation shows what a configured project actually looks like.
//
// line-connecting.png is only captured when branding/provider.json names a
// provider, because an unconfigured dev template shows the URL field instead.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { browserHelp, findBrowser } from "./lib/find-browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs/images");
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

/** Gradient artwork as an inline SVG data URL. */
function art(from, to, glyph) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 200">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="640" height="200" fill="url(#g)"/>
  <g fill="#ffffff" opacity="0.07">
    <circle cx="548" cy="34" r="96"/><circle cx="96" cy="188" r="72"/>
  </g>
  <g fill="#ffffff" opacity="0.13">
    <rect x="40" y="120" width="26" height="26" rx="4"/>
    <rect x="74" y="94" width="26" height="52" rx="4"/>
    <rect x="108" y="108" width="26" height="38" rx="4"/>
  </g>
  <text x="320" y="112" font-family="DejaVu Sans, sans-serif" font-size="30"
        font-weight="700" fill="#ffffff" opacity="0.9" text-anchor="middle">${glyph}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function icon(from, to, letter) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
  </linearGradient></defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <text x="64" y="86" font-family="DejaVu Sans, sans-serif" font-size="62"
        font-weight="700" fill="#ffffff" text-anchor="middle">${letter}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// The demo config ships without launch endpoints. Enable them so the screenshots
// show the real play state rather than "Запуск не настроен".
config.servers[0].auth = {
  launch_ticket_url: "https://auth.example.com/v1/launcher/ticket",
  session_exchange_url: "https://auth.example.com/v1/launcher/exchange",
};

const themes = [
  ["#0f766e", "#052e2b", "SURVIVAL", "S"],
  ["#1d4ed8", "#0b1a3a", "SKYBLOCK", "K"],
  ["#b45309", "#3b1004", "CREATIVE", "C"],
];
config.servers = config.servers.map((server, index) => {
  const [from, to, glyph, letter] = themes[index % themes.length];
  return {
    ...server,
    banner_url: art(from, to, glyph),
    icon_url: icon(from, to, letter),
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

const page = await browser.newPage({
  viewport: { width: 1280, height: 860 },
  reducedMotion: "reduce",
  deviceScaleFactor: 1,
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
  ({ config, skins, installed, configured }) => {
    window.isTauri = true;
    window.__callbacks = new Map();
    window.__cid = 1;
    window.__events = new Map();
    window.__session = null;
    window.__installed = installed;
    window.__library = {
      skins: skins.map((s) => s.entry),
      active: skins[0].entry.id,
      // Already accepted by the provider: the status shows the settled state.
      synced: skins[0].entry.id,
    };
    const bytes = Object.fromEntries(skins.map((s) => [s.entry.id, s.bytes]));
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
          // Only the connecting screenshot needs a slow fetch. In the dev
          // template a cached config is shown first and revalidated in the
          // background; a slow revalidation would reset the screen mid-click.
          if (configured)
            await new Promise((resolve) => setTimeout(resolve, 2500));
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
              sidebarCollapsed: false,
              afterLaunch: "minimize",
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
        if (cmd === "read_skin_texture") return bytes[args.id] || [];
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
        if (cmd === "get_installed_build") return window.__installed;
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
  { config, skins, installed, configured },
);

async function shot(name, height = 860) {
  // Long screens are captured at their full height instead of being cropped.
  await page.setViewportSize({ width: 1280, height });
  // Obsy's animated background never settles; freeze it for a stable image.
  await page.mouse.move(1270, height - 10);
  await page.waitForTimeout(350);
  const file = path.join(outDir, `line-${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  console.log(`docs/images/line-${name}.png`);
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  if (configured) {
    await page
      .getByRole("heading", { name: "Подключение к проекту" })
      .waitFor();
    await shot("connecting", 480);
  } else {
    console.log(
      "skip line-connecting.png: branding/provider.json is empty (dev template)",
    );
  }

  // The single sign-in gate: one account for the whole project.
  await page.getByText("Аккаунт проекта", { exact: true }).waitFor();
  await shot("account");

  await page.getByLabel("Логин", { exact: true }).fill("Player_1");
  await page.getByLabel("Пароль", { exact: true }).fill("demo-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByRole("button", { name: /Открыть сервер Survival/ }).waitFor();
  await shot("servers");

  // Every server is already unlocked: no second login, straight to the build.
  await page.getByRole("button", { name: /Открыть сервер Survival/ }).click();
  await page.getByRole("button", { name: "Играть", exact: true }).waitFor();
  await shot("server");

  await page.getByRole("button", { name: "Гардероб", exact: true }).click();
  await page.getByRole("heading", { name: "Локальная история" }).waitFor();
  await shot("wardrobe", 1000);

  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("heading", { name: "Память игры" }).waitFor();
  await shot("settings", 1060);

  if (errors.length > 0) {
    console.error("page errors:", errors);
    process.exitCode = 1;
  } else {
    console.log("Screenshots regenerated (0 page errors)");
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
}
