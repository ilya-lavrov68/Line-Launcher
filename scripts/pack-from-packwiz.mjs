#!/usr/bin/env node
// packwiz pack  →  pack.zip for the provider archive path.
//
// Why this exists: a provider may publish a packwiz pack, and players whose
// launcher has not been updated yet install `distribution` instead. Both paths
// must produce the *same file set* or the two players are on different builds
// with one config saying they are on the same one.
//
// The converter is therefore held to the launcher's rules, not to packwiz's
// full feature set: it reads the same three files, applies the same side and
// optional filtering, the same strong-hash rule and the same path derivation,
// and refuses what the launcher refuses — with the same reasoning in the same
// words where a provider will see it.
//
//   node scripts/pack-from-packwiz.mjs <pack.toml URL | path> [-o pack.zip]
//
// No network surprises: `https:` is fetched by `fetch()`, a filesystem path is
// read as-is (useful for a local checkout), and nothing is written outside the
// output path.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { inflateRawSync } from "node:zlib";

const MAX_MANIFEST = 256 * 1024;
const MAX_FILE = 512 * 1024 * 1024;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = {
    source: null,
    output: "pack.zip",
    quiet: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-o" || arg === "--output") args.output = argv[++index];
    else if (arg === "-q" || arg === "--quiet") args.quiet = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (!arg.startsWith("-")) args.source = arg;
    else throw new Error(`Неизвестный параметр: ${arg}`);
  }
  return args;
}

const HELP = `packwiz → pack.zip

  node scripts/pack-from-packwiz.mjs <pack.toml> [-o pack.zip] [--dry-run]

<pack.toml> — HTTPS-ссылка (raw.githubusercontent.com/…) или путь к файлу.
--dry-run   показать файлы, ничего не скачивая и не записывая.

Файлы сборки скачиваются и проверяются по хешу; pack.zip содержит mod/
сборку в виде install/ (то, что распаковывает лаунчер) и pack.json.
`;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * A reader for a pack root that may be remote or local.
 * Local mode resolves `index.toml` and `mods/*.pw.toml` relative to the
 * directory of `pack.toml`, which is how packwiz itself lays a repo out.
 */
