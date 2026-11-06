// End-to-end check of the reference provider + generated pack + Java client.
// Rust is not involved: Node plays the launcher's IPC peer. This validates the
// provider-side protocol and the pack, so a manual desktop run has a known-good
// counterpart.
//
//   node scripts/test-provider.mjs
//   JAVA_HOME=... ECJ_JAR=... node scripts/test-provider.mjs
//
// Requires: Node 22+, openssl, JDK 17+ (or ECJ_JAR with a JRE).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerDir = path.join(root, ".provider");
const tmp = mkdtempSync(path.join(os.tmpdir(), "line-provider-test-"));
const javaHome = process.env.JAVA_HOME;
const bin = (name) =>
  javaHome
    ? path.join(
        javaHome,
        "bin",
        process.platform === "win32" ? `${name}.exe` : name,
      )
    : name;
const port = Number(process.env.LINE_TEST_PORT || 8443);
const base = `https://127.0.0.1:${port}`;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
  console.log(`ok ${message}`);
}

function request(url, { method = "GET", body, token, ca } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      url,
      {
        method,
        ca,
        // The dev certificate is self-signed; the test pins it explicitly.
        rejectUnauthorized: true,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }),
        );
      },
    );
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function ipcPath(channel) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\line-launcher-${channel}`
    : path.join("/tmp", `line-ipc-${channel}`, "ticket.sock");
}

async function withIpc(channel, response, run) {
  const socketPath = ipcPath(channel);
  if (process.platform !== "win32")
    mkdirSync(path.dirname(socketPath), { mode: 0o700 });
  const server = net.createServer((socket) => {
    socket.once("error", () => {});
    socket.once("data", () => socket.end(`${JSON.stringify(response)}\n`));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await run();
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (process.platform !== "win32")
      rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
}

function runDemo(channel, trustStore, packDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin("java"),
      [
        "-cp",
        path.join(packDir, "client.jar"),
        `-DlineLauncher.sessionChannel=${channel}`,
        "-DlineLauncher.ipcTimeoutMs=5000",
        `-Djavax.net.ssl.trustStore=${trustStore}`,
        "-Djavax.net.ssl.trustStorePassword=changeit",
        "-Djavax.net.ssl.trustStoreType=PKCS12",
        "DemoGame",
        "--gameDir",
        packDir,
        "--username",
        "Player_1",
        "--version",
        "1.21.1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("demo game timeout"));
    }, 30_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let provider;
try {
  // 1. Build the pack with the same script the runbook uses.
  const build = spawnSync(
    process.execPath,
    [path.join(root, "examples/provider/build-pack.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, LINE_PROVIDER_URL: base },
    },
  );
  if (build.status !== 0)
    throw new Error(`build-pack failed: ${build.stderr || build.stdout}`);
  const config = JSON.parse(
    readFileSync(path.join(providerDir, "config.json"), "utf8"),
  );
  const pack = readFileSync(path.join(providerDir, "pack.zip"));
  const sha256 = createHash("sha256").update(pack).digest("hex");
  check(
    config.servers[0].distribution.sha256 === sha256,
    "published sha256 matches the archive",
  );
  check(
    config.servers[0].distribution.size_bytes === pack.length,
    "published size matches the archive",
  );

  // 2. Start the reference provider and fetch over real HTTPS.
  provider = spawn(
    process.execPath,
    [path.join(root, "examples/provider/server.mjs")],
    {
      env: { ...process.env, LINE_PROVIDER_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let providerLog = "";
  provider.stdout.on("data", (c) => (providerLog += c));
  provider.stderr.on("data", (c) => (providerLog += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`provider did not start:\n${providerLog}`)),
      15_000,
    );
    provider.stdout.on("data", (c) => {
      if (String(c).includes("Reference provider listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    provider.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`provider exited ${code}:\n${providerLog}`));
    });
  });
  const ca = readFileSync(path.join(providerDir, "tls.crt"));
  const fetched = await request(`${base}/config.json`, { ca });
  check(fetched.status === 200, "config.json is served over HTTPS");
  check(
    fetched.bytes.equals(readFileSync(path.join(providerDir, "config.json"))),
    "served config matches the generated document",
  );
  const downloaded = await request(`${base}/pack.zip`, { ca });
  check(
    createHash("sha256").update(downloaded.bytes).digest("hex") === sha256,
    "downloaded archive hash matches the config",
  );

  // Java needs the dev certificate in a truststore.
  const trustStore = path.join(tmp, "trust.p12");
  const certPem = path.join(tmp, "cert.pem");
  writeFileSync(certPem, ca);
  const keytool = spawnSync(
    bin("keytool"),
    [
      "-importcert",
      "-noprompt",
      "-alias",
      "line",
      "-file",
      certPem,
      "-keystore",
      trustStore,
      "-storetype",
      "PKCS12",
      "-storepass",
      "changeit",
    ],
    { encoding: "utf8" },
  );
  if (keytool.status !== 0)
    throw new Error(`keytool failed: ${keytool.stderr || keytool.stdout}`);

  // Unpack the archive the same way the launcher would (regular files only).
  const packDir = path.join(tmp, "pack");
  mkdirSync(packDir, { recursive: true });
  const { unzipTo } = await import("./lib/unzip.mjs");
  unzipTo(pack, packDir);
  const manifest = JSON.parse(
    readFileSync(path.join(packDir, "line-launch.json"), "utf8"),
  );
  check(
    manifest.classpath.includes("client.jar"),
    "manifest classpath is relative",
  );

  // 3. Log in, issue a ticket, run the demo game through the private channel.
  const login = await request(`${base}/v1/login`, {
    method: "POST",
    ca,
    body: {
      username: process.env.LINE_DEMO_USER || "Player_1",
      password: process.env.LINE_DEMO_PASSWORD || "demo-password",
      server_id: "demo",
    },
  });
  check(login.status === 200, "demo login succeeds");
  const session = JSON.parse(login.bytes.toString("utf8"));

  const channel = randomUUID();
  const issued = await request(`${base}/v1/launcher/ticket`, {
    method: "POST",
    ca,
    token: session.access_token,
    body: {
      server_id: "demo",
      sha256,
      channel_id: channel,
      username: session.username,
    },
  });
  check(issued.status === 200, "launch ticket is issued to a bearer session");
  const ticket = JSON.parse(issued.bytes.toString("utf8"));

  const result = await withIpc(
    channel,
    {
      type: "line.launch-ticket.response",
      ticket: ticket.ticket,
      exchange_url: `${base}/v1/launcher/exchange`,
      server_id: "demo",
      sha256,
      username: session.username,
    },
    () => runDemo(channel, trustStore, packDir),
  );
  check(
    result.code === 0 && result.stdout.includes("handshake OK"),
    `demo game completes the handshake (exit ${result.code})\n${result.stdout}\n${result.stderr}`,
  );
  check(
    !result.stdout.includes(ticket.ticket),
    "the ticket is never printed by the game",
  );

  // 4. The same ticket must be rejected on replay.
  const replay = await request(`${base}/v1/launcher/exchange`, {
    method: "POST",
    ca,
    body: {
      ticket: ticket.ticket,
      server_id: "demo",
      sha256,
      channel_id: channel,
      username: session.username,
    },
  });
  check(replay.status === 409, "replayed ticket is rejected with 409");

  // 5. A binding mismatch must be rejected.
  const second = await request(`${base}/v1/launcher/ticket`, {
    method: "POST",
    ca,
    token: session.access_token,
    body: {
      server_id: "demo",
      sha256,
      channel_id: randomUUID(),
      username: session.username,
    },
  });
  const secondTicket = JSON.parse(second.bytes.toString("utf8"));
  const mismatch = await request(`${base}/v1/launcher/exchange`, {
    method: "POST",
    ca,
    body: {
      ticket: secondTicket.ticket,
      server_id: "demo",
      sha256: "b".repeat(64),
      channel_id: randomUUID(),
      username: session.username,
    },
  });
  check(mismatch.status === 403, "binding mismatch is rejected with 403");

  console.log(`Reference provider end-to-end: ${checks}/${checks} passed`);
} finally {
  provider?.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
}
