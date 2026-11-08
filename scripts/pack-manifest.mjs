// Builds `pack.json` for a ZIP of a whole Minecraft instance.
//
//   node scripts/pack-manifest.mjs pack.zip https://cdn.example.com/pack.zip
//   node scripts/pack-manifest.mjs pack.zip https://.../pack.zip --version 1.21.1
//   node scripts/pack-manifest.mjs pack.zip https://.../pack.zip --out .provider/pack.json
//
// The launcher fetches this small JSON on every «Играть»: same sha256 means the
// copy on disk is still current, a different one means download the new archive.
// Sizes are read from the ZIP central directory (no extra dependencies) and
// checked against the same limits the Rust installer enforces, so a pack that
// would be rejected fails here instead of on the player's machine.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACK_SCHEMA_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 50_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_SENTINEL = 0xffffffff;

/** End-of-central-directory record: entry count and where the directory starts. */
export function findEndRecord(buffer) {
  const min = Math.max(0, buffer.length - 65_557);
  for (let at = buffer.length - 22; at >= min; at -= 1) {
    if (buffer.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    const entries = buffer.readUInt16LE(at + 10);
    const offset = buffer.readUInt32LE(at + 16);
    if (entries === 0xffff || offset === ZIP64_SENTINEL) {
      throw new Error(
        "ZIP64 не поддерживается: лаунчер ограничивает архив 4 ГиБ. Уменьшите сборку.",
      );
    }
    return { entries, offset };
  }
  throw new Error("Это не ZIP-архив: не найден конец центрального каталога.");
}

/** Relative file names and uncompressed sizes from the central directory. */
export function readDirectory(buffer) {
  const { entries, offset } = findEndRecord(buffer);
  const files = [];
  let at = offset;
  for (let index = 0; index < entries; index += 1) {
    if (
      at + 46 > buffer.length ||
      buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("Центральный каталог ZIP повреждён.");
    }
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    if (size === ZIP64_SENTINEL) {
      throw new Error(
        "ZIP64-запись в архиве: лаунчер такие сборки не принимает.",
      );
    }
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    if (!name.endsWith("/"))
      files.push({ name: name.replaceAll("\\", "/"), size });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const MARKERS = [
  "versions/",
  "libraries/",
  "assets/",
  "mods/",
  "config/",
  "options.txt",
  "resourcepacks/",
];

/**
 * Mirrors `instance::find_game_prefix` and `version_profile_ids` closely enough
 * to warn about a mis-shaped archive before it is uploaded. The launcher still
 * decides on its own; this is feedback for the person building the pack.
 */
export function inspectLayout(files) {
  const names = files.map((file) => file.name);
  const hasMarker = (prefix) =>
    MARKERS.some((marker) =>
      marker.endsWith("/")
        ? names.some((name) => name.startsWith(prefix + marker))
        : names.includes(prefix + marker),
    );
  const tops = [
    ...new Set(
      names
        .filter((name) => name.includes("/"))
        .map((name) => name.split("/")[0]),
    ),
  ]
    .filter((top) => top && !top.startsWith("."))
    .sort();
  const candidates = [".minecraft/", "minecraft/", ""];
  for (const top of tops) {
    candidates.push(`${top}/.minecraft/`, `${top}/`);
  }
  const prefix = candidates.find(hasMarker);
  if (prefix === undefined) {
    return {
      prefix: null,
      profiles: [],
      hasLibraries: false,
      hasAssets: false,
    };
  }
  const root = `${prefix}versions/`;
  const profiles = [
    ...new Set(
      names
        .filter((name) => name.startsWith(root))
        .map((name) => name.slice(root.length).split("/"))
        .filter(
          (parts) =>
            parts.length === 2 && parts[1] === `${parts[0]}.json` && parts[0],
        )
        .map((parts) => parts[0]),
    ),
  ].sort();
  return {
    prefix,
    profiles,
    hasLibraries: names.some((name) => name.startsWith(`${prefix}libraries/`)),
    hasAssets: names.some((name) =>
      name.startsWith(`${prefix}assets/objects/`),
    ),
  };
}

/** Validates and normalises the manifest the launcher will parse. */
export function buildManifest({
  url,
  sha256,
  sizeBytes,
  unpackedBytes,
  version,
  revision,
}) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error(
      "Адрес архива должен быть HTTPS: лаунчер не принимает http.",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
    throw new Error("Ожидается sha256 из 64 символов в нижнем регистре.");
  }
  if (
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("Размер архива должен быть от 1 байта до 4 ГиБ.");
  }
  if (
    !Number.isInteger(unpackedBytes) ||
    unpackedBytes <= 0 ||
    unpackedBytes > MAX_UNPACKED_BYTES
  ) {
    throw new Error("Распакованный размер должен быть от 1 байта до 16 ГиБ.");
  }
  const manifest = {
    schema_version: PACK_SCHEMA_VERSION,
    url,
    sha256,
    size_bytes: sizeBytes,
    unpacked_size_bytes: unpackedBytes,
  };
  if (revision) {
    if ([...revision].length > 64)
      throw new Error("revision длиннее 64 символов.");
    manifest.revision = revision;
  }
  if (version) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(version) ||
      version.includes("..")
    ) {
      throw new Error(
        "minecraft_version: только буквы, цифры, точка, дефис, подчёркивание.",
      );
    }
    manifest.minecraft_version = version;
  }
  return manifest;
}

