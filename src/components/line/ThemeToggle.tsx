import { Moon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "./ThemeProvider";

/**
 * Instant switch between the two designs. It lives in the sidebar footer and in
 * Settings so it is reachable from wherever someone notices the change.
 */
export default function ThemeToggle({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { theme, toggleTheme } = useTheme();
  const toOld = theme === "line";
  const label = toOld ? "Старый дизайн" : "Новый дизайн";

  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={toggleTheme}
        aria-label={`Включить ${label.toLowerCase()}`}
        title={`Включить ${label.toLowerCase()}`}
        className="text-muted-foreground hover:text-foreground"
      >
        {toOld ? (
          <Moon className="size-4" aria-hidden="true" />
        ) : (
          <Sparkles className="size-4" aria-hidden="true" />
        )}
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggleTheme}
      className="cursor-pointer gap-2 self-start text-xs"
    >
      {toOld ? (
        <Moon className="size-3.5" aria-hidden="true" />
      ) : (
        <Sparkles className="size-3.5" aria-hidden="true" />
      )}
      <span>Оформление: {label.toLowerCase()}</span>
    </Button>
  );
}
