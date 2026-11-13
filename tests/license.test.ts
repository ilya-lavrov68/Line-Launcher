import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("Line is source-available with a mandatory visible credit, not MIT", () => {
  const license = read("LICENSE");
  assert.match(license, /Line Launcher Provider License 1\.0/);
  assert.match(license, /not an open-source license/);
  assert.match(
    license,
    /NO PERMISSION TO USE OR DISTRIBUTE LINE MATERIALS IS GRANTED/,
  );
  assert.ok(license.includes("Работает на Line Launcher | Plus In Plus"));
  assert.ok(license.includes("Powered by Line Launcher | Plus In Plus"));
  assert.match(license, /About-only credit is insufficient/);
  assert.match(license, /withdraws rights already\s+granted under MIT/);
});

test("upstream MIT notice is preserved verbatim", () => {
  const upstream = readFileSync(new URL("LICENSES/Obsy-MIT.txt", root));
  assert.equal(
    createHash("sha256")
      .update(upstream.toString("utf8").replace(/\r\n/g, "\n"))
      .digest("hex"),
    "691ea4ebe69879968574569951bffd0e39834c8e84b4e134ecd295668c77d2c3",
  );
  assert.match(upstream.toString(), /Copyright \(c\) 2026 obsy-official/);
  assert.match(upstream.toString(), /MIT License/);
});

test("package metadata points to the custom Line license", () => {
  const pkg = JSON.parse(read("package.json")) as { license: string };
  const lock = JSON.parse(read("package-lock.json")) as {
    packages: { "": { license: string } };
  };
  assert.equal(pkg.license, "SEE LICENSE IN LICENSE");
  assert.equal(lock.packages[""].license, pkg.license);
  const cargo = read("src-tauri/Cargo.toml");
  assert.match(cargo, /license-file = "\.\.\/LICENSE"/);
  assert.doesNotMatch(cargo, /^license\s*=\s*"MIT"/m);
});

test("desktop bundle includes the license and upstream notices", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    bundle: {
      licenseFile: string;
      resources: Record<string, string>;
    };
  };
  assert.equal(config.bundle.licenseFile, "../LICENSE");
  const resources = config.bundle.resources;
  for (const source of [
    "../LICENSE",
    "../NOTICE.md",
    "../LICENSES/Obsy-MIT.txt",
    "../LICENSES/Lucide-LICENSE.txt",
  ]) {
    assert.ok(resources[source], `missing bundle resource ${source}`);
    assert.ok(
      existsSync(new URL(`src-tauri/${source}`, root)),
      `resource source does not exist: ${source}`,
    );
  }
  const notice = read("NOTICE.md");
  assert.ok(notice.includes("Работает на Line Launcher | Plus In Plus"));
  assert.ok(notice.includes("Powered by Line Launcher | Plus In Plus"));
  assert.ok(notice.includes("branding/assets/app-icon.svg"));
  assert.ok(!notice.includes("src-tauri/icons/source.svg"));
});
