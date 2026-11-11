import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  displayVersion,
  isPrerelease,
  meetsMinimum,
  parseVersion,
} from "../src/lib/line/version.ts";
import { drift, readVersion, SEMVER } from "../scripts/version.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("the version has exactly one authored source", () => {
  const version = readVersion(ROOT);
  assert.match(version, SEMVER);

  // Every derived file agrees with version.json. The launcher shipped 0.1.0 for
  // four releases because four hand-written copies drifted; this is the check
  // that makes that impossible.
  assert.deepEqual(drift(ROOT, version), []);

  // And the frontend has no literal of its own: Vite injects the number, so a
  // stale string cannot hide in the bundle.
  const shell = read("src/components/line/LineLauncher.tsx");
  assert.doesNotMatch(
    shell,
    /const LAUNCHER_VERSION = "\d+\.\d+\.\d+"/,
    "the version must come from version.json, not a literal",
  );
  assert.match(shell, /__LAUNCHER_VERSION__/);

  // The build refuses to produce an installer with a split-brain version.
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.build, /version:check/);
  assert.equal(pkg.scripts["version:sync"], "node scripts/version.mjs");
  assert.equal(
    pkg.scripts["version:check"],
    "node scripts/version.mjs --check",
  );
});

test("the repository's own version is what the package declares", () => {
  const version = readVersion(ROOT);
  const pkg = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml");
  assert.equal(pkg.version, version);
  assert.equal(tauri.version, version);
  assert.match(
    cargo,
    new RegExp(
      `\\[package\\][\\s\\S]*?\\nversion = "${version.replace(/\./g, "\\.")}"`,
    ),
  );
});

test("a version parses into the parts the UI shows", () => {
  const stable = parseVersion("1.4.2");
  assert.ok(stable);
  assert.equal(stable.core, "1.4.2");
  assert.deepEqual(stable.parts, [1, 4, 2]);
  assert.equal(stable.preRelease, undefined);
  assert.equal(stable.channel, "stable");
  assert.equal(stable.isPrerelease, false);

  const preview = parseVersion("0.10.0");
  assert.ok(preview);
  // A 0.x build makes no compatibility promise, so it is marked as one.
  assert.equal(preview.isPrerelease, true);

  const rc = parseVersion("1.0.0-rc.1");
  assert.ok(rc);
  assert.equal(rc.preRelease, "rc.1");
  assert.equal(rc.channel, "preview");
  assert.equal(rc.isPrerelease, true);

  // Build metadata never affects what is displayed.
  const built = parseVersion("1.0.0+build.7");
  assert.ok(built);
  assert.equal(built.build, "build.7");
  assert.equal(displayVersion("1.0.0+build.7"), "1.0.0");
  assert.equal(isPrerelease("1.0.0+build.7"), false);
  assert.equal(isPrerelease("0.10.0"), true);
  assert.equal(displayVersion("1.0.0-rc.1+build.7"), "1.0.0-rc.1");

  // Rubbish is rejected rather than half-parsed: a malformed number must not
  // reach the UI as "0.0.0" without anyone noticing.
  assert.equal(parseVersion("1.0"), null);
  assert.equal(parseVersion("v1.0.0"), null);
  assert.equal(parseVersion("01.0.0"), null);
  assert.equal(parseVersion(""), null);
  // Displaying an unparseable string still shows something rather than nothing.
  assert.equal(displayVersion("nightly"), "nightly");
});

test("the pre-release mark is shown where a version is shown", () => {
  // The footer and the About dialog both carry it; a bug report screenshot then
  // names the build it came from.
  const shell = read("src/components/line/LineLauncher.tsx");
  assert.match(shell, /isPrerelease\(LAUNCHER_VERSION\)/);
  assert.match(shell, /t\("about\.channelPreviewShort"\)/);

  const about = read("src/components/line/AboutDialog.tsx");
  assert.match(about, /isPrerelease\(version\)/);
  assert.match(about, /t\("about\.channelLabel"\)/);
  assert.match(about, /t\("about\.channelStable"\)/);
  assert.match(about, /t\("about\.channelPreview"\)/);
});

test("requirements are compared as versions, not as strings", () => {
  // The bug a text comparison causes: "0.9.0" > "0.10.0" alphabetically.
  assert.equal(meetsMinimum("0.10.0", "0.9.0"), true);
  assert.equal(meetsMinimum("0.9.0", "0.10.0"), false);
  assert.equal(meetsMinimum("1.0.0", "1.0.0"), true);
  assert.equal(meetsMinimum("1.2.3", "1.2.3"), true);
  assert.equal(meetsMinimum("1.2.4", "1.2.3"), true);
  assert.equal(meetsMinimum("1.2.2", "1.2.3"), false);

  // SemVer ordering of pre-releases: 1.0.0-rc.1 < 1.0.0-rc.2 < 1.0.0.
  assert.equal(meetsMinimum("1.0.0-rc.1", "1.0.0"), false);
  assert.equal(meetsMinimum("1.0.0", "1.0.0-rc.1"), true);
  assert.equal(meetsMinimum("1.0.0-rc.2", "1.0.0-rc.1"), true);
  assert.equal(meetsMinimum("1.0.0-rc.1", "1.0.0-rc.2"), false);
  assert.equal(meetsMinimum("1.0.0-beta", "1.0.0-rc.1"), false);

  // Anything unparseable fails closed: better to say "does not meet it" than to
  // let a config through on a version nobody can read.
  assert.equal(meetsMinimum("nightly", "1.0.0"), false);
  assert.equal(meetsMinimum("1.0.0", "latest"), false);
});

test("the changelog opens with the version the launcher reports", () => {
  const version = readVersion(ROOT);
  const changelog = read("CHANGELOG.md");
  // The heading must name the current version: a changelog that stops at an old
  // number is the same failure as a hardcoded constant, one release later.
  assert.match(
    changelog,
    new RegExp(`^## ${version.replace(/\./g, "\\.")} `, "m"),
  );
  // And it must explain how the number is managed, or the next person bumps a
  // literal somewhere and the drift starts again.
  assert.match(changelog, /version\.json/);
  assert.match(changelog, /npm run version:sync/);
});

test("the build guide tells people to bump one file, not four", () => {
  const guide = read("docs/BUILD.md");
  const section = guide.slice(
    guide.indexOf("### 4.4. Версия"),
    guide.indexOf("### 4.5."),
  );
  // The old text listed package.json, Cargo.toml and tauri.conf.json and told
  // the reader to keep the same value in all three by hand. That is how they
  // drifted in the first place, so the instruction must not come back.
  assert.match(section, /version\.json/);
  assert.match(section, /npm run version:sync/);
  assert.match(section, /version:check/);
  assert.doesNotMatch(
    section,
    /Держите одинаковое значение в трёх местах/,
    "the guide must not ask for hand-editing three files",
  );
  assert.doesNotMatch(section, /cargo update -p line-launcher/);
  // And it points at the changelog, so the history has one home.
  assert.match(section, /CHANGELOG\.md/);
});
