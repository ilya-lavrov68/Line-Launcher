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
import { findOpenSsl, openSslHelp } from "../../scripts/lib/find-openssl.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dir = path.resolve(root, process.env.LINE_PROVIDER_DIR || ".provider");
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
  const openssl = findOpenSsl();
  if (!openssl) {
    console.error(openSslHelp());
    process.exit(2);
  }
  if (openssl.via !== "PATH") {
    console.log(`Using openssl from ${openssl.via}: ${openssl.path}`);
  }
  const result = spawnSync(
    openssl.path,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
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
  if (result.error || result.status !== 0) {
    console.error(
      `Не удалось создать сертификат разработки (${openssl.path}).\n` +
        (result.stderr || String(result.error)) +
        "\n" +
        openSslHelp(),
    );
    process.exit(2);
  }
  console.log(`Created self-signed certificate: ${certPath}`);
}

/**
 * The config is read per request, not cached at startup: `publish-release.mjs`
 * rewrites it while this server runs, which is how the demo exercises
 * update → install → rollback without restarting anything.
 */
function readConfig() {
  const bytes = readFileSync(path.join(dir, "config.json"));
  const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
  return { bytes, etag };
}

/**
 * Only archives this demo published are served, and only by bare file name —
 * a request can never walk out of `.provider/`.
 */
function packPath(name) {
  if (!/^pack[a-z0-9.-]*\.zip$/.test(name)) return null;
  const file = path.join(dir, name);
  return existsSync(file) ? file : null;
}

function artPath(name) {
  if (!/^[a-z0-9-]+\.svg$/.test(name)) return null;
  const file = path.join(dir, "art", name);
  return existsSync(file) ? file : null;
}

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

/**
 * Raw body with a hard cap. Rejects with a tagged error instead of destroying the
 * socket, so the caller can answer 413 and the launcher shows a real reason
 * rather than a generic network failure.
 */
function readRaw(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        chunks.length = 0;
        const error = new Error("body too large");
        error.tooLarge = true;
        reject(error);
        // Stop reading, but keep the connection alive for the 413 response.
        req.pause();
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
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

// Reference wardrobe storage: username -> { model, png }. Never persisted.
const skins = new Map();

function bearerSession(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return sessions.get(token);
}

const server = https.createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  async (req, res) => {
    prune();
    const url = new URL(req.url, `https://${host}:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/config.json") {
        const config = readConfig();
        if (req.headers["if-none-match"] === config.etag) {
          res.writeHead(304, { ETag: config.etag }).end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": config.bytes.length,
          ETag: config.etag,
        });
        res.end(config.bytes);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/art/")) {
        const file = artPath(url.pathname.slice("/art/".length));
        if (!file) return json(res, 404, { error: "not_found" });
        const bytes = readFileSync(file);
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Length": bytes.length,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        });
        res.end(bytes);
        return;
      }
      if (
        req.method === "GET" &&
        /^\/pack[a-z0-9.-]*\.zip$/.test(url.pathname)
      ) {
        const file = packPath(url.pathname.slice(1));
        if (!file) return json(res, 404, { error: "not_found" });
        const bytes = readFileSync(file);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": bytes.length,
          ETag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
        });
        res.end(bytes);
        return;
      }
      if (url.pathname === "/v1/launcher/skin") {
        const session = bearerSession(req);
        if (!session) return json(res, 401, { error: "invalid_session" });
        const base = `https://${host}:${port}`;
        if (req.method === "GET") {
          const skin = skins.get(session.username);
          if (!skin) return json(res, 404, { error: "no_skin" });
          return json(res, 200, {
            model: skin.model,
            texture_url: `${base}/skins/${encodeURIComponent(session.username)}.png`,
          });
        }
        if (req.method === "DELETE") {
          skins.delete(session.username);
          log("skin reset", session.username);
          res.writeHead(204).end();
          return;
        }
        if (req.method === "POST") {
          const model = req.headers["x-skin-model"];
          if (model !== "classic" && model !== "slim") {
            return json(res, 400, { error: "invalid_model" });
          }
          if (!String(req.headers["content-type"]).startsWith("image/png")) {
            return json(res, 415, { error: "expected_png" });
          }
          const png = await readRaw(req);
          // The launcher validates too; a provider must never trust the client.
          const signature = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]);
          if (
            png.length < 33 ||
            !png.subarray(0, 8).equals(signature) ||
            png.readUInt32BE(16) !== 64 ||
            ![32, 64].includes(png.readUInt32BE(20))
          ) {
            return json(res, 400, { error: "invalid_skin" });
          }
          skins.set(session.username, { model, png });
          log("skin updated", { username: session.username, model });
          return json(res, 200, {
            model,
            texture_url: `${base}/skins/${encodeURIComponent(session.username)}.png`,
          });
        }
        return json(res, 405, { error: "method_not_allowed" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/skins/")) {
        const username = decodeURIComponent(
          url.pathname.slice("/skins/".length).replace(/\.png$/, ""),
        );
        const skin = skins.get(username);
        if (!skin) return json(res, 404, { error: "no_skin" });
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": skin.png.length,
          // The preview canvas is cross-origin; allow it to read the pixels.
          "Access-Control-Allow-Origin": "*",
        });
        res.end(skin.png);
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
      if (error.tooLarge) return json(res, 413, { error: "body_too_large" });
      return json(res, 400, { error: "bad_request" });
    }
  },
);

server.listen(port, host, () => {
  log(`Reference provider listening on https://${host}:${port}`);
  log(`Config URL: https://${host}:${port}/config.json`);
  log(`Demo account: ${demoUser} / ${demoPassword}`);
  try {
    const config = JSON.parse(readConfig().bytes.toString("utf8"));
    log(`Project: ${config.provider.name}`);
    for (const server of config.servers) {
      log(
        `  ${server.id.padEnd(10)} ${server.name} v${server.version}` +
          `${server.auth?.launch_ticket_url ? "" : "  (без запуска)"}`,
      );
    }
  } catch {
    // A hand-written fixture config may be minimal; serving it is still fine.
  }
  log("Development only — do not expose this server to a network.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
