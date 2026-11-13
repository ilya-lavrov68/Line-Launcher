// Shared packwiz/Modrinth rules, exercised by tests/sources.test.ts.
//
// This is a line-by-line mirror of `src-tauri/src/line/source/{packwiz,modrinth}.rs`
// for the parts that decide *which files install*: TOML/JSON parsing, side and
// optional filtering, hash rules, path derivation. A mirror is a maintenance
// cost, and it is paid deliberately: CI has a Rust toolchain, but the rules are
// also what `scripts/pack-from-packwiz.mjs` must agree with, and a second
// independent expression of them is what makes an agreement test meaningful.
//
// It deliberately does NOT read PNG contents, download anything, or know about
// the game. Callers pass bytes in.
import { createHash } from "node:crypto";

export const STRONG_HASHES = ["sha256", "sha512"];

/** Anything the reader can produce. TOML is dynamically typed by nature; this
 * keeps the rest of the file checkable without pretending to a schema. */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export interface PackwizMeta {
  name?: string;
  filename?: string;
  side?: string;
  option?: { optional?: boolean };
  update?: { mode?: string };
  download?: { url?: string; "hash-format"?: string; hash?: string };
}

export interface PackwizFile {
  path: string;
  url: string;
  hashFormat: string;
  hash: string;
}

export type PackwizOutcome =
  | { skip: string; error?: undefined; file?: undefined }
  | { error: string; skip?: undefined; file?: undefined }
  | { file: PackwizFile; skip?: undefined; error?: undefined };

/** pack.toml is small; anything larger is not a manifest. */
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;

/**
 * A minimal TOML reader for the subset packwiz uses: tables, arrays of tables,
 * strings, booleans, integers, bare keys, dotted keys and quoted keys.
 *
 * Written out rather than imported because the launcher ships to Windows and
 * Linux with a vendored dependency tree, and `toml` is not in the npm side at
 * all. Anything outside the subset throws instead of guessing: a manifest the
 * reader does not understand must fail loudly, not parse to an empty pack.
 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  let tableStack: string[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let line = stripComment(lines[index]).trim();
    if (!line) continue;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      const path = parseKeyPath(line.slice(2, -2).trim());
      const parent = descend(root, path.slice(0, -1));
      const key = path[path.length - 1];
      if (!Array.isArray(parent[key])) parent[key] = [];
      table = {};
      (parent[key] as TomlTable[]).push(table);
      tableStack = path.slice(0, -1);
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const path = parseKeyPath(line.slice(1, -1).trim());
      table = descend(root, path);
      tableStack = path;
      continue;
    }

    const equals = findTopLevel(line, "=");
    if (equals < 0) throw new Error(`TOML: нет «=» в строке ${index + 1}`);
    const keyPath = parseKeyPath(line.slice(0, equals).trim());
    let value = line.slice(equals + 1).trim();

    // Multi-line strings and arrays of tables are the two places a line-based
    // reader would be wrong. Handle arrays spanning lines; refuse multi-line
    // strings with a clear message instead of a wrong value.
    if (value.startsWith('"""') || value.startsWith("'''")) {
      throw new Error(
        "TOML: многострочные строки в манифестах не поддерживаются",
      );
    }
    let consumed = 0;
    while (bracketDepth(value) > 0) {
      consumed += 1;
      if (index + consumed >= lines.length)
        throw new Error("TOML: незакрытый массив");
      value += "\n" + stripComment(lines[index + consumed]).trim();
    }
    index += consumed;

    setPath(
      descend(table, keyPath.slice(0, -1)),
      keyPath[keyPath.length - 1],
      parseValue(value),
    );
  }
  return root;
  void tableStack;
}

function stripComment(line: string): string {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

function findTopLevel(line: string, char: string): number {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const current = line[index];
    if (quote) {
      if (current === "\\" && quote === '"') index += 1;
      else if (current === quote) quote = null;
    } else if (current === '"' || current === "'") quote = current;
    else if (current === char) return index;
  }
  return -1;
}

function bracketDepth(value: string): number {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return depth;
}

function parseKeyPath(raw: string): string[] {
  return raw
    .split(".")
    .map((part) => part.trim())
    .map((part) => {
      if (/^".*"$/.test(part)) return JSON.parse(part);
      if (/^'.*'$/.test(part)) return part.slice(1, -1);
      if (!part) throw new Error("TOML: пустой ключ");
      return part;
    });
}

function descend(table: TomlTable, path: string[]): TomlTable {
  let current = table;
  for (const key of path) {
    if (current[key] === undefined) current[key] = {};
    const next = current[key];
    if (Array.isArray(next)) current = next[next.length - 1] as TomlTable;
    else if (typeof next === "object" && next !== null) current = next;
    else throw new Error(`TOML: ключ ${key} уже занят значением`);
  }
  return current;
}

function setPath(table: TomlTable, key: string, value: TomlValue): void {
  if (table[key] !== undefined && typeof table[key] === "object") {
    throw new Error(`TOML: ключ ${key} уже занят таблицей`);
  }
  table[key] = value;
}

function parseValue(raw: string): TomlValue {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTopLevel(value.slice(1, -1))
      .map((part) => part.trim())
      .filter(Boolean)
      .map(parseValue);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inline: TomlTable = {};
    for (const part of splitTopLevel(value.slice(1, -1))) {
      const equals = findTopLevel(part, "=");
      if (equals < 0) throw new Error("TOML: некорректная inline-таблица");
      setPath(
        inline,
        parseKeyPath(part.slice(0, equals).trim())[0],
        parseValue(part.slice(equals + 1)),
      );
    }
    return inline;
  }
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new Error(`TOML: неизвестное значение ${value}`);
}

function splitTopLevel(raw: string): string[] {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts;
}

/** Same rule as the Rust side: only sha256 and sha512 are accepted. */
export function strongHash(format: unknown): boolean {
  return STRONG_HASHES.includes(String(format).toLowerCase());
}

