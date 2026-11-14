import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const panel = read("src/components/line/MinecraftPanel.tsx");
const launcher = read("src/components/line/LineLauncher.tsx");
const rust = read("src-tauri/src/line/minecraft.rs");
const source = read("src-tauri/src/line/source/install.rs");
const resolve = read("src-tauri/src/line/source/resolve.rs");
const detail = read("src/components/line/ServerDetail.tsx");

test("play and prepare refresh provider configuration before the verified path", () => {
  const play = panel.slice(
    panel.indexOf("async function play("),
    panel.indexOf("async function prepare("),
  );
  const prepare = panel.slice(
    panel.indexOf("async function prepare("),
    panel.indexOf("async function stop("),
  );
  for (const action of [play, prepare]) {
    assert.ok(
      action.indexOf("await onRefreshConfig?.()") <
        action.indexOf("lineApi.mcPlay("),
    );
    assert.match(action, /setProgress\(null\)/);
  }
  assert.match(prepare, /prepareOnly: true/);
  assert.match(launcher, /if \(refreshed\?\.stale\) throw new Error/);
  const check = launcher.slice(
    launcher.indexOf("onCheckPacks={async"),
    launcher.indexOf(
      "onReportPacks={",
      launcher.indexOf("onCheckPacks={async"),
    ),
  );
  assert.ok(
    check.indexOf("refreshConfigForMinecraft()") <
      check.indexOf("lineApi.checkPacks("),
  );
});

test("preparation does not launch and occurs after pack and profile verification", () => {
  const play = rust.slice(
    rust.indexOf("pub async fn mc_play("),
    rust.indexOf("async fn launch_profile("),
  );
  const prepare = play.indexOf("if request.prepare_only {");
  assert.ok(prepare > play.indexOf("integrity::scan(&release)"));
  assert.ok(prepare > play.indexOf("install_profile("));
  assert.ok(prepare < play.indexOf("launch_profile("));
  assert.match(play.slice(prepare), /phase: GamePhase::Idle/);
  assert.match(rust, /#\[serde\(default\)\]\s*pub prepare_only: bool/);
});

test("progress is phase-specific and reports completed files without false aggregate bytes", () => {
  assert.match(resolve, /report\(file_done, file_total\)/);
  assert.match(source, /update\.files_done = Some\(done\)/);
  assert.match(source, /update\.files_total = Some\(total\)/);
  assert.match(source, /update\.total_bytes = 0/);
  assert.match(panel, /progress\.filesTotal/);
  assert.match(panel, /progress\.receivedBytes/);
  assert.match(panel, /if \(!next\.finished\) setProgress\(next\)/);
  assert.ok(
    detail.indexOf("<PackCheckPanel") <
      detail.indexOf('data-testid="source-line"'),
  );
});
