import { isTauri } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  LogicalSize,
  type Window,
} from "@tauri-apps/api/window";

/**
 * True when the app draws its own frame (`decorations: false` in tauri.conf.json)
 * and therefore must show caption buttons. In a plain browser (vite dev, UI smoke
 * test) there is no native window to drive, so the controls stay hidden.
 */
export const hasCustomFrame = isTauri();

/**
 * `getCurrentWindow()` reads `__TAURI_INTERNALS__.metadata.currentWindow` and
 * throws when it is absent — a multiwebview host or an injected environment can
 * legitimately lack it. A missing window must degrade to a no-op, never crash the
 * shell during render or inside an unhandled promise rejection.
 */
function currentWindow(): Window | null {
  if (!hasCustomFrame) return null;
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export async function minimizeWindow(): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  await win.minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  await win.toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  await win.close();
}

export async function isWindowMaximized(): Promise<boolean> {
  const win = currentWindow();
  if (!win) return false;
  try {
    return await win.isMaximized();
  } catch {
    return false;
  }
}

export async function applyWindowSize(
  width: number,
  height: number,
): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  // Resizing a maximized window is a no-op on Windows; restore first.
  if (await win.isMaximized()) await win.unmaximize();
  await win.setSize(new LogicalSize(width, height));
}

/** Fires on maximize/restore so the title-bar glyph stays truthful. */
export async function onMaximizeChanged(
  callback: (maximized: boolean) => void,
): Promise<() => void> {
  const win = currentWindow();
  if (!win) return () => undefined;
  try {
    return await win.onResized(async () => {
      callback(await win.isMaximized().catch(() => false));
    });
  } catch {
    return () => undefined;
  }
}
