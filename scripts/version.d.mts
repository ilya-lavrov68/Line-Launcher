/** Types for `scripts/version.mjs`, so vite.config.ts can import it typed. */

export declare function readVersion(root?: string): string;

export declare function drift(
  root: string,
  version: string,
): { file: string; found: string | undefined; expected: string }[];

export declare function apply(root: string, version: string): string[];

export declare const SEMVER: RegExp;

export declare const TARGETS: {
  file: string;
  pattern: RegExp;
  current: (text: string) => string | undefined;
}[];
