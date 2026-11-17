import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("README and every documentation page have valid local markdown links", () => {
  const files = ["README.md", ...readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`)];
  for (const file of files) {
    const body = readFileSync(path.join(root, file), "utf8");
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0].split("?")[0];
      if (!target || /^(https?:|mailto:|<|\/)/.test(target)) continue;
      assert.ok(existsSync(path.resolve(root, path.dirname(file), target)), `${file}: ${target}`);
    }
  }
});

test("current guides distinguish historical verification, mocked screenshots and partial repairs", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  assert.match(read("docs/VERIFICATION.md"), /Historical desktop-fix pass \(not current status\)/);
  assert.match(read("docs/VERIFICATION.md"), /Tauri commands.*fixtures/);
  assert.match(read("docs/INSTALLATION-ROADMAP.md"), /not an exhaustive download manifest/);
  assert.match(read("docs/PLAN-0.12-0.15.md"), /Исторический план/);
  assert.doesNotMatch(read("docs/PROVIDER.md"), /автоматический выбор JRE из сети и загрузка Java лаунчером не реализованы/);
});
