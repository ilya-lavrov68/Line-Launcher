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

/**
 * The primary action has the same size and interaction for every launch mode.
 *
 * ## The button is a button
 *
 * It used to double as the download display: the label was replaced by the
 * running stage, and a bar plus a file name opened underneath it. That is a
 * music player's transport bar, not an action — a control that alternates
 * between "Играть" and "Скачивание · 45%" has no stable meaning, and the file
 * name underneath changed several times a second.
 *
 * So the label here is only ever the action. Progress lives in
 * [`ActionProgress`], a fixed-height row of the dock that does not reflow and
 * never prints a path. Nothing in this component knows a download is running.
 */
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
  return (
    <div className="min-w-0 flex-1">
      <Button
        size="lg"
        disabled={disabled}
        aria-disabled={disabled}
        onClick={onClick}
        className={cn(
          "h-11 w-full gap-2 rounded-[var(--radius-item)] text-sm font-semibold",
          active
            ? "bg-fill-strong text-foreground hover:bg-fill-strong/80"
            : "bg-primary text-primary-foreground hover:bg-primary/85",
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {children}
        </span>
      </Button>
    </div>
  );
}

/**
 * One quiet line for work in progress: the stage, the bar, the percentage.
 *
 * ## Why it is its own element, and why its height never changes
 *
 * The complaint was that a download "rendered on the button" and that file
 * names flashed underneath it. Both come from the same mistake: using moving
 * text as the affordance. This row answers "how far along is it" without
 * touching the button and without naming a file — the stage comes from the
 * dictionary (`mc.stageDownload` and friends), never from the payload.
 *
 * The wrapper reserves its height even when there is nothing to show
 * (`reserve` on the dock), so a stage transition cannot shift the panel: the
 * row appears where it always was.
 *
 * `percent` is `null` for a stage with no meaningful total (resolving a pack,
 * checking a cache). The bar then pulses instead of filling, and no number is
 * printed, because "0%" for work you cannot measure is a lie.
 */
export function ActionProgress({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number | null;
  /** A short non-identifying counter ("12 / 480 файлов"), never a path. */
  detail?: string;
}) {
  const clamped =
    percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground truncate text-[12px]">
          {label}
        </span>
        {clamped !== null && (
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
            {clamped}%
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped ?? undefined}
        aria-label={label}
        className="bg-fill h-1.5 w-full overflow-hidden rounded-full"
      >
        <div
          className={cn(
            "bg-primary h-full rounded-full transition-[width] duration-200",
            clamped === null && "w-1/3 animate-pulse",
          )}
          style={clamped === null ? undefined : { width: `${clamped}%` }}
        />
      </div>
      {detail && (
        <span className="text-muted-foreground font-mono text-[11px]">
          {detail}
        </span>
      )}
    </div>
  );
}
