import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  detectSkinModel,
  type SkinPixels,
} from "../src/lib/line/skin-model.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** A 64x64 RGBA buffer, fully transparent. */
function blank(width = 64, height = 64): SkinPixels {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function paint(
  pixels: SkinPixels,
  x: number,
  y: number,
  width: number,
  height: number,
  alpha = 255,
) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      pixels.data[(row * pixels.width + column) * 4 + 3] = alpha;
    }
  }
}

/**
 * A skin the way an editor exports it: an arm strip that is 4 columns wide
 * (classic) or 3 (slim), with the fourth column left empty for slim.
 */
function skin(armWidth: 3 | 4): SkinPixels {
  const pixels = blank();
  // Right arm block: side face 16x16 at (40,16), front at (44,20).
  paint(pixels, 40, 16, armWidth, 16);
  paint(pixels, 44, 20, armWidth, 12);
  // Left arm, 64x64 layout only.
  paint(pixels, 32, 48, armWidth, 16);
  paint(pixels, 36, 52, armWidth, 12);
  return pixels;
}

test("a slim skin is recognised by its unused fourth arm column", () => {
  const pixels = skin(3);
  assert.equal(detectSkinModel(pixels), "slim");

  // Independent of which arm the editor filled in: clipping a slim skin to
  // one arm still leaves the other one's fourth column empty.
  const noLeft = skin(3);
  paint(noLeft, 32, 48, 4, 16, 0);
  paint(noLeft, 36, 52, 4, 12, 0);
  assert.equal(detectSkinModel(noLeft), "slim");
});

test("a classic skin is recognised by its painted fourth column", () => {
  assert.equal(detectSkinModel(skin(4)), "classic");

  // One painted pixel in the fourth column anywhere in the strip is proof: a
  // slim texture has no UV mapping that could reach it.
  const sparse = skin(3);
  paint(sparse, 43, 30, 1, 1);
  assert.equal(detectSkinModel(sparse), "classic");

  // The left arm alone is enough, too.
  const leftOnly = skin(3);
  paint(leftOnly, 35, 60, 1, 1);
  assert.equal(detectSkinModel(leftOnly), "classic");
});

test("a legacy 64x32 texture is always classic", () => {
  // Slim arms arrived with 1.8, in the same format change that introduced the
  // 64x64 layout, so a 64x32 texture cannot be slim by definition.
  const legacy = blank(64, 32);
  paint(legacy, 40, 16, 3, 16);
  assert.equal(detectSkinModel(legacy), "classic");
});

test("a texture with nothing to read returns unknown instead of guessing", () => {
  // Fully transparent arms, empty file-ish texture: both models would render
  // the same, and inventing an answer would overwrite a correct manual choice.
  assert.equal(detectSkinModel(blank()), "unknown");
  // Wrong dimensions are not a skin at all.
  assert.equal(detectSkinModel(blank(32, 32)), "unknown");
});

test("almost-transparent pixels do not count as painted", () => {
  // A faint alpha in the fourth column is an artefact of an editor's padding,
  // not an arm. The threshold keeps a stray 4/255 pixel from flipping the
  // answer to classic.
  const pixels = skin(3);
  paint(pixels, 43, 25, 1, 1, 4);
  assert.equal(detectSkinModel(pixels), "slim");
});

test("detection reads alpha, not colour", () => {
  // Transparent pixels usually carry black RGB. Reading colour would count the
  // whole fourth column as painted and call every slim skin classic.
  const pixels = skin(3);
  // RGB of everything in the fourth column is black but alpha is 0 — already
  // the case in `blank`. Confirm the opposite: a slim skin whose padded column
  // has bright RGB and no alpha still reads slim.
  for (let row = 0; row < 16; row += 1) {
    const index = ((20 + row) * 64 + 43) * 4;
    pixels.data[index] = 255;
    pixels.data[index + 1] = 255;
    pixels.data[index + 2] = 255;
    pixels.data[index + 3] = 0;
  }
  assert.equal(detectSkinModel(pixels), "slim");
});

test("the wardrobe reads the model from the file instead of asking", () => {
  const screen = read("src/components/line/WardrobeScreen.tsx");
  // Uploading is where the model matters, and the pick handler is where it can
  // be read — the old flow made the player state something the file already
  // knows, and a wrong answer renders wide arms on a narrow body.
  const choose = screen.slice(
    screen.indexOf("function chooseFile("),
    screen.indexOf("async function save()"),
  );
  assert.match(choose, /detectModel\(bytes\)/);
  assert.match(choose, /setModel\(detected\)/);
  // The decoder is behind that helper, and it must be the pixel reader, not a
  // filename guess.
  const helper = screen.slice(
    screen.indexOf("async function detectModel("),
    screen.indexOf("function chooseFile("),
  );
  assert.match(helper, /decodePng\(bytes\)/);
  assert.match(helper, /detectSkinModel\(image\)/);
  // The dropdown stays: detection is best-effort, and an ambiguous texture has
  // to remain correctable by hand.
  assert.match(screen, /<Select/);
  assert.match(screen, /t\("wardrobe\.modelDetected"\)/);
  // Choosing by hand must stop the "detected" claim, or the interface keeps
  // asserting something the player has overridden.
  assert.match(screen, /setModelDetected\(false\)/);
});
