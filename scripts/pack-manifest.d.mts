export const PACK_SCHEMA_VERSION: number;
export const MAX_ARCHIVE_BYTES: number;
export const MAX_UNPACKED_BYTES: number;
export const MAX_ZIP_ENTRIES: number;

export interface PackEntry {
  name: string;
  size: number;
}

export interface PackLayout {
  /** `null` when no game directory was recognised. */
  prefix: string | null;
  profiles: string[];
  hasLibraries: boolean;
  hasAssets: boolean;
}

export interface PackManifestFields {
  schema_version: number;
  url: string;
  sha256: string;
  size_bytes: number;
  unpacked_size_bytes: number;
  revision?: string;
  minecraft_version?: string;
}

export function findEndRecord(buffer: Buffer): {
  entries: number;
  offset: number;
};
export function readDirectory(buffer: Buffer): PackEntry[];
export function inspectLayout(files: PackEntry[]): PackLayout;
export function buildManifest(options: {
  url: string;
  sha256: string;
  sizeBytes: number;
  unpackedBytes: number;
  version?: string;
  revision?: string;
}): PackManifestFields;
export function manifestForArchive(
  buffer: Buffer,
  options: { url: string; version?: string; revision?: string },
): { manifest: PackManifestFields; layout: PackLayout; fileCount: number };
export function positionalArguments(argv: string[]): string[];
