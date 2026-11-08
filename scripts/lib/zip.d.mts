export function crc32(bytes: Uint8Array): number;
/** Deterministic Stored/Deflate archive from relative forward-slash paths. */
export function zip(entries: { name: string; bytes: Buffer }[]): Buffer;
