import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("the complete screenshot, guidebook GIF and poster set matches its capture manifest", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-visual-evidence.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /14 screenshots, 6 GIFs, and 6 posters/);
});
