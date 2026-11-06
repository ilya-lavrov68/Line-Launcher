import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isLineError,
  toLineError,
  type LineConfig,
} from "../src/types/line.ts";

const example = JSON.parse(
  readFileSync(new URL("../examples/config.json", import.meta.url), "utf8"),
) as LineConfig;

test("example satisfies the public schema contract", () => {
  assert.equal(example.schema_version, 1);
  assert.match(example.min_launcher_version, /^\d+\.\d+\.\d+/);
  assert.ok(example.servers.length > 0);
  for (const server of example.servers) {
    assert.match(server.id, /^[a-z0-9][a-z0-9_-]{0,63}$/);
    assert.match(server.distribution.sha256, /^[a-f0-9]{64}$/);
    assert.ok(server.distribution.size_bytes > 0);
    assert.ok(server.distribution.unpacked_size_bytes > 0);
    assert.equal(new URL(server.auth.login_url).protocol, "https:");
  }
});

test("IPC error guard accepts only the typed public DTO", () => {
  assert.ok(
    isLineError({
      code: "INTEGRITY",
      message: "Hash mismatch",
      retryable: false,
    }),
  );
  assert.ok(
    isLineError({
      code: "HTTP_STATUS",
      message: "Unavailable",
      retryable: true,
      httpStatus: 503,
    }),
  );
  assert.equal(
    isLineError({ code: "MADE_UP", message: "x", retryable: false }),
    false,
  );
  assert.equal(
    isLineError({ code: "NETWORK", message: "x", retryable: "yes" }),
    false,
  );
  assert.equal(isLineError(null), false);
});

test("unknown exceptions never expose signed URLs or tokens", () => {
  const result = toLineError(
    new Error("Bearer secret https://host/file?signature=secret"),
  );
  assert.equal(result.code, "INTERNAL");
  assert.equal(result.message.includes("secret"), false);
});
