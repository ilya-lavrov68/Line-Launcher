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
  progress,
}: {
  children: ReactNode;
  disabled: boolean;
  active?: boolean;
  onClick: () => void;
  progress?: { label: string; percent: number | null };
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Button
        size="lg"
        disabled={disabled}
        aria-disabled={disabled}
        onClick={onClick}
        className={cn(
          "relative h-11 w-full gap-2 overflow-hidden rounded-[var(--radius-item)] text-sm font-semibold",
          progress && "disabled:opacity-100",
          active
            ? "bg-fill-strong text-foreground hover:bg-fill-strong/80"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        {progress && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-black/10">
            <span className={cn("block h-full bg-black/45 transition-[width] duration-200", progress.percent === null && "w-1/3 animate-pulse motion-reduce:animate-none")} style={progress.percent === null ? undefined : { width: `${progress.percent}%` }} />
          </span>
        )}
        <span className="flex min-w-0 items-center justify-center gap-2">{children}</span>
        {progress && <span aria-hidden="true" className="truncate text-xs font-normal opacity-75">{progress.label}{progress.percent === null ? "" : ` · ${progress.percent}%`}</span>}
      </Button>
      {progress && <span role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined} className="sr-only" />}
    </div>
  );
}
