// Mirror of the Tauri CLI's version check, so a mismatch is reported before the
// build starts and with a remedy.
//
// tauri-cli (crates/tauri-cli/src/info/plugins.rs) compares the `tauri` crate
// resolved in Cargo.lock against the installed `@tauri-apps/api`, and requires
// the SAME major AND minor. Plugins are paired the same way. `tauri-build` and
// `@tauri-apps/cli` are versioned independently and are not part of that check.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Parse `[[package]] name/version` pairs out of a Cargo.lock. */
export function cargoLockVersions(toml) {
  const versions = new Map();
  for (const block of toml.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) versions.set(name, version);
  }
  return versions;
}

export function majorMinor(version) {
  const m = /^(\d+)\.(\d+)/.exec(version || "");
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Installed npm version, falling back to the lockfile when not installed. */
export function npmVersion(root, name) {
  try {
    const pkg = require.resolve(`${name}/package.json`, { paths: [root] });
    return JSON.parse(readFileSync(pkg, "utf8")).version;
  } catch {
    // fall through to the lockfile
  }
  try {
    const lock = JSON.parse(
      readFileSync(path.join(root, "package-lock.json"), "utf8"),
    );
    return lock.packages?.[`node_modules/${name}`]?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ pairs: Array<object>, mismatches: Array<object>, missing: string[] }}
 */
export function checkTauriVersions(root) {
  const lockPath = path.join(root, "src-tauri/Cargo.lock");
  const pairs = [];
  const missing = [];
  if (!existsSync(lockPath)) {
    return { pairs, mismatches: [], missing: ["src-tauri/Cargo.lock"] };
  }
  const crates = cargoLockVersions(readFileSync(lockPath, "utf8"));

  // Core pair, then every tauri-plugin-* that has an npm counterpart.
  const wanted = [["tauri", "@tauri-apps/api"]];
  for (const crate of crates.keys()) {
    if (!crate.startsWith("tauri-plugin-")) continue;
    wanted.push([
      crate,
      `@tauri-apps/plugin-${crate.slice("tauri-plugin-".length)}`,
    ]);
  }

  for (const [crate, npm] of wanted) {
    const crateVersion = crates.get(crate);
    if (!crateVersion) continue;
    const installed = npmVersion(root, npm);
    if (!installed) {
      // The CLI skips pairs it cannot resolve on the npm side; so do we.
      if (crate === "tauri") missing.push(npm);
      continue;
    }
    pairs.push({
      crate,
      npm,
      crateVersion,
      npmVersion: installed,
      crateMinor: majorMinor(crateVersion),
      npmMinor: majorMinor(installed),
    });
  }
  return {
    pairs,
    mismatches: pairs.filter((p) => p.crateMinor !== p.npmMinor),
    missing,
  };
}

export function tauriVersionHelp(mismatches) {
  const lines = [
    "Tauri требует, чтобы крейт и npm-пакет совпадали по major.minor.",
    "Выровняйте одну из сторон (обычно npm — он отстаёт от крейта):",
  ];
  for (const m of mismatches) {
    lines.push(
      "",
      `  ${m.crate} ${m.crateVersion}  ↔  ${m.npm} ${m.npmVersion}`,
      `  npm install ${m.npm}@~${m.crateMinor}`,
      `  # либо откатить крейт: cargo update -p ${m.crate} --precise ${m.npmMinor}.0`,
    );
  }
  lines.push(
    "",
    "Обе стороны закреплены на minor (Cargo.toml `~2.x`, package.json `~2.x.y`),",
    "поэтому обновлять их нужно вместе — иначе проверка снова упадёт.",
  );
  return lines.join("\n");
}
