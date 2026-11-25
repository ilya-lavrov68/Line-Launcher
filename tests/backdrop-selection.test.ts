import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKDROP_THEMES, backdropTheme } from "../src/lib/line/backdrops.ts";

const EXPECTED_IDS = [
  "aurora",
  "zenith",
  "garden",
  "mint",
  "steel",
  "copper",
  "arc",
  "flare",
  "frost",
  "azure",
  "borealis",
  "pearl",
];

function channels(color: string) {
  return [1, 3, 5].map((offset) =>
    parseInt(color.slice(offset, offset + 2), 16),
  );
}

test("backdrop themes keep every saved id selectable", () => {
  assert.deepEqual(
    BACKDROP_THEMES.map((theme) => theme.id),
    EXPECTED_IDS,
  );
  for (const theme of BACKDROP_THEMES) {
    assert.equal(backdropTheme(theme.id), theme);
  }
  assert.equal(backdropTheme("unknown-theme"), BACKDROP_THEMES[0]);
});

test("all twelve backdrop palettes are distinct, subdued, and mostly cool", () => {
  const palettes = BACKDROP_THEMES.map((theme) => theme.config.palette);
  assert.equal(new Set(palettes.map((palette) => palette.join(","))).size, 12);
  assert.ok(
    new Set(BACKDROP_THEMES.map((theme) => theme.config.shape)).size >= 4,
    "themes should keep a variety of shapes as well as colours",
  );

  let coolPalettes = 0;
  for (const theme of BACKDROP_THEMES) {
    assert.equal(theme.config.background, "#000000", `${theme.id} base`);
    assert.ok(
      theme.config.palette.length >= 5,
      `${theme.id} needs a full ramp`,
    );
    assert.ok(theme.shade >= 0.5 && theme.shade <= 0.58);
    assert.ok(theme.config.speed >= 1.4 && theme.config.speed <= 1.8);
    assert.equal(theme.config.grain, 0.28, `${theme.id} grain`);

    const paletteChannels = theme.config.palette.map(channels);
    const peaks = paletteChannels.map((rgb) => Math.max(...rgb));
    assert.ok(Math.max(...peaks) <= 176, `${theme.id} has an over-bright stop`);
    for (const [r, g, b] of paletteChannels) {
      assert.ok(
        Math.max(r, g, b) - Math.min(r, g, b) <= 72,
        `${theme.id} has a high-chroma stop`,
      );
    }
    if (peaks.at(-1)! > paletteChannels.at(-1)![0]) coolPalettes += 1;

    assert.ok(
      theme.swatch.every((color) => theme.config.palette.includes(color)),
      `${theme.id} swatch must come from its rendered ramp`,
    );
    assert.ok(
      theme.config.mesh.every(
        ([, , color]) =>
          theme.config.palette.includes(color) ||
          color === theme.config.background,
      ),
      `${theme.id} mesh uses a colour outside its palette`,
    );
  }
  assert.ok(coolPalettes >= 10, `only ${coolPalettes} palettes read as cool`);
});
