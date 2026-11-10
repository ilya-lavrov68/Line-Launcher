/**
 * Design theme: `"line"` is the current look, `"old"` is the previous launcher
 * design kept intact for rollback.
 *
 * It is a **build-time** choice, not a setting: `VITE_LINE_THEME=old npm run
 * build` produces the previous design, and the shipped window has no control
 * that switches designs under the player. The attribute stays because that is
 * how `themes.css` scopes the two looks, and because a rollback build has to be
 * the same bytes with a different value — nothing in a component branches on it
 * at runtime.
 */
/**
 * Legacy storage key. Kept so a profile written by an older build (which did
 * have a switch) still resolves, and because `bootstrapTheme` used to persist;
 * nothing reads it as a *preference* any more — see `readTheme`.
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
 * The design this build ships. Read once at module load; never a preference.
 *
 * `import.meta.env` is replaced by Vite at build time; the optional chain keeps
 * this module importable under `node --test`, where the object does not exist.
 */
export function buildTheme(): LineTheme {
  // Read the whole env object rather than `import.meta.env.VITE_LINE_THEME`:
  // Vite replaces `import.meta.env` with a literal, but it only substitutes the
  // dotted form, so `import.meta.env?.VAR` silently stayed empty and the
  // rollback build produced the new design.
  const env = (import.meta.env ?? {}) as { VITE_LINE_THEME?: unknown };
  return isLineTheme(env.VITE_LINE_THEME) ? env.VITE_LINE_THEME : "line";
}

/**
 * `localStorage` throws in some hardened WebView profiles. A broken store must
 * degrade to the build's design, never to a white screen.
 *
 * A stored value is *not* consulted: the design is not switchable at runtime,
 * so honouring a leftover `line.theme` from an older build would let a file
 * override what was compiled. The storage argument is still read so the
 * signature keeps serving callers that pre-date the build-time choice (and the
 * tests that pass a store which throws).
 */
export function readTheme(storage?: Pick<Storage, "getItem">): LineTheme {
  const build = buildTheme();
  try {
    storage?.getItem(THEME_STORAGE_KEY);
  } catch {
    return build;
  }
  return build;
}

/**
 * No-op by design. This used to persist a runtime switch; the switch is gone,
 * so writing would only leave a key that a future build might trust again.
 */
export function writeTheme(
  _theme: LineTheme,
  _storage?: Pick<Storage, "setItem">,
): void {
  // Intentionally empty.
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
  const { read, root } = options;
  const theme = read ? read() : buildTheme();
  if (root) applyTheme(theme, root);
  else applyTheme(theme);
  return theme;
}
