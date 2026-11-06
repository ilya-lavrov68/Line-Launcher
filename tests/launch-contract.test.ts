import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LINE_SUPPORTED_FEATURES,
  isLineError,
  isNewerGameStatus,
  type GamePhase,
  type GameStatus,
  type LaunchManifest,
} from "../src/types/line.ts";

const manifest = JSON.parse(
  readFileSync(
    new URL("../examples/line-launch.json", import.meta.url),
    "utf8",
  ),
) as LaunchManifest;

test("launch manifest example is strict and relative", () => {
  assert.equal(manifest.schema_version, 1);
  assert.ok(Number.isInteger(manifest.java_major));
  assert.match(manifest.main_class, /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/);
  assert.ok(manifest.classpath.length > 0);
  for (const entry of manifest.classpath) {
    assert.ok(
      !entry.startsWith("/") && !entry.includes("..") && !entry.includes("\\"),
    );
    assert.ok(entry.endsWith(".jar"));
  }
  assert.equal(Boolean(manifest.asset_index), Boolean(manifest.assets_dir));
});

test("launch capabilities and Java error are public contract values", () => {
  assert.ok(LINE_SUPPORTED_FEATURES.includes("launch-manifest-v1"));
  assert.ok(LINE_SUPPORTED_FEATURES.includes("private-ipc-v1"));
  assert.ok(
    isLineError({
      code: "JAVA_REQUIRED",
      message: "Нужна Java 21.",
      retryable: false,
    }),
  );
});

test("game status revisions reject reordered events and keep terminal states", () => {
  const status = (revision: number, phase: GamePhase): GameStatus => ({
    serverId: "survival",
    revision,
    phase,
  });
  assert.equal(isNewerGameStatus(null, status(1, "starting")), true);
  assert.equal(
    isNewerGameStatus(status(3, "failed"), status(2, "running")),
    false,
  );
  assert.equal(
    isNewerGameStatus(status(2, "running"), status(3, "failed")),
    true,
  );
  // The command reply repeats the event that already arrived: still accepted.
  assert.equal(
    isNewerGameStatus(status(2, "running"), status(2, "running")),
    true,
  );
  // A different server never inherits the previous server's revision.
  assert.equal(
    isNewerGameStatus(
      { ...status(9, "running"), serverId: "creative" },
      status(1, "starting"),
    ),
    true,
  );
});
