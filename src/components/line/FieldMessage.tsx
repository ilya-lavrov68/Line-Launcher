import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * What the app says about a field.
 *
 * A form field has three things to say and no fourth: something is wrong, a
 * hint before you touch it, or confirmation that it is fine. The platform has
 * its own idea of how to say the first — a black-bordered speech bubble with a
 * system-coloured warning icon, positioned by the browser, unthemed,
 * untranslated and different on every OS. It looked like a tooltip from another
 * program pasted onto this launcher, so the forms turn native validation off
 * (`noValidate` on the form, `required` kept for assistive tech) and use this.
 *
 * The message occupies a reserved slot: the element is always mounted at its
 * final height, so showing and clearing it cannot move the submit button below.
 * That is not cosmetic — the button used to jump on every failed attempt.
 */
export type FieldTone = "error" | "hint" | "success";

const TONE_ICON = {
  error: AlertCircle,
  hint: Info,
  success: CheckCircle2,
} as const;

export interface FieldMessageProps {
  tone?: FieldTone;
  /** Identifies this message for `aria-describedby` on the field. */
  id?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * One line of field feedback.
 *
 * Errors are announced (`role="alert"`); hints are not, because they are
 * always there and reading them on every keystroke is noise. The colour comes
 * from the theme's destructive/muted tokens — no new colours are introduced.
 */
export default function FieldMessage({
  tone = "error",
  id,
  children,
  className,
}: FieldMessageProps) {
  const reduced = useReducedMotion();
  const Icon = TONE_ICON[tone];
  return (
    <m.div
      // A short fade and a 2px lift: enough to notice the line changed, too
      // little to read as a panel opening under the field.
      initial={reduced ? false : { opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={cn(
        "flex items-start gap-1.5 text-[12px] leading-relaxed",
        tone === "error" && "text-destructive",
        tone === "hint" && "text-muted-foreground",
        tone === "success" && "text-foreground",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "hint" && "text-muted-foreground/70",
          tone === "success" && "text-line-online",
        )}
      />
      <span id={id} role={tone === "error" ? "alert" : undefined}>
        {children}
      </span>
    </m.div>
  );
}

/**
 * The reserved-height wrapper. `min-h` is the tallest message this slot will
 * ever hold at the narrowest supported window: the wrapper keeps the geometry
 * while `FieldMessage` handles the content.
 */
export function FieldMessageSlot({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      id={id}
      className={cn("min-h-4", className)}
      aria-live="polite"
      aria-atomic="true"
    >
      <AnimatePresence initial={false} mode="wait">
        {children}
      </AnimatePresence>
    </div>
  );
}
