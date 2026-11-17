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
  // Одна кнопка на весь док, как play/pause у Liner: пока идёт работа, её
  // заливка растёт, а подпись остаётся действием. Второй строки прогресса нет.
  for (const panel of [minecraft, archive]) {
    assert.match(panel, /<ServerDockPrimary/);
    assert.match(panel, /progress=\{/);
  }
  assert.match(dock, /role="progressbar"/);
  assert.doesNotMatch(dock, /whileTap|whileHover/);
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
