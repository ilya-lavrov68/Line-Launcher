// Build the desktop installers.
//
// Windows needs two bundling passes because the two installers want the license
// in different shapes, and Tauri exposes a single `bundle.licenseFile`:
//
//   NSIS  renders licenseFile verbatim (MUI_PAGE_LICENSE, UTF-8 with BOM), so it
//         must stay the plain bilingual ../LICENSE.
//   MSI   feeds licenseFile to WiX. A non-.rtf file is wrapped in an
//         \ansicpg1252 RTF with the raw text, so Cyrillic cannot be stored in an
//         en-US database and light.exe fails with LGHT0311. The MSI pass adds
//         tauri.msi.conf.json, pointing at the ASCII-only LICENSE.rtf.
//
// The Rust binary is compiled once; the second pass reuses it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tauriCliCommand } from "./lib/tauri-cli.mjs";

export const BRAND_CONFIG = "src-tauri/tauri.brand.conf.json";
export const MSI_CONFIG = "src-tauri/tauri.msi.conf.json";

/**
 * Bundling passes for a platform, in order. Each pass is a set of extra CLI
 * arguments appended to `build -c <brand overlay>`.
 */
export function buildPasses(platform) {
  if (platform !== "win32") {
    return [{ label: "Desktop bundles", args: [] }];
  }
  return [
    {
      label: "NSIS installer (plain-text license)",
      args: ["--bundles", "nsis"],
    },
    {
      label: "MSI installer (ASCII RTF license)",
      args: ["--bundles", "msi", "-c", MSI_CONFIG],
    },
  ];
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const extraArgs = process.argv.slice(2);

  // An installer must name its one provider (branding/provider.json). Reuses the
  // real validator instead of a second copy of the rule. Players never type an
  // address, so shipping an unconfigured template would be a dead end.
  const provider = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(root, "scripts/apply-brand.ts"),
      "--require-provider",
      "--skip-icons",
    ],
    { stdio: "inherit", cwd: root },
  );
  if (provider.status !== 0) process.exit(provider.status ?? 1);

  // The doctor runs once, not per pass.
  const doctor = spawnSync(
    process.execPath,
    [path.join(root, "scripts/doctor.mjs")],
    { stdio: "inherit", cwd: root },
  );
  if (doctor.status !== 0) process.exit(doctor.status ?? 1);

  for (const pass of buildPasses(process.platform)) {
    console.log(`\n=== ${pass.label} ===`);
    const cli = tauriCliCommand([
      "build",
      "-c",
      BRAND_CONFIG,
      ...pass.args,
      ...extraArgs,
    ]);
    const result = spawnSync(cli.command, cli.args, {
      stdio: "inherit",
      cwd: root,
    });
    if (result.error) {
      console.error(`Не удалось запустить Tauri CLI: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
