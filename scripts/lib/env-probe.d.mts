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

export function findWebView2(
  env?: Record<string, string | undefined>,
): string | null;

export function tryLink(): { ok: boolean; detail: string };
