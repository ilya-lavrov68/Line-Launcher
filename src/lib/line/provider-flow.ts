import type { BakedProvider, BakedProviders } from "@/brand/provider-types";

/**
 * Connection decisions for a build whose providers were declared in
 * `branding/provider.json`.
 *
 * Kept pure and separate from the component so the rules are unit-tested rather
 * than asserted against source text. Rust re-validates every URL before use;
 * these helpers only decide what the player is shown.
 */

/** Trailing slashes are not meaningful for a config URL identity. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** True when the build lets the player type an arbitrary config URL at all. */
export function manualEntryAllowed(baked: BakedProviders): boolean {
  return baked.providers.length === 0 || baked.allowManualUrl;
}

/**
 * Whether the first screen is the manual URL field. A baked build starts on the
 * picker (or connects by itself) — never on an empty URL input.
 */
export function startsWithManualEntry(baked: BakedProviders): boolean {
  return baked.providers.length === 0;
}

/** The single provider to connect to on launch, if the build names exactly one. */
export function autoConnectProvider(
  baked: BakedProviders,
): BakedProvider | undefined {
  return baked.providers.length === 1 ? baked.providers[0] : undefined;
}

/**
 * Whether a cached config may be reused. A locked build only trusts its own
 * addresses, so a universal build's cache cannot carry a player into an
 * unrelated provider after an update.
 */
export function isAllowedCachedUrl(
  baked: BakedProviders,
  url: string,
): boolean {
  if (manualEntryAllowed(baked)) return true;
  return baked.providers.some(
    (provider) => normalize(provider.configUrl) === normalize(url),
  );
}
