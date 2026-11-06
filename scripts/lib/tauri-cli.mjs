// Resolve the Tauri CLI to something spawnable without a shell.
//
// On Windows the bin is `tauri.cmd` / `npx.cmd`. Since Node 18.20.2 / 20.12.2
// (CVE-2024-27980) spawning a .cmd/.bat without `shell: true` throws EINVAL, and
// going through a shell re-introduces argument-quoting problems. Running the
// CLI's JS entry point with the current Node executable avoids both.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * @param {string[]} args arguments for the Tauri CLI
 * @returns {{ command: string, args: string[] }} spawn without a shell
 */
export function tauriCliCommand(args = []) {
  let entry;
  try {
    entry = require.resolve("@tauri-apps/cli/tauri.js");
  } catch {
    // Walk up from this file to the repo root so the message is actionable.
    const root = path.resolve(here, "../..");
    throw new Error(
      `Не найден @tauri-apps/cli. Установите зависимости: npm ci (в ${root})`,
    );
  }
  return { command: process.execPath, args: [entry, ...args] };
}
