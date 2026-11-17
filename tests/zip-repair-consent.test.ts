import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isLineError, toLineError } from "../src/types/line.ts";
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const minecraft = read("src-tauri/src/line/minecraft.rs");
const panel = read("src/components/line/MinecraftPanel.tsx");

test("ZIP supplementary installation stops before invoking installer without matching consent", () => {
  const segment = minecraft.slice(
    minecraft.indexOf("// 4. Fill only the gaps."),
    minecraft.indexOf(
      "if request.prepare_only {",
      minecraft.indexOf("// 4. Fill only the gaps."),
    ),
  );
  assert.ok(segment.indexOf("if server.source.is_none()") > 0);
  assert.ok(
    segment.indexOf(
      "plan.is_approved_by(request.approve_zip_repair.as_ref())",
    ) < segment.indexOf("install_profile("),
  );
  assert.ok(
    segment.indexOf("return Err(error)") < segment.indexOf("install_profile("),
  );
  for (const field of [
    "release_sha256",
    "instance_id",
    "detected_loader",
    "requested_loader",
    "missing_from_archive",
    "prepare_only",
    "test_mode",
  ])
    assert.ok(segment.includes(field), field);
});

test("a structured confirmation survives the API error conversion", () => {
  const error = {
    code: "CONFIRMATION_REQUIRED",
    message: "confirm",
    retryable: false,
    zipRepair: { schema: 1 },
  };
  assert.equal(isLineError(error), true);
  assert.equal(toLineError(error), error);
});

test("dialog declines without invoking play and resumes the original action on approval", () => {
  assert.match(panel, /if \(!open\)/);
  assert.match(panel, /zipRepair\.declined/);
  assert.match(panel, /if \(plan\.prepareOnly\) void prepare\(plan, pendingRepairJava\)/);
  assert.match(panel, /else void play\(plan\.testMode, plan, pendingRepairJava\)/);
  assert.match(panel, /approveZipRepair: approved/);
});


test("partial runtime audit uses release profiles and prompts on verified mismatches", () => {
  const worker = minecraft.slice(minecraft.indexOf("if audit_runtime {"), minecraft.indexOf("if audit_live_assets &&"));
  assert.match(worker, /index\.files\.iter\(\)\.any/);
  assert.match(worker, /runtime_inventory::inspect/);
  assert.match(worker, /sha1_file/);
  const consent = minecraft.slice(minecraft.indexOf("let live_runtime_issues"), minecraft.indexOf("let loader_started"));
  assert.match(consent, /live_runtime_issues > 0/);
  assert.match(consent, /live_runtime_bytes/);
  assert.match(consent, /live_runtime_files/);
  assert.match(panel, /pendingRepair\.liveRuntimeFiles\.map/);
  assert.match(consent, /live_runtime_skipped/);
  assert.match(panel, /zipRepair\.runtimePartial/);
});


test("asset consent binds the complete ordered issue set with a bounded preview", () => {
  assert.match(minecraft, /line-asset-issues-v1/);
  assert.match(minecraft, /digest\.update\(hash\.as_bytes\(\)\)/);
  assert.match(minecraft, /digest\.update\(size\.to_be_bytes\(\)\)/);
  assert.match(minecraft, /digest\.update\(reason\.as_bytes\(\)\)/);
  assert.match(minecraft, /preview\.len\(\) < 32/);
  assert.match(minecraft, /live_asset_digest: detected\.live_asset_digest/);
  assert.match(panel, /liveAssetPreview\.map/);
  assert.match(panel, /zipRepair\.assetPreviewLimit/);
});