export function createReader(source) {
  const remote = /^https:\/\//i.test(source);
  if (!remote && /^[a-z]+:\/\//i.test(source)) {
    throw new Error("Разрешены только HTTPS-ссылки или путь к файлу.");
  }
  const root = remote
    ? new URL("./", source).href
    : path.dirname(path.resolve(source));

  return {
    remote,
    root,
    async text(name) {
      const bytes = await this.bytes(name, MAX_MANIFEST);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    /** @returns {Promise<Buffer>} */
    async bytes(name, limit = MAX_FILE) {
      // An absolute URL in a metafile (the normal case) is fetched as-is; only
      // a relative name is resolved against the pack root.
      const absolute = /^https:\/\//i.test(name);
      if (absolute && !remote) {
        throw new Error(
          `${name}: локальная сборка ссылается на файл по сети. Используйте --offline-map или запустите конвертацию по HTTPS-ссылке.`,
        );
      }
      const url = absolute
        ? name
        : remote
          ? new URL(name, root).href
          : path.join(root, name);
      if (remote && !url.startsWith("https://")) {
        throw new Error(`Ссылка вне HTTPS: ${url}`);
      }
      let bytes;
      if (remote) {
        const response = await fetch(url, { redirect: "follow" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} для ${url}`);
        }
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > limit)
          throw new Error(`${url}: файл больше допустимого размера`);
        const array = new Uint8Array(await response.arrayBuffer());
        if (array.byteLength > limit)
          throw new Error(`${url}: файл больше допустимого размера`);
        bytes = Buffer.from(array);
      } else {
        const stat = await import("node:fs/promises").then((fs) =>
          fs.stat(url),
        );
        if (stat.size > limit)
          throw new Error(`${url}: файл больше допустимого размера`);
        bytes = await readFile(url);
      }
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// The rules — mirrored from src-tauri/src/line/source/ and src/lib/line/sources.ts
// ---------------------------------------------------------------------------

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function strongHash(format) {
  return ["sha256", "sha512"].includes(String(format).toLowerCase());
}

/** @returns {{ok: true, entry: object} | {ok: false, skip?: string, error?: string}} */
export function entryFromMetafile(metaPath, meta) {
  if (meta.side === "server") return { ok: false, skip: "только серверу" };
  if (meta.option && meta.option.optional === true)
    return { ok: false, skip: "необязательный" };
  const mode = meta.update && meta.update.mode;
  // Only CurseForge: other update modes still carry a download URL and hash,
  // and refusing them would be refusing a mode that works.
  if (
    typeof mode === "string" &&
    mode.toLowerCase() === "metadata:curseforge"
  ) {
    return {
      ok: false,
      error: `${metaPath}: источник ${mode} требует CurseForge API-ключ, которого в лаунчере нет.`,
    };
  }
  const download = meta.download ?? {};
  if (!strongHash(download["hash-format"])) {
    return {
      ok: false,
      error: `${metaPath}: хеш ${download["hash-format"]} не поддерживается — нужен sha256 или sha512.`,
    };
  }
  if (!download.hash) return { ok: false, error: `${metaPath}: нет hash.` };
  if (!/^https:\/\//.test(download.url ?? "")) {
    return { ok: false, error: `${metaPath}: ссылка не HTTPS.` };
  }
  const filename = String(meta.filename ?? "").trim();
  if (
    !filename ||
    filename.length > 256 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return {
      ok: false,
      error: `${metaPath}: некорректное имя файла ${filename}.`,
    };
  }
  const dir = metaPath.includes("/")
    ? metaPath.slice(0, metaPath.lastIndexOf("/"))
    : "";
  const target = dir ? `${dir}/${filename}` : filename;
  if (target.includes(".."))
    return { ok: false, error: `${metaPath}: путь вне сборки.` };
  return {
    ok: true,
    entry: {
      path: target,
      url: download.url,
      hashFormat: String(download["hash-format"]).toLowerCase(),
      hash: String(download.hash).toLowerCase(),
      declaredSize: 0,
    },
  };
}

export function loaderFromVersions(versions = {}) {
  const order = [
    ["fabric", "fabric"],
    ["quilt", "quilt"],
    ["neoforge", "neoforge"],
    ["forge", "forge"],
  ];
  for (const [key, loader] of order) {
    if (versions[key]) return { loader, loaderVersion: versions[key] };
  }
  return {};
}

// ---------------------------------------------------------------------------
// ZIP writer — stored blocks only, deterministic
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a ZIP with no compression and a fixed timestamp.
 *
 * Stored, not deflated, because the contents are already-compressed jars and
 * packs; fixed timestamp and file order (sorted) so that converting the same
 * pack twice produces byte-identical output and a provider can diff two builds.
 * Class 3 (/) separators on every platform: this file is read by Tauri on
 * Windows too, and a backslash in a ZIP name is legal-but-wrong there.
 *
 * @param {{name: string, data: Buffer}[]} entries
 */
export function writeZip(entries) {
  const sorted = [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time 00:00
    local.writeUInt16LE(0x2821, 12); // date 2000-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads one stored/deflated entry out of a ZIP. Used by the tests and by
 * `--verify` on an archive the converter just wrote. */
export function readZipEntry(zip, name) {
  const buffer = Buffer.isBuffer(zip) ? zip : Buffer.from(zip);
  // Find the end-of-central-directory record; comment is empty for our files.
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP: нет end-of-central-directory");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("ZIP: плохой каталог");
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryName = buffer.toString(
      "utf8",
      cursor + 46,
      cursor + 46 + nameLength,
    );
    if (entryName === name) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtra = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtra;
      const data = buffer.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`ZIP: метод сжатия ${method} не поддерживается`);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Converts a packwiz pack. Returns what happened, writes nothing unless
 * `write` is true.
 *
 * @param {object} options
 * @param {string} options.source pack.toml URL or local path
 * @param {string} [options.output]
 * @param {boolean} [options.dryRun]
 * @param {(line: string) => void} [options.log]
 */
export async function convert({
  source,
  output = "pack.zip",
  dryRun = false,
  log = () => {},
  reader = createReader(source),
}) {
  const { parseToml } = await import("../src/lib/line/sources.ts");

  const pack = parseToml(await reader.text("pack.toml"));
  const format = String(pack["pack-format"] ?? "packwiz:1.0.0");
  if (!format.startsWith("packwiz:")) {
    throw new Error(
      "pack-format должен начинаться с «packwiz:» — это не сборка packwiz.",
    );
  }
  const major = Number.parseInt(format.slice("packwiz:".length), 10);
  if (!Number.isFinite(major) || major > 1) {
    throw new Error(
      `pack-format ${format} не поддерживается: нужен packwiz:1.x.`,
    );
  }

  const index = pack.index ?? {};
  if (!strongHash(index["hash-format"])) {
    throw new Error(
      `index.hash-format=${index["hash-format"]} не поддерживается: нужен sha256 или sha512.`,
    );
  }
  if (!index.file || String(index.file).includes("..")) {
    throw new Error("index.file не может выходить за папку сборки.");
  }
  const indexBytes = await reader.bytes(String(index.file));
  const expectedKind = String(index["hash-format"]).toLowerCase();
  const actual = createHash(expectedKind).update(indexBytes).digest("hex");
  if (actual !== String(index.hash).toLowerCase()) {
    throw new Error(
      "index.toml не совпадает с хешем в pack.toml: файл на сервере отличается от опубликованного.",
    );
  }

  const indexToml = parseToml(indexBytes.toString("utf8"));
  const listed = Array.isArray(indexToml.files) ? indexToml.files : [];
  log(`pack "${pack.name}": ${listed.length} записей в ${index.file}`);

  /** @type {{name: string, data: Buffer}[]} */
  const entries = [];
  let skipped = 0;
  for (const item of listed) {
    const metaPath = String(item.file ?? "").replace(/^\.\//, "");
    if (
      !metaPath ||
      metaPath.startsWith("/") ||
      metaPath.includes("..") ||
      metaPath.includes("\\") ||
      metaPath.split("/").some((part) => !part || part === ".") ||
      [".line-complete", ".line-files.json"].includes(metaPath)
    ) {
      throw new Error(`Некорректный путь в index.toml: ${metaPath}`);
    }
    const indexKind = String(
      indexToml["hash-format"] ?? "sha256",
    ).toLowerCase();
    if (!strongHash(indexKind))
      throw new Error("Неподдерживаемый формат хеша index.toml.");
    const expected = String(item.hash ?? "").toLowerCase();
    if (
      !new RegExp(`^[a-f0-9]{${indexKind === "sha512" ? 128 : 64}}$`).test(
        expected,
      )
    )
      throw new Error(`Некорректный хеш: ${metaPath}`);
    const indexedBytes = await reader.bytes(metaPath);
    if (createHash(indexKind).update(indexedBytes).digest("hex") !== expected)
      throw new Error(`Хеш файла ${metaPath} не совпадает с index.toml.`);
    if (!item.metafile) {
      entries.push({ name: `install/${metaPath}`, data: indexedBytes });
      continue;
    }
    const meta = parseToml(
      new TextDecoder("utf-8", { fatal: true }).decode(indexedBytes),
    );
    const outcome = entryFromMetafile(metaPath, meta);
    if (!outcome.ok) {
      if (outcome.error) throw new Error(outcome.error);
      skipped += 1;
      log(`  — ${metaPath}: ${outcome.skip}`);
      continue;
    }
    const bytes = await reader.bytes(outcome.entry.url);
    const kind = outcome.entry.hashFormat;
    const digest = createHash(kind).update(bytes).digest("hex");
    if (digest !== outcome.entry.hash) {
      throw new Error(
        `${outcome.entry.path}: скачанный файл не совпадает с ${kind} из .pw.toml.`,
      );
    }
    log(`  + ${outcome.entry.path} (${bytes.length} Б)`);
    entries.push({ name: `install/${outcome.entry.path}`, data: bytes });
  }

  // The provider archive layout: `install/` is what the launcher unpacks into
  // the game directory on a fresh install, and `pack.json` describes it.
  const manifest = {
    schema_version: 1,
    name: pack.name ?? "packwiz",
    revision: null,
    minecraft_version: (pack.versions ?? {}).minecraft ?? null,
    ...loaderFromVersions(pack.versions ?? {}),
    files: entries.map((entry) => ({
      path: entry.name.slice("install/".length),
      sha256: sha256(entry.data),
      size_bytes: entry.data.length,
    })),
  };
  manifest.revision = createHash("sha256")
    .update(
      manifest.files
        .map((file) => `${file.path}\0${file.sha256}\0${file.size_bytes}\n`)
        .sort()
        .join(""),
    )
    .digest("hex");

  const zip = writeZip(
    entries
      .map((entry) => ({ name: entry.name, data: entry.data }))
      .concat([
        {
          name: "pack.json",
          data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"),
        },
      ]),
  );

  log(`итог: ${entries.length} файлов, ${skipped} пропущено, ${zip.length} Б`);
  if (!dryRun) await writeFile(output, zip);
  return { zip, manifest, entries: entries.length, skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }
  const log = args.quiet
    ? () => {}
    : (line) => process.stdout.write(line + "\n");
  await convert({
    source: args.source,
    output: args.output,
    dryRun: args.dryRun,
    log,
  });
  if (args.dryRun) return;
  log(`записано: ${path.resolve(args.output)}`);
  // Self-check: the archive must be readable back with the paths we put in.
  const zip = await readFile(args.output);
  if (!readZipEntry(zip, "pack.json"))
    throw new Error("pack.zip испорчен: нет pack.json");
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("pack-from-packwiz.mjs") &&
  existsSync(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exit(1);
  });
}
