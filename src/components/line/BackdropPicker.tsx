import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  BACKDROP_THEMES,
  backdropNameKey,
  backdropField,
  backdropTheme,
  type BackdropTheme,
} from "@/lib/line/backdrops";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/line/i18n";

/**
 * Backdrop picker.
 *
 * A single row: a swatch, the current theme's name and a chevron. It used to be
 * a grid of twelve tiles, which took a third of the settings page to say the
 * same thing — and none of the tiles moved, so the one property that matters
 * here (the gradient is animated) was invisible until you applied it.
 *
 * Now the list is folded away, and the picture is in a preview that opens beside
 * the row while a name is hovered or focused. The preview is a real
 * `AnimatedBackdrop`, not a static swatch: it paints the CSS colour field and
 * the WebGL haze with the same config the window will use, which is why
 * `backdropField` lives next to the themes — the preview and the app cannot
 * drift apart, because both call it.
 *
 * Keyboard and screen reader semantics are the list's, not the preview's: the
 * trigger reports `aria-expanded`, the options are a radiogroup through
 * `role="radio"` with `aria-checked`, and opening/closing with arrows and Escape
 * is handled by Base UI's popover.
 */
export interface BackdropPickerProps {
  value: string | null | undefined;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/** Hover-intent delay for the preview, so sweeping the list does not strobe. */
const PREVIEW_DELAY_MS = 120;

export default function BackdropPicker({
  value,
  onChange,
  disabled = false,
}: BackdropPickerProps) {
  const t = useT();
  const active = backdropTheme(value);
  const [open, setOpen] = useState(false);
  /** Theme hovered or focused in the list; the preview shows this one. */
  const [peeked, setPeeked] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const peek = useCallback(
    (id: string | null) => {
      clearTimer();
      if (id === null) {
        setPeeked(null);
        return;
      }
      // A short delay on purpose: running the pointer down the list should not
      // mount and unmount a WebGL layer per row it crosses.
      timer.current = window.setTimeout(() => setPeeked(id), PREVIEW_DELAY_MS);
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const previewed = backdropTheme(peeked ?? active.id);

  return (
    <div className="relative flex items-center gap-2">
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (disabled) return;
          setOpen(next);
          if (!next) setPeeked(null);
        }}
      >
        <PopoverTrigger
          disabled={disabled}
          aria-label={t("settings.backdropPreview", {
            name: t(backdropNameKey(active.id)),
          })}
          className={cn(
            "border-input bg-fill-subtle hover:bg-fill group flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border px-2 pr-2.5 text-left transition-colors",
            "focus-visible:ring-ring/40 focus-visible:ring-2 focus-visible:outline-none",
            disabled && "pointer-events-none opacity-50",
          )}
        >
          <Swatch theme={active} className="h-5 w-9" />
          <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium">
            {t(backdropNameKey(active.id))}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </PopoverTrigger>

        <PopoverContent
          // Narrow, anchored to the trigger and pushed in from the edge: the
          // list is a menu of names, not a second page.
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-(--anchor-width) min-w-56 p-1"
          onMouseLeave={() => peek(null)}
        >
          <div
            role="radiogroup"
            aria-label={t("settings.backdrop")}
            className="flex flex-col"
          >
            {BACKDROP_THEMES.map((theme) => {
              const selected = theme.id === active.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    onChange(theme.id);
                    setPeeked(null);
                    setOpen(false);
                  }}
                  onMouseEnter={() => peek(theme.id)}
                  onFocus={() => setPeeked(theme.id)}
                  onBlur={() => peek(null)}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-1.5 py-[5px] text-left transition-colors",
                    selected ? "bg-fill" : "hover:bg-fill-subtle",
                  )}
                >
                  <Swatch theme={theme} className="h-4.5 w-8" />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      selected
                        ? "text-foreground font-medium"
                        : "text-foreground/85",
                    )}
                  >
                    {t(backdropNameKey(theme.id))}
                  </span>
                  {selected && (
                    <Check
                      className="text-foreground size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/*
        The preview window. It sits beside the row instead of inside the list so
        a 12-item menu stays a menu; it is `aria-hidden` because the names in the
        list already carry the meaning, and it is pointer-transparent so it can
        never eat a click meant for the option underneath.

        Rendered at a fixed size and clipped: an animated shader wants a stable
        box, and scaling a canvas with `backdrop-filter` over it costs frames.
      */}
      {/*
        Mounted only while it is showing. It is absolutely positioned 208px to
        the right of the trigger, and an absolutely positioned box still counts
        towards its container's scrollWidth — parked here permanently it made
        the settings column 212px wider than its parent and turned the page into
        a horizontal scroller, with the long German labels the only thing anyone
        noticed, because that is when the overflow finally got a chance to show.
        Fading in on hover is unaffected: it mounts and animates from the same
        render that sets `peeked`.
      */}
      {peeked !== null && <BackdropPreview theme={previewed} open />}
    </div>
  );
}