export function digest(format: string, bytes: Uint8Array | Buffer): string {
  const kind = String(format).toLowerCase();
  if (kind !== "sha256" && kind !== "sha512") {
    throw new Error(`weak hash: ${format}`);
  }
  return createHash(kind).update(bytes).digest("hex");
}

/**
 * Which packwiz entry becomes a file. `null` means "correctly skipped".
 * Errors match the Rust wording closely enough that a test can assert on the
 * reason without depending on the exact sentence.
 */
export function packwizEntry(path: string, meta: PackwizMeta): PackwizOutcome {
  if (meta.side === "server") return { skip: "server-side" };
  if (meta.option && meta.option.optional === true) return { skip: "optional" };
  const mode = meta.update && meta.update.mode;
  // Only CurseForge: other update modes still carry a download URL and hash,
  // and refusing them would be refusing a mode that works.
  if (
    typeof mode === "string" &&
    mode.toLowerCase() === "metadata:curseforge"
  ) {
    return { error: `metadata source ${mode} needs a CurseForge key` };
  }
  const download = meta.download || {};
  if (!strongHash(download["hash-format"] ?? "")) {
    return { error: `hash ${download["hash-format"]} is not strong enough` };
  }
  if (!download.hash) return { error: "missing hash" };
  const url = download.url ?? "";
  if (!/^https:\/\//.test(url)) return { error: "not https" };
  const filename = String(meta.filename ?? "").trim();
  if (
    !filename ||
    filename.length > 256 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return { error: `bad filename ${filename}` };
  }
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const target = dir ? `${dir}/${filename}` : filename;
  if (target.includes("..")) return { error: "path escapes the pack" };
  return {
    file: {
      path: target,
      url,
      hashFormat: String(download["hash-format"]).toLowerCase(),
      hash: String(download.hash).toLowerCase(),
    },
  };
}

/** Newest release, or the explicitly requested version. */
export interface ModrinthVersion {
  id: string;
  version_number?: string;
  version_type?: string;
  files?: unknown[];
}

export interface ModrinthIndexFile {
  path: string;
  downloads?: string[];
  hashes?: Record<string, string>;
  file_size?: number;
}

export function pickModrinthVersion<T extends ModrinthVersion>(
  versions: T[],
  requested?: string | null,
): T {
  if (requested) {
    const found = versions.find(
      (version) =>
        version.id === requested || version.version_number === requested,
    );
    if (!found) throw new Error(`version ${requested} not found`);
    return found;
  }
  const release = versions.find(
    (version) => (version.version_type ?? "release") === "release",
  );
  if (!release) throw new Error("no stable version: only betas");
  return release;
}

/** Files of an `.mrpack` index, minus the ones we cannot honour. */
export function modrinthFiles(index: { files: ModrinthIndexFile[] }) {
  return index.files.map((file) => {
    const download = (file.downloads ?? []).find(
      (url) => !/curseforge\.com|forgecdn\.net/i.test(url),
    );
    if (!download)
      throw new Error(`only CurseForge downloads for ${file.path}`);
    const sha512 = file.hashes && file.hashes.sha512;
    if (!sha512 || !/^[0-9a-f]{128}$/i.test(sha512)) {
      throw new Error(`no usable sha512 for ${file.path}`);
    }
    return {
      path: file.path,
      url: download,
      sha512: sha512.toLowerCase(),
      size: file.file_size,
    };
  });
}

/**
 * The revision a file list resolves to: path, digest and size in path order.
 * Identical to `ResolvedPack::compute_revision`.
 */
export function computeRevision(
  files: { path: string; sha256?: string; blake?: string; size?: number }[],
) {
  const ordered = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const file of ordered) {
    hash.update(Buffer.from(file.path, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(file.blake ?? file.sha256 ?? "", "utf8"));
    hash.update(Buffer.from([0]));
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(file.size ?? 0));
    hash.update(size);
  }
  return hash.digest("hex");
}
