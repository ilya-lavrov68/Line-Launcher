import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "docs/visual-evidence.json");
const screenshotNames = [
  "welcome",
  "setup",
  "account",
  "guidebook",
  "servers",
  "server",
  "server-actions",
  "minecraft",
  "minecraft-actions",
  "wardrobe",
  "profile",
  "settings",
  "workspace",
  "privacy",
].map((name) => `docs/images/line-${name}.png`);
const chapters = [
  "navigation",
  "servers",
  "server-actions",
  "wardrobe",
  "account",
  "settings",
];

function fail(message) {
  console.error(`[visual-evidence] ${message}`);
  process.exitCode = 1;
}

function hash(relativePath) {
  return createHash("sha256")
    .update(readFileSync(path.join(root, relativePath)))
    .digest("hex");
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1)
    fail("Unsupported evidence manifest schema.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.generatedOn ?? "")) {
    fail("Manifest is missing its generation date.");
  }
  if (typeof manifest.browser !== "string" || !manifest.browser.trim()) {
    fail("Manifest is missing the browser version.");
  }
  if (manifest.screenshotCount !== screenshotNames.length) {
    fail(`Expected ${screenshotNames.length} screenshots in the manifest.`);
  }
  if (manifest.guidebookChapterCount !== chapters.length) {
    fail(`Expected ${chapters.length} guidebook chapters in the manifest.`);
  }

  const recordedScreenshots = manifest.screenshots ?? {};
  if (
    JSON.stringify(Object.keys(recordedScreenshots).sort()) !==
    JSON.stringify([...screenshotNames].sort())
  ) {
    fail("Manifest screenshot list does not match the full gallery.");
  }
  for (const relativePath of screenshotNames) {
    if (recordedScreenshots[relativePath] !== hash(relativePath)) {
      fail(`Screenshot hash is stale or missing: ${relativePath}`);
    }
  }

  const recordedChapters = manifest.guidebook ?? {};
  if (
    JSON.stringify(Object.keys(recordedChapters).sort()) !==
    JSON.stringify([...chapters].sort())
  ) {
    fail("Manifest chapter list does not match the six-page guidebook.");
  }
  for (const chapter of chapters) {
    const entry = recordedChapters[chapter] ?? {};
    const gif = `public/guidebook/${chapter}.gif`;
    const poster = `public/guidebook/${chapter}.png`;
    if (entry.gif !== gif || entry.gifSha256 !== hash(gif)) {
      fail(`GIF hash is stale or missing: ${gif}`);
    }
    if (entry.poster !== poster || entry.posterSha256 !== hash(poster)) {
      fail(`Poster hash is stale or missing: ${poster}`);
    }
  }
} catch (error) {
  fail(`Cannot validate generated evidence: ${error.message}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log(
  "[visual-evidence] 14 screenshots, 6 GIFs, and 6 posters match the capture manifest.",
);
