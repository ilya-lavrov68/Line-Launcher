import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("the shared icon exports use Lucide React", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.ok(packageJson.dependencies["lucide-react"]);
  assert.equal(
    packageJson.dependencies["@material-symbols/svg-400"],
    undefined,
  );

  const icons = read("src/components/ui/icons.tsx");
  assert.match(icons, /from "lucide-react"/);
  assert.match(icons, /LucideIcon as LineIcon/);
  assert.doesNotMatch(icons, /@material-symbols|maskImage|line-symbol/);
});
