// The demo must stay a single command that cleans up after itself. These are
// mechanism assertions, not prose checks: each one corresponds to a way the
// demo silently stopped working before (manual env vars, a lost branding file,
// a provider that could not be reached, a pack whose hash did not match).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(demo, /LINE_DEV_CA_CERT: certPath/);
  assert.match(demo, /"--features",\s*"dev-provider-ca"/);
  assert.doesNotMatch(
    demo,
    /danger_accept_invalid_certs|NODE_TLS_REJECT_UNAUTHORIZED/,
  );
  assert.doesNotMatch(demo, /tauri:build|tauri", "build/);
  // The player never types the URL: it is baked for the duration of the demo.
  assert.match(demo, /config_url: configUrl/);
  assert.match(demo, /apply-brand\.ts/);
  // A listening socket is not enough; the config must actually be served.
  assert.match(demo, /https\.get\(\s*configUrl/);
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
  assert.match(build, /\.\.\.\(launchable \? \{ auth: launchAuth \} : \{\}\)/);
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
