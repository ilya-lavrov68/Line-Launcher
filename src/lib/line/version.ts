/**
 * Reading a launcher version.
 *
 * The version is authored once in `version.json` and reaches the UI through
 * `__LAUNCHER_VERSION__` (Vite) and the Rust side through `Cargo.toml` (see
 * `scripts/version.mjs`). What the components need on top of the raw string is
 * a channel and a couple of shapes: a pre-release build has to say so, and a
 * footer has no room for `0.10.0-rc.1+build.7`.
 *
 * Kept pure and unit-tested rather than slicing strings at the call site.
 */

export type ReleaseChannel = "stable" | "preview";

export interface ParsedVersion {
  /** `0.10.0` — the numbers only, no pre-release or build metadata. */
  core: string;
  /** `major.minor.patch` as numbers. */
  parts: [number, number, number];
  /** `rc.1`, `beta.2` — absent on a stable build. */
  preRelease?: string;
  /** `+build.7` metadata, which never affects ordering. */
  build?: string;
  channel: ReleaseChannel;
  /** True for 0.10.0-style builds: no release promise yet. */
  isPrerelease: boolean;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  const [, major, minor, patch, preRelease, build] = match;
  return {
    core: `${major}.${minor}.${patch}`,
    parts: [Number(major), Number(minor), Number(patch)],
    preRelease,
    build,
    // A `-rc.1` suffix is an explicit preview; so is anything before 1.0.0,
    // because the launcher keeps no compatibility promise yet. Both are shown
    // the same way, because to a player the useful fact is the same: this is
    // not a finished release.
    channel: preRelease ? "preview" : "stable",
    isPrerelease: Boolean(preRelease) || Number(major) === 0,
  };
}

/**
 * The version as it fits in a footer: `0.10.0`, or `0.10.0-rc.1` — build
 * metadata is dropped because it says nothing a player can act on.
 */
export function displayVersion(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) return version;
  return parsed.preRelease
    ? `${parsed.core}-${parsed.preRelease}`
    : parsed.core;
}

/** Whether a player should be told this is a pre-release build. */
export function isPrerelease(version: string): boolean {
  return parseVersion(version)?.isPrerelease ?? false;
}

/**
 * True when the build is newer than what the provider's config requires. Used
 * only for diagnostics: the backend already refuses a config that demands a
 * newer launcher, and this answers the neighbouring question — "am I ahead of
 * the config I am reading?" — which is what a developer needs to see.
 */
export function meetsMinimum(version: string, minimum: string): boolean {
  const mine = parseVersion(version);
  const required = parseVersion(minimum);
  if (!mine || !required) return false;
  for (let i = 0; i < 3; i += 1) {
    if (mine.parts[i] !== required.parts[i]) {
      return mine.parts[i] > required.parts[i];
    }
  }
  // Same numbers: a stable build satisfies the requirement, a pre-release of
  // the same version does not — `1.0.0-rc.1` is older than `1.0.0`.
  if (required.preRelease) {
    if (!mine.preRelease) return true;
    return comparePreRelease(mine.preRelease, required.preRelease) >= 0;
  }
  return !mine.preRelease;
}

/** SemVer's rule: dot-separated identifiers, numeric ones sort numerically. */
function comparePreRelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff;
    } else if (ln) {
      return -1;
    } else if (rn) {
      return 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}
