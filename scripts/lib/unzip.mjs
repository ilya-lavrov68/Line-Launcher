// Minimal strict ZIP reader for the reference-pack test. Mirrors the launcher's
// rules: regular files only, relative forward-slash paths, no traversal, no
// symlinks, Stored/Deflate only, bounded entry count and total size.
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 50_000;
const MAX_TOTAL = 16 * 1024 * 1024 * 1024;

export function unzipTo(archive, destination) {
  let offset = 0;
  let count = 0;
  let total = 0;
  const names = new Set();
  const written = [];
  while (offset + 4 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature !== 0x04034b50) break; // central directory reached
    if (count >= MAX_ENTRIES) throw new Error("too many zip entries");
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if (flags & 0x08) throw new Error("data descriptors are not supported");
    const name = archive
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString("utf8");
    const bodyStart = offset + 30 + nameLength + extraLength;
    const body = archive.subarray(bodyStart, bodyStart + compressedSize);
    offset = bodyStart + compressedSize;

    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes(":") ||
      name.split("/").includes("..")
    ) {
      throw new Error(`unsafe zip entry: ${name}`);
    }
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`duplicate zip entry: ${name}`);
    names.add(key);
    if (name.endsWith("/")) continue;
    if (method !== 0 && method !== 8)
      throw new Error(`unsupported compression method: ${method}`);
    const bytes = method === 0 ? Buffer.from(body) : inflateRawSync(body);
    if (bytes.length !== uncompressedSize)
      throw new Error(`size mismatch for ${name}`);
    total += bytes.length;
    if (total > MAX_TOTAL) throw new Error("unpacked size limit exceeded");
    const target = path.join(destination, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    written.push(key);
  }
  if (written.length === 0) throw new Error("archive contains no files");
  return written;
}
