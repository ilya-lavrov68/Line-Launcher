import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("the UI uses local rounded Material Symbols rather than Lucide components", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.ok(packageJson.dependencies["@material-symbols/svg-400"]);
  assert.equal(packageJson.dependencies["lucide-react"], undefined);

  const icons = read("src/components/ui/icons.tsx");
  assert.match(icons, /@material-symbols\/svg-400\/rounded\//);
  assert.match(icons, /maskImage/);
  assert.doesNotMatch(icons, /lucide-react/);

  const css = read("src/index.css");
  assert.match(css, /\.line-symbol\s*\{[\s\S]*?mask-size:\s*contain/);
  assert.match(css, /background-color:\s*currentColor/);
});
