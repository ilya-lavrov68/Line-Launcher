import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isLineError } from "../src/types/line.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const errorRs = read("src-tauri/src/line/error.rs");
const lineTs = read("src/types/line.ts");

/** Rust enum variants, in declaration order. */
function rustErrorCodes(): string[] {
  const body = errorRs.split("pub enum ErrorCode {")[1].split("}")[0];
  return body
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase());
}

test("the TLS failure has its own wire code on both sides", () => {
  assert.ok(rustErrorCodes().includes("TLS_UNTRUSTED"));
  assert.match(lineTs, /\| "TLS_UNTRUSTED"/);
  // The runtime guard must accept it too, or the UI drops the error.
  assert.ok(
    isLineError({
      code: "TLS_UNTRUSTED",
      message: "Не удалось проверить сертификат провайдера.",
      retryable: false,
    }),
  );
});

test("every Rust error code exists in the TS union and the runtime guard", () => {
  const union = lineTs.split("export type LineErrorCode =")[1].split(";")[0];
  const guard = lineTs
    .split("const codes: LineErrorCode[] = [")[1]
    .split("];")[0];
  for (const code of rustErrorCodes()) {
    assert.ok(union.includes(`"${code}"`), `missing from the union: ${code}`);
    assert.ok(guard.includes(`"${code}"`), `missing from the guard: ${code}`);
  }
});

test("an untrusted certificate is not offered as a retry", () => {
  // Retrying cannot fix trust; only NETWORK stays retryable.
  assert.match(
    errorRs,
    /Self::new\(code, message, code == ErrorCode::Network\)/,
  );
});

test("the TLS message points at the fix instead of blaming the network", () => {
  const classifier = errorRs.split("pub fn classify_network_chain")[1];
  const tlsBranch = classifier
    .split("ErrorCode::TlsUntrusted,")[1]
    .split(");")[0];
  assert.match(tlsBranch, /сертификат/);
  assert.match(tlsBranch, /3\.2/, "must name the runbook section");
  assert.ok(
    !tlsBranch.includes("Проверьте подключение"),
    "the old misleading wording must not come back",
  );
});

test("the error chain is classified, never serialized", () => {
  const network = errorRs.split("pub fn network(")[1].split("\n    }")[0];
  assert.match(network, /classify_network_chain\(&chain/);
  // The flattened text must not reach the DTO.
  assert.ok(!/Self::new\([^)]*chain/.test(network));
  assert.match(network, /chain\.len\(\) > 4096/, "the walk must be bounded");
});

test("certificate verification is never disabled anywhere in the crate", () => {
  const files = [
    "src-tauri/src/line/state.rs",
    "src-tauri/src/line/dev_ca.rs",
    "src-tauri/src/line/http.rs",
  ];
  for (const file of files) {
    const src = read(file);
    assert.ok(
      !/danger_accept_invalid_certs|danger_accept_invalid_hostnames|NoVerifier/.test(
        src,
      ),
      `${file} must not weaken TLS`,
    );
  }
});

test("the dev CA is opt-in at compile time and off by default", () => {
  const cargo = read("src-tauri/Cargo.toml");
  assert.match(cargo, /\[features\]/);
  assert.match(cargo, /default = \[\]/, "no feature may be on by default");
  assert.match(cargo, /dev-provider-ca = \[\]/);
  const mod = read("src-tauri/src/line/mod.rs");
  assert.match(
    mod,
    /#\[cfg\(feature = "dev-provider-ca"\)\]\s*pub mod dev_ca;/,
    "the module must not compile without the feature",
  );
  const state = read("src-tauri/src/line/state.rs");
  assert.match(
    state,
    /#\[cfg\(feature = "dev-provider-ca"\)\]\s*let builder = super::dev_ca::apply\(builder\)\?;/,
  );
});

test("the dev CA only adds a root and warns loudly", () => {
  const src = read("src-tauri/src/line/dev_ca.rs");
  assert.match(src, /add_root_certificate/);
  assert.match(src, /LINE_DEV_CA_CERT/);
  assert.match(src, /WARNING: dev-provider-ca active/);
  assert.match(src, /never ship this build/);
  // An unset variable must be a no-op, not a hard failure.
  assert.match(src, /trust store unchanged/);
  // macOS cannot take extra roots; it must fail with guidance, not opaque error.
  assert.match(src, /cfg!\(target_os = "macos"\)/);
});

test("no shipped build path enables the dev feature", () => {
  for (const file of [
    ".github/workflows/release.yml",
    ".github/workflows/ci.yml",
  ]) {
    const src = read(file);
    assert.ok(
      !/--features[= ][^\n]*dev-provider-ca/.test(src),
      `${file} must never enable dev-provider-ca`,
    );
    assert.ok(
      !/--all-features/.test(src),
      `${file}: --all-features would silently enable it`,
    );
  }
  const pkg = JSON.parse(read("package.json"));
  for (const [name, script] of Object.entries(pkg.scripts)) {
    assert.ok(
      !String(script).includes("dev-provider-ca"),
      `npm script ${name} must not bake in the dev feature`,
    );
  }
});

test("the runbook documents both routes and the machine-wide risk", () => {
  const runbook = read("docs/RUNBOOK.md");
  const section = runbook.split("### 3.2.")[1].split("### 3.3.")[0];
  assert.match(section, /LINE_DEV_CA_CERT/);
  assert.match(section, /--features dev-provider-ca/);
  assert.match(section, /для всей машины/, "must warn about the OS-wide scope");
  assert.match(
    section,
    /tls\.key/,
    "must warn that the private key sits nearby",
  );
  assert.match(section, /Никогда не собирайте/);
  // Must use the script that actually exists.
  assert.ok(!section.includes("tauri:dev"), "there is no tauri:dev script");
  const pkg = JSON.parse(read("package.json"));
  assert.ok("tauri" in pkg.scripts);
});
