// Minimal deterministic ZIP writer (stored + deflate) for the reference test
// pack. It exists so building a pack needs no npm dependency and no `jar` tool.
// The launcher only accepts Stored/Deflate, which is exactly what this emits.
import { deflateRawSync } from "node:zlib";

const table = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * @param {{name: string, bytes: Buffer}[]} entries forward-slash relative paths
 * @returns {Buffer} a complete archive
 */
export function zip(entries) {
  // Fixed DOS timestamp (1980-01-01) keeps the archive byte-reproducible, so the
  // published sha256 stays stable across rebuilds of identical inputs.
  const dosTime = 0;
  const dosDate = 0x21;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    if (name.startsWith("/") || name.includes("\\") || name.includes("..")) {
      throw new Error(`unsafe zip entry: ${name}`);
    }
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(bytes, { level: 9 });
    const useDeflate = deflated.length < bytes.length;
    const body = useDeflate ? deflated : bytes;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by UNIX, version 3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 30); // extra/comment/disk
    central.writeUInt16LE(0, 34); // internal attrs
    // External attributes: regular file, 0644. Never a symlink/device node.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
