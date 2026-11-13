export interface OpenSslInstall {
  path: string;
  version: string;
  via: string;
}
export function findOpenSsl(
  env?: Record<string, string | undefined>,
  options?: {
    run?: (command: string) => string | null;
    locateGit?: (env: Record<string, string | undefined>) => string[];
  },
): OpenSslInstall | null;
export function openSslHelp(): string;
