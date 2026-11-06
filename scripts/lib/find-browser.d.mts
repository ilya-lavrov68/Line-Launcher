export interface BrowserInstall {
  path: string;
  via: string;
}
export function findBrowser(
  env?: Record<string, string | undefined>,
  platform?: string,
): BrowserInstall | null;
export function browserHelp(platform?: string): string;
