import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BACKDROP_THEMES, backdropTheme } from "../src/lib/line/backdrops.ts";

// Copper Bush is the one explicitly retained palette; pin its full config so
// later edits cannot accidentally change it while warming the other themes.
test("Copper Bush remains exactly as selected", () => {
  const expected: Record<string, string> = {
    copper: "843fa99ef1ac37e10e06555e54bae7a86530124b2e51ea7111d4bcd6c74f759a",
  };
  for (const [id, digest] of Object.entries(expected)) {
    const theme = BACKDROP_THEMES.find((entry) => entry.id === id);
    assert.ok(theme, `${id} must still be selectable`);
    assert.equal(
      createHash("sha256").update(JSON.stringify(theme)).digest("hex"),
      digest,
      id,
    );
    assert.equal(backdropTheme(id), theme);
  }
});

test("the non-copper backdrops are warm and slightly grainier", () => {
  for (const theme of BACKDROP_THEMES) {
    if (theme.id === "copper") {
      assert.equal(theme.config.grain, 0.443);
      continue;
    }
    assert.equal(theme.config.grain, 0.52, `${theme.id} grain strength`);
    for (const color of theme.config.palette) {
      const [r, g, b] = [1, 3, 5].map((offset) =>
        parseInt(color.slice(offset, offset + 2), 16),
      );
      assert.ok(r > b, `${theme.id}: ${color} is not warm-toned`);
      assert.ok(r >= g, `${theme.id}: ${color} shifts green over red`);
    }
  }
});

test("the eight replacements are subdued, diverse and keep stored ids", () => {
  const ids = [
    "aurora",
    "zenith",
    "garden",
    "steel",
    "arc",
    "flare",
    "borealis",
    "pearl",
  ];
  const themes = ids.map((id) => {
    const found = BACKDROP_THEMES.find((theme) => theme.id === id);
    assert.ok(found, `${id} must still resolve a saved preference`);
    return found;
  });
  assert.equal(
    new Set(themes.map((theme) => theme.config.shape)).size >= 4,
    true,
  );
  assert.equal(new Set(themes.map((theme) => theme.config.seed)).size, 8);
  for (const theme of themes) {
    assert.equal(theme.config.background, "#000000");
    for (const color of theme.config.palette) {
      const rgb = [1, 3, 5].map((offset) =>
        parseInt(color.slice(offset, offset + 2), 16),
      );
      assert.ok(Math.max(...rgb) <= 160, `${theme.id}: bright ${color}`);
      assert.ok(
        Math.max(...rgb) - Math.min(...rgb) <= 65,
        `${theme.id}: saturated ${color}`,
      );
    }
  }
});
