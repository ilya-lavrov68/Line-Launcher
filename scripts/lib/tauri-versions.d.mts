export interface TauriPair {
  crate: string;
  npm: string;
  crateVersion: string;
  npmVersion: string;
  crateMinor: string | null;
  npmMinor: string | null;
}
export function cargoLockVersions(toml: string): Map<string, string>;
export function majorMinor(version: string): string | null;
export function npmVersion(root: string, name: string): string | null;
export function checkTauriVersions(root: string): {
  pairs: TauriPair[];
  mismatches: TauriPair[];
  missing: string[];
};
export function tauriVersionHelp(mismatches: TauriPair[]): string;
