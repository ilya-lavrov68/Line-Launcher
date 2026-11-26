// Prefer an already-installed Chromium-family browser before the shared
// restore helper fetches Playwright's pinned browser. Windows typically has
// Edge; macOS and Linux often have Chrome or Chromium.
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * @returns {{ path: string, via: string } | null}
 */
export function findBrowser(env = process.env, platform = process.platform) {
  if (env.CHROMIUM_PATH && existsSync(env.CHROMIUM_PATH)) {
    return { path: env.CHROMIUM_PATH, via: "CHROMIUM_PATH" };
  }

  const candidates = [];
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    for (const root of [pf86, pf]) {
      // Edge first: present on every Windows 10/11 install.
      candidates.push({
        file: path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        via: "Microsoft Edge",
      });
    }
    for (const root of [pf, pf86]) {
      candidates.push({
        file: path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        via: "Google Chrome",
      });
    }
    if (env.LOCALAPPDATA) {
      candidates.push({
        file: path.join(
          env.LOCALAPPDATA,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        ),
        via: "Google Chrome (per-user)",
      });
    }
  } else if (platform === "darwin") {
    candidates.push(
      {
        file: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        via: "Google Chrome",
      },
      {
        file: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        via: "Microsoft Edge",
      },
      {
        file: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        via: "Chromium",
      },
    );
  } else {
    for (const name of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
    ]) {
      candidates.push({ file: name, via: path.basename(name) });
    }
  }

  const hit = candidates.find((c) => existsSync(c.file));
  // Same shape as the CHROMIUM_PATH branch: callers read `.path`.
  return hit ? { path: hit.file, via: hit.via } : null;
}

export function browserHelp(platform = process.platform) {
  const lines = [
    "Не найден браузер для UI-smoke. Любой из вариантов:",
    "  1) Использовать уже установленный Chrome или Edge — укажите путь:",
  ];
  if (platform === "win32") {
    lines.push(
      '     $env:CHROMIUM_PATH="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
    );
  } else if (platform === "darwin") {
    lines.push(
      '     export CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
    );
  } else {
    lines.push("     export CHROMIUM_PATH=/usr/bin/chromium");
  }
  lines.push(
    "  2) Восстановить закреплённый браузер:",
    "     npm run browser:restore",
    "     npx playwright-core install chromium (ручной запасной вариант)",
    "",
    "Не забудьте запустить dev-сервер в другом терминале: npm run dev",
  );
  return lines.join("\n");
}
