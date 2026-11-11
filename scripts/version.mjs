#!/usr/bin/env node
/**
 * One version number, five files that need it.
 *
 * The launcher's version lived in four places written by hand — package.json,
 * Cargo.toml, tauri.conf.json and a `const LAUNCHER_VERSION` in the shell — plus
 * Cargo.lock, which records it too. They drifted exactly as you would expect:
 * every file still said 0.1.0 long after the build had grown past it, so the
 * number in «О программе» was decoration rather than information.
 *
 * `version.json` is now the only place the number is authored. This script
 * pushes it into every derived file:
 *
 *   node scripts/version.mjs            # write the version everywhere
 *   node scripts/version.mjs --check    # fail if anything drifted (CI, tests)
 *   node scripts/version.mjs 0.11.0     # bump the source, then write everywhere
 *
 * The frontend no longer carries a literal at all: Vite injects
 * `__LAUNCHER_VERSION__` from `version.json` at build time (see vite.config.ts),
 * so there is nothing in the bundle that can disagree with the binary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "version.json");

/** Strict SemVer, the same shape Rust's `semver` crate accepts. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readVersion(root = ROOT) {
  const raw = JSON.parse(readFileSync(path.join(root, "version.json"), "utf8"));
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) {
    throw new Error(
      `version.json: "${raw.version}" is not a valid SemVer version`,
    );
  }
  return raw.version;
}

const read = (root, rel) => readFileSync(path.join(root, rel), "utf8");
const write = (root, rel, text) => writeFileSync(path.join(root, rel), text);

/**
 * Each entry replaces exactly the one line that carries the version, so the
 * surrounding formatting (indentation, key order, comments) survives untouched
 * and a diff shows a version change and nothing else.
 */
const TARGETS = [
  {
    file: "package.json",
    // Top-level "version" is the first one in the file; nested dependency
    // objects use "version" too, so anchor on the two-space indent.
    pattern: /^(\s{2}"version":\s*")[^"]*(")/m,
    current: (text) => text.match(/^\s{2}"version":\s*"([^"]*)"/m)?.[1],
  },
  {
    file: "src-tauri/Cargo.toml",
    // `[package]` is the first table, and its `version = ` has no leading
    // spaces in this file; dependency versions are indented or use `= {`.
    pattern: /^(\[package\][\s\S]*?\nversion = ")[^"]*(")/m,
    current: (text) =>
      text.match(/^\[package\][\s\S]*?\nversion = "([^"]*)"/m)?.[1],
  },
  {
    file: "src-tauri/tauri.conf.json",
    pattern: /^(\s{2}"version":\s*")[^"]*(")/m,
    current: (text) => text.match(/^\s{2}"version":\s*"([^"]*)"/m)?.[1],
  },
  {
    file: "src-tauri/Cargo.lock",
    // The lock records this crate's own version; a mismatch makes `cargo`
    // rewrite the lock on every build.
    pattern: /(name = "line-launcher"\nversion = ")[^"]*(")/,
    current: (text) =>
      text.match(/name = "line-launcher"\nversion = "([^"]*)"/)?.[1],
  },
];

/** Returns the list of files whose version differs from `version`. */
export function drift(root, version) {
  const stale = [];
  for (const target of TARGETS) {
    const file = path.join(root, target.file);
    if (!existsSync(file)) continue;
    const found = target.current(read(root, target.file));
    if (found !== version)
      stale.push({ file: target.file, found, expected: version });
  }
  return stale;
}

export function apply(root, version) {
  const changed = [];
  for (const target of TARGETS) {
    const file = path.join(root, target.file);
    if (!existsSync(file)) continue;
    const text = read(root, target.file);
    if (!target.pattern.test(text)) {
      throw new Error(
        `${target.file}: could not find the version line to replace`,
      );
    }
    const next = text.replace(target.pattern, `$1${version}$2`);
    if (next !== text) {
      write(root, target.file, next);
      changed.push(target.file);
    }
  }
  return changed;
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const explicit = args.find((a) => !a.startsWith("--"));

  if (explicit) {
    if (!SEMVER.test(explicit)) {
      console.error(`"${explicit}" is not a valid SemVer version`);
      process.exit(1);
    }
    write(ROOT, "version.json", `{\n  "version": "${explicit}"\n}\n`);
    console.log(`version.json -> ${explicit}`);
  }

  const version = readVersion(ROOT);

  if (check) {
    const stale = drift(ROOT, version);
    if (stale.length > 0) {
      console.error(`Version drift: version.json says ${version}`);
      for (const item of stale) {
        console.error(`  ${item.file}: ${item.found ?? "(missing)"}`);
      }
      console.error("\nRun: npm run version:sync");
      process.exit(1);
    }
    console.log(
      `Version ${version} is consistent across ${TARGETS.length} files`,
    );
    return;
  }

  const changed = apply(ROOT, version);
  console.log(
    changed.length === 0
      ? `Version ${version} already in sync`
      : `Version ${version} written to: ${changed.join(", ")}`,
  );
}

// Only run when executed, not when imported by the tests.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  main(process.argv);
}

export { SEMVER, TARGETS };
