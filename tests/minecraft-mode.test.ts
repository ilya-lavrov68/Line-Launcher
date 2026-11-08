import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LINE_MC_GAME_EVENT,
  LINE_MC_INSTALL_EVENT,
  type McLoaderKind,
} from "../src/types/line.ts";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const rust = read("src-tauri/src/line/minecraft.rs");
const core = read("src-tauri/src/line/minecraft_core.rs");

test("the crate is pinned and the prelude is imported without shadowing Result", () => {
  const manifest = read("src-tauri/Cargo.toml");
  assert.match(manifest, /mc-launcher-core = "=0\.1\.2"/);
  assert.match(rust, /use mc_launcher_core::prelude::\{/);
  // A glob would import the crate's one-parameter `Result` alias over std's.
  assert.doesNotMatch(rust, /use mc_launcher_core::prelude::\*/);
  const preludeAt = rust.indexOf("use mc_launcher_core::prelude::{");
  const imported = rust.slice(preludeAt, rust.indexOf("};", preludeAt) + 2);
  assert.doesNotMatch(imported, /\bResult\b/);
  for (const type of [
    "Account",
    "InstallRequest",
    "JavaInstallPolicy",
    "LaunchOptions",
    "Launcher",
    "LoaderSpec",
  ]) {
    assert.ok(imported.includes(type), `${type} must come from the prelude`);
  }
});

test("every blocking crate call runs on spawn_blocking, never on the async runtime", () => {
  // reqwest::blocking inside a Tokio worker panics; each entry point must be
  // inside a spawn_blocking closure.
  for (const call of [
    "install_with_progress(",
    "load_version(",
    "build_launch_command_from_version(",
    "install_jvm_runtime(",
  ]) {
    const at = rust.indexOf(call);
    assert.ok(at > 0, `${call} is not called`);
    const before = rust.slice(0, at);
    const opened = before.lastIndexOf("tokio::task::spawn_blocking(");
    assert.ok(opened > 0, `${call} runs outside spawn_blocking`);
    // No async fn boundary between the closure and the call.
    const between = before.slice(opened);
    assert.doesNotMatch(between, /\nasync fn |\npub async fn /);
  }
  assert.match(rust, /tokio::process::Command::new\(&command\.executable\)/);
});

test("the offline account keeps a stable UUID instead of a random one per launch", () => {
  assert.match(
    rust,
    /Account::Offline \{\s*username: account_name,\s*uuid: account_uuid,/,
  );
  assert.doesNotMatch(rust, /Account::offline\(/);
  assert.match(rust, /let uuid = player_uuid\(&username\);/);
  assert.match(rust, /let session = line\.session\(\)\?;/);
});

test("player heap and argument hardening are applied to the built command", () => {
  // LaunchOptions has no memory knob, so the metadata's -Xmx must be replaced.
  assert.match(
    core,
    /pub fn apply_heap\(args: &mut Vec<String>, heap_mb: u32\)/,
  );
  assert.match(core, /args\.retain\(\|arg\| !\(arg\.starts_with\("-Xmx"\)/);
  const build = rust.slice(
    rust.indexOf("let command = launcher"),
    rust.indexOf("let logs ="),
  );
  assert.match(build, /reject_dangerous_args\(&args\)\?;/);
  assert.match(build, /apply_heap\(&mut args, heap_mb\);/);
  assert.ok(
    build.indexOf("reject_dangerous_args") < build.indexOf("apply_heap"),
    "arguments must be screened before the heap is injected",
  );
  assert.match(rust, /validate_heap\(requested, total\)\?/);
});

test("the child gets args, env, cwd, logging and a kill switch", () => {
  assert.match(rust, /\.args\(&command\.args\)/);
  assert.match(rust, /\.envs\(command\.env\.iter\(\)/);
  assert.match(rust, /\.current_dir\(&command\.working_dir\)/);
  assert.match(rust, /\.kill_on_drop\(true\)/);
  assert.match(rust, /creation_flags\(0x0800_0000\)/);
  assert.match(rust, /logs\.join\("launch\.log"\)/);
  assert.match(rust, /if stop\.load\(Ordering::Acquire\)/);
  assert.match(rust, /let _ = child\.kill\(\)\.await;/);
});

test("Java falls back from the player's choice to discovery to Mojang's runtime", () => {
  const resolve = rust.slice(
    rust.indexOf("async fn resolve_java("),
    rust.indexOf("fn emit_status("),
  );
  const order = [
    "java::inspect_path(requested)",
    "java::discover(required_major)",
    "runtime::get_executable_path(",
    "runtime::install_jvm_runtime(",
  ].map((needle) => resolve.indexOf(needle));
  for (const [index, at] of order.entries()) {
    assert.ok(at > 0, `missing step ${order[index]}`);
    if (index > 0)
      assert.ok(at > order[index - 1], "java fallback out of order");
  }
  // The downloaded runtime is executed before it is trusted.
  assert.match(
    resolve,
    /let probed = java::inspect_path\(&path\.to_string_lossy\(\)\)\.await\?;/,
  );
  assert.match(resolve, /probed\.major != required_major/);
  // Auto is a placeholder in the facade; the real work is resolve_java.
  assert.match(rust, /The facade does not bundle Java/);
});

test("commands, state and the additive boundary are wired", () => {
  const lib = read("src-tauri/src/lib.rs");
  for (const command of [
    "mc_install",
    "mc_list_installed",
    "mc_launch",
    "mc_stop",
    "mc_status",
  ]) {
    assert.match(lib, new RegExp(`line::minecraft::${command},`));
  }
  assert.match(
    lib,
    /app\.manage\(line::minecraft::MinecraftState::default\(\)\)/,
  );
  const mod = read("src-tauri/src/line/mod.rs");
  assert.match(mod, /pub mod minecraft;/);
  assert.match(mod, /pub mod minecraft_core;/);
  // Provider releases stay untouched: no shared directory helpers.
  assert.doesNotMatch(
    rust,
    /server_dir\(|releases|current_receipt|PrivateChannel/,
  );
  assert.match(rust, /root\.join\("minecraft"\)\.join\(instance_id\)/);
  // The provider pipeline itself is still registered.
  assert.match(lib, /line::launch::launch_game,/);
  assert.match(lib, /line::install::download_and_extract_zip,/);
});

test("the WebView contract matches the Rust event names and payload shape", () => {
  assert.equal(LINE_MC_INSTALL_EVENT, "line://mc-install-progress");
  assert.equal(LINE_MC_GAME_EVENT, "line://mc-game-status");
  assert.match(
    rust,
    /pub const MC_INSTALL_EVENT: &str = "line:\/\/mc-install-progress";/,
  );
  assert.match(
    rust,
    /pub const MC_GAME_EVENT: &str = "line:\/\/mc-game-status";/,
  );
  const api = read("src/lib/line/api.ts");
  for (const command of [
    "mc_install",
    "mc_list_installed",
    "mc_launch",
    "mc_stop",
    "mc_status",
  ]) {
    assert.ok(
      api.includes(`"${command}"`),
      `${command} is not exposed to the UI`,
    );
  }
  const kinds: McLoaderKind[] = ["fabric", "quilt", "forge", "neoforge"];
  for (const kind of kinds) {
    assert.ok(
      core.includes(`"${kind}" => LoaderChoice::`),
      `${kind} is not accepted by Rust`,
    );
  }
});

test("the pure Minecraft rules are part of the compiled Rust subset", () => {
  const harness = read("scripts/test-rust-pure.mjs");
  for (const fn of [
    "validate_server_address(",
    "has_quick_play_token(",
    "server_join_args(",
    "ensure_server_join(",
    "validate_instance_id(",
    "validate_version_id(",
    "validate_loader(",
    "apply_heap(",
    "reject_dangerous_args(",
  ]) {
    assert.ok(
      harness.includes(`fn ${fn}`),
      `${fn} escaped the compiled subset`,
    );
  }
});

test("the guide states what offline mode cannot do", () => {
  const doc = read("docs/MINECRAFT.md");
  assert.match(doc, /online-mode=true/);
  assert.match(doc, /Account::Offline/);
  assert.match(doc, /JavaInstallPolicy::Auto/);
  assert.match(doc, /spawn_blocking/);
  assert.match(doc, /Microsoft/);
});

test("Играть verifies-or-downloads and then joins the server in one command", () => {
  const play = rust.slice(
    rust.indexOf("pub async fn mc_play("),
    rust.indexOf("async fn launch_profile("),
  );
  assert.match(play, /validate_server_address\(&request\.server_address\)\?/);
  assert.ok(
    play.indexOf("install_profile(") < play.indexOf("launch_profile("),
    "the profile must be verified/downloaded before the client starts",
  );
  // Re-running install is the verify step: unchanged files are skipped.
  assert.match(rust, /skips every file whose checksum still matches/);
  assert.match(read("src/types/line.ts"), /serverAddress: string;/);
});

test("auto-join uses Quick Play on 1.20+ and the legacy pair only on older clients", () => {
  // Mojang removed --server/--port in 23w14a; the crate still emits that pair,
  // so LaunchOptions.server stays None and the join args are ours.
  assert.match(rust, /server: None,/);
  assert.match(rust, /modern clients ignore/);
  assert.match(
    rust,
    /let quick_play = has_quick_play_token\(&game_argument_tokens\(&version\)\);/,
  );
  assert.match(
    rust,
    /ensure_server_join\(&mut args, quick_play, &join_host, port\);/,
  );
  const build = rust.slice(
    rust.indexOf("let command = launcher"),
    rust.indexOf("let logs ="),
  );
  assert.ok(
    build.indexOf("apply_heap") < build.indexOf("ensure_server_join"),
    "join args must be appended after the heap rewrite",
  );
  assert.match(
    core,
    /pub const QUICK_PLAY_MULTIPLAYER: &str = "--quickPlayMultiplayer";/,
  );
  assert.match(core, /token == QUICK_PLAY_MULTIPLAYER/);
  // Rule-gated metadata is inspected too, and inheritance is already merged.
  assert.match(rust, /ArgumentValue::Ruled \{ value, \.\. \}/);
  assert.match(rust, /StringOrVec::Vec\(list\)/);
  assert.match(rust, /load_version` already merged inheritsFrom/);
});

test("multiplayer stays enabled and no singleplayer path is offered", () => {
  assert.match(rust, /disable_multiplayer: false,/);
  assert.match(rust, /disable_chat: false,/);
  assert.match(rust, /demo: false,/);
  // The production half of the module must never offer a singleplayer or
  // Realms path; the test module may name them as impostors to reject.
  const coreProduction = core.slice(0, core.indexOf("#[cfg(test)]"));
  assert.doesNotMatch(rust, /quickPlaySingleplayer|quickPlayRealms/);
  assert.doesNotMatch(coreProduction, /quickPlaySingleplayer|quickPlayRealms/);
  assert.match(
    read("src-tauri/src/line/config.rs"),
    /validate_server_address\(address\)\?/,
  );
});

test("no Microsoft or third-party auth logic is reachable from this mode", () => {
  for (const source of [rust, core, read("src/types/line.ts")]) {
    assert.doesNotMatch(
      source,
      /microsoft_account|Account::Microsoft|login_with_xbox|authlib/i,
    );
  }
  // The identity is offline by construction, not by configuration.
  assert.match(rust, /Account::Offline \{/);
});
