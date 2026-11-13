/**
 * Build-time branding generator.
 *
 *   npm run brand            # apply branding/line.brand.json
 *   npm run brand:check      # verify generated files are up to date (CI)
 *
 * Outputs (deterministic, committed):
 *   src/brand/generated.css         — always empty: the palette is fixed
 *   src/brand/generated.ts          — typed product/attribution constants
 *   src/brand/logo.svg|png          — copied header mark (if configured)
 *   src-tauri/tauri.brand.conf.json — Tauri overlay for `tauri build -c`
 *   src-tauri/icons/*               — regenerated OS icons via `tauri icon`
 *   src-tauri/LICENSE.rtf           — ASCII-only RTF of LICENSE for the MSI dialog
 *
 * The palette is not configurable: the build uses upstream Obsy's tokens and
 * radii unchanged, and a config that tries to set colours fails here.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { licenseToRtf } from "./lib/license-rtf.mjs";
import { tauriCliCommand } from "./lib/tauri-cli.mjs";
import { sameText } from "./lib/text-eol.mjs";
import type { BrandConfig } from "../branding/brand.types.ts";
import {
  renderCss,
  renderOwnerTs,
  renderTauriOverlay,
  renderTs,
  validateBrand,
  validateSupportEmail,
} from "./brand-config.ts";
import {
  renderProviderTs,
  requireConfigured,
  validateProvider,
} from "./provider-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRANDING = join(ROOT, "branding");
const CONFIG_PATH = join(BRANDING, "line.brand.json");
const OUT_CSS = join(ROOT, "src/brand/generated.css");
const OUT_TS = join(ROOT, "src/brand/generated.ts");
const OUT_TAURI = join(ROOT, "src-tauri/tauri.brand.conf.json");
const PROVIDER_PATH = join(BRANDING, "provider.json");
// The publisher's file, deliberately outside the brand schema: re-branding a
// build must not be able to redirect a player's diagnostics.
const OWNER_PATH = join(BRANDING, "owner.ts");
const OUT_OWNER = join(ROOT, "src/brand/owner.generated.ts");
const OUT_PROVIDER = join(ROOT, "src/brand/provider.generated.ts");
const ICONS_DIR = join(ROOT, "src-tauri/icons");

const CHECK_ONLY = process.argv.includes("--check");
const SKIP_ICONS = process.argv.includes("--skip-icons");
// Installers must name their one provider; the dev template may stay empty.
const REQUIRE_PROVIDER = process.argv.includes("--require-provider");

function fail(message: string): never {
  throw new Error(`[brand] ${message}`);
}

/** Write only when content differs, so repeat runs are quiet and idempotent. */
/** Asset paths in the config are relative to branding/, not to the repo root. */
function missingAsset(field: string, rel: string, absolute: string): string {
  const hint = rel.startsWith("branding/")
    ? `\nПохоже, путь указан от корня репозитория. Уберите префикс: "${rel.slice("branding/".length)}".`
    : "";
  return (
    `${field} указывает на отсутствующий файл: ${absolute}\n` +
    `Пути в assets.* задаются относительно каталога branding/.${hint}\n` +
    `Положите файл на место или задайте ${field} = null в branding/line.brand.json.`
  );
}

