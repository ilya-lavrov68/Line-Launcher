import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import {
  CloudDownload,
  History,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GameStatus, InstallProgress, LineServer } from "@/types/line";

/**
 * Server status as the launcher understands it today.
 *
 * There is deliberately no "online/offline player count": the provider config
 * does not publish a status endpoint and the launcher will not ping a game
 * server from the webview. The two honest states are "ready to play" and
 * "provider has not enabled launching", plus the live game phase.
 */
export type ServerAvailability = "ready" | "unconfigured";

export type ServerActionPhase =
  | "needs-install"
  | "needs-update"
  | "installing"
  | "installed"
  | "starting"
  | "running"
  | "exited"
  | "failed";

export interface ServerActionPanelProps {
  server: LineServer;
  /** Install receipt sha256 vs the published one — the caller decides. */
  phase: ServerActionPhase;
  availability?: ServerAvailability;
  progress?: InstallProgress | null;
  status?: GameStatus | null;
  error?: string | null;
  disabled?: boolean;
  onPrimary: () => void;
  onCancel?: () => void;
  onHistory?: () => void;
}

const STATUS_LABEL: Record<ServerActionPhase, string> = {
  "needs-install": "Сборка не скачана",
  "needs-update": "Доступно обновление",
  installing: "Загрузка сборки",
  installed: "Готов к запуску",
  starting: "Запуск",
  running: "Игра запущена",
  exited: "Игра завершилась",
  failed: "Не удалось запустить",
};

const PRIMARY_LABEL: Record<ServerActionPhase, string> = {
  "needs-install": "Установить сборку",
  "needs-update": "Обновить сборку",
  installing: "Отменить загрузку",
  installed: "Играть",
  starting: "Отменить запуск",
  running: "Остановить игру",
  exited: "Играть",
  failed: "Повторить попытку",
};

const INSTALL_PHASE_LABEL: Record<InstallProgress["phase"], string> = {
  downloading: "Скачивание",
  verifying: "Проверка архива",
  extracting: "Распаковка",
  committing: "Применение",
  completed: "Готово",
  cancelled: "Отменено",
  failed: "Ошибка",
};

function percentOf(progress?: InstallProgress | null): number | null {
  if (!progress) return null;
  if (!Number.isFinite(progress.percent)) return null;
  return Math.min(100, Math.max(0, Math.round(progress.percent)));
}

/**
 * The launcher's answer to tryliner's "now playing" bar: one dock that owns
 * *the* action for the selected server. Where a player puts transport controls
 * and artwork, the launcher puts the name, the honest status, the build
 * progress and one large button.
 *
 * Motion follows tryliner's rules — one easing curve, 0.12–0.22s, springs only
 * for things that land — and everything collapses under
 * `prefers-reduced-motion`.
 */
