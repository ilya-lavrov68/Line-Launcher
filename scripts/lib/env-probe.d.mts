export function probe(
  cmd: string,
  args?: string[],
  opts?: Record<string, unknown>,
): string | null;

export function programFilesRoots(
  env?: Record<string, string | undefined>,
): string[];

export function vsWherePath(
  env?: Record<string, string | undefined>,
): string | null;

export interface MsvcInstall {
  path: string;
  via: "vswhere" | "cl.exe";
}

export function findMsvc(
  env?: Record<string, string | undefined>,
  run?: (cmd: string, args: string[]) => string | null,
): MsvcInstall | null;

export declare const WEBVIEW2_CLIENT_KEY: string;

/** null when pv is absent, empty or 0.0.0.0 (key present but no runtime). */
export function parseWebView2Version(output: string | null): string | null;

export interface WebView2Install {
  version: string | null;
  path: string | null;
  via: "registry" | "files";
}

export function findWebView2(
  env?: Record<string, string | undefined>,
  run?: (cmd: string, args: string[]) => string | null,
): WebView2Install | null;

export function tryLink(): { ok: boolean; detail: string };
