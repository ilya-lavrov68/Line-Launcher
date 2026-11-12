// End-to-end check of the demo project over real HTTPS. Needs Node 22+ and
// openssl only — no JDK, no Rust, no desktop window — so it runs anywhere and
// proves the demo the user is about to click through actually answers.
//
//   npm run demo:check
//
// It builds the demo into an isolated directory (.provider/demo-check), starts
// the same provider `npm run demo` uses, and walks the whole contract: config
// schema, published hashes, artwork, one account for every server, the wardrobe
// the launcher syncs automatically, one-shot tickets, and publishing a second
// release while the provider keeps running.
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { unzipTo } from "./lib/unzip.mjs";
import { findOpenSsl, openSslHelp } from "./lib/find-openssl.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relDir = ".provider/demo-check";
const dir = path.join(root, relDir);
const port = Number(process.env.LINE_TEST_PORT || 8451);
const base = `https://127.0.0.1:${port}`;
let checks = 0;
let skipped = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
  console.log(`ok   ${message}`);
}

function skip(message) {
  skipped += 1;
  console.log(`skip ${message}`);
}

/** A valid 64×64 RGBA PNG, so the provider's own validator accepts it. */
function skinPng(tint = 0x40) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((64 * 4 + 1) * 64, tint);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/// Mirrors the launcher's `player_uuid` rule: sha256 of the prefixed
/// nickname, first 16 bytes, with the RFC 4122 version/variant bits set.
function deterministicPlayerUuid(nickname) {
  const digest = createHash("sha256")
    .update(`line-launcher:player:${nickname}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function request(url, { method = "GET", body, token, ca, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body
      ? Buffer.isBuffer(body)
        ? body
        : Buffer.from(JSON.stringify(body))
      : null;
    const req = https.request(
      url,
      {
        method,
        ca,
        rejectUnauthorized: true,
        headers: {
          ...(payload
            ? {
                "Content-Type": Buffer.isBuffer(body)
                  ? "image/png"
                  : "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}
const json = (res) => JSON.parse(res.bytes.toString("utf8") || "{}");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (!findOpenSsl()) {
  console.error(openSslHelp());
  process.exit(2);
}

mkdirSync(dir, { recursive: true });
const env = {
  ...process.env,
  LINE_PROVIDER_DIR: relDir,
  LINE_PROVIDER_URL: base,
  LINE_PROVIDER_PORT: String(port),
};

// `--no-java` keeps this JDK-free. The packs are real archives with a real
// manifest; only the compiled client is a placeholder, and the config then
// advertises no launch endpoints — which is itself worth asserting.
const build = spawnSync(
  process.execPath,
  [path.join(root, "examples/provider/build-pack.mjs"), "--no-java"],
  { cwd: root, env, encoding: "utf8" },
);
if (build.status !== 0) {
  console.error(build.stdout + build.stderr);
  process.exit(1);
}

let provider;
let log = "";
try {
  provider = spawn(
    process.execPath,
    [path.join(root, "examples/provider/server.mjs")],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  provider.stdout.on("data", (c) => (log += c));
  provider.stderr.on("data", (c) => (log += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`provider did not start:\n${log}`)),
      20_000,
    );
    provider.stdout.on("data", (c) => {
      if (String(c).includes("Reference provider listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    provider.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`provider exited ${code}:\n${log}`));
    });
  });
  const ca = readFileSync(path.join(dir, "tls.crt"));

  // ---------------------------------------------------------------- config
  const served = await request(`${base}/config.json`, { ca });
  check(served.status === 200, "config.json is served over HTTPS");
  const config = json(served);
  check(
    served.bytes.equals(readFileSync(path.join(dir, "config.json"))),
    "the served config is the generated document",
  );
  check(
    typeof served.headers.etag === "string",
    "the config carries an ETag for the launcher's cache",
  );
  const cached = await request(`${base}/config.json`, {
    ca,
    headers: { "If-None-Match": served.headers.etag },
  });
  check(cached.status === 304, "a matching ETag is answered with 304");

  check(config.schema_version === 1, "schema version is 1");
  check(
    new URL(config.provider.auth.login_url).protocol === "https:",
    "the project has one HTTPS sign-in endpoint",
  );
  check(
    Boolean(config.provider.auth.register_url),
    "registration is offered, so a new player can create an account",
  );
  check(
    Boolean(config.provider.wardrobe?.skin_upload_url),
    "the project exposes a wardrobe, so the automatic skin sync has a target",
  );
  check(
    config.servers.length === 3,
    "three servers come from one config, not from the build",
  );
  for (const server of config.servers) {
    check(
      server.auth?.login_url === undefined && server.wardrobe === undefined,
      `${server.id}: no per-server login or wardrobe (one account per project)`,
    );
    check(
      Boolean(server.icon_url && server.banner_url),
      `${server.id}: icon and banner are published`,
    );
  }
  check(
    config.servers.find((s) => s.id === "showcase").auth === undefined &&
      config.servers.find((s) => s.id === "showcase").launch_mode === undefined,
    "the showcase server advertises no launch, so the UI can explain it",
  );

  // ---------------------------------------------------------------- packs
  for (const server of config.servers) {
    const pack = await request(server.distribution.url, { ca });
    check(pack.status === 200, `${server.id}: archive downloads`);
    check(
      sha256(pack.bytes) === server.distribution.sha256,
      `${server.id}: published sha256 matches the served bytes`,
    );
    check(
      pack.bytes.length === server.distribution.size_bytes,
      `${server.id}: published size matches the served bytes`,
    );
    const unpacked = path.join(dir, `unpacked-${server.id}`);
    mkdirSync(unpacked, { recursive: true });
    unzipTo(pack.bytes, unpacked);
    const manifest = JSON.parse(
      readFileSync(path.join(unpacked, "line-launch.json"), "utf8"),
    );
    check(
      manifest.schema_version === 1 && manifest.classpath[0] === "client.jar",
      `${server.id}: the pack carries a valid launch manifest`,
    );
    const total = ["client.jar", "line-launch.json", "README.txt"].reduce(
      (sum, name) => sum + readFileSync(path.join(unpacked, name)).length,
      0,
    );
    check(
      total === server.distribution.unpacked_size_bytes,
      `${server.id}: unpacked size matches the real files`,
    );
  }
  const traversal = await request(`${base}/pack-..%2F..%2Fpackage.zip`, { ca });
  check(traversal.status === 404, "archive requests cannot escape .provider/");

  // ---------------------------------------------------------------- artwork
  const art = await request(config.servers[0].icon_url, { ca });
  check(
    art.status === 200 && art.headers["content-type"] === "image/svg+xml",
    "server artwork is served with an image content type",
  );
  check(
    art.headers["access-control-allow-origin"] === "*",
    "artwork is readable cross-origin by the WebView",
  );

  // ---------------------------------------------------------------- account
  const username = `Tester_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const registered = await request(`${base}/v1/register`, {
    method: "POST",
    ca,
    body: { username, password: "demo-password" },
  });
  check(registered.status === 200, "a new player can register once");
  const duplicate = await request(`${base}/v1/register`, {
    method: "POST",
    ca,
    body: { username, password: "demo-password" },
  });
  check(duplicate.status === 409, "a taken login is rejected with 409");
  const wrong = await request(`${base}/v1/login`, {
    method: "POST",
    ca,
    body: { username, password: "not-the-password" },
  });
  check(wrong.status === 401, "a wrong password is rejected with 401");
  const login = await request(`${base}/v1/login`, {
    method: "POST",
    ca,
    body: { username, password: "demo-password" },
  });
  check(login.status === 200, "the seeded flow signs in without a server id");
  const token = json(login).access_token;
  check(
    typeof token === "string" && token.length > 0,
    "a session token is issued",
  );

  // One session must authorise every server in the project.
  for (const id of ["demo", "creative"]) {
    const issued = await request(`${base}/v1/launcher/ticket`, {
      method: "POST",
      ca,
      token,
      body: {
        server_id: id,
        sha256: config.servers[0].distribution.sha256,
        channel_id: randomUUID(),
        username,
      },
    });
    check(
      issued.status === 200,
      `the same account gets a launch ticket for ${id} without signing in again`,
    );
  }

  // ---------------------------------------------------------------- wardrobe
  const skinUrl = `${base}/v1/launcher/skin`;
  const empty = await request(skinUrl, { ca, token });
  check(empty.status === 404, "a player without a skin gets 404, not an error");
  const png = skinPng();
  const uploaded = await request(skinUrl, {
    method: "POST",
    ca,
    token,
    body: png,
    headers: { "X-Skin-Model": "slim" },
  });
  check(uploaded.status === 200, "the automatic upload is accepted");
  check(json(uploaded).model === "slim", "the chosen model is stored");
  const read = await request(skinUrl, { ca, token });
  check(read.status === 200, "the account's skin is readable after upload");
  const texture = await request(json(read).texture_url, { ca });
  check(
    texture.status === 200 && texture.bytes.equals(png),
    "the served texture is the uploaded PNG byte for byte",
  );
  const again = await request(skinUrl, {
    method: "POST",
    ca,
    token,
    body: png,
    headers: { "X-Skin-Model": "slim" },
  });
  check(again.status === 200, "a repeated upload stays safe (idempotent sync)");
  const reset = await request(skinUrl, { method: "DELETE", ca, token });
  check(reset.status === 204, "the standard look resets the account skin");
  const afterReset = await request(skinUrl, { ca, token });
  check(afterReset.status === 404, "the skin is gone after the reset");

  // ---------------------------------------------------------------- tickets
  const channel = randomUUID();
  const bound = {
    server_id: "demo",
    sha256: config.servers[0].distribution.sha256,
    channel_id: channel,
    username,
  };
  const ticketRes = await request(`${base}/v1/launcher/ticket`, {
    method: "POST",
    ca,
    token,
    body: bound,
  });
  const ticket = json(ticketRes).ticket;
  const exchanged = await request(`${base}/v1/launcher/exchange`, {
    method: "POST",
    ca,
    body: { ticket, ...bound },
  });
  check(exchanged.status === 200, "the game's exchange succeeds");

  // ------------------------------------------------- model A session contract
  // The demo provider must speak the same shape as docs/SESSION-MODEL-A.md, or a
  // mod written against that document has nothing to integrate with.
  const issued = json(exchanged);
  check(
    typeof issued.session_id === "string" && issued.session_id.length >= 32,
    "the exchange mints a session_id",
  );
  check(
    typeof issued.session_secret === "string" &&
      issued.session_secret.length === 43,
    "the exchange mints a 32-byte session_secret (43 base64url chars)",
  );
  // The uuid must match the launcher's `player_uuid` exactly: the
  // client already passes that value to the game as --uuid, so a provider that
  // mints a different one gives the player two identities.
  const expectedUuid = deterministicPlayerUuid(issued.username);
  check(
    issued.uuid === expectedUuid && issued.username === username,
    "the session carries the deterministic account uuid",
  );
  check(
    issued.expires_in >= 30 && issued.expires_in <= 600,
    "the session TTL is in the documented 30..600 s range",
  );
  check(
    !("ticket" in issued) && !("access_token" in issued),
    "the exchange response leaks neither the ticket nor the provider token",
  );

  // The game server proves possession with an HMAC over its own nonce; the
  // secret itself never travels.
  const nonce = randomUUID().replace(/-/g, "");
  const proof = createHmac(
    "sha256",
    Buffer.from(issued.session_secret, "base64url"),
  )
    .update(nonce, "utf8")
    .digest("base64url");
  const verifyBody = {
    session_id: issued.session_id,
    username: issued.username,
    server_id: "demo",
    nonce,
    proof,
  };
  const verified = await request(`${base}/v1/session/verify`, {
    method: "POST",
    ca,
    body: verifyBody,
    headers: { Authorization: "Bearer demo-verify-key" },
  });
  check(verified.status === 200, "a valid session verifies");
  const verifiedBody = json(verified);
  check(
    verifiedBody.valid === true && verifiedBody.uuid === issued.uuid,
    "verification returns the same account uuid",
  );

  const badProof = await request(`${base}/v1/session/verify`, {
    method: "POST",
    ca,
    body: { ...verifyBody, proof: "A".repeat(43) },
    headers: { Authorization: "Bearer demo-verify-key" },
  });
  check(badProof.status === 403, "a wrong proof is rejected with 403");

  const noKey = await request(`${base}/v1/session/verify`, {
    method: "POST",
    ca,
    body: verifyBody,
  });
  check(noKey.status === 403, "verification without an api key is rejected");

  const wrongServer = await request(`${base}/v1/session/verify`, {
    method: "POST",
    ca,
    body: { ...verifyBody, server_id: "creative" },
    headers: { Authorization: "Bearer demo-verify-key" },
  });
  check(
    wrongServer.status === 403,
    "a session issued for another server is rejected",
  );

  const unknown = await request(`${base}/v1/session/verify`, {
    method: "POST",
    ca,
    body: { ...verifyBody, session_id: randomUUID() },
    headers: { Authorization: "Bearer demo-verify-key" },
  });
  check(unknown.status === 401, "an unknown session is rejected with 401");
  const replay = await request(`${base}/v1/launcher/exchange`, {
    method: "POST",
    ca,
    body: { ticket, ...bound },
  });
  check(replay.status === 409, "a replayed ticket is rejected with 409");
  const mismatch = await request(`${base}/v1/launcher/ticket`, {
    method: "POST",
    ca,
    token,
    body: bound,
  });
  const rejected = await request(`${base}/v1/launcher/exchange`, {
    method: "POST",
    ca,
    body: { ticket: json(mismatch).ticket, ...bound, server_id: "creative" },
  });
  check(rejected.status === 403, "a ticket for another server is rejected");
  const anonymousTicket = await request(`${base}/v1/launcher/ticket`, {
    method: "POST",
    ca,
    body: bound,
  });
  check(anonymousTicket.status === 401, "a ticket needs a signed-in account");

  // ---------------------------------------------------------------- update
  const before = json(await request(`${base}/config.json`, { ca }));
  const publish = spawnSync(
    process.execPath,
    [path.join(root, "examples/provider/publish-release.mjs")],
    { cwd: root, env, encoding: "utf8" },
  );
  check(
    publish.status === 0,
    "a second release can be published while running",
  );
  const after = json(await request(`${base}/config.json`, { ca }));
  const beforeServer = before.servers.find((s) => s.id === "demo");
  const afterServer = after.servers.find((s) => s.id === "demo");
  check(
    afterServer.distribution.sha256 !== beforeServer.distribution.sha256 &&
      afterServer.version !== beforeServer.version,
    "the provider serves the new version without a restart (update path)",
  );
  const newPack = await request(afterServer.distribution.url, { ca });
  check(
    sha256(newPack.bytes) === afterServer.distribution.sha256,
    "the new release downloads with the published hash",
  );
  const oldPack = await request(beforeServer.distribution.url, { ca });
  check(
    oldPack.status === 200 &&
      sha256(oldPack.bytes) === beforeServer.distribution.sha256,
    "the previous release stays available, so rollback has a target",
  );

  check(!log.includes(token), "the session token never appears in the log");
  check(!log.includes(ticket), "the launch ticket never appears in the log");

  // The launchable variant needs a compiler; verify it only where one exists.
  const javac = spawnSync("javac", ["-version"], { encoding: "utf8" });
  if (javac.status === 0) {
    const full = spawnSync(
      process.execPath,
      [path.join(root, "examples/provider/build-pack.mjs")],
      {
        cwd: root,
        env: { ...env, LINE_PROVIDER_DIR: `${relDir}/full` },
        encoding: "utf8",
      },
    );
    check(full.status === 0, "with a JDK the demo builds a launchable pack");
    const fullConfig = JSON.parse(
      readFileSync(path.join(dir, "full", "config.json"), "utf8"),
    );
    const survival = fullConfig.servers.find((s) => s.id === "demo");
    check(
      Boolean(
        survival.auth?.launch_ticket_url && survival.auth?.session_exchange_url,
      ),
      "demo: ticket endpoints are published as a pair",
    );
    const creative = fullConfig.servers.find((s) => s.id === "creative");
    check(
      creative.launch_mode === "offline" && creative.auth === undefined,
      "creative: explicit offline launch needs no ticket endpoints",
    );
    check(
      fullConfig.required_features.includes("offline-launch-v1"),
      "old launchers must reject the new offline capability instead of guessing",
    );
    const showcase = fullConfig.servers.find((s) => s.id === "showcase");
    check(
      showcase.auth === undefined && showcase.launch_mode === undefined,
      "the showcase server stays install-only even with a JDK",
    );
  } else {
    skip(
      "launchable pack: no JDK on this machine (npm run demo will warn too)",
    );
  }

  console.log(
    `\nDemo provider: ${checks} checks passed${skipped ? `, ${skipped} skipped` : ""}`,
  );
} catch (error) {
  console.error(`\nFAIL ${error.message}`);
  console.error(log.slice(-4000));
  process.exitCode = 1;
} finally {
  if (provider && provider.exitCode === null) {
    provider.kill("SIGTERM");
    await new Promise((resolve) => {
      provider.once("exit", resolve);
      setTimeout(resolve, 3000).unref();
    });
  }
}
