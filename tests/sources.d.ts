// The converter is a `.mjs` script, not part of the TypeScript build; the test
// imports it to compare its rules against the resolver's. Declaring the shape it
// actually exports keeps the comparison type-checked rather than `any`-typed, so
// a renamed export breaks the test instead of the build.
declare module "*pack-from-packwiz.mjs" {
  import type { PackwizMeta } from "../src/lib/line/sources.ts";

  export interface ConvertedFile {
    path: string;
    sha256: string;
    size_bytes: number;
  }
  export interface ConvertedManifest {
    name: string;
    revision: string;
    files: ConvertedFile[];
    minecraft_version: string | null;
    loader?: string;
    loaderVersion?: string;
  }
  export interface ConvertResult {
    zip: Buffer;
    manifest: ConvertedManifest;
    entries: number;
    skipped: number;
  }
  export interface Reader {
    text(name: string): Promise<string>;
    bytes(name: string, limit?: number): Promise<Buffer>;
  }
  export function convert(options: {
    source: string;
    output?: string;
    dryRun?: boolean;
    log?: (line: string) => void;
    reader?: Reader;
  }): Promise<ConvertResult>;
  export function entryFromMetafile(
    path: string,
    meta: PackwizMeta,
  ): { ok: boolean; skip?: string; error?: string; entry?: { path: string } };
  export function parseArgs(argv: string[]): Record<string, unknown>;
  export function createReader(
    source: string,
  ): Reader & { remote: boolean; root: string };
  export function validateOutputPaths(entries: { name: string }[]): void;
  export function sha256(bytes: Buffer): string;
  export function strongHash(format: unknown): boolean;
  export function loaderFromVersions(versions?: Record<string, string>): {
    loader?: string;
    loaderVersion?: string;
  };
  export function crc32(bytes: Buffer): number;
  export function writeZip(entries: { name: string; data: Buffer }[]): Buffer;
  export function readZipEntry(zip: Buffer, name: string): Buffer | null;
}

declare module "*check-modrinth.mjs" {
  export function readMrpackIndex(buffer: Buffer): {
    files: unknown[];
    dependencies?: Record<string, string>;
  };
  export function inspectModrinth(
    project: string,
    version: string,
    fetcher?: typeof fetch,
  ): Promise<{
    files: number;
    clientFiles: number;
    missingSha512: number;
    dependencies: Record<string, string>;
    overrideFiles: number;
    declaredOverrideBytes: number;
    exceedsLauncherOverrideLimit: boolean;
  }>;
}

declare module "*frontend-deps.mjs" {
  export function missingFrontendDependencies(root: string): string[];
  export const frontendDependenciesHelp: string;
}
