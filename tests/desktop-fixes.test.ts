import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertReleaseArgs } from "../scripts/tauri-build.mjs";
import { LINE_SUPPORTED_FEATURES } from "../src/types/line.ts";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("the upload heading has no fake plus button; section icons are unframed", () => {
  const wardrobe = read("src/components/line/WardrobeScreen.tsx");
  const upload = wardrobe.slice(
    wardrobe.indexOf("Добавить скин в историю") - 400,
    wardrobe.indexOf("Файл текстуры"),
  );
  assert.doesNotMatch(upload, /<Plus\b|SectionIcon/);
  assert.match(wardrobe, /<SectionIcon icon=\{History\} \/>/);
  assert.match(wardrobe, /<SectionIcon icon=\{Shirt\} \/>/);
  const icon = read("src/components/line/SectionIcon.tsx");
  assert.match(icon, /h-5 w-5/);
  const className = icon.match(/className="([^"]+)"/)?.[1] ?? "";
  assert.doesNotMatch(className, /border|bg-|rounded|shadow/);
  assert.match(
    read("src/components/line/SettingsScreen.tsx"),
    /<SectionIcon icon=\{Icon\} \/>/,
  );
  for (const file of [
    "ConnectingScreen.tsx",
    "ConfigUrlInput.tsx",
    "ServerCard.tsx",
    "ServerBanner.tsx",
    "SkinPreview.tsx",
  ]) {
    const src = read(`src/components/line/${file}`);
    assert.match(src, /data-line-icon/);
    assert.doesNotMatch(
      src,
      /bg-primary\/10 text-primary border-primary\/20|rounded-full shadow-inner/,
    );
  }
});

