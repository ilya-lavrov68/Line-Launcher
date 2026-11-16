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

test("preparation claims the instance before touching its files and blocks direct install or launch", () => {
  const play = rust.slice(
    rust.indexOf("pub async fn mc_play("),
    rust.indexOf("async fn launch_profile("),
  );
  assert.ok(
    play.indexOf("state.begin_preparation(&instance_id)?") <
      play.indexOf("pack::effective_server("),
  );
  assert.ok(
    play.indexOf("state.begin_preparation(&instance_id)?") <
      play.indexOf("pack::sync_game_dir("),
  );
  const install = rust.slice(
    rust.indexOf("async fn install_profile("),
    rust.indexOf("pub async fn mc_list_installed("),
  );
  assert.match(
    install,
    /inner\.preparing\.contains\(&instance_id\) && !within_preparation/,
  );
  assert.ok(
    install.indexOf("inner.installing.insert(") <
      install.indexOf("game_root(app, &instance_id)"),
  );
  const launch = rust.slice(
    rust.indexOf("async fn launch_profile("),
    rust.indexOf("async fn start_game("),
  );
  assert.match(
    launch,
    /inner\.preparing\.contains\(&instance_id\) && !within_preparation/,
  );
  assert.match(rust, /impl Drop for PreparationGuard/);
});

test("the live sync blocking worker retains the preparation claim when its awaiter is dropped", () => {
  const play = rust.slice(
    rust.indexOf("pub async fn mc_play("),
    rust.indexOf("async fn launch_profile("),
  );
  const clone = play.indexOf(
    "let worker_preparation = Arc::clone(&preparation)",
  );
  const worker = play.indexOf("tokio::task::spawn_blocking", clone);
  const hold = play.indexOf(
    "let _worker_preparation = worker_preparation",
    worker,
  );
  const sync = play.indexOf("pack::sync_game_dir(", hold);
  assert.ok(clone >= 0 && worker > clone && hold > worker && sync > hold);
});
