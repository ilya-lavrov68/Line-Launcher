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
    // The shipped example pins everything — it is the reference a provider
    // copies. The three integrity fields are optional in general (a bare link
    // is enough now), but an example that omits them would teach the tedious
    // version, so this file is held to the strict form.
    assert.match(server.distribution.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok((server.distribution.size_bytes ?? 0) > 0);
    assert.ok((server.distribution.unpacked_size_bytes ?? 0) > 0);
    // Launch endpoints are per-server and optional; the account is not.
    if (server.auth?.launch_ticket_url) {
      assert.ok(server.auth.session_exchange_url);
      assert.equal(new URL(server.auth.launch_ticket_url).protocol, "https:");
      assert.equal(
        new URL(server.auth.session_exchange_url).protocol,
        "https:",
      );
    }
    assert.equal(
      (server.auth as Record<string, unknown> | undefined)?.login_url,
      undefined,
      "login must live on the provider: one account per project",
    );
    assert.equal(
      (server as unknown as Record<string, unknown>).wardrobe,
      undefined,
    );
  }
  // The single sign-in endpoint belongs to the project, not to a server.
  assert.equal(new URL(example.provider.auth.login_url).protocol, "https:");
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

test("a distribution can be one link, and a pin is still honoured", () => {
  const rust = readFileSync(
    new URL("../src-tauri/src/line/config.rs", import.meta.url),
    "utf8",
  );
  // The three integrity fields are optional so publishing a build is "put a ZIP
  // at a URL". Keeping them required asked a provider to run a checksum tool and
  // count bytes for a file they had just uploaded.
  const distribution = rust.slice(
    rust.indexOf("pub struct Distribution {"),
    rust.indexOf("impl Distribution {"),
  );
  assert.match(distribution, /pub url: String/);
  for (const field of ["sha256", "size_bytes", "unpacked_size_bytes"]) {
    assert.match(
      distribution,
      new RegExp(`pub ${field}: Option<`),
      `${field} must stay optional`,
    );
    assert.match(
      distribution,
      new RegExp(
        `serde\\(default, skip_serializing_if = "Option::is_none"\\)[\\s\\S]{0,80}pub ${field}`,
      ),
      `${field} must default when absent`,
    );
  }

  // Optional is not ignored: a value that *is* given is still validated, and
  // the installer still enforces it. Otherwise removing the requirement would
  // have quietly removed the check.
  assert.match(rust, /if let Some\(sha256\) = &dist\.sha256/);
  assert.match(rust, /dist\s*\.size_bytes\s*\.is_some_and/);
  assert.match(rust, /dist\s*\.unpacked_size_bytes\s*\.is_some_and/);

  const install = readFileSync(
    new URL("../src-tauri/src/line/install.rs", import.meta.url),
    "utf8",
  );
  // The download measures the archive it received and publishes the release
  // under that digest — never under a claim from the config file.
  assert.match(install, /struct Downloaded \{/);
  assert.match(
    install,
    /let release = releases\.join\(&downloaded_archive\.sha256\)/,
  );
  assert.match(install, /sha256: downloaded_archive\.sha256\.clone\(\)/);
  // An unpinned size must not divide by zero into the progress bar.
  assert.match(install, /if p\.total_bytes > 0 \{/);
  assert.match(install, /if p\.unpacked_bytes > 0 \{/);

  // The TypeScript mirror agrees, or the UI compiles against the wrong shape.
  const types = readFileSync(
    new URL("../src/types/line.ts", import.meta.url),
    "utf8",
  );
  const tsDistribution = types.slice(
    types.indexOf("export interface LineDistribution {"),
    types.indexOf("}", types.indexOf("export interface LineDistribution {")),
  );
  for (const field of ["sha256", "size_bytes", "unpacked_size_bytes"]) {
    assert.match(tsDistribution, new RegExp(`${field}\\?: (string|number)`));
  }
});

test("pack.json governs the ZIP install path, not only Minecraft", () => {
  const install = readFileSync(
    new URL("../src-tauri/src/line/install.rs", import.meta.url),
    "utf8",
  );
  // Found while making `distribution` a single link: `effective_server` — the
  // function that reads pack.json — was called from the Minecraft path only. A
  // ZIP provider who configured `pack_manifest_url` got a silent no-op, which
  // is indistinguishable from the feature being broken.
  const entry = install.slice(
    install.indexOf("pub async fn download_and_extract("),
    install.indexOf("pub async fn repair("),
  );
  assert.match(entry, /pack::effective_server\(client, server, base\)/);
  // And it must run before the archive is requested, or the manifest could not
  // change which archive that is.
  assert.match(entry, /let server = [\s\S]*install_inner/);

  // pack.json always carries the full description, so resolving it yields a
  // pinned distribution rather than a second bare link.
  const pack = readFileSync(
    new URL("../src-tauri/src/line/pack.rs", import.meta.url),
    "utf8",
  );
  const applied = pack.slice(
    pack.indexOf("fn apply(server: &Server, manifest: &PackManifest)"),
    pack.indexOf("pub fn release_dir"),
  );
  assert.match(applied, /sha256: Some\(manifest\.sha256\.clone\(\)\)/);
  assert.match(applied, /size_bytes: Some\(manifest\.size_bytes\)/);
});
