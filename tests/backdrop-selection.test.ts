import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BACKDROP_THEMES, backdropTheme } from "../src/lib/line/backdrops.ts";

// Pin the four accent themes after the intentional grain and focal-point
// alignment updates, so palette or geometry edits stay reviewable.
test("the selected backdrops retain their tuned seam-aligned configs", () => {
  const expected: Record<string, string> = {
    mint: "390a70c1eefaa2ee663e1d4b5ef9002a63d54edb246dc714b7e6d9a481dc7254",
    copper: "843fa99ef1ac37e10e06555e54bae7a86530124b2e51ea7111d4bcd6c74f759a",
    frost: "77c6029de2bf891f58343c4d2588626d23460b5c07f39caca1254964511a8622",
    azure: "7f9b69f16492e8ad911192563f11049d17094cf284b48c86bee85dcfa33f2966",
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
