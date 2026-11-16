import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BACKDROP_THEMES, backdropTheme } from "../src/lib/line/backdrops.ts";

// These are the four full configurations the player chose to keep, including
// their geometry, colours, speed and shade. Editing only their names or ids
// would also alter what a saved selection means.
test("the four selected backdrops are preserved exactly", () => {
  const expected: Record<string, string> = {
    mint: "6334d1a74681b0e07571a435c7748569739039d784e35a7c9828f6eba26698ad",
    copper: "4094a6cc22ea88a5efb192299821b0f6ae538eca4ef25bee3c188d38d5f7aa07",
    frost: "564c34ec3b9bb56487b2bd455ab6b0206f47d1d1fb1e4a479f2dd49d88466d3f",
    azure: "6fb9579ceb64ba13b54b02dbb8bec8556d92bcf919c3d6e0732353a30dd37ecd",
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
