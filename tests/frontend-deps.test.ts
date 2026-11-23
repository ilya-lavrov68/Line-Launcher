import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  missingFrontendDependencies,
  frontendDependenciesHelp,
} from "../scripts/lib/frontend-deps.mjs";

test("frontend preflight catches a missing Lucide package before Vite builds", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "line-frontdeps-icons-"));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    assert.ok(missingFrontendDependencies(root).includes("lucide-react"));

    const directory = path.join(root, "node_modules", "lucide-react");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "index.js"), "export {};");
    assert.ok(!missingFrontendDependencies(root).includes("lucide-react"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend preflight requires the vendored shadcn stylesheet", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "line-frontdeps-"));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    assert.ok(
      missingFrontendDependencies(root).includes(
        "src/vendor/shadcn/tailwind.css",
      ),
    );
    const dir = path.join(root, "src/vendor/shadcn");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "tailwind.css"), "/* fixture */");
    assert.ok(
      !missingFrontendDependencies(root).includes(
        "src/vendor/shadcn/tailwind.css",
      ),
    );
    assert.match(frontendDependenciesHelp, /npm ci --include=dev/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vendored stylesheet preserves upstream shadcn v4.13.0 and its license", async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(
    new URL("../src/vendor/shadcn/tailwind.css", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(css).digest("hex"),
    "bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a",
  );
  const notice = readFileSync(
    new URL("../LICENSES/Shadcn-MIT.txt", import.meta.url),
    "utf8",
  );
  assert.match(notice, /Copyright \(c\) 2023 shadcn/);
});
