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
import { ServerDock, ServerDockPrimary } from "./ServerDock";
import { cn } from "@/lib/utils";
import { useT, type Translator } from "@/lib/line/i18n";
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
  | "failed"
  /** Refused by the build check: the dock's action is «Повторить», not «Играть». */
  | "blocked";

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

/**
 * Captions are built from the translator rather than from module constants:
 * a `Record` at module scope would freeze the language at import time, and the
 * whole point of this interface is that switching is instant.
 */
function statusLabel(t: Translator, phase: ServerActionPhase): string {
  const labels: Record<ServerActionPhase, string> = {
    "needs-install": t("detail.buildMissing"),
    "needs-update": t("detail.updateAvailable"),
    installing: t("detail.installing"),
    installed: t("detail.readyToLaunch"),
    starting: t("detail.launching"),
    running: t("detail.running"),
    exited: t("detail.exited"),
    failed: t("detail.launchFailed"),
    blocked: t("minecraft.blocked"),
  };
  return labels[phase];
}

function primaryLabel(t: Translator, phase: ServerActionPhase): string {
  const labels: Record<ServerActionPhase, string> = {
    "needs-install": t("detail.install"),
    "needs-update": t("detail.update"),
    installing: t("detail.cancelDownload"),
    installed: t("detail.play"),
    starting: t("detail.cancelLaunch"),
    running: t("detail.stopGame"),
    exited: t("detail.play"),
    failed: t("detail.retry"),
    blocked: t("detail.retry"),
  };
  return labels[phase];
}

function installPhaseLabel(
  t: Translator,
  phase: InstallProgress["phase"],
): string {
  const labels: Record<InstallProgress["phase"], string> = {
    downloading: t("install.step.download"),
    verifying: t("install.step.verify"),
    extracting: t("install.step.extract"),
    committing: t("install.step.apply"),
    completed: t("install.step.done"),
    cancelled: t("install.step.cancelled"),
    failed: t("install.failed"),
  };
  return labels[phase];
}

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
  const t = useT();
  const percent = percentOf(progress);
  const installing = phase === "installing";
  const active = phase === "running" || phase === "starting";
  const unavailable = availability !== "ready";

  const statusText = useMemo(() => {
    // While an install runs, the row below the status names the stage and the
    // percentage; the status row stays one word, so the two do not say the same
    // thing twice on one screen.
    if (installing && progress) return t("detail.installing");
    if (phase === "starting" && status?.message) return status.message;
    if (phase === "exited" && typeof status?.exitCode === "number") {
      return `${t("detail.exited")} · ${status.exitCode}`;
    }
    return statusLabel(t, phase);
  }, [installing, phase, progress, status, t]);

  const canPress = !unavailable && (!disabled || installing || active);

  return (
    <ServerDock name={server.name}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
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
                {unavailable ? t("detail.launchUnconfigured") : statusText}
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
            title={t("detail.history")}
            aria-label={t("detail.history")}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <History className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {/* Одна кнопка на весь док. Пока идёт загрузка, её заливка и есть
          прогресс — подпись при этом остаётся действием («Отменить
          скачивание»), поэтому ничего не прыгает и второй полосы нет. */}
      <div className="flex items-center gap-2">
        <ServerDockPrimary
          disabled={!canPress}
          active={active}
          // The fill follows the real percentage of files/bytes done, from the
          // left edge. `indeterminate` is only for a stage that genuinely has
          // no denominator — and even then it does not "run": it holds a third
          // of the surface at the left, so the button still reads as filling.
          progress={installing && progress ? (percent ?? 0) : null}
          indeterminate={false}
          progressLabel={
            progress ? installPhaseLabel(t, progress.phase) : undefined
          }
          onClick={installing && onCancel ? onCancel : onPrimary}
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
          <span>{primaryLabel(t, phase)}</span>
        </ServerDockPrimary>
      </div>

      <div className="text-muted-foreground flex items-center gap-1.5 text-[12px]">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {server.launch_mode === "offline"
            ? t("detail.offlineBuild")
            : t("detail.providerAccount")}
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
    </ServerDock>
  );
}
