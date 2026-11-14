import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  missingFrontendDependencies,
  frontendDependenciesHelp,
} from "../scripts/lib/frontend-deps.mjs";

test("frontend preflight detects a missing or damaged shadcn CSS entry", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "line-frontdeps-"));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    const missing = missingFrontendDependencies(root);
    assert.ok(missing.includes("shadcn/tailwind.css"));
    const pkg = path.join(root, "node_modules/shadcn");
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "shadcn",
        exports: { "./tailwind.css": "./dist/tailwind.css" },
      }),
    );
    assert.ok(
      missingFrontendDependencies(root).includes("shadcn/tailwind.css"),
    );
    writeFileSync(path.join(pkg, "dist/tailwind.css"), "/* fixture */");
    assert.ok(
      !missingFrontendDependencies(root).includes("shadcn/tailwind.css"),
    );
    assert.match(frontendDependenciesHelp, /npm ci --include=dev/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
