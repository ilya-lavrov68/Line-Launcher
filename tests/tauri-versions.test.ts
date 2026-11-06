import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cargoLockVersions,
  checkTauriVersions,
  majorMinor,
  tauriVersionHelp,
} from "../scripts/lib/tauri-versions.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const LOCK = `# generated
[[package]]
name = "adler2"
version = "2.0.1"

[[package]]
name = "tauri"
version = "2.12.5"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-build"
version = "2.7.4"

[[package]]
name = "tauri-plugin-shell"
version = "2.5.0"
`;

/** A fake project with a Cargo.lock and an installed npm package. */
function fixture(crate: string, npm: string | null, extra = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "line tauri-ver-"));
  mkdirSync(path.join(dir, "src-tauri"), { recursive: true });
  writeFileSync(
    path.join(dir, "src-tauri/Cargo.lock"),
    LOCK.replace(
      'name = "tauri"\nversion = "2.12.5"',
      `name = "tauri"\nversion = "${crate}"`,
    ) + extra,
  );
  if (npm) {
    const pkg = path.join(dir, "node_modules/@tauri-apps/api");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@tauri-apps/api", version: npm }),
    );
  }
  return dir;
}

test("cargoLockVersions reads name/version pairs, not other fields", () => {
  const v = cargoLockVersions(LOCK);
  assert.equal(v.get("tauri"), "2.12.5");
  assert.equal(v.get("tauri-build"), "2.7.4");
  assert.equal(v.get("adler2"), "2.0.1");
  assert.equal(v.size, 4);
});

test("majorMinor ignores the patch component", () => {
  assert.equal(majorMinor("2.12.5"), "2.12");
  assert.equal(majorMinor("2.12.0"), "2.12");
  assert.equal(majorMinor("2.11.1"), "2.11");
  assert.equal(majorMinor("garbage"), null);
});

test("a differing patch is allowed — the CLI only compares major.minor", () => {
  const dir = fixture("2.12.5", "2.12.4");
  try {
    const r = checkTauriVersions(dir);
    assert.equal(r.mismatches.length, 0);
    assert.equal(r.pairs[0].crateVersion, "2.12.5");
    assert.equal(r.pairs[0].npmVersion, "2.12.4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reported Windows failure is detected: crate 2.12.5 vs api 2.11.1", () => {
  const dir = fixture("2.12.5", "2.11.1");
  try {
    const r = checkTauriVersions(dir);
    assert.equal(r.mismatches.length, 1);
    const m = r.mismatches[0];
    assert.equal(m.crate, "tauri");
    assert.equal(m.npm, "@tauri-apps/api");
    const help = tauriVersionHelp(r.mismatches);
    assert.match(help, /npm install @tauri-apps\/api@~2\.12/);
    assert.match(help, /cargo update -p tauri --precise 2\.11\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a differing major is also a mismatch", () => {
  const dir = fixture("3.0.0", "2.12.4");
  try {
    assert.equal(checkTauriVersions(dir).mismatches.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugins are paired by name, and unmatched ones are ignored", () => {
  const dir = fixture("2.12.5", "2.12.4");
  try {
    const plugin = path.join(dir, "node_modules/@tauri-apps/plugin-shell");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      path.join(plugin, "package.json"),
      JSON.stringify({ name: "@tauri-apps/plugin-shell", version: "2.4.0" }),
    );
    const r = checkTauriVersions(dir);
    const shell = r.pairs.find((p) => p.crate === "tauri-plugin-shell");
    assert.ok(shell, "the plugin pair must be discovered");
    assert.equal(shell!.npmVersion, "2.4.0");
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0].crate, "tauri-plugin-shell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing npm package is reported, not silently treated as aligned", () => {
  const dir = fixture("2.12.5", null);
  try {
    const r = checkTauriVersions(dir);
    assert.deepEqual(r.missing, ["@tauri-apps/api"]);
    assert.equal(r.pairs.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing Cargo.lock is reported", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line no-lock-"));
  try {
    const r = checkTauriVersions(dir);
    assert.deepEqual(r.missing, ["src-tauri/Cargo.lock"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the version falls back to package-lock.json when not installed", () => {
  const dir = fixture("2.12.5", null);
  try {
    writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/@tauri-apps/api": { version: "2.12.4" } },
      }),
    );
    const r = checkTauriVersions(dir);
    assert.equal(r.pairs[0].npmVersion, "2.12.4");
    assert.equal(r.mismatches.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real repository is aligned and the gate passes", () => {
  const r = checkTauriVersions(ROOT);
  assert.equal(r.missing.length, 0, `missing: ${r.missing.join(", ")}`);
  assert.equal(
    r.mismatches.length,
    0,
    `mismatched: ${r.mismatches.map((m) => `${m.crate} ${m.crateVersion} vs ${m.npm} ${m.npmVersion}`).join("; ")}`,
  );
  const out = execFileSync(
    process.execPath,
    ["scripts/check-tauri-versions.mjs"],
    { encoding: "utf8", cwd: ROOT, shell: false },
  );
  assert.match(out, /aligned/);
});

test("both sides are pinned to a minor so they cannot drift apart", () => {
  const manifest = readFileSync(
    path.join(ROOT, "src-tauri/Cargo.toml"),
    "utf8",
  );
  const req = /^tauri\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/m.exec(
    manifest,
  )?.[1];
  assert.ok(req, "tauri dependency must declare a version");
  assert.match(req!, /^~\d+\.\d+$/, `expected a ~minor pin, got "${req}"`);

  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const api = pkg.dependencies["@tauri-apps/api"];
  assert.match(api, /^~\d+\.\d+\.\d+$/, `expected a ~pin, got "${api}"`);
  assert.equal(
    majorMinor(req!),
    majorMinor(api),
    "the Cargo.toml pin and the package.json pin must target the same minor",
  );
});
