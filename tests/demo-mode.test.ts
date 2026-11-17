// The demo must stay a single command that cleans up after itself. These are
// mechanism assertions, not prose checks: each one corresponds to a way the
// demo silently stopped working before (manual env vars, a lost branding file,
// a provider that could not be reached, a pack whose hash did not match).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCertificate } from "../scripts/lib/demo-cert.mjs";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
};

test("the demo is one command, with update and a windowless self-check", () => {
  assert.equal(pkg.scripts.demo, "node scripts/demo.mjs");
  assert.equal(pkg.scripts["demo:check"], "node scripts/demo-selftest.mjs");
  assert.match(pkg.scripts["demo:update"], /publish-release\.mjs/);
  // The self-check must not need the desktop toolchain.
  const selftest = read("scripts/demo-selftest.mjs");
  assert.doesNotMatch(selftest, /tauri|cargo|javac\s+-d/);
  assert.match(selftest, /--no-java/);
});

test("the orchestrator sets up trust and the address instead of asking", () => {
  const demo = read("scripts/demo.mjs");
  // The certificate is handed to the app process, never to the OS store.
  assert.match(demo, /LINE_DEV_CA_CERT: state\.certPath/);
  assert.match(demo, /"--features",\s*"dev-provider-ca"/);
  assert.doesNotMatch(
    demo,
    /danger_accept_invalid_certs|NODE_TLS_REJECT_UNAUTHORIZED/,
  );
  assert.doesNotMatch(demo, /tauri:build|tauri", "build/);
  // The player never types the URL: it is baked for the duration of the demo.
  assert.match(demo, /config_url: configUrl/);
  assert.match(demo, /apply-brand\.ts/);
  // A listening socket is not enough; the config must actually be served, with
  // the demo certificate as the only trust anchor for that probe.
  assert.match(demo, /function probeProvider\(url, cert\)/);
  assert.match(demo, /ca: readFileSync\(cert\)/);
  assert.match(demo, /await probeProvider\(configUrl, certPath\)/);
});

