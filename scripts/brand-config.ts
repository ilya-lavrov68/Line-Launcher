/**
 * Pure branding validation + rendering. No filesystem, no child processes, so
 * it can be unit-tested directly (tests/brand.test.ts).
 *
 * Hard rules enforced here:
 *  - Only semantic COLOUR slots may be overridden. Radii/spacing/geometry are
 *    rejected, because Line must keep upstream Obsy's UI geometry.
 *  - The exact Line Launcher | Plus In Plus credit is a license condition.
 *    Only footer/header placement and ru/en/both language are configurable.
 *  - Colour values must be plain colours: no var(), url(), or CSS injection.
 *  - Asset paths must stay inside branding/ and be .svg or .png.
 */
import {
  ATTRIBUTION_LANGUAGES,
  ATTRIBUTION_PLACEMENTS,
  ATTRIBUTION_TEXT,
  PALETTE_SLOTS,
  type BrandConfig,
  type BrandPalette,
} from "../branding/brand.types.ts";

export class BrandError extends Error {
  constructor(message: string) {
    super(`[brand] ${message}`);
    this.name = "BrandError";
  }
}

function fail(message: string): never {
  throw new BrandError(message);
}

/** A colour slot must be a plain CSS colour, never a reference or a rule. */
const COLOR_RE =
  /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|color)\([-\w\s.,%/+()]*\)|[a-zA-Z]+)$/;

export function validateColor(slot: string, value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    fail(`palette.${slot} must be a non-empty trimmed string`);
  }
  if (value.length > 120 || !COLOR_RE.test(value)) {
    fail(`palette.${slot} is not a plain CSS colour: ${value}`);
  }
  if (/var\(|url\(|expression|;|\{|\}|\/\*|\*\//i.test(value)) {
    fail(`palette.${slot} must not contain var(), url() or CSS syntax`);
  }
  return value;
}

function validateText(field: string, value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(`${field} must be a non-empty string of at most ${max} characters`);
  }
  if (/[\u0000-\u001f<>{}"`\\]/.test(value)) {
    fail(`${field} contains control or markup characters`);
  }
  return value;
}

export function validateAppId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9-]*)+$/.test(value)
  ) {
    fail(
      "product.app_id must be reverse-DNS, e.g. com.example.launcher (letters, digits, hyphens, dots)",
    );
  }
  return value;
}

/** Validate a branding-relative asset path. Returns the normalised relative path. */
export function validateAssetPath(
  field: string,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value) {
    fail(`${field} must be a relative path string or null`);
  }
  if (value.startsWith("/") || value.includes("..") || value.includes("\\")) {
    fail(`${field} must be a relative path inside branding/ without ".."`);
  }
  const lower = value.toLowerCase();
  if (!lower.endsWith(".svg") && !lower.endsWith(".png")) {
    fail(`${field} must point to an .svg or .png file`);
  }
  return value;
}

export interface ValidatedBrand {
  config: BrandConfig;
  /** Merged preset + overrides, ready to emit as CSS custom properties. */
  palette: Record<string, string>;
  logoPath: string | null;
  appIconPath: string | null;
}

export function validateBrand(
  config: BrandConfig,
  presets: Record<string, BrandPalette>,
): ValidatedBrand {
  if (typeof config.preset !== "string") fail("preset must be a string");
  const preset = presets[config.preset];
  if (!preset) {
    fail(
      `unknown preset "${config.preset}". Available: ${Object.keys(presets).join(", ")}`,
    );
  }

  const product = config.product;
  if (!product) fail("product section is required");
  validateText("product.name", product.name, 60);
  validateText("product.short_name", product.short_name, 24);
  validateText("product.publisher", product.publisher, 60);
  validateText("product.window_title", product.window_title, 80);
  validateText("product.description", product.description, 200);
  validateAppId(product.app_id);

  const attribution = config.attribution;
  if (!attribution || typeof attribution !== "object") {
    fail(
      "attribution is required. The Line Launcher | Plus In Plus credit cannot be removed.",
    );
  }
  if ("enabled" in attribution) {
    fail(
      "attribution.enabled is not supported: the Line Launcher | Plus In Plus credit is mandatory.",
    );
  }
  for (const key of Object.keys(attribution)) {
    if (key !== "placement" && key !== "language") {
      fail(
        `attribution.${key} is not supported: the Line Launcher | Plus In Plus credit is mandatory and its text cannot be customized.`,
      );
    }
  }
  if (
    !ATTRIBUTION_PLACEMENTS.includes(
      attribution.placement as (typeof ATTRIBUTION_PLACEMENTS)[number],
    )
  ) {
    fail(
      `attribution.placement must be one of: ${ATTRIBUTION_PLACEMENTS.join(", ")}. The credit must stay visible in the main interface; About is an additional copy, not an About-only placement.`,
    );
  }
  if (
    !ATTRIBUTION_LANGUAGES.includes(
      attribution.language as (typeof ATTRIBUTION_LANGUAGES)[number],
    )
  ) {
    fail(
      `attribution.language must be one of: ${ATTRIBUTION_LANGUAGES.join(", ")}`,
    );
  }

  const merged: Record<string, string> = {};
  for (const [source, values] of [
    ["preset", preset],
    ["palette", config.palette ?? {}],
  ] as const) {
    for (const [slot, value] of Object.entries(values ?? {})) {
      if (!(PALETTE_SLOTS as readonly string[]).includes(slot)) {
        fail(
          `${source}: unknown palette slot "${slot}". Only semantic colours may be overridden; Obsy's radii and geometry are fixed.`,
        );
      }
      merged[slot] = validateColor(slot, value);
    }
  }

  return {
    config,
    palette: merged,
    logoPath: validateAssetPath("assets.logo", config.assets?.logo ?? null),
    appIconPath: validateAssetPath(
      "assets.app_icon",
      config.assets?.app_icon ?? null,
    ),
  };
}

