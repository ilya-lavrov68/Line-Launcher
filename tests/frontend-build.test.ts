import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  frontendDigest,
  writeFrontendStamp,
} from "../scripts/frontend-build-stamp.mjs";

const root = path.resolve(import.meta.dirname, "..");
test("production frontend stamp follows content, names, additions and deletions", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "line-frontend-"));
  try {
    const dir = path.join(tmp, "dist"),
      stamp = path.join(tmp, "stamp");
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    assert.throws(() => frontendDigest(dir), /index.html/);
    writeFileSync(path.join(dir, "index.html"), "first");
    writeFileSync(path.join(dir, "assets", "bundle.js"), "one");
    const first = writeFrontendStamp(dir, stamp);
    const unchanged = statSync(stamp).mtimeMs;
    assert.equal(writeFrontendStamp(dir, stamp), first);
    assert.equal(statSync(stamp).mtimeMs, unchanged);
    writeFileSync(path.join(dir, "assets", "bundle.js"), "two");
    const second = writeFrontendStamp(dir, stamp);
    assert.notEqual(first, second);
    writeFileSync(path.join(dir, "assets", "new.css"), "x");
    assert.notEqual(frontendDigest(dir), second);
    rmSync(path.join(dir, "assets", "bundle.js"));
    assert.notEqual(frontendDigest(dir), first);
    assert.match(readFileSync(stamp, "utf8"), /^[a-f0-9]{64}\n$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Tauri tracks the completed production tree and test build never starts an old exe on failure", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(
    pkg.scripts.build,
    /vite build && node scripts\/frontend-build-stamp\.mjs/,
  );
  const rust = readFileSync(path.join(root, "src-tauri/build.rs"), "utf8");
  assert.match(rust, /rerun-if-changed=\.\.\/dist/);
  assert.match(rust, /rerun-if-changed=\.frontend-build\.sha256/);
  const script = readFileSync(
    path.join(root, "scripts/demo-build.mjs"),
    "utf8",
  );
  assert.ok(
    script.indexOf("result.status !== 0") < script.indexOf("spawnSync(exe"),
  );
  assert.match(script, /before\.pid !== after\.pid/);
  assert.match(
    script,
    /CARGO_TARGET_DIR: path\.join\(root, "src-tauri\/target"\)/,
  );
});
