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
  onClick,
  progress,
}: {
  children: ReactNode;
  disabled: boolean;
  active?: boolean;
  /** 0–100, or `null` when nothing is running. */
  progress?: number | null;
  indeterminate?: boolean;
  /** Accessible name for the progress value, e.g. «Скачивание сборки». */
  progressLabel?: string;
  onClick: () => void;
  progress?: { label: string; percent: number | null };
}) {
  const reducedMotion = useReducedMotion();
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
          // `--action`, not `--primary`: see `src/components/ui/button.tsx`.
          // The accent turns to ink on glass, but the launch chip keeps its
          // light fill — a dark launch button on white glass is a reversal of
          // the interface, not the same button on a lighter ground.
          active
            ? "bg-fill-strong text-foreground hover:bg-fill-strong/80"
            : "bg-action text-action-foreground hover:bg-action/85",
          // The button is disabled *because* it is working, and the base class
          // dims disabled controls to half opacity — which would fade the very
          // fill a player is watching. Keep it at full strength.
          busy && "disabled:opacity-100",
        )}
      >
        {busy && (
          // Decorative: the fill a player watches. `aria-hidden` because the
          // real progressbar sits outside the button (see above).
          <span
            aria-hidden="true"
            className={cn(
              // A wash of the label's own colour, not a second colour: the
              // button reads as filling, not as a bar laid on top of it.
              "bg-action-foreground/25 absolute inset-y-0 left-0",
              indeterminate
                ? "w-1/3"
                : "transition-[width] duration-300 ease-[var(--ease-line)]",
            )}
            style={indeterminate ? undefined : { width: `${clamped}%` }}
          />
        )}
        {indeterminate && !reducedMotion && (
          // No number to show, so the wash sweeps instead of standing still.
          // Reduced motion keeps a static third — the state stays visible, only
          // the movement is gone.
          <m.span
            aria-hidden="true"
            className="bg-action-foreground/25 absolute inset-y-0 w-1/3"
            animate={{ x: ["-100%", "300%"] }}
            transition={{
              duration: 1.4,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        )}
        <span className="flex min-w-0 items-center justify-center gap-2">{children}</span>
        {progress && <span aria-hidden="true" className="truncate text-xs font-normal opacity-75">{progress.label}{progress.percent === null ? "" : ` · ${progress.percent}%`}</span>}
      </Button>
      {progress && <span role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined} className="sr-only" />}
    </div>
  );
}
