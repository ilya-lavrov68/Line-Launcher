// Wiring checks for the real-client launch and the per-file integrity guard.
// The behaviour itself is covered by the Rust unit tests (`npm run test:rust`
// runs the pure ones, `cargo test` the filesystem ones). What these tests protect
// is the *ordering and wiring* that a unit test cannot see: the index must be
// published before the completion marker, the scan must happen under the install
// lock before Java is spawned, the lease must be released before repairing, and
// every argument the launcher owns must be shielded from pack overrides.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { LaunchManifest } from "../src/types/line.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const integrity = read("src-tauri/src/line/integrity.rs");
const install = read("src-tauri/src/line/install.rs");
const launch = read("src-tauri/src/line/launch.rs");
const manifestRs = read("src-tauri/src/line/launch_manifest.rs");

test("integrity module is part of the crate", () => {
  assert.match(read("src-tauri/src/line/mod.rs"), /pub mod integrity;/);
  assert.match(integrity, /pub const INDEX_FILE: &str = "\.line-files\.json";/);
  assert.match(
    integrity,
    /pub const COMPLETE_MARKER: &str = "\.line-complete";/,
  );
});

test("every extracted file is hashed and the index is validated", () => {
  // Hashing must happen in the write loop, not from a second pass over paths.
  const loop = install.slice(
    install.indexOf("let mut indexed:"),
    install.indexOf("Ok(index)"),
  );
  assert.ok(loop.length > 0, "extraction loop not found");
  assert.match(loop, /hasher\.update\(&buffer\[\.\.count\]\);/);
  assert.match(loop, /indexed\.push\(super::integrity::FileEntry \{/);
  assert.match(loop, /sha256: format!\("\{:x\}", hasher\.finalize\(\)\)/);
  assert.match(loop, /size: entry_size/);
  assert.match(install, /index\.validate\(\)\?;\s*\n\s*Ok\(index\)/);
});

test("the index is published before the release is called complete", () => {
  const writeIndex = install.indexOf(
    "super::integrity::write_index(&content, &index)",
  );
  const marker = install.indexOf(
    "content.join(super::integrity::COMPLETE_MARKER)",
  );
  assert.ok(writeIndex > 0, "index is never written");
  assert.ok(marker > writeIndex, "marker must be written after the index");
});

test("a pack cannot ship the launcher's own bookkeeping files", () => {
  assert.match(
    install,
    /if super::integrity::is_reserved\(entry\.name\(\)\) \{\s*\n\s*return Err\(LineError::new\(\s*\n\s*ErrorCode::UnsafeArchive/,
  );
  assert.match(
    integrity,
    /relative == INDEX_FILE \|\| relative == COMPLETE_MARKER/,
  );
});

test("repair re-downloads instead of returning the installed receipt", () => {
  assert.match(install, /pub async fn repair\(/);
  assert.match(
    install,
    /install_inner\(client, server, base, operation_id, cancel, sink, true\)/,
  );
  // The short circuit has to be conditional, otherwise repair does nothing.
  assert.match(
    install,
    /if !repair \{\s*\n\s*if let Some\(mut receipt\) = installed_receipt/,
  );
});

test("launch scans under the lock, deletes foreign files and repairs before spawn", () => {
  const scanFn = launch.slice(
    launch.indexOf("fn scan_release_blocking("),
    launch.indexOf("async fn prepare_release("),
  );
  assert.ok(scanFn.length > 0);
  const lockAt = scanFn.indexOf("InstallLock::acquire(base)");
  const scanAt = scanFn.indexOf("super::integrity::scan(&release)");
  assert.ok(
    lockAt > 0 && scanAt > lockAt,
    "scan must run while holding the lease",
  );
  assert.match(
    scanFn,
    /super::integrity::remove_foreign\(&release, &report\.foreign\)/,
  );
  assert.match(scanFn, /prune_empty_dirs\(&release, &report\.foreign\)/);
  // An unreadable/missing index is a repair, never a silent pass.
  assert.match(scanFn, /Err\(_\) => \(true, 0\)/);

  const prepare = launch.slice(
    launch.indexOf("async fn prepare_release("),
    launch.indexOf("pub async fn launch_game("),
  );
  const dropAt = prepare.indexOf("drop(lease);");
  const repairAt = prepare.indexOf("super::install::repair(");
  assert.ok(
    dropAt > 0 && repairAt > dropAt,
    "the lease must be released before repairing",
  );
  assert.match(prepare, /if lease\.repair_needed \|\| lease\.removed > 0 \{/);
  assert.match(prepare, /ErrorCode::Integrity/);

  // The scan is wired into the launch path before Java is started.
  const game = launch.slice(
    launch.indexOf("pub async fn launch_game("),
    launch.indexOf("pub async fn stop_game("),
  );
  const prepareCall = game.indexOf(
    "prepare_release(&app, &state, &server, &base, &stop)",
  );
  const spawn = game.indexOf("command.spawn()");
  assert.ok(prepareCall > 0 && spawn > prepareCall);
  // A refactor must not reintroduce the marker-only path around the scan.
  assert.ok(
    !game.includes("InstallLock::acquire"),
    "launch_game took the lease without verifying files",
  );
  assert.ok(
    !game.includes("verified_game_dir("),
    "launch_game resolved a release without verifying files",
  );
});

test("the game runs in the server's own writable directory", () => {
  assert.match(launch, /let dir = base\.join\("game"\);/);
  const game = launch.slice(
    launch.indexOf("pub async fn launch_game("),
    launch.indexOf("pub async fn stop_game("),
  );
  assert.match(game, /let game_dir = instance_game_dir\(&io_base\)\?;/);
  assert.match(game, /game_dir: game_dir\.clone\(\)/);
  assert.match(game, /\.current_dir\(&game_dir\)/);
  // The manifest is still read from the immutable release, not from game/.
  assert.match(game, /read_optional\(&io_release\)\?/);
});

test("real client arguments are present and the token stays a placeholder", () => {
  for (const flag of [
    "--uuid",
    "--accessToken",
    "--userType",
    "--versionType",
    "--gameDir",
    "--username",
    "--version",
  ]) {
    assert.ok(launch.includes(`"${flag}".into()`), `missing ${flag}`);
  }
  assert.match(launch, /"--accessToken"\.into\(\),\s*\n\s*"0"\.into\(\)/);
  assert.match(launch, /"-Xss1M"\.into\(\)/);
  assert.match(
    launch,
    /if cfg!\(target_os = "macos"\) \{\s*\n\s*args\.push\("-XstartOnFirstThread"/,
  );
  assert.match(launch, /-Dorg\.lwjgl\.librarypath=/);
  assert.match(launch, /-Dlog4j\.configurationFile=/);
  assert.match(launch, /pub fn player_uuid\(username: &str\) -> String/);
});

test("every launcher-owned argument is shielded from pack overrides", () => {
  const block =
    /pub const LAUNCHER_OWNED_ARGS: &\[&str\] = &\[([\s\S]*?)\];/.exec(
      manifestRs,
    );
  assert.ok(block, "LAUNCHER_OWNED_ARGS not found");
  const owned = new Set(
    [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
  // Only the real command builder: the Rust tests mention pack arguments too.
  const builder = launch.slice(
    launch.indexOf("pub fn build_java_command("),
    launch.indexOf("pub fn instance_game_dir("),
  );
  const emitted = [
    ...builder.matchAll(/"(--[A-Za-z][A-Za-z0-9]*)"\.into\(\)/g),
  ].map((match) => match[1].slice(2).toLowerCase());
  assert.ok(emitted.length >= 7, "no launcher arguments found");
  for (const flag of emitted) {
    assert.ok(owned.has(flag), `${flag} can be overridden by a pack`);
  }
  // Both gates use the same validator: install-time and pre-spawn.
  assert.match(manifestRs, /if !game_args_are_safe\(&self\.game_args\)/);
  assert.match(
    launch,
    /!super::launch_manifest::game_args_are_safe\(&spec\.game_args\)/,
  );
  assert.match(
    launch,
    /args\.extend\(spec\.game_args\.iter\(\)\.cloned\(\)\);/,
  );
});

test("the player can see what the launch is doing while files are checked", () => {
  // The dock is the only thing that shows launch progress now. `status.message`
  // used to be rendered only for a failed launch, which would hide every note
  // published during the file scan.
  const controls = read("src/components/line/ServerActionPanel.tsx");
  assert.match(controls, /phase === "starting" && status\?\.message/);
  assert.match(launch, /message: Some\("Проверка файлов сборки…"\.into\(\)\)/);
  assert.match(launch, /удалено посторонних/);
  assert.match(launch, /скачиваем заново/);
});

test("manifest fields are declared in Rust and in the WebView types", () => {
  const types = read("src/types/line.ts");
  for (const field of ["logging_config", "game_args", "user_type"]) {
    assert.ok(manifestRs.includes(`pub ${field}:`), `Rust is missing ${field}`);
    assert.ok(types.includes(`${field}?:`), `types are missing ${field}`);
  }
  // Optional in the contract: an older pack must stay valid.
  const example = JSON.parse(
    read("examples/line-launch.json"),
  ) as LaunchManifest;
  assert.equal(example.schema_version, 1);
  assert.equal(example.game_args, undefined);
  // The demo pack exercises the new path end to end.
  const demo = read("examples/provider/build-pack.mjs");
  assert.match(demo, /game_args: \["--demoMode", "line"\]/);
  assert.match(demo, /user_type: "mojang"/);
});

test("the launch guide is linked and states the limits honestly", () => {
  const guide = read("docs/GAME.md");
  assert.match(read("README.md"), /\[GAME\.md\]\(docs\/GAME\.md\)/);
  assert.match(read("docs/PROVIDER.md"), /\[GAME\.md\]\(GAME\.md\)/);
  for (const phrase of [
    "instances/<id>/game",
    ".line-files.json",
    "Microsoft",
    "Forge",
    "--accessToken 0",
  ]) {
    assert.ok(guide.includes(phrase), `guide does not mention ${phrase}`);
  }
});