export default function ServerActionPanel({
  server,
  phase,
  availability = "ready",
  progress,
  status,
  error,
  disabled = false,
  onPrimary,
  onCancel,
  onHistory,
}: ServerActionPanelProps) {
  const reducedMotion = useReducedMotion();
  const percent = percentOf(progress);
  const installing = phase === "installing";
  const active = phase === "running" || phase === "starting";
  const unavailable = availability !== "ready";

  const statusText = useMemo(() => {
    // While an install runs, the caption under the bar already reads
    // «Скачивание … 45%». Repeating the same two facts in the status row above
    // it was the third copy of one number on a single screen.
    if (installing && progress) return "Загрузка сборки";
    if (phase === "starting" && status?.message) return status.message;
    if (phase === "exited" && typeof status?.exitCode === "number") {
      return `${STATUS_LABEL.exited} · код ${status.exitCode}`;
    }
    return STATUS_LABEL[phase];
  }, [installing, phase, progress, status]);

  const canPress = !unavailable && (!disabled || installing || active);

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
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* Still the region's accessible name, no longer a second visible
              copy of the heading directly above it. */}
          <h2 id="server-action-title" className="sr-only">
            {server.name}
          </h2>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span
              className={cn(
                "inline-flex items-center gap-1",
                phase === "failed" && "text-destructive",
                active && "text-primary",
              )}
            >
              {unavailable ? (
                <WifiOff className="size-3" aria-hidden="true" />
              ) : (
                <Wifi className="size-3" aria-hidden="true" />
              )}
              {/* role=status so a screen reader hears the build progress too. */}
              <span role="status">
                {unavailable ? "Запуск не настроен" : statusText}
              </span>
            </span>
            {server.minecraft_version && (
              <span className="font-mono text-[12px] opacity-80">
                MC {server.minecraft_version}
              </span>
            )}
          </div>
        </div>

        {onHistory && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onHistory}
            disabled={disabled || active}
            title="История сборок"
            aria-label="История сборок"
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <History className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {installing && (
          <m.div
            key="progress"
            initial={reducedMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reducedMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{
              duration: reducedMotion ? 0 : 0.18,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                aria-label="Загрузка сборки"
                className="bg-fill relative h-2 w-full overflow-hidden rounded-full"
              >
                {/* Determinate while the installer reports a percentage,
                    indeterminate (a quiet sweep) when it only knows bytes. */}
                {percent === null ? (
                  <m.div
                    className="bg-primary/60 absolute inset-y-0 w-1/3 rounded-full"
                    animate={
                      reducedMotion ? undefined : { x: ["-40%", "260%"] }
                    }
                    transition={{
                      duration: 1.4,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  />
                ) : (
                  <m.div
                    className="bg-primary absolute inset-y-0 left-0 rounded-full"
                    initial={false}
                    animate={{ width: `${percent}%` }}
                    transition={{
                      duration: reducedMotion ? 0 : 0.2,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  />
                )}
              </div>
              <div className="text-muted-foreground flex items-center justify-between font-mono text-[12px]">
                <span>{INSTALL_PHASE_LABEL[progress!.phase]}</span>
                <span>{percent === null ? "…" : `${percent}%`}</span>
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2">
        <m.div
          className="min-w-0 flex-1"
          whileHover={
            reducedMotion || canPress === false ? undefined : { scale: 1.004 }
          }
          whileTap={
            reducedMotion || canPress === false ? undefined : { scale: 0.994 }
          }
          transition={{ type: "spring", stiffness: 320, damping: 22 }}
        >
          <Button
            size="lg"
            disabled={!canPress}
            aria-disabled={!canPress}
            onClick={installing && onCancel ? onCancel : onPrimary}
            className={cn(
              "h-11 w-full gap-2 rounded-[var(--radius-item)] text-sm font-semibold",
              active
                ? "bg-fill-strong text-foreground hover:bg-fill-strong/80"
                : // No glow: a coloured halo around the button was the only
                  // ornament on the screen, and it read as a light source that
                  // does not exist. The fill itself is enough.
                  "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {installing ? (
              <CloudDownload className="size-4" aria-hidden="true" />
            ) : phase === "starting" ? (
              <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
            ) : phase === "running" ? (
              <Square className="size-4 fill-current" aria-hidden="true" />
            ) : (
              <Play className="size-4 fill-current" aria-hidden="true" />
            )}
            <span>{PRIMARY_LABEL[phase]}</span>
          </Button>
        </m.div>
      </div>

      <div className="text-muted-foreground flex items-center gap-1.5 text-[12px]">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {server.launch_mode === "offline"
            ? "Офлайн-сборка: ник аккаунта проекта."
            : "Вход через аккаунт проекта."}
        </span>
      </div>

      <AnimatePresence initial={false}>
        {error && (
          <m.p
            key="error"
            role="alert"
            initial={reducedMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0 }}
            className="text-destructive bg-destructive/10 rounded-[var(--radius-control)] p-2 text-[12px] leading-relaxed"
          >
            {error}
          </m.p>
        )}
      </AnimatePresence>
    </m.section>
  );
}
