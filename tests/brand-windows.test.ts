import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tauriCliCommand } from "../scripts/lib/tauri-cli.mjs";
import { normalizeEol, sameText } from "../scripts/lib/text-eol.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STAMP = path.join(ROOT, "src-tauri/icons/.brand-source.sha256");

// The icon pipeline only runs when a custom app icon is configured. With
// assets.app_icon = null these two cases have nothing to exercise, so skip
// them explicitly rather than report a misleading pass. sameText() below still
// guards the line-ending normalization itself.
const brandConfig = JSON.parse(
  readFileSync(path.join(ROOT, "branding/line.brand.json"), "utf8"),
);
const iconSkip = brandConfig.assets?.app_icon
  ? false
  : "assets.app_icon is null — no icon pipeline to exercise";

test("tauri CLI is resolved to node + a JS entry, never a .cmd shim", () => {
  const cli = tauriCliCommand(["icon", "x", "-o", "y"]);
  assert.equal(cli.command, process.execPath, "must run under this Node");
  assert.ok(cli.args[0].endsWith("tauri.js"), `got ${cli.args[0]}`);
  assert.ok(existsSync(cli.args[0]), "the resolved entry must exist");
  assert.deepEqual(cli.args.slice(1), ["icon", "x", "-o", "y"]);
  for (const part of [cli.command, ...cli.args]) {
    assert.ok(!/\.cmd$/i.test(part), `.cmd cannot be spawned: ${part}`);
  }
});

test("the resolved CLI actually runs without a shell", () => {
  const cli = tauriCliCommand(["--version"]);
  const out = execFileSync(cli.command, cli.args, {
    encoding: "utf8",
    cwd: ROOT,
    shell: false,
  });
  assert.match(out, /tauri-cli \d+\./);
});

test("normalizeEol handles CRLF, bare CR and LF", () => {
  assert.equal(normalizeEol("a\r\nb\r\nc"), "a\nb\nc");
  assert.equal(normalizeEol("a\rb\rc"), "a\nb\nc");
  assert.equal(normalizeEol("a\nb\n"), "a\nb\n");
});

test("sameText treats a CRLF checkout as unchanged", () => {
  assert.equal(sameText("hash\n", "hash\r\n"), true);
  assert.equal(sameText("a\r\nb\r\n", "a\nb\n"), true);
  assert.equal(sameText("hash\n", "other\n"), false);
  assert.equal(sameText(null, "x"), false);
  assert.equal(sameText(null, null), true);
});

test(
  "brand:check passes when the icon stamp has Windows line endings",
  { skip: iconSkip },
  () => {
    // Regression: a CRLF stamp never matched, so every `npm run dev` regenerated
    // all OS icons — and on Windows that path died with `spawnSync npx.cmd EINVAL`.
    const original = readFileSync(STAMP, "utf8");
    try {
      writeFileSync(STAMP, original.replace(/\n/g, "\r\n"));
      const out = execFileSync(
        process.execPath,
        ["--experimental-strip-types", "scripts/apply-brand.ts", "--check"],
        { encoding: "utf8", cwd: ROOT, shell: false },
      );
      assert.match(out, /up to date/);
      assert.ok(
        !/generating OS icons/.test(out),
        "a CRLF stamp must not trigger icon regeneration",
      );
    } finally {
      writeFileSync(STAMP, original);
    }
  },
);

test(
  "brand:check still fails when the source icon really changed",
  { skip: iconSkip },
  () => {
    const original = readFileSync(STAMP, "utf8");
    try {
      writeFileSync(STAMP, "0".repeat(64) + "\r\n");
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            ["--experimental-strip-types", "scripts/apply-brand.ts", "--check"],
            { encoding: "utf8", cwd: ROOT, shell: false, stdio: "pipe" },
          ),
        /out of date|Command failed/,
        "normalizing line endings must not hide a genuine mismatch",
      );
    } finally {
      writeFileSync(STAMP, original);
    }
  },
);

test("repo forces LF so Windows checkouts match generated output", () => {
  const attrs = readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  assert.match(attrs, /^\* text=auto eol=lf$/m);
  assert.match(attrs, /^\*\.ico binary$/m);
});

test("no script spawns a .cmd shim directly", () => {
  // Node >=18.20.2 throws EINVAL for .cmd/.bat without a shell. Resolve the JS
  // entry point instead — see scripts/lib/tauri-cli.mjs.
  const files = [
    "scripts/apply-brand.ts",
    "scripts/tauri.mjs",
    "scripts/doctor.mjs",
  ];
  for (const file of files) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.ok(
      !/["'`][^"'`]*\.cmd["'`]/.test(code),
      `${file} must not spawn a .cmd shim`,
    );
  }
});
