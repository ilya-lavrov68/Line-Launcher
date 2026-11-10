import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "./ThemeProvider";

/**
 * The design switch must be reachable from every screen, including the ones
 * that appear before the sidebar exists (provider address, sign-in, connecting).
 * On those screens the shell renders this pill in the title bar; inside the
 * app the same control lives in the sidebar and in Settings.
 */
export default function ThemeSwitchPill() {
  const { theme, toggleTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const toOld = theme === "line";

  return (
    <AnimatePresence initial={false}>
      <m.div
        key={theme}
        initial={reducedMotion ? false : { opacity: 0, y: -2 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reducedMotion ? undefined : { opacity: 0 }}
        transition={{
          duration: reducedMotion ? 0 : 0.16,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        <Button
          variant="ghost"
          size="xs"
          onClick={toggleTheme}
          aria-label={`Включить ${toOld ? "старый" : "новый"} дизайн`}
          title={`Включить ${toOld ? "старый" : "новый"} дизайн`}
          className="text-muted-foreground hover:text-foreground gap-1.5 font-normal"
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          <span>{toOld ? "Старый дизайн" : "Новый дизайн"}</span>
        </Button>
      </m.div>
    </AnimatePresence>
  );
}
