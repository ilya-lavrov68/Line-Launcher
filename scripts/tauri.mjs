// Wrapper around the Tauri CLI. Runs the environment doctor first, but only
// requires Rust for subcommands that actually invoke cargo. `tauri icon` and
// `tauri signer` work without a Rust toolchain.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const sub = argv.find((a) => !a.startsWith("-")) || "";

// Subcommands that shell out to cargo.
const NEEDS_RUST = new Set([
  "dev",
  "build",
  "run",
  "info",
  "add",
  "plugin",
  "android",
  "ios",
]);

if (NEEDS_RUST.has(sub)) {
  const doctor = spawnSync(
    process.execPath,
    [path.join(root, "scripts/doctor.mjs")],
    { stdio: "inherit" },
  );
  if (doctor.status !== 0) process.exit(doctor.status ?? 1);
}

// Resolve the CLI's JS entry point instead of relying on a shell shim.
let cli;
try {
  cli = require.resolve("@tauri-apps/cli/tauri.js");
} catch {
  cli = null;
}

const result = cli
  ? spawnSync(process.execPath, [cli, ...argv], {
      stdio: "inherit",
      cwd: root,
    })
  : spawnSync("tauri", argv, {
      stdio: "inherit",
      cwd: root,
      shell: process.platform === "win32",
    });

if (result.error) {
  console.error(`Не удалось запустить Tauri CLI: ${result.error.message}`);
  console.error("Проверьте, что зависимости установлены: npm ci");
  process.exit(1);
}
process.exit(result.status ?? 0);
