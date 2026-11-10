import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url));

/** Width and height from the PNG IHDR chunk, without decoding the pixels. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  assert.ok(
    bytes.subarray(0, 8).equals(signature),
    "файл не является PNG: сигнатура не совпадает",
  );
  assert.equal(
    bytes.subarray(12, 16).toString("ascii"),
    "IHDR",
    "первый чанк PNG должен быть IHDR",
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const SHOT_WIDTH = 1280;
const SHOT_HEIGHT = 800;

const SCREENS = [
  "connecting",
  "account",
  "profile",
  "servers",
  "server",
  "wardrobe",
  "settings",
] as const;

/**
 * The README gallery shows every screen side by side, so they must share one
 * aspect ratio. They used to be captured at 480/860/1000/1060 heights, which is
 * exactly what the complaint "one is tall, another is short" was about.
 */
test("every README screenshot is the same size", () => {
  for (const name of SCREENS) {
    const file = `docs/images/line-${name}.png`;
    const size = pngSize(read(file));
    assert.deepEqual(
      size,
      { width: SHOT_WIDTH, height: SHOT_HEIGHT },
      `${file} имеет размер ${size.width}x${size.height}, а должен ${SHOT_WIDTH}x${SHOT_HEIGHT}`,
    );
  }
});

test("the README embeds exactly the screenshots that are checked", () => {
  const readme = read("README.md").toString("utf8");
  const used = [...readme.matchAll(/docs\/images\/line-([a-z]+)\.png/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(new Set(used), new Set(SCREENS));
});

test("the bundled render font keeps its licence next to it", () => {
  // The TTFs are redistributed in the repository, so the OFL text has to travel
  // with them — NOTICE.md points at this exact path.
  const notice = read("NOTICE.md").toString("utf8");
  assert.match(notice, /Geist/);
  assert.match(notice, /LICENSES\/Geist-OFL\.txt/);
  const ofl = read("LICENSES/Geist-OFL.txt").toString("utf8");
  assert.match(ofl, /SIL Open Font License, Version 1\.1/);
  assert.match(ofl, /The Geist Project Authors/);
});

test("both screenshot writers agree on the size", () => {
  const playwright = read("scripts/screenshots.mjs").toString("utf8");
  const renderer = read("scripts/render-screens.mjs").toString("utf8");

  assert.match(
    playwright,
    new RegExp(`const SHOT_WIDTH = ${SHOT_WIDTH};`),
    "scripts/screenshots.mjs must capture at 1280 wide",
  );
  assert.match(
    playwright,
    new RegExp(`const SHOT_HEIGHT = ${SHOT_HEIGHT};`),
    "scripts/screenshots.mjs must capture at 800 tall",
  );
  // No per-screen height overrides: `shot("wardrobe", 1000)` is the regression.
  assert.doesNotMatch(
    playwright,
    /shot\("[a-z]+",\s*\d+\)/,
    "scripts/screenshots.mjs must not pass a per-screen height",
  );
  assert.match(renderer, new RegExp(`SHOT_WIDTH = ${SHOT_WIDTH};`));
  assert.match(renderer, new RegExp(`SHOT_HEIGHT = ${SHOT_HEIGHT};`));
});

test("the offline renderer reads tokens from the live palette block", () => {
  // The renderer parses `src/index.css` itself, so it breaks silently whenever
  // that file is reorganised: an earlier version read only one of two blocks and
  // resolved every token to the white fallback — white cards on a dark page.
  const renderer = read("scripts/render-screens.mjs").toString("utf8");
  assert.match(renderer, /css\("src\/index\.css"\)/);
  assert.match(renderer, /readBlock\(":root \{"\)/);
  assert.doesNotMatch(renderer, /themes\.css/);
});
