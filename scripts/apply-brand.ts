/**
 * Build-time branding generator.
 *
 *   npm run brand            # apply branding/line.brand.json
 *   npm run brand:check      # verify generated files are up to date (CI)
 *
 * Outputs (deterministic, committed):
 *   src/brand/generated.css         — palette overrides only, never geometry
 *   src/brand/generated.ts          — typed product/attribution constants
 *   src/brand/logo.svg|png          — copied header mark (if configured)
 *   src-tauri/tauri.brand.conf.json — Tauri overlay for `tauri build -c`
 *   src-tauri/icons/*               — regenerated OS icons via `tauri icon`
 *
 * The DEFAULT preset ("obsy") produces zero palette overrides, so the shipped
 * build inherits upstream Obsy's tokens and radii unchanged.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tauriCliCommand } from "./lib/tauri-cli.mjs";
import { sameText } from "./lib/text-eol.mjs";
import type { BrandConfig, BrandPalette } from "../branding/brand.types.ts";
import {
  renderCss,
  renderTauriOverlay,
  renderTs,
  validateBrand,
} from "./brand-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRANDING = join(ROOT, "branding");
const CONFIG_PATH = join(BRANDING, "line.brand.json");
const PRESETS_PATH = join(BRANDING, "presets.json");
const OUT_CSS = join(ROOT, "src/brand/generated.css");
const OUT_TS = join(ROOT, "src/brand/generated.ts");
const OUT_TAURI = join(ROOT, "src-tauri/tauri.brand.conf.json");
const ICONS_DIR = join(ROOT, "src-tauri/icons");

const CHECK_ONLY = process.argv.includes("--check");
const SKIP_ICONS = process.argv.includes("--skip-icons");

function fail(message: string): never {
  throw new Error(`[brand] ${message}`);
}

/** Write only when content differs, so repeat runs are quiet and idempotent. */
function writeIfChanged(path: string, content: string): boolean {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  // A CRLF checkout (Git for Windows default) must not look "out of date".
  if (sameText(current, content)) return false;
  if (CHECK_ONLY) fail(`${path} is out of date. Run: npm run brand`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

function main(): void {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as BrandConfig;
  const { presets } = JSON.parse(readFileSync(PRESETS_PATH, "utf8")) as {
    presets: Record<string, BrandPalette>;
  };
  const { palette, logoPath, appIconPath } = validateBrand(config, presets);
  const changed: string[] = [];

  if (writeIfChanged(OUT_CSS, renderCss(palette))) {
    changed.push("src/brand/generated.css");
  }

  // Copy the header mark next to generated.ts so Vite can hash the import.
  let logoExt: string | null = null;
  if (logoPath) {
    logoExt = extname(logoPath).toLowerCase();
    const target = join(ROOT, "src/brand", `logo${logoExt}`);
    const bytes = readFileSync(join(BRANDING, logoPath));
    const current = existsSync(target) ? readFileSync(target) : null;
    if (!current || !current.equals(bytes)) {
      if (CHECK_ONLY) fail(`${target} is out of date. Run: npm run brand`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      changed.push(`src/brand/logo${logoExt}`);
    }
  }
  for (const ext of [".svg", ".png"]) {
    if (ext === logoExt) continue;
    const stale = join(ROOT, "src/brand", `logo${ext}`);
    if (existsSync(stale)) {
      if (CHECK_ONLY) fail(`${stale} should be removed. Run: npm run brand`);
      rmSync(stale);
    }
  }

  if (writeIfChanged(OUT_TS, renderTs(config, logoExt))) {
    changed.push("src/brand/generated.ts");
  }

  // Icon generation is the slow step: only rerun when the source changes.
  if (appIconPath && !SKIP_ICONS) {
    const source = join(BRANDING, appIconPath);
    const stamp = `${createHash("sha256").update(readFileSync(source)).digest("hex")}\n`;
    const stampPath = join(ICONS_DIR, ".brand-source.sha256");
    const current = existsSync(stampPath)
      ? readFileSync(stampPath, "utf8")
      : null;
    if (!sameText(current, stamp)) {
      if (CHECK_ONLY)
        fail("src-tauri/icons is out of date. Run: npm run brand");
      console.log("[brand] generating OS icons via tauri icon…");
      // Never shell out to npx.cmd: Node >=18.20.2 throws EINVAL for .cmd
      // without a shell. Run the CLI entry point with this Node instead.
      const cli = tauriCliCommand(["icon", source, "-o", ICONS_DIR]);
      execFileSync(cli.command, cli.args, { cwd: ROOT, stdio: "inherit" });
      // Desktop-only product: drop generated mobile assets.
      for (const mobile of ["ios", "android"]) {
        rmSync(join(ICONS_DIR, mobile), { recursive: true, force: true });
      }
      writeFileSync(stampPath, stamp);
      changed.push("src-tauri/icons");
    }
  }

  if (
    writeIfChanged(OUT_TAURI, renderTauriOverlay(config, Boolean(appIconPath)))
  ) {
    changed.push("src-tauri/tauri.brand.conf.json");
  }

  if (CHECK_ONLY) {
    console.log("[brand] generated files are up to date");
    return;
  }
  console.log(
    changed.length === 0
      ? "[brand] already up to date"
      : `[brand] updated: ${changed.join(", ")}`,
  );
  console.log(
    `[brand] preset="${config.preset}", palette overrides=${Object.keys(palette).length}, ` +
      `attribution="${config.attribution.placement}/${config.attribution.language}" (mandatory)`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
