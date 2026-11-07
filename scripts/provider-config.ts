/**
 * Build-time provider catalogue.
 *
 * The B2B intent: a server owner builds a branded launcher that already knows
 * where its config lives. The player never sees a URL field — they open the
 * launcher, register/sign in, and play. `branding/provider.json` is that input.
 *
 * Security: this is compiled into the binary, so it is held to exactly the same
 * HTTPS rule as a URL typed at runtime (src-tauri/src/line/config.rs). A build
 * must not be able to bake in an http:// URL, credentials, or a fragment.
 */

export interface ProviderEntry {
  /** Stable slug, used as a React key and for the last-used marker. */
  id: string;
  /** Shown in the picker when several providers are baked in. */
  name: string;
  /** HTTPS URL of the provider's config.json. */
  config_url: string;
}

export interface ProviderConfig {
  /**
   * Keep the manual URL screen available. Off by default: a branded build
   * should not let players point the launcher at an arbitrary provider.
   */
  allow_manual_url?: boolean;
  providers: ProviderEntry[];
}

export class ProviderConfigError extends Error {}

const MAX_PROVIDERS = 20;
const MAX_URL_LENGTH = 2048;

function fail(message: string): never {
  throw new ProviderConfigError(`[provider] ${message}`);
}

function validateSlug(field: string, value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    fail(`${field} must be a lowercase slug (a-z, 0-9, - and _), 1..64 chars`);
  }
  return value;
}

function validateName(field: string, value: unknown): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) {
    fail(`${field} must be 1..100 characters`);
  }
  if ([...trimmed].some((c) => c.charCodeAt(0) < 0x20)) {
    fail(`${field} must not contain control characters`);
  }
  return trimmed;
}

/** Mirrors validate_https in Rust. Kept in sync by tests/provider-config.test.ts. */
export function validateConfigUrl(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${field} must be a non-empty HTTPS URL`);
  }
  const raw = value.trim();
  if (raw.length > MAX_URL_LENGTH)
    fail(`${field} is longer than 2048 characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`${field} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    fail(
      `${field} must use https:// (got ${url.protocol}). A launcher build cannot ` +
        `ship a plaintext provider endpoint.`,
    );
  }
  if (!url.hostname) {
    fail(`${field} must name a host`);
  }
  if (url.username || url.password) {
    fail(`${field} must not embed credentials`);
  }
  if (url.hash) {
    fail(`${field} must not contain a #fragment`);
  }
  return url.toString();
}

export interface ValidatedProviders {
  allowManualUrl: boolean;
  providers: { id: string; name: string; configUrl: string }[];
}

export function validateProviders(input: unknown): ValidatedProviders {
  if (!input || typeof input !== "object") fail("config must be an object");
  const config = input as Record<string, unknown>;
  const allowManualUrl = config.allow_manual_url ?? false;
  if (typeof allowManualUrl !== "boolean") {
    fail("allow_manual_url must be a boolean");
  }
  const list = config.providers ?? [];
  if (!Array.isArray(list)) fail("providers must be an array");
  if (list.length > MAX_PROVIDERS) fail(`at most ${MAX_PROVIDERS} providers`);

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const providers = list.map((raw, index) => {
    if (!raw || typeof raw !== "object")
      fail(`providers[${index}] must be an object`);
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!["id", "name", "config_url"].includes(key)) {
        fail(`providers[${index}]: unknown key "${key}"`);
      }
    }
    const id = validateSlug(`providers[${index}].id`, entry.id);
    if (seenIds.has(id)) fail(`duplicate provider id "${id}"`);
    seenIds.add(id);
    const name = validateName(`providers[${index}].name`, entry.name);
    const configUrl = validateConfigUrl(
      `providers[${index}].config_url`,
      entry.config_url,
    );
    if (seenUrls.has(configUrl)) fail(`duplicate config_url: ${configUrl}`);
    seenUrls.add(configUrl);
    return { id, name, configUrl };
  });

  // An empty catalogue with no manual entry would produce a launcher nobody can
  // connect with. Refuse the build instead of shipping a dead end.
  if (providers.length === 0 && !allowManualUrl) {
    fail(
      "providers is empty and allow_manual_url is false: the built launcher " +
        "would have no way to connect. Add a provider or allow manual entry.",
    );
  }
  return { allowManualUrl, providers };
}

export function renderProviderTs(config: ValidatedProviders): string {
  const entries = config.providers
    .map(
      (p) =>
        `    { id: ${JSON.stringify(p.id)}, name: ${JSON.stringify(p.name)}, configUrl: ${JSON.stringify(p.configUrl)} },`,
    )
    .join("\n");
  return `/* GENERATED by npm run brand — do not edit by hand.
 * Source: branding/provider.json
 *
 * Baked in at build time. The Rust layer re-validates every URL before use, so
 * this file is a convenience, not a trust boundary.
 */
import type { BakedProviders } from "./provider-types";

export const bakedProviders: BakedProviders = {
  allowManualUrl: ${config.allowManualUrl},
  providers: [
${entries}
  ],
};
`;
}
