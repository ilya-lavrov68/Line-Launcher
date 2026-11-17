import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const detail = read("src/components/line/ServerDetail.tsx");
const minecraft = read("src/components/line/MinecraftPanel.tsx");
const archive = read("src/components/line/ServerActionPanel.tsx");
const shell = read("src/components/line/LineLauncher.tsx");

const dock = read("src/components/line/ServerDock.tsx");

test("the server action dock cannot be pushed up by a progress panel", () => {
  assert.doesNotMatch(detail, /className="mt-auto"/);
  // The primary button carries the action and nothing else. Progress is the
  // `ActionProgress` row, in its own element, so the two cannot be confused:
  // a control whose label changes under the pointer has no stable meaning.
  for (const panel of [minecraft, archive]) {
    assert.match(panel, /<ServerDockPrimary/);
    assert.match(panel, /<ActionProgress/);
    // No progress attribute on the button itself — that was the music-player
    // transport bar the design rejected.
    assert.doesNotMatch(panel, /progress=\{/);
    assert.doesNotMatch(panel, /indeterminate=\{/);
  }
  // The bar exists once, in the shared row, with a real progress role so
  // assistive technology gets the number.
  assert.match(dock, /role="progressbar"/);
  assert.match(dock, /aria-valuenow=/);
  assert.match(dock, /aria-valuemin=/);
  assert.match(dock, /aria-valuemax=/);
  // A fixed button height keeps the dock's own height constant.
  assert.match(dock, /h-11 w-full/);
  assert.doesNotMatch(
    read("src/components/line/ServerDock.tsx"),
    /whileTap|whileHover/,
  );
  assert.doesNotMatch(
    read("src/components/ui/button.tsx"),
    /active:not-aria-\[haspopup\]:translate-y-px/,
  );
});

test("Minecraft operations retain state in background and reject repeat actions", () => {
  assert.match(
    minecraft,
    /if \(locked \|\| operationActive\.current\) return/g,
  );
  assert.match(minecraft, /onBusyChange\?\.\(operationActive\.current\)/);
  assert.match(shell, /navigationDisabled=\{!session\}/);
  assert.match(shell, /<DownloadWidget/);
  assert.match(
    shell,
    /hidden=\{section !== "servers" \|\| screen !== "detail"\}/,
  );
  assert.match(shell, /onMinecraftBusyChange=\{setMinecraftBusy\}/);
  const listener = minecraft.slice(
    minecraft.indexOf(".onMcGame("),
    minecraft.indexOf(".onMcProgress("),
  );
  assert.doesNotMatch(listener, /updateBusy\("idle"\)/);
});

test("refresh preserves a current server and stable controls", () => {
  const refresh = shell.slice(
    shell.indexOf("async function refresh()"),
    shell.indexOf("async function selectServer("),
  );
  assert.match(refresh, /next\.config\.servers\.find/);
  assert.match(refresh, /setSelected\(updated\)/);
  assert.doesNotMatch(refresh, /lineApi\.(?:install|mcPlay)/);
  const list = read("src/components/line/ServerList.tsx");
  assert.doesNotMatch(list, /layout !== undefined && !refreshing/);
  assert.match(list, /disabled=\{actionsDisabled \|\| refreshing\}/);
  for (const file of [
    "ServerList",
    "ServerDetail",
    "SettingsScreen",
    "WardrobeScreen",
    "ConfigUrlInput",
  ]) {
    assert.match(read(`src/components/line/${file}.tsx`), /<StableActionLabel/);
  }
});
