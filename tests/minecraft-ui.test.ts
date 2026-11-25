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
    /matches!\(\s*server\.launch_mode,\s*LaunchMode::Offline \| LaunchMode::Minecraft\s*\)/,
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
  assert.equal(
    (detail.match(/<MinecraftPanel\b/g) ?? []).length,
    1,
    "Minecraft controls must be rendered only once",
  );
  assert.match(detail, /\) : \(\s*\n\s*<ServerActionPanel/);
  // One design, so there is no second page to keep in step: the panel is the
  // only place a minecraft-mode server can end up, and the ZIP dock cannot be
  // reached for it at all.
  assert.doesNotMatch(detail, /theme === /);
  assert.doesNotMatch(detail, /LegacyDetail/);
});

test("the panel exposes only provider-bound play and lifecycle commands", () => {
  // mcStatus is reached through a chained call, hence the looser match.
  for (const call of [
    /lineApi\s*\.?\s*mcStatus\(/,
    /lineApi\.mcPlay\(/,
    /lineApi\.mcStop\(/,
  ]) {
    assert.match(panel, call, "a command is missing its caller in the panel");
  }
  // Preparation uses the same verified pack path without starting the game.
  assert.match(panel, /prepareOnly: true/);
  assert.match(panel, /await onRefreshConfig\?\.\(\)/);
  // The backend itself rejects arbitrary install/list/launch commands; only
  // provider-bound mc_play can select and start a profile.
  assert.doesNotMatch(panel, /lineApi\.mc(?:Install|ListInstalled|Launch)\(/);
  assert.match(minecraftDocs, /не являются\s+публичными командами/);
  // Only provider-bound playback and lifecycle commands are public. Arbitrary
  // install/list/launch IPC would bypass provider-controlled build policy.
  for (const cmd of ["mc_play", "mc_stop", "mc_status"]) {
    assert.ok(api.includes(`"${cmd}"`), `${cmd} is missing from the API layer`);
  }
  for (const cmd of ["mc_install", "mc_list_installed", "mc_launch"]) {
    assert.ok(!api.includes(`"${cmd}"`), `${cmd} must not be public`);
  }
  assert.match(minecraftDocs, /не являются\s+публичными командами/);
});

test("Minecraft dock keeps advanced actions in the split menu and reports build checks", () => {
  assert.match(panel, /data-testid="server-action-menu"/);
  assert.match(panel, /role="menu"/);
  assert.match(panel, /t\("detail\.checkBuild"\)/);
  assert.match(panel, /t\("detail\.prepareAhead"\)/);
  assert.match(panel, /t\("detail\.offlineLaunch"\)/);
  assert.match(panel, /lineApi\.checkBuild\(instanceId\)/);
  assert.match(panel, /lineApi\.checkPacks\(instanceId\)/);
  assert.match(panel, /setUnprovedMods\(packs\.unproved\)/);
  assert.match(panel, /data-testid="build-integrity-result"/);
  assert.match(panel, /paths\.slice\(0, 12\)/);
});

test("the advanced-actions trigger is a separate animated segment beside Play", () => {
  const dock = read("src/components/line/ServerDock.tsx");
  assert.match(panel, /<ServerDockPrimary\s+joined=\{!running\}/);
  assert.match(panel, /<details[\s\S]*?<summary[\s\S]*?aria-haspopup="menu"/);
  assert.match(panel, /group-open:rotate-180/);
  assert.match(
    dock,
    /joined && "rounded-s-\[calc\(var\(--radius-item\)-1px\)\] rounded-e-none"/,
  );
  assert.match(
    panel,
    /rounded-s-none rounded-e-\[calc\(var\(--radius-item\)-1px\)\]/,
  );
  assert.match(panel, /bg-border gap-0 rounded-\[var\(--radius-item\)\] p-px/);
  assert.match(panel, /flex h-11 w-11/);
  assert.doesNotMatch(panel, /bg-border gap-px/);
  assert.doesNotMatch(
    read("src/components/line/ServerActionPanel.tsx"),
    /bg-border gap-px/,
  );
});

test("Minecraft quarantine and restore operate in the separate writable instance", () => {
  const launch = read("src-tauri/src/line/launch.rs");
  const quarantine = launch.slice(
    launch.indexOf("pub async fn quarantine_mods("),
    launch.indexOf("pub async fn restore_quarantined("),
  );
  const restore = launch.slice(
    launch.indexOf("pub async fn restore_quarantined("),
    launch.indexOf("pub async fn launch_game("),
  );
  for (const action of [quarantine, restore]) {
    assert.match(action, /LaunchMode::Minecraft/);
    assert.match(action, /root\.join\("minecraft"\)/);
    assert.match(action, /validate_instance_id\(&server_id\)/);
  }
});

test("Minecraft safety errors expose exact paths to an explicit, non-launching quarantine dialog", () => {
  const error = read("src-tauri/src/line/error.rs");
  const minecraft = read("src-tauri/src/line/minecraft.rs");
  const quarantine = read("src/components/line/QuarantineDialog.tsx");
  assert.match(error, /pub unproved_mods: Option<Vec<String>>/);
  assert.match(minecraft, /error\.unproved_mods = Some\(scan\.unproved\)/);
  assert.match(types, /unprovedMods\?: string\[\]/);
  assert.match(panel, /getUnprovedMods\(cause\)/);
  assert.match(panel, /<QuarantineDialog[\s\S]*?paths=\{unprovedMods\}/);
  assert.match(
    quarantine,
    /lineApi\.quarantineMods\(serverId, \[\.\.\.selected\]\)/,
  );
  const onChanged = panel.slice(
    panel.indexOf("onChanged={(moved) =>"),
    panel.indexOf("}\n        />", panel.indexOf("onChanged={(moved) =>")),
  );
  assert.doesNotMatch(onChanged, /\bplay\(|\bprepare\(/);
  assert.match(panel, /t\("quarantine\.moved", \{ count: moved\.length \}\)/);
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
  // The panel reports; the shell decides. It used to decide by clearing the
  // session outright, on nothing more than a failed request — and since
  // AUTH_REQUIRED was also what the backend said for a stale config, a closed
  // IPC socket or a mod that never asked for its ticket, pressing a button on
  // this page could sign the player out of a session with hours left on it.
  assert.match(panel, /onAuthRequired\?\.\(\)/);
  const shell = read("src/components/line/LineLauncher.tsx");
  assert.match(shell, /onAuthRequired=\{requireAuth\}/);

  const requireAuth = shell.slice(
    shell.indexOf("const requireAuth = () =>"),
    shell.indexOf("async function confirmSignOut()"),
  );
  // Asking the backend whether a session still exists is the whole point: it
  // must not throw the session away on the child's word alone.
  assert.doesNotMatch(requireAuth, /setSession\(null\)/);
  assert.match(requireAuth, /confirmSignOut\(\)/);

  const confirm = shell.slice(
    shell.indexOf("async function confirmSignOut()"),
    shell.indexOf("async function openHistory("),
  );
  assert.match(confirm, /await lineApi\.session\(\)/);
  // A session that is still alive is restored, not discarded.
  assert.match(confirm, /stillThere\.expiresAt > Date\.now\(\)/);
  assert.match(confirm, /setSession\(/);
  assert.match(confirm, /endSession\(t\("status\.authExpired"\)\)/);
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

test("Minecraft dock keeps actions and errors prominent, with explanations on demand", () => {
  assert.doesNotMatch(panel, /lineApi\.mcListInstalled\(/);
  assert.doesNotMatch(panel, /t\("mc\.profiles"/);
  assert.match(panel, /<details className=/);
  assert.match(panel, /<summary[^>]*>[\s\S]*?t\("mc\.launchDetails"\)/);
  const details = panel.slice(
    panel.lastIndexOf("<details", panel.indexOf('t("mc.launchDetails")')),
    panel.indexOf("</details>", panel.indexOf('t("mc.launchDetails")')),
  );
  assert.match(details, /t\("mc\.testModeHint"\)/);
  assert.match(details, /t\("mc\.onlineMode"\)/);
  assert.match(panel, /role="alert"/);
  // The dock's button is the loader: it takes the number, not a {label,percent}
  // object, and the label travelled into `progressLabel`.
  // The fill starts at zero and grows by real work; a stage without a
  // denominator holds a third at the left instead of sweeping.
  assert.match(panel, /progress=\{working \? \(percent \?\? 0\) : null\}/);
  assert.match(panel, /indeterminate=\{working && percent === null\}/);
  assert.match(panel, /progressLabel=\{/);
  assert.match(
    read("src/components/line/ServerDock.tsx"),
    /role="progressbar"/,
  );
  assert.doesNotMatch(panel, /progress\.label/);
  assert.doesNotMatch(panel, /progress\.percent/);
  assert.doesNotMatch(detail, /t\("source\.hint"\)/);
});
