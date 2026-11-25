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
 * The primary action, and — while it works — the progress display itself.
 *
 * ## Кнопка и есть лоадер
 *
 * Ссылка — плеер Liner: там одна кнопка play/pause, которая сама меняет
 * состояние, и никакой строки «Скачивание · 45 %» рядом с ней. Первая попытка
 * понять это закончилась подписью с процентами на кнопке, вторая — отдельной
 * строкой прогресса под ней. Обе добавляли на экран ещё один элемент; нужен
 * был ровно один.
 *
 * Поэтому кнопка не меняет подпись — она по-прежнему говорит, что произойдёт
 * при нажатии, — а её заливка растёт слева направо по мере загрузки. Нет ни
 * процентов текстом, ни имени файла, ни второй полосы. Стадия уже названа в
 * строке статуса этого дока («Подготовка…»), поэтому здесь её не повторяем.
 *
 * ## Почему полоса отрисована в кнопке, а роль — снаружи
 *
 * У роли `button` в ARIA все потомки презентационные: `role="progressbar"`
 * внутри `<button>` скринридер проигнорирует. Поэтому заливка — декоративная
 * (`aria-hidden`), а сам `progressbar` с числом стоит рядом с кнопкой и
 * визуально скрыт. Кнопка получает `aria-busy`, имя остаётся действием.
 *
 * `progress` — 0–100 или `null`. `indeterminate` — стадия без измеримого
 * итога (разбор пакета, проверка кэша): заливка тогда ходит, а не растёт, а
 * `aria-valuenow` не выставляется, потому что числа нет.
 */
export function ServerDockPrimary({
  children,
  disabled,
  active = false,
  progress = null,
  indeterminate = false,
  progressLabel,
  joined = false,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  active?: boolean;
  /** 0–100, or `null` when nothing is running. */
  progress?: number | null;
  indeterminate?: boolean;
  /** Accessible name for the progress value, e.g. «Скачивание сборки». */
  progressLabel?: string;
  /** Square off the trailing edge when a separate disclosure button adjoins it. */
  joined?: boolean;
  onClick: () => void;
}) {
  const busy = progress !== null || indeterminate;
  const clamped =
    progress === null ? null : Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className="relative min-w-0 flex-1">
      <Button
        size="lg"
        disabled={disabled}
        aria-disabled={disabled}
        aria-busy={busy || undefined}
        onClick={onClick}
        className={cn(
          "relative h-11 w-full gap-2 overflow-hidden rounded-[var(--radius-item)] text-sm font-semibold",
          joined && "rounded-e-none",
          active
            ? "bg-fill-strong text-foreground hover:bg-fill-strong/80"
            : "bg-primary text-primary-foreground hover:bg-primary/85",
          // The button is disabled *because* it is working, and the base class
          // dims disabled controls to half opacity — which would fade the very
          // fill a player is watching. Keep it at full strength.
          busy && "disabled:opacity-100",
        )}
      >
        {busy && !indeterminate && (
          // Decorative: the fill a player watches. `aria-hidden` because the
          // real progressbar sits outside the button (see above).
          //
          // The mechanic is tryliner's, from `MiniPlayer.tsx`: an element that
          // covers the whole surface, anchored at the left edge with
          // `transform-origin: left`, scaled on X. Not a bar that starts life
          // in the middle and grows both ways — a sheet that is rolled out from
          // the start. `width` would do the same thing visually, but scaling a
          // fixed-size layer keeps the work on the compositor and lets the
          // eased step match the one the player uses (`transform 600ms`).
          //
          // This is the *install* shape: it needs a denominator. A stage with
          // no denominator gets the sweep below instead of a frozen third.
          <span
            aria-hidden="true"
            className={cn(
              // A wash of the label's own colour, not a second colour: the
              // button reads as filling, not as a bar laid on top of it.
              //
              // `/12` of the *ink* on the accent plate. Liner's 12 % is white
              // on a dark surface (`MiniPlayer.tsx`); here the plate is the
              // near-white accent, so the tint that reads is the dark one. At a
              // quarter white the growing area read as a grey slab cut into the
              // button — «посредственно» was fair.
              "bg-primary-foreground/12 absolute inset-0 origin-left",
              "transition-transform duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            )}
            style={{ transform: `scaleX(${(clamped ?? 0) / 100})` }}
          />
        )}
        {busy && indeterminate && (
          // The indeterminate shape: this stage has no denominator, so a third
          // of the surface travels across the clipped button and loops. It says
          // "working, length unknown" without inventing a percentage.
          //
          // It is a separate element from the fill above rather than a mode of
          // it: the fill is anchored (`origin-left`, scale) and the sweep
          // travels (`translateX`), and one element cannot do both without
          // lurching back to zero each cycle.
          <span
            aria-hidden="true"
            data-slot="dock-sweep"
            className="absolute inset-0 overflow-hidden"
          >
            <span className="dock-sweep bg-primary-foreground/12 absolute inset-y-0 left-0 w-1/3" />
          </span>
        )}
        <span className="relative z-10 inline-flex min-w-0 items-center gap-2">
          {children}
        </span>
      </Button>
      {/* Outside the button, because `button` makes its descendants
          presentational: a progressbar inside it would be ignored by a screen
          reader. Visually hidden — the fill above is what a player watches. */}
      {busy && (
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : (clamped ?? 0)}
          aria-label={progressLabel}
          className="sr-only"
        />
      )}
    </div>
  );
}
