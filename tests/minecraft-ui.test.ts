import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The minecraft mode is a provider opt-in, and the point of these tests is that
 * the opt-in cannot leak: no config without the field gets the panel, and no
 * config that asks for it gets a half-working screen. Everything here reads the
 * source, because the Rust half cannot be compiled in this environment — the
 * assertions are about wiring and arguments, not about runtime behaviour.
 */

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const config = read("src-tauri/src/line/config.rs");
const detail = read("src/components/line/ServerDetail.tsx");
const panel = read("src/components/line/MinecraftPanel.tsx");
const api = read("src/lib/line/api.ts");
const types = read("src/types/line.ts");
const providerDocs = read("docs/PROVIDER.md");
const minecraftDocs = read("docs/MINECRAFT.md");

test("the mode is an explicit enum variant, not a flag inferred from data", () => {
  // A third variant of LaunchMode, defaulting to Ticket: a config written
  // before this variant existed keeps its exact previous behaviour.
  assert.match(config, /pub enum LaunchMode \{/);
  assert.match(config, /#\[default\]\s*\n\s*Ticket,/);
  assert.match(config, /\n\s*Minecraft,/);
  assert.match(
    types,
    /export type LaunchMode = "ticket" \| "offline" \| "minecraft";/,
  );
  // Never derived from the presence of an address or a version.
  assert.doesNotMatch(
    config,
    /launch_mode\s*=\s*LaunchMode::Minecraft\s*;?\s*\/\/\s*if/,
  );
  assert.match(detail, /server\.launch_mode === "minecraft"/);
});

test("a minecraft server is validated at parse time, not at button time", () => {
  // Address and version are required, and the message names the missing field.
  assert.match(config, /launch_mode=minecraft требует server_address/);
  assert.match(config, /launch_mode=minecraft требует minecraft_version/);
  // The address itself is validated by the same checker everything else uses.
  assert.match(config, /validate_server_address\(address\)/);
  // No ticket endpoints: the identity is the project account, not a session.
  assert.match(
    config,
    /matches!\(server\.launch_mode, LaunchMode::Offline \| LaunchMode::Minecraft\)/,
  );
});

test("the provider ZIP requirements are skipped only for this mode", () => {
  // Distribution is unused for a Mojang-sourced install, so an empty
  // placeholder must not fail validation — but only for this branch.
  const skip = config.indexOf(
    "if server.launch_mode == LaunchMode::Minecraft {\n                continue;",
  );
  assert.ok(
    skip > 0,
    "the distribution check must be skipped for minecraft mode",
  );
  const distCheck = config.indexOf("let dist = &server.distribution;");
  assert.ok(
    skip < distCheck,
    "the skip has to come before the distribution validation",
  );
});

test("the panel replaces the ZIP dock instead of competing with it", () => {
  // One dock at a time: a ternary, not two panels on the same screen.
  assert.match(detail, /isMinecraft \? \(/);
  assert.match(detail, /<MinecraftPanel/);
  assert.match(detail, /\) : \(\s*\n\s*<ServerActionPanel/);
  // One design, so there is no second page to keep in step: the panel is the
  // only place a minecraft-mode server can end up, and the ZIP dock cannot be
  // reached for it at all.
  assert.doesNotMatch(detail, /theme === /);
  assert.doesNotMatch(detail, /LegacyDetail/);
});

test("every mc_* command has exactly one caller, and mc_launch has none", () => {
  // These four are reached from the panel (`mcStatus` through a chained call,
  // hence the looser match).
  for (const call of [
    /lineApi\s*\.?\s*mcStatus\(/,
    /lineApi\.mcListInstalled\(/,
    /lineApi\.mcPlay\(/,
    /lineApi\.mcStop\(/,
  ]) {
    assert.match(panel, call, "a command is missing its caller in the panel");
  }
  // «Подготовить заранее» is the only path to mc_install.
  assert.ok(panel.includes("lineApi.mcInstall("), "mc_install has no caller");
  // mc_launch would start a profile without checking it against the published
  // pack; mc_play is the only correct "just play" path, so it stays unused in
  // the UI on purpose (documented in MINECRAFT.md).
  assert.ok(
    !panel.includes("lineApi.mcLaunch("),
    "the panel must not bypass mc_play's verification",
  );
  assert.match(
    minecraftDocs,
    /`mc_launch` в интерфейсе намеренно не используется/,
  );
  // Every command still exists in the API layer.
  for (const cmd of [
    "mc_install",
    "mc_list_installed",
    "mc_launch",
    "mc_play",
    "mc_stop",
    "mc_status",
  ]) {
    assert.ok(api.includes(`"${cmd}"`), `${cmd} is missing from the API layer`);
  }
});

test("running state survives a screen change and comes from the backend", () => {
  // mc_status is called on mount: a game started before the player navigated
  // away is still running, and the panel has to show «Остановить игру».
  assert.match(panel, /lineApi\s*\n\s*\.mcStatus\(instanceId\)/);
  // Events are filtered by instance so two servers never mix progress.
  assert.match(api, /event\.payload\.instanceId === instanceId/);
  // Stop relies on the exited event, not on the promise's return value.
  assert.match(panel, /\/\/ The exited phase arrives as an event/);
});

test("an expired session leaves the panel instead of failing silently", () => {
  assert.match(panel, /onAuthRequired\?\.\(\)/);
  assert.match(
    read("src/components/line/LineLauncher.tsx"),
    /onAuthRequired=\{requireAuth\}/,
  );
});

test("the provider guide documents the opt-in, its fields and its limit", () => {
  assert.match(providerDocs, /"launch_mode": "minecraft"/);
  assert.match(providerDocs, /server_address/);
  assert.match(providerDocs, /minecraft_version/);
  assert.match(providerDocs, /online-mode=false/);
  assert.match(providerDocs, /distribution/);
  // The honest limit — no Mojang session, no bypass — is written down.
  assert.match(providerDocs, /не подделывает сессию/);
});
