/**
 * Design-theme switch: `"line"` is the current look, `"old"` is the previous
 * launcher design kept intact for rollback (and for people who liked it).
 *
 * The theme is one attribute on `<html>`, so a component never branches on it:
 * `themes.css` re-declares the legacy slots for `"line"` and leaves `"old"`
 * inheriting `index.css` untouched. Nothing is stored in Rust — this is purely
 * a view preference of this window, readable before the first paint.
 */
export const THEME_STORAGE_KEY = "line.theme";
export const THEMES = ["line", "old"] as const;

export type LineTheme = (typeof THEMES)[number];

export const THEME_LABELS: Record<LineTheme, string> = {
  line: "Новый дизайн",
  old: "Старый дизайн",
};

export function isLineTheme(value: unknown): value is LineTheme {
  return (
    typeof value === "string" && (THEMES as readonly string[]).includes(value)
  );
}

/**
 * `localStorage` throws in some hardened WebView profiles. A broken store must
 * degrade to the default theme, never to a white screen.
 */
export function readTheme(storage?: Pick<Storage, "getItem">): LineTheme {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(
      THEME_STORAGE_KEY,
    );
    return isLineTheme(value) ? value : "line";
  } catch {
    return "line";
  }
}

export function writeTheme(
  theme: LineTheme,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A preference that cannot be persisted is still applied for this session.
  }
}

/** Single place that touches the DOM, so tests can assert one attribute. */
export function applyTheme(
  theme: LineTheme,
  root: Pick<HTMLElement, "dataset"> = document.documentElement,
): void {
  root.dataset.theme = theme;
}

export interface ThemeBootstrap {
  /** Stored value, already validated. */
  read?: () => LineTheme;
  root?: Pick<HTMLElement, "dataset">;
  /** Reserved for a future first-run choice; kept explicit for tests. */
  write?: (theme: LineTheme) => void;
}

/**
 * Runs before React mounts. The document is dark for both themes, so there is
 * no flash of light content — only the palette and surfaces swap.
 *
 * Dependencies are injectable on purpose: this module is executed by Node tests
 * where `document` does not exist.
 */
export function bootstrapTheme(options: ThemeBootstrap = {}): LineTheme {
  const { read = () => readTheme(), root, write } = options;
  const theme = read();
  if (root) applyTheme(theme, root);
  else applyTheme(theme);
  write?.(theme);
  return theme;
}
