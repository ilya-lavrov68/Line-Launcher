import type { BakedProvider } from "@/brand/provider-types";

/**
 * Connection decisions for a build that names exactly one provider.
 *
 * Kept pure and separate from the component so the rules are unit-tested rather
 * than asserted against source text. Rust re-validates the URL before use; these
 * helpers only decide what the player is shown.
 */

export type ConnectionMode =
  /** Configured build: connect to the baked address, no address screen at all. */
  | "auto"
  /** Unconfigured template under `npm run dev`: developer may type an address. */
  | "dev-url"
  /** Unconfigured release: refuse to start rather than let players guess. */
  | "unconfigured";

/** Trailing slashes and whitespace are not a different address. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isConfigured(baked: BakedProvider): boolean {
  return baked.configUrl.trim().length > 0;
}

export function connectionMode(
  baked: BakedProvider,
  dev: boolean,
): ConnectionMode {
  if (isConfigured(baked)) return "auto";
  return dev ? "dev-url" : "unconfigured";
}

/**
 * Whether a cached config may be reused. A configured build only trusts its own
 * address, so a cache left by a dev run cannot carry a player somewhere else.
 */
export function isAllowedCachedUrl(baked: BakedProvider, url: string): boolean {
  if (!isConfigured(baked)) return true;
  return normalize(baked.configUrl) === normalize(url);
}
