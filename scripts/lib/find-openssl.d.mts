export interface OpenSslInstall {
  path: string;
  version: string;
  via: string;
}
export function findOpenSsl(
  env?: Record<string, string | undefined>,
): OpenSslInstall | null;
export function openSslHelp(): string;