const CSS_HEADER = `/* GENERATED by npm run brand — do not edit by hand.
 * Source: branding/line.brand.json + branding/presets.json
 * Colour slots only. Obsy's radii, spacing and component geometry are never
 * overridden here.
 */
`;

export function renderCss(palette: Record<string, string>): string {
  const entries = PALETTE_SLOTS.filter((slot) => palette[slot] !== undefined);
  if (entries.length === 0) {
    return `${CSS_HEADER}\n/* preset "obsy": upstream Obsy tokens are inherited unchanged. */\n`;
  }
  const body = entries
    .map((slot) => `  --${slot.replace(/_/g, "-")}: ${palette[slot]};`)
    .join("\n");
  return `${CSS_HEADER}\n:root {\n${body}\n}\n`;
}

export function renderTs(
  config: BrandConfig,
  logoExt: string | null,
  logoTinted = false,
): string {
  const p = config.product;
  const attribution = {
    placement: config.attribution.placement,
    language: config.attribution.language,
    en: ATTRIBUTION_TEXT.en,
    ru: ATTRIBUTION_TEXT.ru,
  };
  // A real import lets Vite fingerprint/hash the asset; a bare string would not.
  const logoImport = logoExt
    ? `import logoUrl from "./logo${logoExt}";\n\n`
    : "";
  const attributionBody = Object.entries(attribution)
    .map(([key, value]) => `    ${key}: ${JSON.stringify(value)},`)
    .join("\n");
  return `/* GENERATED by npm run brand — do not edit by hand.
 * Source: branding/line.brand.json
 */
import type { Brand } from "./types";
${logoImport ? `\n${logoImport}` : ""}
export const brand: Brand = {
  name: ${JSON.stringify(p.name)},
  shortName: ${JSON.stringify(p.short_name)},
  appId: ${JSON.stringify(p.app_id)},
  publisher: ${JSON.stringify(p.publisher)},
  windowTitle: ${JSON.stringify(p.window_title)},
  description: ${JSON.stringify(p.description)},
  logo: ${logoExt ? "logoUrl" : "null"},
  logoTinted: ${logoExt === ".svg" && logoTinted ? "true" : "false"},
  attribution: {
${attributionBody}
  },
};
`;
}

/**
 * Mirrors the window block in src-tauri/tauri.conf.json. Kept next to the
 * renderer and asserted against the real file by tests/brand.test.ts, so the two
 * cannot drift apart silently.
 */
export const BASE_WINDOW = {
  label: "main",
  width: 1100,
  height: 720,
  minWidth: 800,
  minHeight: 560,
  resizable: true,
  center: true,
  fullscreen: false,
  decorations: false,
} as const;

export function renderTauriOverlay(
  config: BrandConfig,
  hasIcons: boolean,
): string {
  const p = config.product;
  const bundle: Record<string, unknown> = {
    shortDescription: p.description,
    publisher: p.publisher,
  };
  if (hasIcons) {
    bundle.icon = [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico",
    ];
  }
  return `${JSON.stringify(
    {
      productName: p.name,
      identifier: p.app_id,
      // Tauri merges configs with RFC 7386, which REPLACES arrays. Emitting a
      // bare [{ title }] here would drop width/height/min*/decorations from
      // tauri.conf.json and bring the native title bar back over the custom one.
      // Carry the full window object so branding only changes the title.
      app: { windows: [{ ...BASE_WINDOW, title: p.window_title }] },
      bundle,
    },
    null,
    2,
  )}\n`;
}
