export declare const BRAND_CONFIG: string;
export declare const MSI_CONFIG: string;

export interface BuildPass {
  label: string;
  args: string[];
}

/** Bundling passes for a platform, in order. */
export declare function buildPasses(platform: string): BuildPass[];
export function assertReleaseArgs(args: string[]): void;
