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
  assert.match(rust, /fn begin_install\(/);
  assert.match(rust, /fn begin_start\(/);
  assert.match(
    rust,
    /state\.begin_install\(&instance_id, preparation_lease\.is_some\(\)\)/,
  );
  assert.match(
    rust,
    /state\.begin_start\(&instance_id, preparation_lease\.is_some\(\)\)/,
  );
  assert.match(
    rust,
    /inner\.preparing\.contains\(instance_id\) && !within_preparation/,
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

test("blocking install and launch work retains operation claims and Java extraction owns its staging lock", () => {
  const java = read("src-tauri/src/line/java_auto.rs");
  assert.match(rust, /let worker_claim = Arc::clone\(&claim\)/);
  assert.match(rust, /let load_claim = Arc::clone\(claim\)/);
  assert.match(rust, /let build_claim = Arc::clone\(claim\)/);
  assert.match(java, /let worker_temp = Arc::clone\(&temp\)/);
  assert.match(java, /let worker_lock = Arc::clone\(&lock\)/);
});

test("cooperating launcher processes hold an instance lease through sync, install, launch and game monitor", () => {
  const play = rust.slice(
    rust.indexOf("pub async fn mc_play("),
    rust.indexOf("async fn launch_profile("),
  );
  assert.ok(
    play.indexOf("acquire_instance_lease(&app, &instance_id)?") <
      play.indexOf("pack::sync_game_dir("),
  );
  assert.match(play, /Some\(Arc::clone\(&preparation\.1\)\)/);
  assert.match(rust, /None => acquire_instance_lease\(app, &instance_id\)\?/);
  assert.match(rust, /let game_lease = Arc::clone\(&claim\.lease\)/);
  assert.match(rust, /let _game_lease = game_lease/);
});