/** The theme at chip size: its own three colours, on its own background. */
function Swatch({
  theme,
  className,
}: {
  theme: BackdropTheme;
  className?: string;
}) {
  const [warm, cool, mid] = theme.swatch;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "border-border/60 block shrink-0 overflow-hidden rounded-[5px] border",
        className,
      )}
      style={{
        backgroundImage: `radial-gradient(120% 120% at 12% 18%, ${warm}, transparent 62%), radial-gradient(120% 120% at 88% 84%, ${cool}, transparent 62%), radial-gradient(90% 90% at 62% 42%, ${mid}, transparent 70%), linear-gradient(${theme.config.background}, ${theme.config.background})`,
      }}
    />
  );
}

/**
 * The hover preview: the same colour field and the same shader the page uses,
 * at 176x104, with a caption so the name is never guessed from a colour.
 *
 * It starts as a 0-opacity, 4px-shifted box and fades in over 140ms — the same
 * cadence as the rest of the interface, and short enough that it never feels
 * like a dialog opening behind the pointer. It keeps its last theme while it
 * fades out, which is why `theme` is stored rather than read from the parent at
 * close time.
 */
function BackdropPreview({
  theme,
  open,
}: {
  theme: BackdropTheme;
  open: boolean;
}) {
  const t = useT();
  return (
    <div
      aria-hidden="true"
      data-backdrop-preview={open ? theme.id : undefined}
      className={cn(
        "pointer-events-none absolute top-1/2 left-full z-30 ml-3 hidden w-52 origin-left -translate-y-1/2",
        "transition-[opacity,transform] duration-150 ease-out",
        "sm:block",
        open
          ? "translate-x-0 scale-100 opacity-100"
          : "pointer-events-none -translate-x-1 scale-[0.98] opacity-0",
      )}
      style={{ transitionDuration: "150ms" }}
    >
      <div
        data-line-glass
        className="flex flex-col gap-1.5 overflow-hidden rounded-[var(--radius-item)] p-1.5"
      >
        <div className="relative h-[124px] w-full overflow-hidden rounded-[6px] bg-black">
          {/*
            Two copies of the same field, drifting in opposite directions, the
            same trick the page uses. Two differences from the page, both
            because of scale:

             - `mix-blend-normal` instead of the shell's `screen`: at 208px the
               additive blend washed every stop towards the same pale grey, and
               two themes in a row looked identical in the preview.
             - the theme's own veil is not applied here. It exists to keep text
               legible over a whole window; in a 124px picture with no text on
               it, the veil was doing nothing but removing the colour it is
               supposed to be previewing.
          */}
          <div
            data-line-haze
            className="absolute -inset-[18%]"
            style={{
              backgroundImage: backdropField(theme),
              mixBlendMode: "normal",
            }}
          />
          <div
            data-line-haze="echo"
            className="absolute -inset-[18%] opacity-70"
            style={{
              backgroundImage: backdropField(theme),
              mixBlendMode: "normal",
            }}
          />
        </div>
        <span className="text-foreground truncate px-0.5 text-[11px] font-medium">
          {t(backdropNameKey(theme.id))}
        </span>
      </div>
    </div>
  );
}
