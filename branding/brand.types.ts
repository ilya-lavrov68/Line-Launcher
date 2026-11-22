/**
 * Build-time branding contract for Line Launcher.
 *
 * This file is the single source of truth for `npm run brand`. It intentionally
 * has no runtime dependency: the generator (scripts/apply-brand.ts) imports the
 * types only, and the app consumes the generated `src/brand/generated.ts`.
 *
 * Design rule: the palette is FIXED. Re-branding changes the product name,
 * the logo and the icon — never the colours. The interface is built around this
 * exact palette (deep surfaces, one bright accent, status colours tuned against
 * them), and a swapped accent does not "re-brand" it, it breaks it: contrast
 * ratios that make the sidebar readable stop holding, and the animated
 * backdrops are generated against these hues.
 *
 * The old `preset`/`palette` keys were removed in 0.12.0 rather than kept with
 * a single "obsy" value: a setting with one legal value is an invitation to add
 * a second one in the next release. A config that still carries them fails
 * `npm run brand` with an explanation instead of silently building an
 * unpredictable interface.
 */

export interface BrandProduct {
  /** Full product name shown in the header and About dialog. */
  name: string;
  /** Compact name for tight spaces. */
  short_name: string;
  /** Reverse-DNS bundle identifier. Changing it changes the app-data directory. */
  app_id: string;
  publisher: string;
  window_title: string;
  description: string;
}

export interface BrandAssets {
  /**
   * Header/logo mark rendered inside the UI. Relative to `branding/`.
   * SVG or PNG. `null` keeps the built-in Material Symbols Rounded `layers` mark.
   */
  logo?: string | null;
  /**
   * Source for the OS application icon (.ico/.icns/PNG set). Relative to
   * `branding/`. Square SVG or PNG with transparency, ideally 1024x1024.
   */
  app_icon?: string | null;
}

export type AttributionPlacement = "footer" | "header";
export type AttributionLanguage = "ru" | "en" | "both";

/**
 * The Line Launcher / Plus In Plus credit is MANDATORY.
 *
 * LICENSE makes the exact credit a condition of permission to use Line
 * Materials. A config may choose footer/header and language, but cannot
 * switch it off or make it About-only. About always repeats the credit.
 */
export interface BrandAttribution {
  placement: AttributionPlacement;
  language: AttributionLanguage;
}

export interface BrandConfig {
  product: BrandProduct;
  assets: BrandAssets;
  attribution: BrandAttribution;
}

/**
 * Keys that used to configure colours. They are rejected by name so an older
 * config gets "the palette is fixed" instead of a generic unknown-key error,
 * which would suggest the key moved somewhere.
 */
export const REMOVED_PALETTE_KEYS = ["preset", "palette"] as const;

export const ATTRIBUTION_PLACEMENTS = [
  "footer",
  "header",
] as const satisfies readonly AttributionPlacement[];

export const ATTRIBUTION_LANGUAGES = [
  "ru",
  "en",
  "both",
] as const satisfies readonly AttributionLanguage[];

/** Exact credit strings. Not configurable, not translatable by downstream. */
export const ATTRIBUTION_TEXT = {
  en: "Powered by Line Launcher | Plus In Plus",
  ru: "Работает на Line Launcher | Plus In Plus",
} as const;
