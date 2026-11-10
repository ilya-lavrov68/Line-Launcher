import { Check } from "lucide-react";
import { BACKDROP_THEMES, backdropTheme } from "@/lib/line/backdrops";
import { cn } from "@/lib/utils";

/**
 * Backdrop picker.
 *
 * Twelve swatches, each painted with the theme's own three dominant colours
 * rather than a generic gradient: a grid of identical grey chips tells the
 * player nothing about what they are choosing. Selecting one applies it
 * immediately (the shell already has the value) and the backdrop crossfades —
 * the fade lives in `AnimatedBackdrop`, not here, so the switch is smooth even
 * if the settings screen is re-rendered mid-transition.
 *
 * Radio semantics, not buttons: this is a single choice out of a known set, and
 * `aria-checked` is what a screen reader needs to read "выбрано" correctly.
 */
export interface BackdropPickerProps {
  value: string | null | undefined;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export default function BackdropPicker({
  value,
  onChange,
  disabled = false,
}: BackdropPickerProps) {
  const active = backdropTheme(value).id;
  return (
    <div
      role="radiogroup"
      aria-label="Фон лаунчера"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {BACKDROP_THEMES.map((theme) => {
        const selected = theme.id === active;
        const [warm, cool, mid] = theme.swatch;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={theme.name}
            disabled={disabled}
            onClick={() => onChange(theme.id)}
            className={cn(
              "group relative flex cursor-pointer flex-col gap-2 rounded-[var(--radius-control)] border p-1.5 text-left transition-colors",
              selected
                ? "border-foreground/35 bg-fill"
                : "border-input hover:border-foreground/20 hover:bg-fill-subtle",
              disabled && "pointer-events-none opacity-50",
            )}
          >
            {/* The swatch is the theme's own ramp: warm pool, cool pool, the
                mid-tone between them, on the canvas every theme shares. */}
            <span
              aria-hidden="true"
              className="block h-10 w-full overflow-hidden rounded-[5px]"
              style={{
                backgroundImage: `radial-gradient(120% 120% at 12% 18%, ${warm}, transparent 62%), radial-gradient(120% 120% at 88% 84%, ${cool}, transparent 62%), radial-gradient(90% 90% at 62% 42%, ${mid}, transparent 70%), linear-gradient(#08090c, #08090c)`,
              }}
            />
            <span className="flex items-center justify-between gap-1 px-0.5">
              <span className="text-foreground truncate text-[11px] font-medium">
                {theme.name}
              </span>
              {selected && (
                <Check
                  className="text-foreground size-3 shrink-0"
                  aria-hidden="true"
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
