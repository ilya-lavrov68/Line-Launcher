import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  applyTheme,
  bootstrapTheme,
  readTheme,
  writeTheme,
  type LineTheme,
} from "@/lib/line/theme";

interface ThemeContextValue {
  theme: LineTheme;
  setTheme: (theme: LineTheme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Owns the `data-theme` attribute. Mount it once, above the app shell: the
 * value is read from storage here too, so a test or a hot reload never depends
 * on the inline bootstrap script having run.
 */
export default function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<LineTheme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
    writeTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: LineTheme) => {
    setThemeState(next);
    // Apply synchronously as well: the preference must take effect on the
    // click, not on the next animation frame of an effect.
    applyTheme(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggleTheme: () => setTheme(theme === "line" ? "old" : "line"),
    }),
    [theme, setTheme],
  );

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

export { bootstrapTheme };
