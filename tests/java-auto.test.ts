import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const minecraft = read("src-tauri/src/line/minecraft.rs");
const auto = read("src-tauri/src/line/java_auto.rs");
test("automatic Java follows verified local choice and uses private Windows runtime before Mojang fallback", () => {
  const section = minecraft.slice(
    minecraft.indexOf("async fn resolve_java("),
    minecraft.indexOf("fn emit_status("),
  );
  const order = [
    "java::inspect_path(requested)",
    "java::discover(required_major)",
    "java_auto::install_windows_x64",
    "runtime::install_jvm_runtime(",
  ];
  for (let i = 0; i < order.length; i++) {
    assert.ok(section.indexOf(order[i]) >= 0, order[i]);
    if (i)
      assert.ok(
        section.indexOf(order[i - 1]) < section.indexOf(order[i]),
        "Java selection order",
      );
  }
  assert.match(section, /target_os = "windows", target_arch = "x86_64"/);
  assert.match(section, /"runtime",\s*"Установка Java"/);
  assert.match(minecraft, /let runtime_dir = dir\.parent\(\)/);
});
test("runtime is verified, bounded, extracted safely and reused", () => {
  for (const part of [
    "integrity::valid_sha256",
    "MAX_DOWNLOAD",
    "MAX_METADATA",
    "sha.finalize()",
    "install::extract_verified_zip",
    "integrity::scan",
    "integrity::write_index",
    "java::inspect_path",
    "InstallLock::acquire",
  ])
    assert.ok(auto.includes(part), part);
  assert.ok(
    auto.indexOf("if let Some(path) = cached") <
      auto.indexOf("let client = client()"),
  );
  assert.match(auto, /release-assets\.githubusercontent\.com/);
  assert.match(auto, /runtime\.major != major/);
  assert.match(auto, /downloads_java_17_and_reuses_verified_install/);
});
