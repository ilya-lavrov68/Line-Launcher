// Wardrobe endpoints of the reference provider, over real HTTPS.
//
//   node scripts/test-wardrobe-provider.mjs
//
// Requires Node 22+ and openssl. Unlike test:provider this needs no JDK: it
// exercises only the skin contract, so it runs where javac is unavailable.
// Rust is not involved — this validates the provider side that the launcher's
// `wardrobe.rs` talks to.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { zip } from "./lib/zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".provider");
const port = Number(process.env.LINE_TEST_PORT || 8449);
const base = `https://127.0.0.1:${port}`;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
  console.log(`ok ${message}`);
}

/** Build a PNG with explicit IHDR fields so rejection paths can be exercised. */
function png({ width = 64, height = 64, depth = 8, colour = 6 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colour;
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
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x40);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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
          resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }),
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

// The provider refuses to start without a pack; the skin routes never read it,
// so a structural fixture is enough and keeps this test JDK-free.
mkdirSync(dir, { recursive: true });
const created = [];
function fixture(name, bytes) {
  const file = path.join(dir, name);
  if (existsSync(file)) return;
  writeFileSync(file, bytes);
  created.push(file);
}
fixture(
  "pack.zip",
  zip([
    {
      name: "line-launch.json",
      bytes: Buffer.from(
        JSON.stringify({
          schema_version: 1,
          main_class: "DemoGame",
          classpath: ["client.jar"],
          minecraft_version: "1.21.1",
        }),
      ),
    },
    {
      name: "client.jar",
      bytes: zip([{ name: "placeholder.txt", bytes: Buffer.from("fixture") }]),
    },
  ]),
);
fixture(
  "config.json",
  Buffer.from(
    JSON.stringify({
      schema_version: 1,
      min_launcher_version: "0.1.0",
      provider: { id: "wardrobe-test", name: "Wardrobe Test" },
      required_features: ["custom-auth-v1", "zip-sha256-v1", "skin-upload-v1"],
      servers: [
        {
          id: "demo",
          name: "Demo",
          description: "fixture",
          version: "1.0.0",
          auth: {
            login_url: `${base}/v1/login`,
          },
          wardrobe: {
            skin_url: `${base}/v1/launcher/skin`,
            skin_upload_url: `${base}/v1/launcher/skin`,
          },
          distribution: {
            url: `${base}/pack.zip`,
            sha256: "0".repeat(64),
            size_bytes: 1,
            unpacked_size_bytes: 1,
          },
        },
      ],
    }),
  ),
);

let provider;
try {
  provider = spawn(
    process.execPath,
    [path.join(root, "examples/provider/server.mjs")],
    {
      env: { ...process.env, LINE_PROVIDER_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  provider.stderr.on("data", (c) => (log += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`provider did not start:\n${log}`)),
      20_000,
    );
    provider.stdout.on("data", (c) => {
      log += c;
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

  const login = await request(`${base}/v1/login`, {
    method: "POST",
    body: { username: "Player_1", password: "demo-password", mode: "login" },
    ca,
  });
  check(login.status === 200, "demo login succeeds");
  const token = json(login).access_token;
  check(typeof token === "string" && token.length > 0, "session token issued");

  const skinUrl = `${base}/v1/launcher/skin`;

  const anonymous = await request(skinUrl, { ca });
  check(anonymous.status === 401, "skin read without a session is rejected");
  const badToken = await request(skinUrl, { ca, token: randomUUID() });
  check(badToken.status === 401, "an unknown bearer token is rejected");

  const empty = await request(skinUrl, { ca, token });
  check(empty.status === 404, "a player without a skin gets 404, not an error");

  const noModel = await request(skinUrl, {
    method: "POST",
    body: png(),
    token,
    ca,
  });
  check(noModel.status === 400, "upload without X-Skin-Model is rejected");

  const badModel = await request(skinUrl, {
    method: "POST",
    body: png(),
    token,
    ca,
    headers: { "X-Skin-Model": "capes" },
  });
  check(badModel.status === 400, "an unknown model is rejected");

  const wrongType = await request(skinUrl, {
    method: "POST",
    body: { not: "a png" },
    token,
    ca,
    headers: { "X-Skin-Model": "classic" },
  });
  check(wrongType.status === 415, "a non-PNG content type is rejected");

  const notPng = await request(skinUrl, {
    method: "POST",
    body: Buffer.from("definitely not a png"),
    token,
    ca,
    headers: { "X-Skin-Model": "classic" },
  });
  check(notPng.status === 400, "bytes without a PNG signature are rejected");

  const wrongSize = await request(skinUrl, {
    method: "POST",
    body: png({ width: 32, height: 32 }),
    token,
    ca,
    headers: { "X-Skin-Model": "classic" },
  });
  check(
    wrongSize.status === 400,
    "a 32x32 texture is rejected server-side too",
  );

  const oversize = await request(skinUrl, {
    method: "POST",
    body: Buffer.concat([png(), Buffer.alloc(300 * 1024)]),
    token,
    ca,
    headers: { "X-Skin-Model": "classic" },
  });
  check(
    oversize.status === 413,
    "an oversized body is refused with 413, not a dropped connection",
  );

  const good = await request(skinUrl, {
    method: "POST",
    body: png(),
    token,
    ca,
    headers: { "X-Skin-Model": "slim" },
  });
  check(good.status === 200, "a valid 64x64 slim skin is accepted");
  const state = json(good);
  check(state.model === "slim", "the stored model is returned");
  check(
    typeof state.texture_url === "string" &&
      state.texture_url.startsWith("https://"),
    "the texture URL is HTTPS",
  );

  const read = await request(skinUrl, { ca, token });
  check(
    read.status === 200 && json(read).model === "slim",
    "skin read round-trips",
  );

  const texture = await request(state.texture_url, { ca });
  check(texture.status === 200, "the texture is downloadable");
  check(
    texture.bytes.subarray(0, 8).equals(png().subarray(0, 8)),
    "the served texture is the uploaded PNG",
  );

  const legacy = await request(skinUrl, {
    method: "POST",
    body: png({ height: 32 }),
    token,
    ca,
    headers: { "X-Skin-Model": "classic" },
  });
  check(legacy.status === 200, "a legacy 64x32 skin is accepted");

  const reset = await request(skinUrl, { method: "DELETE", token, ca });
  check(reset.status === 204 || reset.status === 200, "reset succeeds");
  const afterReset = await request(skinUrl, { ca, token });
  check(afterReset.status === 404, "the skin is gone after reset");

  check(!log.includes(token), "the session token is never logged");
  console.log(`\nWardrobe provider: ${checks} checks passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  provider?.kill("SIGKILL");
  for (const file of created) rmSync(file, { force: true });
}
