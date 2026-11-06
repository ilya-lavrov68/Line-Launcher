// Development-only reference provider. See examples/provider/README.md.
// NOT FOR PRODUCTION: in-memory accounts/tickets, demo password check,
// self-signed TLS. It implements the protocol so a desktop build can be tested.
//
//   node examples/provider/build-pack.mjs
//   node examples/provider/server.mjs
//
// Env: LINE_PROVIDER_PORT (8443), LINE_PROVIDER_HOST (127.0.0.1),
//      LINE_DEMO_USER (Player_1), LINE_DEMO_PASSWORD (demo-password).
import { spawnSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dir = path.join(root, ".provider");
const port = Number(process.env.LINE_PROVIDER_PORT || 8443);
// Loopback only. Use 127.0.0.1 rather than `localhost`: on some hosts
// `localhost` resolves to ::1 first while this server binds IPv4.
const host = process.env.LINE_PROVIDER_HOST || "127.0.0.1";
const demoUser = process.env.LINE_DEMO_USER || "Player_1";
const demoPassword = process.env.LINE_DEMO_PASSWORD || "demo-password";

for (const file of ["pack.zip", "config.json"]) {
  if (!existsSync(path.join(dir, file))) {
    console.error(
      `Missing .provider/${file}. Run: node examples/provider/build-pack.mjs`,
    );
    process.exit(2);
  }
}

mkdirSync(dir, { recursive: true });
const keyPath = path.join(dir, "tls.key");
const certPath = path.join(dir, "tls.crt");
if (!existsSync(keyPath) || !existsSync(certPath)) {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2046",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "30",
      "-subj",
      `/CN=${host}`,
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(
      "openssl is required to create the development certificate.\n" +
        (result.stderr || String(result.error)),
    );
    process.exit(2);
  }
  console.log(`Created self-signed certificate: ${certPath}`);
}

const configBytes = readFileSync(path.join(dir, "config.json"));
const packBytes = readFileSync(path.join(dir, "pack.zip"));
const etag = `"${createHash("sha256").update(configBytes).digest("hex").slice(0, 32)}"`;
const packSha = createHash("sha256").update(packBytes).digest("hex");

const accounts = new Map([[demoUser, demoPassword]]);
const sessions = new Map(); // token -> {username, expiresAt}
const tickets = new Map(); // ticket -> {bindings, expiresAt, used}

const log = (...args) => console.log(new Date().toISOString(), ...args);

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  res.end(bytes);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function equal(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function prune() {
  const now = Date.now();
  for (const [token, session] of sessions)
    if (session.expiresAt <= now) sessions.delete(token);
  for (const [ticket, record] of tickets)
    if (record.expiresAt <= now) tickets.delete(ticket);
}

const server = https.createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  async (req, res) => {
    prune();
    const url = new URL(req.url, `https://${host}:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/config.json") {
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag }).end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": configBytes.length,
          ETag: etag,
        });
        res.end(configBytes);
        return;
      }
      if (req.method === "GET" && url.pathname === "/pack.zip") {
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": packBytes.length,
          ETag: `"${packSha}"`,
        });
        res.end(packBytes);
        return;
      }
      if (
        req.method === "POST" &&
        (url.pathname === "/v1/login" || url.pathname === "/v1/register")
      ) {
        const body = await readBody(req);
        const { username, password } = body;
        if (
          typeof username !== "string" ||
          typeof password !== "string" ||
          !/^[A-Za-z0-9_]{3,32}$/.test(username)
        ) {
          return json(res, 400, { error: "invalid_credentials" });
        }
        if (url.pathname === "/v1/register") {
          if (accounts.has(username))
            return json(res, 409, { error: "account_exists" });
          if (password.length < 8)
            return json(res, 400, { error: "weak_password" });
          accounts.set(username, password);
          log("register", username);
        } else if (!equal(accounts.get(username) ?? "", password)) {
          log("login rejected", username);
          return json(res, 401, { error: "invalid_credentials" });
        }
        const token = randomUUID();
        sessions.set(token, {
          username,
          expiresAt: Date.now() + 3_600_000,
        });
        log("login", username);
        return json(res, 200, {
          access_token: token,
          expires_in: 3600,
          username,
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/launcher/ticket") {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        const session = sessions.get(token);
        if (!session) return json(res, 401, { error: "invalid_session" });
        const body = await readBody(req);
        const { server_id, sha256, channel_id, username } = body;
        if (
          typeof server_id !== "string" ||
          typeof sha256 !== "string" ||
          typeof channel_id !== "string" ||
          username !== session.username
        ) {
          return json(res, 400, { error: "invalid_request" });
        }
        const ticket = randomUUID();
        tickets.set(ticket, {
          server_id,
          sha256,
          channel_id,
          username,
          expiresAt: Date.now() + 60_000,
          used: false,
        });
        // The ticket itself is never logged.
        log("ticket issued", { server_id, channel_id, username });
        return json(res, 200, { ticket, expires_in: 60 });
      }
      if (req.method === "POST" && url.pathname === "/v1/launcher/exchange") {
        const body = await readBody(req);
        const record = tickets.get(body.ticket);
        if (!record) {
          log("exchange rejected: unknown ticket");
          return json(res, 401, { error: "unknown_ticket" });
        }
        if (record.used) {
          log("exchange rejected: replay");
          return json(res, 409, { error: "ticket_already_used" });
        }
        if (Date.now() >= record.expiresAt) {
          log("exchange rejected: expired");
          return json(res, 401, { error: "ticket_expired" });
        }
        for (const key of ["server_id", "sha256", "channel_id", "username"]) {
          if (body[key] !== record[key]) {
            log(`exchange rejected: ${key} mismatch`);
            return json(res, 403, { error: "binding_mismatch", field: key });
          }
        }
        record.used = true;
        log("exchange accepted", {
          server_id: record.server_id,
          username: record.username,
        });
        // A real provider returns a Minecraft session/profile here. The shape is
        // provider-defined; the demo returns a minimal, non-secret payload.
        return json(res, 200, {
          ok: true,
          username: record.username,
          server_id: record.server_id,
          session_id: randomUUID(),
        });
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      log("request failed:", error.message);
      return json(res, 400, { error: "bad_request" });
    }
  },
);

server.listen(port, "127.0.0.1", () => {
  log(`Reference provider listening on https://${host}:${port}`);
  log(`Config URL: https://${host}:${port}/config.json`);
  log(`Demo account: ${demoUser} / ${demoPassword}`);
  log("Development only — do not expose this server to a network.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
