// Builds the local demo project: real, installable packs plus a config whose
// sha256/size match the archives byte for byte.
//
//   node examples/provider/build-pack.mjs                # full demo (needs JDK)
//   node examples/provider/build-pack.mjs --no-java      # install-only demo
//   JAVA_HOME=/path/to/jdk node examples/provider/build-pack.mjs
//   ECJ_JAR=/path/to/ecj.jar node examples/provider/build-pack.mjs   # JRE + ECJ
//
// Output (in .provider/, override with LINE_PROVIDER_DIR):
//   pack.zip           Demo Survival, release 1  (also the rollback target)
//   pack-v2.zip        Demo Survival, release 2  (publish with publish-release.mjs)
//   pack-creative.zip  Demo Creative, independent install
//   art/*.svg          server icons and banners
//   packs.json         published metadata for every archive
//   config.json        one account for the whole project, three servers
//
// With a JDK the main class performs the real private-IPC ticket handshake, so
// install → verify → manifest → Java → IPC → launch is exercised without
// Minecraft. Without one the packs still install and the config omits the launch
// endpoints, so the launcher honestly shows «Запуск не настроен» instead of
// failing at spawn.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zip } from "../../scripts/lib/zip.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const out = path.resolve(root, process.env.LINE_PROVIDER_DIR || ".provider");
const argv = new Set(process.argv.slice(2));
const base = process.env.LINE_PROVIDER_URL || "https://127.0.0.1:8443";
const tmp = mkdtempSync(path.join(os.tmpdir(), "line-pack-"));
const javaHome = process.env.JAVA_HOME;
const bin = (name) =>
  javaHome
    ? path.join(
        javaHome,
        "bin",
        process.platform === "win32" ? `${name}.exe` : name,
      )
    : name;

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} failed (${result.status}): ${result.stderr || result.stdout || result.error}`,
    );
  }
  return result.stdout;
}

function javaMajor() {
  if (process.env.LINE_JAVA_MAJOR) return Number(process.env.LINE_JAVA_MAJOR);
  // `java -version` writes to stderr on most JDKs.
  const probe = spawnSync(bin("java"), ["-version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(`java -version failed: ${probe.stderr || probe.error}`);
  }
  return majorFromVersion(`${probe.stdout || ""}${probe.stderr || ""}`);
}

function majorFromVersion(text) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) throw new Error("cannot parse `java -version`");
  const first = Number(match[1]);
  return first === 1 ? Number(match[2]) : first;
}

/** True when a compiler is available, so the demo can include a real launch. */
function hasCompiler() {
  if (process.env.ECJ_JAR) return true;
  const probe = spawnSync(bin("javac"), ["-version"], { encoding: "utf8" });
  return probe.status === 0;
}

function collect(dir, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...collect(full, relative));
    else entries.push({ name: relative, bytes: readFileSync(full) });
  }
  return entries;
}

function compileClientJar() {
  const classes = path.join(tmp, "classes");
  mkdirSync(classes);
  const sources = [
    path.join(root, "examples/mod-client/LineTicketClient.java"),
    path.join(root, "examples/provider/DemoGame.java"),
  ];
  if (process.env.ECJ_JAR) {
    run(bin("java"), [
      "-jar",
      process.env.ECJ_JAR,
      "-17",
      "-warn:none",
      "-d",
      classes,
      ...sources,
    ]);
  } else {
    run(bin("javac"), ["--release", "17", "-d", classes, ...sources]);
  }
  // A jar is a zip; the launcher only needs regular files on the classpath.
  return zip([
    {
      name: "META-INF/MANIFEST.MF",
      bytes: Buffer.from("Manifest-Version: 1.0\nMain-Class: DemoGame\n\n"),
    },
    ...collect(classes),
  ]);
}

/** Deterministic vector art: no binary assets in the repository. */
function icon(letter, from, to) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
      `</linearGradient></defs>` +
      `<rect width="128" height="128" rx="28" fill="url(#g)"/>` +
      `<text x="64" y="86" font-family="Geist,Arial,sans-serif" font-size="64" font-weight="700" ` +
      `fill="#ffffff" text-anchor="middle">${letter}</text></svg>\n`,
  );
}

function banner(title, subtitle, from, to) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400" viewBox="0 0 1600 400">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
      `</linearGradient></defs>` +
      `<rect width="1600" height="400" fill="url(#g)"/>` +
      `<circle cx="1330" cy="70" r="190" fill="#ffffff" opacity="0.08"/>` +
      `<rect x="120" y="250" width="46" height="90" fill="#ffffff" opacity="0.18"/>` +
      `<rect x="180" y="210" width="46" height="130" fill="#ffffff" opacity="0.22"/>` +
      `<rect x="240" y="270" width="46" height="70" fill="#ffffff" opacity="0.16"/>` +
      `<text x="800" y="200" font-family="Geist,Arial,sans-serif" font-size="86" font-weight="800" ` +
      `fill="#ffffff" text-anchor="middle" letter-spacing="6">${title}</text>` +
      `<text x="800" y="255" font-family="Geist,Arial,sans-serif" font-size="30" ` +
      `fill="#ffffff" opacity="0.75" text-anchor="middle">${subtitle}</text></svg>\n`,
  );
}

/**
 * A valid 64×64 skin, so the wardrobe can be tested without hunting for a PNG.
 * Built with node:zlib — no binary assets in the repository.
 */
function skinPng([r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = -1;
    for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  // Head/torso/limb rectangles in the classic layout, transparent elsewhere.
  const pixel = (x, y) => {
    const inBox = (x0, y0, w, h) =>
      x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
    if (inBox(8, 0, 8, 8) || inBox(0, 8, 32, 8)) return [r, g, b, 255];
    if (inBox(20, 16, 8, 4) || inBox(16, 20, 24, 12)) return [r, g, b, 255];
    if (inBox(44, 16, 8, 4) || inBox(40, 20, 16, 12)) return [r, g, b, 230];
    if (inBox(4, 16, 4, 4) || inBox(0, 20, 16, 12)) return [r, g, b, 210];
    if (inBox(20, 48, 8, 4) || inBox(16, 52, 16, 12)) return [r, g, b, 200];
    if (inBox(4, 48, 8, 4) || inBox(0, 52, 16, 12)) return [r, g, b, 190];
    return [0, 0, 0, 0];
  };
  const raw = Buffer.alloc((64 * 4 + 1) * 64);
  for (let y = 0; y < 64; y += 1) {
    const row = y * (64 * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < 64; x += 1) {
      const [pr, pg, pb, pa] = pixel(x, y);
      const at = row + 1 + x * 4;
      raw[at] = pr;
      raw[at + 1] = pg;
      raw[at + 2] = pb;
      raw[at + 3] = pa;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ART = {
  "demo-icon.svg": icon("S", "#0f766e", "#14b8a6"),
  "demo-banner.svg": banner(
    "DEMO SURVIVAL",
    "Установка, запуск, приватный IPC",
    "#0f766e",
    "#0d9488",
  ),
  "creative-icon.svg": icon("C", "#6d28d9", "#a855f7"),
  "creative-banner.svg": banner(
    "DEMO CREATIVE",
    "Второй сервер того же аккаунта",
    "#6d28d9",
    "#9333ea",
  ),
  "showcase-icon.svg": icon("V", "#b45309", "#f59e0b"),
  "showcase-banner.svg": banner(
    "DEMO SHOWCASE",
    "Витрина без запуска игры",
    "#b45309",
    "#d97706",
  ),
};

try {
  mkdirSync(out, { recursive: true });
  const artDir = path.join(out, "art");
  mkdirSync(artDir, { recursive: true });
  for (const [name, bytes] of Object.entries(ART)) {
    writeFileSync(path.join(artDir, name), bytes);
  }

  // Ready-made textures: «Гардероб» can be tested without finding a PNG.
  const skinDir = path.join(out, "skins");
  mkdirSync(skinDir, { recursive: true });
  writeFileSync(
    path.join(skinDir, "demo-classic.png"),
    skinPng([90, 160, 220]),
  );
  writeFileSync(path.join(skinDir, "demo-slim.png"), skinPng([200, 130, 90]));

  const launchable = !argv.has("--no-java") && hasCompiler();
  let jar;
  let major;
  if (launchable) {
    jar = compileClientJar();
    major = javaMajor();
  } else {
    // Install-only demo: the archive is still a valid pack, but no server in the
    // config advertises launch endpoints, so nothing tries to run this jar.
    jar = zip([
      {
        name: "README.txt",
        bytes: Buffer.from(
          "Install-only demo pack: no JDK was found when it was built.\n" +
            "Install a JDK 17+ and re-run `npm run demo` to enable launching.\n",
        ),
      },
    ]);
    major = Number(process.env.LINE_JAVA_MAJOR || 21);
    console.warn(
      "[demo] Компилятор Java не найден — демо без запуска игры.\n" +
        "[demo] Установка, история, откат, гардероб и настройки работают полностью.\n" +
        "[demo] Поставьте JDK 17+ (или задайте JAVA_HOME / ECJ_JAR) и повторите npm run demo.",
    );
  }

  const manifest = {
    schema_version: 1,
    java_major: major,
    main_class: "DemoGame",
    classpath: ["client.jar"],
    minecraft_version: "1.21.1",
  };

  /** Every release differs in bytes, so sha256 — and the rollback — is real. */
  function writePack(file, label, version) {
    const entries = [
      { name: "client.jar", bytes: jar },
      {
        name: "line-launch.json",
        bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      },
      {
        name: "README.txt",
        bytes: Buffer.from(
          `Line Launcher demo pack — ${label} (${version}).\n` +
            "The main class performs the private-IPC ticket handshake and exits;\n" +
            "it is not Minecraft.\n",
        ),
      },
    ];
    const archive = zip(entries);
    writeFileSync(path.join(out, file), archive);
    return {
      file,
      version,
      sha256: createHash("sha256").update(archive).digest("hex"),
      size_bytes: archive.length,
      unpacked_size_bytes: entries.reduce((sum, e) => sum + e.bytes.length, 0),
    };
  }

  const packs = {
    "pack.zip": writePack("pack.zip", "Demo Survival", "1.0.0"),
    "pack-v2.zip": writePack("pack-v2.zip", "Demo Survival", "1.1.0"),
    "pack-creative.zip": writePack(
      "pack-creative.zip",
      "Demo Creative",
      "1.0.0",
    ),
  };
  writeFileSync(
    path.join(out, "packs.json"),
    `${JSON.stringify(packs, null, 2)}\n`,
  );

  const distribution = (file) => ({
    url: `${base}/${file}`,
    sha256: packs[file].sha256,
    size_bytes: packs[file].size_bytes,
    unpacked_size_bytes: packs[file].unpacked_size_bytes,
  });
  // A ticket authorises one specific server, so these stay per-server.
  const launchAuth = {
    launch_ticket_url: `${base}/v1/launcher/ticket`,
    session_exchange_url: `${base}/v1/launcher/exchange`,
  };
  const server = (id, name, description, art, file, extra = {}) => ({
    id,
    name,
    description,
    version: packs[file].version,
    minecraft_version: "1.21.1",
    icon_url: `${base}/art/${art}-icon.svg`,
    banner_url: `${base}/art/${art}-banner.svg`,
    ...(launchable ? { auth: launchAuth } : {}),
    distribution: distribution(file),
    ...extra,
  });

  const config = {
    schema_version: 1,
    min_launcher_version: "0.1.0",
    provider: {
      id: "line-demo",
      name: "Line Demo (локально)",
      // One account for the whole project; every server below shares it.
      auth: {
        login_url: `${base}/v1/login`,
        register_url: `${base}/v1/register`,
      },
      wardrobe: {
        skin_url: `${base}/v1/launcher/skin`,
        skin_upload_url: `${base}/v1/launcher/skin`,
      },
    },
    cache_ttl_seconds: 60,
    required_features: [
      "custom-auth-v1",
      "zip-sha256-v1",
      "launch-manifest-v1",
      "private-ipc-v1",
      "skin-upload-v1",
    ],
    servers: [
      server(
        "demo",
        "Demo Survival",
        "Полный цикл: установка, запуск, приватный IPC, остановка игры.",
        "demo",
        "pack.zip",
      ),
      server(
        "creative",
        "Demo Creative",
        "Второй сервер проекта: вход не спрашивается, сборка ставится отдельно.",
        "creative",
        "pack-creative.zip",
      ),
      // No launch endpoints on purpose: the launcher must say so, not fail.
      server(
        "showcase",
        "Demo Showcase",
        "Витрина без запуска: установка, история и гардероб, кнопка запуска выключена.",
        "showcase",
        "pack.zip",
      ),
    ],
  };
  // «showcase» deliberately gets no `auth`: the launcher must explain that
  // launching is not configured rather than fail at spawn.
  writeFileSync(
    path.join(out, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  console.log(`output:    ${out}`);
  for (const pack of Object.values(packs)) {
    console.log(
      `${pack.file.padEnd(18)} ${pack.sha256} ${pack.size_bytes} B (unpacked ${pack.unpacked_size_bytes})`,
    );
  }
  console.log(`java:      ${launchable ? major : "нет — запуск отключён"}`);
  console.log(`servers:   ${config.servers.map((s) => s.id).join(", ")}`);
  console.log(`skins:     ${path.join(skinDir, "demo-classic.png")}`);
  console.log(`config URL for the launcher: ${base}/config.json`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