test("PATH bin directories and explicit JDK homes resolve to the real java executable", () => {
  const java = read("src-tauri/src/line/java.rs");
  const harness = read("scripts/test-rust-pure.mjs");
  assert.match(java, /eq_ignore_ascii_case\("bin"\)/);
  assert.match(java, /push\(root\.join\(java_name\(\)\)\)/);
  assert.match(java, /pub fn process_path/);
  assert.match(java, /strip_prefix\(r"\\\\\?\\"\)/);
  assert.match(java, /String::from_utf8_lossy\(&out\)/);
  assert.match(java, /String::from_utf8_lossy\(&err\)/);
  for (const fn of [
    "push_java_candidates(",
    "process_path(",
    "validate_path(",
  ]) {
    assert.ok(
      harness.includes(`fn ${fn}`),
      `${fn} escaped the compiled subset`,
    );
  }
  assert.match(read("src-tauri/src/lib.rs"), /line::settings::probe_java_path/);
  const settings = read("src-tauri/src/line/settings.rs");
  assert.match(settings, /super::java::inspect_path\(requested\)\.await\?/);
  assert.match(settings, /settings\.java_path = Some\(runtime\.path/);
  const launch = read("src-tauri/src/line/launch.rs");
  assert.match(launch, /java::inspect_path\(requested\)\.await\?/);
  assert.match(launch, /runtime\.major != required_major/);
  const ui = read("src/components/line/SettingsScreen.tsx");
  assert.match(ui, /probeJavaPath\(javaPathInput\.trim\(\)\)/);
  assert.match(ui, /Повторить поиск Java/);
  assert.doesNotMatch(ui, /Java не найдена\. Установите JDK/);
});

test("the local demo bypasses system proxies only in the dev-only build", () => {
  const state = read("src-tauri/src/line/state.rs");
  assert.match(
    state,
    /#\[cfg\(feature = "dev-provider-ca"\)\]\s*let builder = builder\.no_proxy\(\);/,
  );
  assert.match(state, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
  const http = read("src-tauri/src/line/http.rs");
  assert.match(http, /HTTP \{status\} без корректного Location/);
  assert.match(http, /url\.join\(location\)/);
  assert.match(http, /validate_https\(/);
  // Release proxy behaviour and TLS verification are not changed by this fix.
  assert.doesNotMatch(state, /danger_accept_invalid_certs/);
});

test("offline launch is explicit, compatible and never inferred from missing auth", () => {
  assert.ok(LINE_SUPPORTED_FEATURES.includes("offline-launch-v1"));
  const config = read("src-tauri/src/line/config.rs");
  assert.match(config, /#\[default\]\s*Ticket,\s*\/\/\/[^\n]*\n\s*Offline/);
  assert.match(config, /launch_mode == LaunchMode::Offline/);
  assert.match(config, /launch_ticket_url\.is_some\(\)/);
  assert.match(config, /session_exchange_url\.is_some\(\)/);
  const ui = read("src/components/line/LaunchControls.tsx");
  assert.match(ui, /server\.launch_mode === "offline"/);
  assert.match(ui, /offline \|\|/);
  assert.match(read("src/types/line.ts"), /launch_mode\?: LaunchMode/);
  const build = read("examples/provider/build-pack.mjs");
  assert.match(build, /launchable \? \{ launch_mode: "offline" \} : \{\}/);
  assert.match(
    read("scripts/demo-selftest.mjs"),
    /creative\.launch_mode === "offline" && creative\.auth === undefined/,
  );
});

test("offline packs create no ticket channel and do not wait for an auth handshake", () => {
  const launch = read("src-tauri/src/line/launch.rs");
  assert.match(launch, /let launch_auth = if offline \{\s*None/);
  assert.match(launch, /let mut ipc_done = ipc_task\.is_none\(\);/);
  assert.match(launch, /session_channel_id: launch_auth\.as_ref\(\)\.map/);
  assert.match(launch, /if let Some\(id\) = &spec\.session_channel_id/);
  assert.match(
    launch,
    /fn offline_command_has_no_session_channel_or_ticket_requirement/,
  );
  assert.ok(
    read("scripts/test-rust-pure.mjs").includes(
      "fn offline_command_has_no_session_channel_or_ticket_requirement(",
    ),
  );
  // The project account, archive verification and release lease remain mandatory.
  assert.match(launch, /let session = state\.session\(\)\?;/);
  assert.match(
    launch,
    /prepare_release\(&app, &state, &server, &base, &stop\)/,
  );
});

test("the game monitor aborts the optional IPC handle inside its own scope", () => {
  const launch = read("src-tauri/src/line/launch.rs");
  const stop = launch.slice(
    launch.indexOf("if monitor_stop.load(Ordering::Acquire)"),
    launch.indexOf("if ipc_done {"),
  );
  assert.match(
    stop,
    /if let Some\(task\) = &ipc_task \{\s*task\.abort\(\);\s*\}/,
  );
  assert.ok(
    stop.indexOf("if let Some(task) = &ipc_task") <
      stop.indexOf("task.abort()"),
  );
  const settings = read("src-tauri/src/line/settings.rs");
  assert.match(settings, /use std::path::PathBuf;/);
  assert.doesNotMatch(settings, /use std::path::\{Path, PathBuf\}/);
});

test("installers reject dev/debug feature arguments before doing any work", () => {
  for (const args of [
    ["--features", "dev-provider-ca"],
    ["--features=dev-provider-ca"],
    ["-f", "dev-provider-ca"],
    ["--all-features"],
    ["--debug"],
    ["-d"],
    ["--", "--all-features"],
  ]) {
    assert.throws(() => assertReleaseArgs(args), /запрещён/);
  }
  assert.doesNotThrow(() =>
    assertReleaseArgs(["--target", "x86_64-pc-windows-msvc", "--no-sign"]),
  );
  const builder = read("scripts/tauri-build.mjs");
  assert.ok(
    builder.indexOf("assertReleaseArgs(extraArgs)") <
      builder.indexOf('"--require-provider"'),
  );
  assert.match(read("src-tauri/Cargo.toml"), /default = \[\]/);
});

test("the guide explains the provider-owned offline path and its limits", () => {
  const build = read("docs/BUILD.md");
  assert.match(build, /launch_mode": "offline"/);
  assert.match(build, /offline-launch-v1/);
  assert.match(build, /не скачивает произвольный Minecraft/);
  assert.match(build, /java\.exe/);
  const game = read("docs/GAME.md");
  assert.match(game, /Офлайн-сборка провайдера/);
  assert.match(game, /без ticket/);
  assert.match(read("docs/PROVIDER.md"), /launch_mode/);
});