test("the demo restores branding on every exit path", () => {
  const demo = read("scripts/demo.mjs");
  const restore = demo.slice(
    demo.indexOf("function restore()"),
    demo.indexOf("writeFileSync(\n  brandFile,"),
  );
  assert.ok(restore.length > 0, "restore() must exist");
  // Original content is remembered before the file is touched.
  assert.ok(
    demo.indexOf("const originalBrand") < demo.indexOf("brandChanged = true"),
    "the original branding must be read before it is overwritten",
  );
  // `brandChanged` is raised *before* the write, never after it. The other
  // order leaves a window where the file is already overwritten but `restore()`
  // still believes it has nothing to do — kill the process there (Ctrl+C, a
  // crash in the next step) and the demo provider's address stays baked into
  // the template. That is exactly how a repository ended up with
  // `https://127.0.0.1:8443/config.json` in `branding/provider.json`.
  const flagAt = demo.indexOf("brandChanged = true");
  const writeAt = demo.indexOf("writeFileSync(\n  brandFile,");
  assert.ok(
    flagAt > 0 && writeAt > 0,
    "both the flag and the write must exist",
  );
  assert.ok(
    flagAt < writeAt,
    "the flag must be raised before the file is overwritten, not after",
  );
  assert.match(restore, /if \(restored\) return;/);
  assert.match(restore, /writeFileSync\(brandFile, originalBrand\)/);
  assert.match(restore, /provider\.kill\(/);
  // Ctrl+C, SIGTERM and a normal exit all go through the same cleanup.
  for (const hook of ['"SIGINT"', '"SIGTERM"', '"exit"']) {
    assert.match(
      demo,
      new RegExp(
        `process\\.on\\(${hook.replace(/"/g, '\\"')},\\s*restore\\)|for \\(const signal of \\["SIGINT", "SIGTERM"\\]\\)`,
      ),
      `${hook} must restore the workspace`,
    );
  }
});

test("the demo project is one account with three servers and two releases", () => {
  const build = read("examples/provider/build-pack.mjs");
  // One account for the project; a ticket stays per-server.
  assert.match(build, /login_url: `\$\{base\}\/v1\/login`/);
  assert.doesNotMatch(build, /server_id/);
  assert.match(build, /launch_ticket_url: `\$\{base\}\/v1\/launcher\/ticket`/);
  // Three servers, and one of them deliberately cannot launch.
  for (const id of ['"demo"', '"creative"', '"showcase"']) {
    assert.ok(build.includes(id), `${id} must be in the demo project`);
  }
  assert.match(build, /«showcase» deliberately gets no `auth`/);
  // Two releases of the same server, so update and rollback are real.
  assert.match(build, /"pack-v2\.zip": writePack\("pack-v2\.zip"/);
  assert.match(build, /packs\.json/);
  // Without a JDK the demo degrades honestly instead of failing at spawn.
  assert.match(build, /--no-java/);
  assert.match(
    build,
    /launchable && !offline && !installOnly \? \{ auth: launchAuth \} : \{\}/,
  );
  assert.match(
    build,
    /const offline = launchable && launch_mode === "offline"/,
  );
  assert.match(build, /const installOnly = id === "showcase"/);
  assert.match(build, /offline \? \{ launch_mode: "offline" \} : \{\}/);
  // Ready-made textures, so the wardrobe is testable immediately.
  assert.match(build, /demo-classic\.png/);
  assert.match(build, /demo-slim\.png/);
});

test("the provider serves only published files and re-reads the config", () => {
  const server = read("examples/provider/server.mjs");
  // Update/rollback works without restarting the provider.
  assert.match(server, /function readConfig\(\)/);
  assert.doesNotMatch(server, /const configBytes = readFileSync/);
  // Bare names only: a request cannot walk out of .provider/.
  assert.match(
    server,
    /if \(!\/\^pack\[a-z0-9\.-\]\*\\\.zip\$\/\.test\(name\)\) return null;/,
  );
  assert.match(
    server,
    /if \(!\/\^\[a-z0-9-\]\+\\\.svg\$\/\.test\(name\)\) return null;/,
  );
  assert.match(server, /"Content-Type": "image\/svg\+xml"/);
});

test("the demo game stays alive so the stop button can be tested", () => {
  const game = read("examples/provider/DemoGame.java");
  assert.match(game, /LINE_DEMO_SECONDS/);
  assert.match(game, /Thread\.sleep\(1000\)/);
  // The guard must be "<= 0", not ">= 0": inverting it makes every run exit
  // immediately and the stop button becomes impossible to test.
  assert.match(game, /if \(seconds <= 0\) \{/);
  // The automated provider test must not wait for the heartbeat.
  const provider = read("scripts/test-provider.mjs");
  assert.match(provider, /LINE_DEMO_SECONDS: "0"/);
});

test("the game log is kept outside the immutable release", () => {
  const launch = read("src-tauri/src/line/launch.rs");
  assert.match(launch, /let log_dir = base\.join\("logs"\);/);
  assert.match(launch, /\.stdout\(Stdio::from\(log_file\)\)/);
  assert.match(launch, /\.stderr\(Stdio::from\(log_copy\)\)/);
  assert.doesNotMatch(launch, /\.stdout\(Stdio::null\(\)\)/);
  // Truncated per launch, so it cannot grow without bound.
  assert.match(launch, /\.truncate\(true\)/);
});

test("the demo is documented and reachable from the overview", () => {
  const readme = read("README.md");
  assert.match(readme, /docs\/DEMO\.md/);
  const start = read("docs/START.md");
  assert.match(start, /DEMO\.md/);
  const demo = read("docs/DEMO.md");
  assert.match(demo, /npm run demo/);
  assert.match(demo, /demo:check/);
  assert.match(demo, /Player_1`?\s*\/\s*`?demo-password/);
});

test("a second terminal can attach the app without shell-specific env syntax", () => {
  assert.equal(pkg.scripts["demo:app"], "node scripts/demo.mjs --app-only");
  assert.equal(pkg.scripts["demo:doctor"], "node scripts/demo-doctor.mjs");
  const demo = read("scripts/demo.mjs");
  // The running provider publishes what the app needs; no `export FOO=...`
  // hint that only works in one shell.
  assert.match(demo, /demo-state\.json/);
  assert.match(demo, /writeFileSync\(\s*stateFile,/);
  assert.match(demo, /if \(appOnly\) \{/);
  assert.match(demo, /readDemoState\(\)/);
  // Attaching still verifies the certificate and that the provider answers.
  const attach = demo.slice(
    demo.indexOf("if (appOnly) {"),
    demo.indexOf("// ------", demo.indexOf("if (appOnly) {")),
  );
  assert.match(attach, /inspectCertificate\(state\.certPath/);
  assert.match(attach, /probeProvider\(state\.configUrl, state\.certPath\)/);
  assert.match(attach, /scripts\/doctor\.mjs/);
  // The state file is removed with the session that created it.
  assert.match(
    demo,
    /if \(brandChanged\) rmSync\(stateFile, \{ force: true \}\)/,
  );
  assert.doesNotMatch(demo, /LINE_DEV_CA_CERT=\$\{/);
});

test("an expired or mismatched demo certificate is reissued, not reused", () => {
  const cert = read("scripts/lib/demo-cert.mjs");
  // Expiry, clock skew and SAN are all checked before the file is trusted.
  assert.match(cert, /X509Certificate/);
  assert.match(cert, /MIN_VALID_MS/);
  assert.match(cert, /to - now < MIN_VALID_MS/);
  assert.match(cert, /from - now > 60_000/);
  assert.match(cert, /cert\.checkIP\(host\)/);
  assert.match(cert, /cert\.checkHost\(host\)/);
  // Both halves go before reissuing, so a stale key cannot survive.
  const ensure = cert.slice(cert.indexOf("export function ensureCertificate("));
  assert.ok(ensure.includes("rmSync(certPath"), "the old certificate must go");
  assert.ok(ensure.includes("rmSync(keyPath"), "the old private key must go");
  assert.ok(
    ensure.indexOf("rmSync(keyPath") < ensure.indexOf('"req"'),
    "the old key must be removed before a new pair is issued",
  );
  assert.match(ensure, /inspectCertificate\(certPath, host\)/);
  // The provider must use it instead of a bare existsSync check.
  const server = read("examples/provider/server.mjs");
  assert.match(server, /cert = ensureCertificate\(dir, host\);/);
  // No "only when the file is missing" shortcut may come back.
  assert.doesNotMatch(server, /existsSync\((keyPath|certPath)\)/);
});

test("the demo doctor reports blockers without touching anything", () => {
  const doctor = read("scripts/demo-doctor.mjs");
  assert.doesNotMatch(doctor, /writeFileSync|rmSync|mkdirSync|spawn\(/);
  // Every blocker carries the command that fixes it.
  assert.match(doctor, /blockers\.push\(\{ label, fix \}\)/);
  assert.match(doctor, /process\.exit\(1\)/);
  for (const check of [
    "findOpenSsl",
    "findMsvc",
    "findWebView2",
    "inspectCertificate",
    "dev-provider-ca",
    "net.createServer",
  ]) {
    assert.ok(doctor.includes(check), `doctor does not check ${check}`);
  }
});

test("the from-scratch build guide covers tools, files and installers", () => {
  const guide = read("docs/BUILD.md");
  for (const fragment of [
    "npm ci",
    "npm run doctor",
    "npm run demo",
    "branding/provider.json",
    "branding/line.brand.json",
    "config_url",
    "npm run tauri:build",
    "src-tauri/target/release/bundle",
    "MSVC",
    "WebView2",
    "rustup",
    "JDK",
  ]) {
    assert.ok(guide.includes(fragment), `guide is missing ${fragment}`);
  }
  for (const bundle of ["nsis", "msi", "dmg", "deb"]) {
    assert.ok(
      guide.includes(`src-tauri/target/release/bundle/${bundle}`),
      `guide does not say where the ${bundle} installer lands`,
    );
  }
  // Generated files must be marked as hands-off, or people edit them and lose work.
  assert.match(guide, /generated/);
  assert.match(read("README.md"), /docs\/BUILD\.md/);
  assert.match(read("docs/DEMO.md"), /BUILD\.md/);
});

test("certificate inspection accepts a good PEM and rejects a dying one", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "line-cert-"));
  try {
    const put = (name: string, fixture: string) => {
      const file = path.join(dir, name);
      writeFileSync(
        file,
        readFileSync(new URL(`fixtures/${fixture}`, import.meta.url)),
      );
      return file;
    };
    const good = put("good.crt", "demo-cert-valid.pem");
    const dying = put("dying.crt", "demo-cert-soon-expired.pem");
    // Behavioural, not a grep: disabling the expiry branch fails here.
    assert.equal(inspectCertificate(good, "127.0.0.1").valid, true);
    assert.equal(inspectCertificate(dying, "127.0.0.1").valid, false);
    // The same file is unusable for a host it was not issued for.
    assert.equal(inspectCertificate(good, "example.com").valid, false);
    assert.equal(
      inspectCertificate(path.join(dir, "missing.crt")).valid,
      false,
    );
    const broken = put("broken.crt", "demo-cert-valid.pem");
    writeFileSync(broken, "not a certificate");
    assert.equal(inspectCertificate(broken).valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BattleArmory demo is opt-in and provides a test-only loopback placeholder", () => {
  const demo = read("scripts/demo.mjs");
  assert.match(demo, /flags\.has\("--battlearmory"\)/);
  assert.match(demo, /id: "battlearmory-test"/);
  assert.match(demo, /server_address: "127\.0\.0\.1:25565"/);
  assert.match(demo, /test_mode_enabled: true/);
  assert.match(demo, /project: "rQiXwLhB"/);
  assert.match(demo, /version: "TQIsQXtg"/);
  assert.match(read("docs/DEMO.md"), /npm run demo -- --battlearmory/);
});
