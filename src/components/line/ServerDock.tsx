import { m, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Shared visual and accessible shell for every server's action dock. */
export function ServerDock({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <m.section
      data-line-glass="dock"
      role="region"
      aria-labelledby="server-action-title"
      initial={
        reducedMotion ? false : { opacity: 0, y: 12, filter: "blur(6px)" }
      }
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{
        duration: reducedMotion ? 0 : 0.22,
        ease: [0.22, 1, 0.36, 1],
      }}
      className="flex flex-col gap-3 p-4"
    >
      <h2 id="server-action-title" className="sr-only">
        {name}
      </h2>
      {children}
    </m.section>
  );
}

/** The primary action has the same size and interaction for every launch mode. */
export function ServerDockPrimary({
  children,
  disabled,
  active = false,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <m.div
      className="min-w-0 flex-1"
      whileHover={reducedMotion || disabled ? undefined : { scale: 1.004 }}
      whileTap={reducedMotion || disabled ? undefined : { scale: 0.994 }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
    >
      <Button
        size="lg"
        disabled={disabled}
        aria-disabled={disabled}
        onClick={onClick}
        className={cn(
          "h-11 w-full gap-2 rounded-[var(--radius-item)] text-sm font-semibold",
          active
            ? "bg-fill-strong text-foreground hover:bg-fill-strong/80"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        {children}
      </Button>
    </m.div>
  );
}
