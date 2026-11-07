// Builds a real, installable Line Launcher pack for manual end-to-end testing:
//   .provider/pack.zip      immutable archive (line-launch.json + client.jar)
//   .provider/config.json   provider config whose sha256/size match the archive
//
//   node examples/provider/build-pack.mjs
//   JAVA_HOME=/path/to/jdk node examples/provider/build-pack.mjs
//   ECJ_JAR=/path/to/ecj.jar node examples/provider/build-pack.mjs   # JRE + ECJ
//
// The pack's main class performs the real private-IPC ticket handshake, so the
// launcher's install → verify → manifest → Java → IPC → launch path is exercised
// without Minecraft. Java major defaults to the runtime that compiles the pack.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const out = path.join(root, ".provider");
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
  const version = `${probe.stdout || ""}${probe.stderr || ""}`;
  const match = /version "(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) throw new Error("cannot parse `java -version`");
  const first = Number(match[1]);
  return first === 1 ? Number(match[2]) : first;
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

try {
  mkdirSync(out, { recursive: true });
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
  const jar = zip([
    {
      name: "META-INF/MANIFEST.MF",
      bytes: Buffer.from("Manifest-Version: 1.0\nMain-Class: DemoGame\n\n"),
    },
    ...collect(classes),
  ]);
  const major = javaMajor();
  const manifest = {
    schema_version: 1,
    java_major: major,
    main_class: "DemoGame",
    classpath: ["client.jar"],
    minecraft_version: "1.21.1",
  };
  const packEntries = [
    { name: "client.jar", bytes: jar },
    {
      name: "line-launch.json",
      bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    {
      name: "README.txt",
      bytes: Buffer.from(
        "Line Launcher reference pack. The main class performs the private-IPC\n" +
          "ticket handshake and exits; it is not Minecraft.\n",
      ),
    },
  ];
  const archive = zip(packEntries);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const unpacked = packEntries.reduce((sum, e) => sum + e.bytes.length, 0);
  writeFileSync(path.join(out, "pack.zip"), archive);

  const base = process.env.LINE_PROVIDER_URL || "https://127.0.0.1:8443";
  const config = {
    schema_version: 1,
    min_launcher_version: "0.1.0",
    provider: { id: "line-demo", name: "Line Demo Provider" },
    cache_ttl_seconds: 60,
    required_features: [
      "custom-auth-v1",
      "zip-sha256-v1",
      "launch-manifest-v1",
      "private-ipc-v1",
      "skin-upload-v1",
    ],
    servers: [
      {
        id: "demo",
        name: "Demo Server",
        description:
          "Локальная сборка для проверки установки, запуска и приватного IPC.",
        version: "1.0.0",
        minecraft_version: "1.21.1",
        auth: {
          login_url: `${base}/v1/login`,
          register_url: `${base}/v1/register`,
          launch_ticket_url: `${base}/v1/launcher/ticket`,
          session_exchange_url: `${base}/v1/launcher/exchange`,
        },
        wardrobe: {
          skin_url: `${base}/v1/launcher/skin`,
          skin_upload_url: `${base}/v1/launcher/skin`,
        },
        distribution: {
          url: `${base}/pack.zip`,
          sha256,
          size_bytes: archive.length,
          unpacked_size_bytes: unpacked,
        },
      },
    ],
  };
  writeFileSync(
    path.join(out, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  console.log(`pack:      ${path.join(out, "pack.zip")}`);
  console.log(`config:    ${path.join(out, "config.json")}`);
  console.log(`sha256:    ${sha256}`);
  console.log(`size:      ${archive.length} bytes (unpacked ${unpacked})`);
  console.log(`java:      ${major}`);
  console.log(`config URL for the launcher: ${base}/config.json`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
