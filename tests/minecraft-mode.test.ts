import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LINE_MC_GAME_EVENT,
  LINE_MC_INSTALL_EVENT,
} from "../src/types/line.ts";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const rust = read("src-tauri/src/line/minecraft.rs");
const install = read("src-tauri/src/line/install.rs");
const core = read("src-tauri/src/line/minecraft_core.rs");
const pack = read("src-tauri/src/line/pack.rs");
const instance = read("src-tauri/src/line/instance.rs");

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

test("Java prefers a valid local runtime, then Windows Temurin or Mojang", () => {
  const resolve = rust.slice(
    rust.indexOf("async fn resolve_java("),
    rust.indexOf("fn emit_status("),
  );
  const order = [
    "java::inspect_path(requested)",
    "java::discover(required_major)",
    "runtime::get_executable_path(",
    "java_auto::find_cached_windows_x64",
    "java_auto::install_windows_x64",
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
  assert.match(
    resolve,
    /consent\.require\(required_major, purpose, "adoptium"\)/,
  );
  assert.match(
    resolve,
    /consent\.require\(required_major, purpose, "mojang"\)/,
  );
});

test("commands, state and the additive boundary are wired", () => {
  const lib = read("src-tauri/src/lib.rs");
  for (const command of ["mc_play", "mc_stop", "mc_status"]) {
    assert.match(lib, new RegExp(`line::minecraft::${command},`));
  }
  for (const removed of ["mc_install", "mc_list_installed", "mc_launch"]) {
    assert.doesNotMatch(lib, new RegExp(`line::minecraft::${removed},`));
    assert.doesNotMatch(rust, new RegExp(`pub async fn ${removed}\\b`));
  }
  assert.match(
    lib,
    /app\.manage\(line::minecraft::MinecraftState::default\(\)\)/,
  );
  const mod = read("src-tauri/src/line/mod.rs");
  assert.match(mod, /pub mod minecraft;/);
  assert.match(mod, /pub mod minecraft_core;/);
  assert.match(mod, /pub mod instance;/);
  assert.match(mod, /pub mod pack;/);
  // The pack flow reads the provider's verified release through the existing
  // installer. It must never open the private ticket channel or write into the
  // release itself: the live copy lives under minecraft/<instance>/game.
  assert.doesNotMatch(rust, /PrivateChannel|remove_dir_if_present/);
  assert.match(rust, /install::download_and_extract_resolved\(/);
  assert.doesNotMatch(
    pack,
    /remove_dir_if_present|releases"\)\.join\(instance/,
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
  for (const command of ["mc_play", "mc_stop", "mc_status"]) {
    assert.ok(
      api.includes(`"${command}"`),
      `${command} is not exposed to the UI`,
    );
  }
  for (const removed of ["mc_install", "mc_list_installed", "mc_launch"]) {
    assert.ok(
      !api.includes(`"${removed}"`),
      `${removed} remains exposed to the UI`,
    );
  }
  assert.doesNotMatch(api, /mcInstall:|mcListInstalled:|mcLaunch:/);
  assert.match(
    rust,
    /pub struct McPlayRequest \{[\s\S]*server_id: String,[\s\S]*test_mode: bool/,
  );
  assert.doesNotMatch(
    rust,
    /pub struct McPlayRequest \{[^}]*minecraft_version|pub struct McPlayRequest \{[^}]*loader:|pub struct McPlayRequest \{[^}]*server_address/s,
  );
  assert.doesNotMatch(
    read("src/types/line.ts"),
    /export interface McLoaderRequest|export interface McInstallRequest|export interface McLaunchRequest/,
  );
});

test("the pure Minecraft rules are part of the compiled Rust subset", () => {
  const harness = read("scripts/test-rust-pure.mjs");
  for (const fn of [
    "validate_server_address(",
    "has_quick_play_token(",
    "server_join_args(",
    "ensure_server_join(",
    "validate_test_mode(",
    "remove_automatic_joins(",
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
  assert.match(play, /validate_server_address\(&address\)\?/);
  assert.ok(
    play.indexOf('"Проверка сборки на сервере…"') <
      play.indexOf("pack::effective_server("),
  );
  assert.match(play, /log_preparation_stage\("pack", pack_started, false\)/);
  assert.match(play, /config\.server\(&request\.server_id\)\?/);
  assert.ok(
    play.indexOf("pack::effective_server(") <
      play.indexOf("install::download_and_extract_resolved("),
    "pack.json must decide the revision before anything is downloaded",
  );
  for (const [earlier, later] of [
    ["install::download_and_extract_resolved(", "pack::inspect("],
    ["pack::inspect(", "pack::sync_game_dir("],
    ["pack::sync_game_dir(", "launch_profile("],
  ]) {
    assert.ok(
      play.indexOf(earlier) < play.indexOf(later),
      `${earlier} must run before ${later}`,
    );
  }
  assert.match(play, /let hint = effective\.minecraft_version\.clone\(\);/);
  assert.doesNotMatch(play, /request\.minecraft_version/);
  assert.match(install, /pub async fn download_and_extract_resolved/);
  const resolved = install.slice(
    install.indexOf("pub async fn download_and_extract_resolved("),
    install.indexOf("/// `repair`"),
  );
  assert.doesNotMatch(resolved, /pack::effective_server\(/);
  // The existing installer is reused, not a second downloader.
  assert.match(rust, /receipt\.already_installed/);
  assert.doesNotMatch(rust, /reqwest::blocking::Client/);
  // Only the downloaded official NeoForge installer is opened to read its bounded profile.
  assert.match(rust, /archive\.by_name\("version\.json"\)/);
  assert.match(rust, /entry\.size\(\) > 4 \* 1024 \* 1024/);
  assert.doesNotMatch(
    read("src/types/line.ts"),
    /export interface McPlayRequest \{[^}]*minecraftVersion|export interface McPlayRequest \{[^}]*loader:|export interface McPlayRequest \{[^}]*serverAddress/s,
  );
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

test("multiplayer stays enabled and test mode avoids automatic joins", () => {
  assert.match(rust, /disable_multiplayer: false,/);
  assert.match(rust, /disable_chat: false,/);
  assert.match(rust, /demo: false,/);
  assert.match(rust, /remove_automatic_joins\(&mut args\)/);
  assert.match(rust, /validate_test_mode/);
  assert.match(core, /pub fn remove_automatic_joins/);
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

test("the pack is a ZIP of a whole instance, verified through pack.json", () => {
  // Freshness comes from a small JSON, and the pinned distribution stays a
  // fallback for providers that do not host one.
  assert.match(pack, /pub struct PackManifest/);
  assert.match(pack, /pack_manifest_url/);
  assert.match(pack, /schema_version: u32/);
  assert.match(pack, /integrity::valid_sha256\(&self\.sha256\)/);
  assert.match(pack, /MAX_ARCHIVE_BYTES/);
  assert.match(pack, /MAX_UNPACKED_BYTES/);
  assert.match(
    read("src-tauri/src/line/config.rs"),
    /pub pack_manifest_url: Option<String>/,
  );
  // A malformed manifest is a provider bug; only a network failure may fall
  // back to the cached copy.
  const effective = pack.slice(
    pack.indexOf("pub async fn effective_server("),
    pack.indexOf("fn apply("),
  );
  assert.match(effective, /PackManifest::parse\(&bytes\)\?;/);
  assert.match(effective, /if !is_real_file\(&cache\)/);
  assert.match(read("package.json"), /"pack:manifest"/);
});

test("the live game directory is writable and player data survives updates", () => {
  // Two directories: the hash-verified release and the live `.minecraft`.
  assert.match(pack, /releases/);
  assert.match(pack, /instance_root\.join\("game"\)/);
  assert.match(rust, /fn game_root\(/);
  assert.match(rust, /instance_root\(app, instance_id\)\?\.join\("game"\)/);
  // An unchanged revision is not re-copied, so mod config edits survive.
  assert.match(pack, /previous\.sha256 == sha256/);
  assert.match(pack, /keep_local\(relative\) && is_real_file\(&target\)/);
  assert.match(pack, /overlay_removals\(&previous\.files, &detected\.files\)/);
  // Every copied or deleted path goes through the archive path validator.
  assert.ok((pack.match(/safe_entry_path\(relative\)\?/g)?.length ?? 0) >= 2);
  assert.match(pack, /checked_game_path\(&game, relative, true\)/);
  assert.match(pack, /temp\.persist\(target\)/);
  for (const guarded of ["saves/", "logs/", "screenshots/", "crash-reports/"]) {
    assert.ok(
      instance.includes(`"${guarded}"`),
      `${guarded} must be protected`,
    );
  }
  assert.match(instance, /pub fn is_user_data/);
});

test("provider builds may use verified instance loaders, never a player override", () => {
  assert.match(pack, /loader_from_libraries\(&library_names\(json\)\)/);
  assert.match(pack, /inheritsFrom/);
  const play = rust.slice(
    rust.indexOf("pub async fn mc_play("),
    rust.indexOf("fn emit_mc_progress("),
  );
  assert.match(play, /if detected\.generated_profile \{/);
  assert.match(play, /let loader = if detected\.generated_profile/);
  assert.doesNotMatch(play, /request\.loader/);
  assert.match(play, /requested_loader: None/);
  assert.match(play, /loader_spec\(\s*kind,/);
  // Only the gaps are fetched, and the pack's own profile is what launches.
  assert.match(play, /if !unresolved_hints\.is_empty\(\)/);
  assert.match(
    play,
    /let mut launch_version = detected\.version_id\.clone\(\);/,
  );
  assert.match(instance, /pub fn missing_parts/);
});

test("test mode is provider-controlled and reuses the normal verified launch path", () => {
  const panel = read("src/components/line/MinecraftPanel.tsx");
  const config = read("src-tauri/src/line/config.rs");
  const play = rust.slice(
    rust.indexOf("pub async fn mc_play("),
    rust.indexOf("async fn launch_profile("),
  );
  assert.match(panel, /server\.test_mode_enabled !== false/);
  assert.match(panel, /play\(true\)/);
  assert.match(config, /pub test_mode_enabled: bool/);
  assert.match(play, /validate_test_mode\(/);
  assert.match(play, /server\.test_mode_enabled/);
  assert.match(play, /integrity::scan\(&release\)/);
  assert.match(play, /scan_packs_with_verified_nested\(/);
  assert.doesNotMatch(
    play,
    /if request\.test_mode \{\s*install::current_receipt/,
  );
  assert.match(play, /install::download_and_extract/);
  assert.match(rust, /if test_mode \{\s*remove_automatic_joins/);
});
