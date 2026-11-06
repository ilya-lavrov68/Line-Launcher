/**
 * Runtime shape of the generated branding constants.
 *
 * `generated.ts` is annotated with this interface instead of `as const` so that
 * `attribution.placement` / `attribution.language` keep their full union types.
 * Otherwise a build using placement "footer" would make comparisons against
 * "header" a type error, and switching presets would not compile.
 */

export type AttributionPlacement = "footer" | "header";
export type AttributionLanguage = "ru" | "en" | "both";

export interface BrandAttribution {
  placement: AttributionPlacement;
  language: AttributionLanguage;
  /** Exact English credit. Build-time constant, not downstream-editable. */
  en: string;
  /** Exact Russian credit. Build-time constant, not downstream-editable. */
  ru: string;
}

export interface Brand {
  name: string;
  shortName: string;
  appId: string;
  publisher: string;
  windowTitle: string;
  description: string;
  /** Hashed asset URL, or null when the built-in mark is used. */
  logo: string | null;
  attribution: BrandAttribution;
}