export function manifestForArchive(buffer, options) {
  const files = readDirectory(buffer);
  if (files.length === 0) throw new Error("В архиве нет файлов.");
  if (files.length > MAX_ZIP_ENTRIES) {
    throw new Error(
      `В архиве больше ${MAX_ZIP_ENTRIES} файлов — лаунчер его отклонит.`,
    );
  }
  const unpackedBytes = files.reduce((total, file) => total + file.size, 0);
  const manifest = buildManifest({
    ...options,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.length,
    unpackedBytes,
  });
  return { manifest, layout: inspectLayout(files), fileCount: files.length };
}

function argument(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const FLAGS = new Set(["--version", "--revision", "--out"]);

/** Positionals only: a flag's value must never be mistaken for the archive. */
export function positionalArguments(argv) {
  const rest = [];
  for (let at = 0; at < argv.length; at += 1) {
    if (FLAGS.has(argv[at])) {
      at += 1;
      continue;
    }
    if (argv[at].startsWith("--")) continue;
    rest.push(argv[at]);
  }
  return rest;
}

function main() {
  const [archive, url] = positionalArguments(process.argv.slice(2));
  if (!archive || !url) {
    console.error(
      "Использование: node scripts/pack-manifest.mjs <pack.zip> <https://…/pack.zip> [--version 1.21.1] [--revision 1.0.0] [--out pack.json]",
    );
    process.exit(2);
  }
  let result;
  try {
    result = manifestForArchive(readFileSync(archive), {
      url,
      version: argument("--version"),
      revision: argument("--revision"),
    });
  } catch (error) {
    console.error(`Не удалось описать сборку: ${error.message}`);
    process.exit(1);
  }
  const out = path.resolve(
    argument("--out") || path.join(path.dirname(archive), "pack.json"),
  );
  writeFileSync(out, `${JSON.stringify(result.manifest, null, 2)}\n`);
  const { layout } = result;
  console.log(`pack.json записан: ${out}`);
  console.log(
    `Файлов: ${result.fileCount}, распаковано: ${result.manifest.unpacked_size_bytes} байт`,
  );
  if (layout.prefix === null) {
    console.error(
      "ВНИМАНИЕ: в архиве не найдена папка игры (mods/, config/, versions/…). Заархивируйте instance целиком.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Папка игры: ${layout.prefix || "корень архива"}; профилей версии: ${layout.profiles.length ? layout.profiles.join(", ") : "нет"}`,
  );
  if (!layout.profiles.length) {
    console.log(
      "Профилей versions/ нет — это сборка только с модами. Укажите minecraft_version у сервера в config.json, остальное лаунчер докачает сам.",
    );
  }
  if (!layout.hasLibraries || !layout.hasAssets) {
    console.log(
      `Лаунчер докачает с официальных серверов: ${[!layout.hasLibraries && "библиотеки", !layout.hasAssets && "ассеты"].filter(Boolean).join(", ")}.`,
    );
  }
}

// fileURLToPath, not URL.pathname: the latter percent-encodes non-ASCII paths
// (a repo under D:\Проекты would never match) and keeps a leading slash on Windows.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
