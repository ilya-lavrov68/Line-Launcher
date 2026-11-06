import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findOpenSsl, openSslHelp } from "../scripts/lib/find-openssl.mjs";
import { findBrowser, browserHelp } from "../scripts/lib/find-browser.mjs";

const win = process.platform === "win32";

/** A fake executable that answers `version` like openssl does. */
function fakeTool(dir: string, name: string, banner: string): string {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    win ? `@echo off\r\necho ${banner}\r\n` : `#!/bin/sh\necho '${banner}'\n`,
  );
  if (!win) chmodSync(file, 0o755);
  return file;
}

test("LINE_OPENSSL override is honoured", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line ossl-"));
  try {
    const exe = fakeTool(
      dir,
      win ? "openssl.exe" : "openssl",
      "OpenSSL 9.9.9 fixture",
    );
    const found = findOpenSsl({ LINE_OPENSSL: exe });
    assert.equal(found?.path, exe);
    assert.equal(found?.via, "LINE_OPENSSL");
    assert.match(found!.version, /9\.9\.9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken override falls through instead of being trusted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line ossl-bad-"));
  try {
    const exe = path.join(dir, "openssl");
    writeFileSync(exe, "#!/bin/sh\nexit 1\n");
    if (!win) chmodSync(exe, 0o755);
    const found = findOpenSsl({ LINE_OPENSSL: exe });
    // Either a working PATH openssl or nothing — never the broken override.
    assert.notEqual(found?.path, exe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "openssl bundled with Git for Windows is discovered through a spaced path",
  { skip: !win },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "line git-"));
    try {
      const pf = path.join(dir, "Program Files");
      const exe = fakeTool(
        path.join(pf, "Git", "usr", "bin"),
        "openssl.exe",
        "OpenSSL 3.5.0 git-fixture",
      );
      const found = findOpenSsl({
        ProgramFiles: pf,
        "ProgramFiles(x86)": path.join(dir, "absent"),
        PATH: dir, // keep the real PATH openssl out of the way
      });
      assert.equal(found?.path, exe);
      assert.equal(found?.via, "Git for Windows");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("openssl help names a concrete Windows path and an install command", () => {
  const help = openSslHelp();
  assert.match(help, /LINE_OPENSSL/);
  if (win) {
    assert.match(help, /Git/);
    assert.match(help, /winget|choco/);
  } else {
    assert.match(help, /apt-get|brew/);
  }
});

test("CHROMIUM_PATH wins over auto-detection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line browser-"));
  try {
    const exe = path.join(dir, "my chrome");
    writeFileSync(exe, "");
    const found = findBrowser({ CHROMIUM_PATH: exe }, "win32");
    assert.equal(found?.path, exe);
    assert.equal(found?.via, "CHROMIUM_PATH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an installed Edge is found without downloading a browser", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line edge-"));
  try {
    const pf86 = path.join(dir, "Program Files (x86)");
    const exe = path.join(
      pf86,
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    );
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, "");
    const found = findBrowser(
      { "ProgramFiles(x86)": pf86, ProgramFiles: path.join(dir, "absent") },
      "win32",
    );
    assert.equal(found?.path, exe);
    assert.equal(found?.via, "Microsoft Edge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser discovery returns null when nothing is installed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line no-browser-"));
  try {
    assert.equal(
      findBrowser(
        { ProgramFiles: dir, "ProgramFiles(x86)": dir, LOCALAPPDATA: dir },
        "win32",
      ),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser help explains the dev server and the download fallback", () => {
  const help = browserHelp("win32");
  assert.match(help, /npm run dev/);
  assert.match(help, /playwright-core install chromium/);
  assert.match(help, /CHROMIUM_PATH/);
});

test("brand config does not reference a deleted asset", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const root = path.resolve(import.meta.dirname, "..");
  const config = JSON.parse(
    readFileSync(path.join(root, "branding/line.brand.json"), "utf8"),
  );
  for (const key of ["logo", "app_icon"]) {
    const rel = config.assets?.[key];
    if (!rel) continue;
    assert.ok(
      existsSync(path.join(root, "branding", rel)),
      `assets.${key} points at a missing file: ${rel}`,
    );
  }
});

test("a root-relative asset path is rejected with a prefix hint", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const root = path.resolve(import.meta.dirname, "..");
  const configPath = path.join(root, "branding/line.brand.json");
  const original = readFileSync(configPath, "utf8");
  const config = JSON.parse(original);
  if (!config.assets?.app_icon) return; // nothing to mis-point
  try {
    // Regression: "branding/assets/..." is joined with branding/ again, giving
    // branding/branding/assets/... The message must name the base dir.
    config.assets.app_icon = `branding/${config.assets.app_icon}`;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", "scripts/apply-brand.ts", "--check"],
        { encoding: "utf8", cwd: root, shell: false, stdio: "pipe" },
      );
      assert.fail("a doubled branding/ prefix must not resolve");
    } catch (error) {
      stderr = `${(error as { stderr?: string }).stderr ?? ""}`;
    }
    assert.match(stderr, /относительно каталога branding/);
    assert.match(stderr, /Уберите префикс/);
  } finally {
    writeFileSync(configPath, original);
  }
});