function writeIfChanged(path: string, content: string): boolean {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  // A CRLF checkout (Git for Windows default) must not look "out of date".
  if (sameText(current, content)) return false;
  if (CHECK_ONLY) fail(`${path} is out of date. Run: npm run brand`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as BrandConfig;
  // `presets.json` was an input of the removed palette feature. Its absence is
  // the normal state now; its presence means the checkout still expects colours
  // to be configurable, so say that plainly instead of ignoring the file.
  if (existsSync(join(BRANDING, "presets.json"))) {
    fail(
      "branding/presets.json is no longer used: the launcher palette is fixed. " +
        "Delete the file and remove preset/palette from branding/line.brand.json. " +
        "See docs/BRANDING.md.",
    );
  }
  const { logoPath, appIconPath } = validateBrand(config);
  const changed: string[] = [];

  // Provider address: baked at build time so players never type a URL.
  if (!existsSync(PROVIDER_PATH) && REQUIRE_PROVIDER) {
    fail("branding/provider.json is missing. Create it with your config_url.");
  }
  if (existsSync(PROVIDER_PATH)) {
    const provider = validateProvider(
      JSON.parse(readFileSync(PROVIDER_PATH, "utf8")),
    );
    if (REQUIRE_PROVIDER) requireConfigured(provider);
    if (writeIfChanged(OUT_PROVIDER, renderProviderTs(provider))) {
      changed.push("src/brand/provider.generated.ts");
    }
    console.log(
      provider.configUrl
        ? `[provider] ${provider.configUrl}`
        : "[provider] config_url пуст — шаблон не настроен (для установщика заполните его)",
    );
  }

  // Publisher support address. `branding/owner.ts` is a plain module, so it is
  // imported rather than parsed: one source of truth, checked by `tsc` as well.
  if (!existsSync(OWNER_PATH)) {
    fail(
      "branding/owner.ts is missing. It holds the publisher's support address " +
        "and is not part of the brand config. Restore it from the template.",
    );
  }
  const owner = (await import(pathToFileURL(OWNER_PATH).href)) as {
    OWNER?: { support_email?: unknown; support_name?: unknown };
  };
  if (!owner.OWNER) fail("branding/owner.ts must export OWNER");
  const supportEmail = validateSupportEmail(
    "owner.support_email",
    owner.OWNER.support_email ?? null,
  );
  const supportName =
    typeof owner.OWNER.support_name === "string" &&
    owner.OWNER.support_name.trim()
      ? owner.OWNER.support_name.trim()
      : "Line Launcher";
  if (writeIfChanged(OUT_OWNER, renderOwnerTs(supportEmail, supportName))) {
    changed.push("src/brand/owner.generated.ts");
  }
  console.log(
    supportEmail
      ? `[owner] support mail: ${supportEmail}`
      : "[owner] support_email пуст — кнопки «Отправить по почте» не будет",
  );

  if (writeIfChanged(OUT_CSS, renderCss())) {
    changed.push("src/brand/generated.css");
  }

  // Copy the header mark next to generated.ts so Vite can hash the import.
  let logoExt: string | null = null;
  let logoTinted = false;
  if (logoPath) {
    logoExt = extname(logoPath).toLowerCase();
    const target = join(ROOT, "src/brand", `logo${logoExt}`);
    const logoSource = join(BRANDING, logoPath);
    if (!existsSync(logoSource))
      fail(missingAsset("assets.logo", logoPath, logoSource));
    const bytes = readFileSync(logoSource);
    // A monochrome mark authored with currentColor is tinted by the palette.
    logoTinted =
      logoExt === ".svg" && /\bcurrentColor\b/i.test(bytes.toString("utf8"));
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

  if (writeIfChanged(OUT_TS, renderTs(config, logoExt, logoTinted))) {
    changed.push("src/brand/generated.ts");
  }

  // Icon generation is the slow step: only rerun when the source changes.
  if (appIconPath && !SKIP_ICONS) {
    const source = join(BRANDING, appIconPath);
    if (!existsSync(source))
      fail(missingAsset("assets.app_icon", appIconPath, source));
    const stamp = `${createHash("sha256").update(readFileSync(source)).digest("hex")}\n`;
    const stampPath = join(ICONS_DIR, ".brand-source.sha256");
    const current = existsSync(stampPath)
      ? readFileSync(stampPath, "utf8")
      : null;
    if (!sameText(current, stamp)) {
      if (CHECK_ONLY)
        fail(
          "src-tauri/icons is out of date (the app icon changed, or the set was " +
            "never regenerated). Run: npm run brand — then rebuild the installer, " +
            "because an already-installed shortcut keeps the icon it was " +
            "installed with.",
        );
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

  // WiX cannot put the bilingual LICENSE into an en-US MSI (code page 1252).
  // An .rtf licenseFile is passed through untouched, so emit ASCII-only RTF
  // with \uN escapes: builds under any code page and still renders Cyrillic.
  const licensePath = join(ROOT, "LICENSE");
  if (existsSync(licensePath)) {
    const rtf = licenseToRtf(readFileSync(licensePath, "utf8"));
    if (writeIfChanged(join(ROOT, "src-tauri", "LICENSE.rtf"), rtf)) {
      changed.push("src-tauri/LICENSE.rtf");
    }
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
    `[brand] palette=fixed (Obsy), ` +
      `attribution="${config.attribution.placement}/${config.attribution.language}" (mandatory)`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
