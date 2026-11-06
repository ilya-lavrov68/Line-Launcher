// Real-JVM integration test for examples/mod-client/LineTicketClient.java.
// Node plays the launcher IPC peer and a one-shot HTTPS exchange provider.
// Requires a JDK (javac/keytool) or ECJ_JAR pointing at an Eclipse compiler jar.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "line-java-test-"));
const classes = path.join(tmp, "classes");
mkdirSync(classes);
const javaHome = process.env.JAVA_HOME;
const bin = (name) =>
  javaHome
    ? path.join(
        javaHome,
        "bin",
        process.platform === "win32" ? `${name}.exe` : name,
      )
    : name;
const java = bin("java");
const keytool = bin("keytool");
const storePass = "changeit";
const serverStore = path.join(tmp, "server.p12");
const trustStore = path.join(tmp, "trust.p12");
const certPem = path.join(tmp, "cert.pem");

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} failed (${result.status}): ${result.stderr || result.stdout || result.error}`,
    );
  }
  return result.stdout;
}

function compile() {
  const sources = [
    path.join(root, "examples/mod-client/LineTicketClient.java"),
    path.join(root, "tests/java/LineTicketClientTest.java"),
  ];
  if (process.env.ECJ_JAR) {
    run(java, [
      "-jar",
      process.env.ECJ_JAR,
      "-17",
      "-warn:none",
      "-d",
      classes,
      ...sources,
    ]);
    return;
  }
  run(bin("javac"), [
    "--release",
    "17",
    "-Xlint:all",
    "-d",
    classes,
    ...sources,
  ]);
}

function makeCerts() {
  run(keytool, [
    "-genkeypair",
    "-alias",
    "line",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-storetype",
    "PKCS12",
    "-keystore",
    serverStore,
    "-storepass",
    storePass,
    "-dname",
    "CN=localhost",
    "-ext",
    "SAN=dns:localhost,ip:127.0.0.1",
    "-validity",
    "1",
  ]);
  run(keytool, [
    "-exportcert",
    "-rfc",
    "-alias",
    "line",
    "-keystore",
    serverStore,
    "-storepass",
    storePass,
    "-file",
    certPem,
  ]);
  run(keytool, [
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
    storePass,
  ]);
}

const tickets = new Map();
function issue(mode, channel) {
  const ticket = randomUUID();
  const expiresIn = mode === "expired" ? 1 : 60;
  tickets.set(ticket, {
    server_id: "survival",
    sha256: "a".repeat(64),
    channel_id: channel,
    username: "Player_1",
    expires_at: Date.now() + expiresIn * 1000,
    used: false,
  });
  const endpoint =
    mode === "redirect"
      ? "/redirect"
      : mode === "oversize-http"
        ? "/oversize"
        : "/exchange";
  return { ticket, expires_in: expiresIn, endpoint };
}

async function startProvider() {
  const server = https.createServer(
    { pfx: readFileSync(serverStore), passphrase: storePass },
    (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/exchange" });
        res.end();
        return;
      }
      if (req.url === "/oversize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ padding: "x".repeat(17 * 1024) }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/exchange") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16 * 1024) req.destroy();
      });
      req.on("end", () => {
        try {
          const input = JSON.parse(body);
          const record = tickets.get(input.ticket);
          const fail = (code) => {
            res.writeHead(code, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false }));
          };
          if (!record) return fail(401);
          if (record.used) return fail(409);
          if (Date.now() >= record.expires_at) return fail(401);
          for (const key of ["server_id", "sha256", "channel_id", "username"]) {
            if (input[key] !== record[key]) return fail(403);
          }
          record.used = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, username: record.username }));
        } catch {
          res.writeHead(400).end();
        }
      });
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function ipcPath(channel) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\line-launcher-${channel}`
    : path.join("/tmp", `line-ipc-${channel}`, "ticket.sock");
}

async function startIpc(mode, channel, port) {
  const socketPath = ipcPath(channel);
  if (process.platform !== "win32") {
    mkdirSync(path.dirname(socketPath), { mode: 0o700 });
  }
  const issued = [
    "exchange",
    "replay",
    "expired",
    "bindings",
    "redirect",
    "oversize-http",
    "ipc-trailing",
  ].includes(mode)
    ? issue(mode, channel)
    : null;
  const server = net.createServer((socket) => {
    socket.once("error", () => {});
    if (mode === "ipc-timeout") return;
    socket.once("data", () => {
      if (mode === "ipc-malformed") {
        socket.end("{bad json}\n");
        return;
      }
      if (mode === "ipc-oversize") {
        socket.end(Buffer.alloc(17 * 1024, 0x61));
        return;
      }
      const response = {
        type: "line.launch-ticket.response",
        ticket: issued.ticket,
        exchange_url: `https://localhost:${port}${issued.endpoint}`,
        server_id: "survival",
        sha256: "a".repeat(64),
        username: "Player_1",
      };
      const line = JSON.stringify(response) + "\n";
      socket.end(mode === "ipc-trailing" ? line + "trailing" : line);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { server, socketPath };
}

function runJava(mode, channel) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      java,
      [
        "-cp",
        classes,
        `-DlineLauncher.sessionChannel=${channel}`,
        "-DlineLauncher.ipcTimeoutMs=1000",
        `-Djavax.net.ssl.trustStore=${trustStore}`,
        `-Djavax.net.ssl.trustStorePassword=${storePass}`,
        "-Djavax.net.ssl.trustStoreType=PKCS12",
        "LineTicketClientTest",
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${mode}: Java harness timeout`));
    }, 30_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim().endsWith("OK")) {
        reject(new Error(`${mode}: exit ${code}\n${stdout}\n${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const modes = [
  "json",
  "exchange",
  "replay",
  "expired",
  "bindings",
  "redirect",
  "oversize-http",
  "ipc-malformed",
  "ipc-oversize",
  "ipc-trailing",
  "ipc-timeout",
];

try {
  compile();
  makeCerts();
  const { server: provider, port } = await startProvider();
  try {
    for (const mode of modes) {
      const channel = randomUUID();
      const ipc = await startIpc(mode, channel, port);
      try {
        await runJava(mode, channel);
        console.log(`ok ${mode}`);
      } finally {
        await closeServer(ipc.server);
        if (process.platform !== "win32") {
          rmSync(path.dirname(ipc.socketPath), {
            recursive: true,
            force: true,
          });
        }
      }
    }
  } finally {
    await closeServer(provider);
  }
  console.log(
    `Java client integration: ${modes.length}/${modes.length} passed`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
