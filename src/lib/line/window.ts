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

/**
 * Hide the window instead of minimising it.
 *
 * `hide()` is what "скрыть в трей" means to Windows: the window leaves the
 * taskbar and the alt-tab list while the process stays alive, so a full-screen
 * game has the machine to itself. `minimize()` is the other option and keeps a
 * taskbar button. Neither is a close — the tray icon (and the game's own exit,
 * see `restoreWindow`) brings it back.
 */
export async function hideWindow(): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  await win.hide();
}

/**
 * Bring the launcher back after the game exits. Called by the shell whenever a
 * game reaches a terminal phase, so all three behaviours converge here: a
 * player who chose "скрыть в трей" gets the window back without hunting for
 * the tray icon, which is what Prism does and what people expect.
 */
export async function restoreWindow(): Promise<void> {
  const win = currentWindow();
  if (!win) return;
  try {
    await win.unminimize();
  } catch {
    // Not minimised — nothing to undo.
  }
  try {
    await win.show();
  } catch {
    // Already visible.
  }
  try {
    await win.setFocus();
  } catch {
    // Windows may refuse focus to a background process; showing is enough.
  }
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
