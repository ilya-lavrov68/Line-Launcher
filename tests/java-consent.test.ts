import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rust = read("src-tauri/src/line/minecraft.rs");
const panel = read("src/components/line/MinecraftPanel.tsx");

test("ZIP Java consent is checked after local discovery and before each launcher-owned download", () => {
  const body = rust.slice(rust.indexOf("async fn resolve_java("), rust.indexOf("fn emit_status("));
  assert.ok(body.indexOf("java::discover(required_major)") < body.indexOf("find_cached_windows_x64"));
  assert.ok(body.indexOf("find_cached_windows_x64") < body.indexOf('consent.require(required_major, purpose, "adoptium")'));
  assert.ok(body.indexOf('consent.require(required_major, purpose, "adoptium")') < body.indexOf("install_windows_x64"));
  assert.ok(body.indexOf('consent.require(required_major, purpose, "mojang")') < body.indexOf("runtime::install_jvm_runtime"));
  assert.match(rust, /server\s*\.source\s*\.is_none\(\)\s*\.then/);
  assert.match(rust, /java_consent,\s*"loader"/);
  assert.match(rust, /java_consent,\s*"launch"/);
});

test("Java refusal does not retry, approval resumes the original action with ZIP consent", () => {
  assert.match(panel, /javaConsent\.declined/);
  assert.match(panel, /approveJavaDownload: approvedJava/);
  assert.match(panel, /prepare\(pending\.zip, pending\.plan\)/);
  assert.match(panel, /play\(pending\.plan\.testMode, pending\.zip, pending\.plan\)/);
  assert.match(panel, /setPendingRepairJava\(approvedJava\)/);
});
