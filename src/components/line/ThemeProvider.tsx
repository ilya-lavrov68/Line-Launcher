import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { applyTheme, buildTheme, type LineTheme } from "@/lib/line/theme";

interface ThemeContextValue {
  /** The design this build ships. Fixed for the lifetime of the window. */
  theme: LineTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Owns the `data-theme` attribute. Mount it once, above the app shell.
 *
 * There is no setter: the design is chosen when the app is built (see
 * `buildTheme`), and the shipped window offers no control that changes it. The
 * provider exists so components can read which build they are in without
 * probing the DOM, and so the attribute survives a test render.
 */
export default function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useMemo(() => buildTheme(), []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({ theme }), [theme]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return context;
}

export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

export { bootstrapTheme } from "@/lib/line/theme";
