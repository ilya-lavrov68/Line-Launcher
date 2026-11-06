/**
 * Build-time branding contract for Line Launcher.
 *
 * This file is the single source of truth for `npm run brand`. It intentionally
 * has no runtime dependency: the generator (scripts/apply-brand.ts) imports the
 * types only, and the app consumes the generated `src/brand/generated.ts`.
 *
 * Design rule: the DEFAULT preset ("obsy") must leave the upstream Obsy palette
 * and radii untouched. Presets exist so downstream projects can re-brand fast,
 * not to redesign the launcher.
 */

/** Semantic colour slots. Values are CSS colours (hex/oklch/rgb/hsl). */
export interface BrandPalette {
  /** Page background base. Obsy also animates a gradient on top of it. */
  background?: string;
  foreground?: string;
  card?: string;
  card_foreground?: string;
  popover?: string;
  popover_foreground?: string;
  primary?: string;
  primary_foreground?: string;
  secondary?: string;
  secondary_foreground?: string;
  muted?: string;
  muted_foreground?: string;
  accent?: string;
  accent_foreground?: string;
  destructive?: string;
  border?: string;
  input?: string;
  ring?: string;
}

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
   * SVG or PNG. `null` keeps the built-in Lucide Layers2 mark.
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
  /** Named preset applied first; `palette` overrides it slot by slot. */
  preset: string;
  product: BrandProduct;
  assets: BrandAssets;
  palette: BrandPalette;
  attribution: BrandAttribution;
}

/** Palette slots the generator is allowed to emit, in stable order. */
export const PALETTE_SLOTS = [
  "background",
  "foreground",
  "card",
  "card_foreground",
  "popover",
  "popover_foreground",
  "primary",
  "primary_foreground",
  "secondary",
  "secondary_foreground",
  "muted",
  "muted_foreground",
  "accent",
  "accent_foreground",
  "destructive",
  "border",
  "input",
  "ring",
] as const satisfies readonly (keyof BrandPalette)[];

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
