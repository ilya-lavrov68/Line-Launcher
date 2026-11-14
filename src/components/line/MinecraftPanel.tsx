import {
  Check,
  Download,
  Gamepad2,
  Loader2,
  Play,
  ShieldCheck,
  Square,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ServerDock, ServerDockPrimary } from "./ServerDock";
import { errorMessage, lineApi } from "@/lib/line/api";
import type {
  GamePhase,
  LineServer,
  McGameStatus,
  McInstallProgress,
} from "@/types/line";
import { cn } from "@/lib/utils";
import { useT, type Translator } from "@/lib/line/i18n";

/**
 * The Minecraft-mode dock for one server.
 *
 * Why this exists: the `mc_*` commands were implemented, registered and tested
 * but no component called them, so the mode was dead weight in the binary. The
 * UI is deliberately *conditional* rather than a new section of its own —
 * it renders only for a server whose provider wrote `launch_mode: "minecraft"`,
 * and those servers have no provider ZIP, so the two docks can never both be
 * on screen. A provider that does not opt in sees exactly the launcher it had
 * before this component existed.
 *
 * The whole flow is one button on purpose. `mc_play` already does resolve →
 * download-or-verify → sync → fill gaps → launch + auto-join; exposing those
 * steps separately would let a player launch a half-synced pack. The four
 * commands that *do* need a separate surface are reached from here:
 * `mc_list_installed` fills the "installed profiles" line, `mc_status` restores
 * state after a screen change, `mc_stop` is the running-game action, and
 * `mc_play` with `prepareOnly` runs the same pack preparation without launching.
 */
export interface MinecraftPanelProps {
  server: LineServer;
  /** Nickname of the signed-in project account; the offline identity. */
  username?: string;
  /** The shell already knows whether the provider enabled launch at all. */
  disabled?: boolean;
  onAuthRequired?: () => void;
  onRefreshConfig?: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onProgressChange?: (progress: McInstallProgress | null) => void;
  onFeedbackChange?: (message: string | null) => void;
}

type Busy = "idle" | "installing" | "launching" | "stopping";

function phaseHint(t: Translator, phase: GamePhase): string {
  const hints: Record<GamePhase, string> = {
    idle: t("minecraft.ready"),
    starting: t("minecraft.starting"),
    running: t("minecraft.running"),
    exited: t("minecraft.exited"),
    failed: t("minecraft.failed"),
    blocked: t("minecraft.blocked"),
  };
  return hints[phase];
}

export default function MinecraftPanel({
  server,
  username,
  disabled = false,
  onAuthRequired,
  onRefreshConfig,
  onBusyChange,
  onProgressChange,
  onFeedbackChange,
}: MinecraftPanelProps) {
  const t = useT();
  const instanceId = server.id;
  const [status, setStatus] = useState<McGameStatus | null>(null);
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<McInstallProgress | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const operationActive = useRef(false);

  function updateBusy(next: Busy) {
    operationActive.current = next !== "idle";
    onBusyChange?.(operationActive.current);
    setBusy(next);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    onProgressChange?.(progress);
  }, [progress, onProgressChange]);
  useEffect(() => {
    onFeedbackChange?.(error ?? notice ?? null);
  }, [error, notice, onFeedbackChange]);

  const refreshProfiles = useCallback(async () => {
    try {
      const found = await lineApi.mcListInstalled(instanceId);
      if (mounted.current) setProfiles(found);
    } catch {
      // Reading the install list is informational; failing to read it must not
      // put an error in front of a player who can still press «Играть».
      if (mounted.current) setProfiles(null);
    }
  }, [instanceId]);

  // Restore state after a screen change: a game started before the player
  // navigated away is still running, and the dock has to say so.
  useEffect(() => {
    let cancelled = false;
    void lineApi
      .mcStatus(instanceId)
      .then((current) => {
        if (!cancelled && mounted.current) setStatus(current);
      })
      .catch(() => undefined);
    void refreshProfiles();
    return () => {
      cancelled = true;
    };
  }, [instanceId, refreshProfiles]);

  // Events are filtered by instance id in `onMcGame`/`onMcProgress`.
  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let cancelled = false;
    void lineApi
      .onMcGame(instanceId, (next) => {
        if (cancelled || !mounted.current) return;
        setStatus(next);
        if (next.phase === "running" || next.phase === "starting") {
          setProgress(null);
        }
        if (next.phase === "exited") setProgress(null);
        if (next.phase === "failed" && next.message) setError(next.message);
        if (next.phase === "exited") void refreshProfiles();
      })
      .then((fn) => (cancelled ? fn() : (unlistenStatus = fn)))
      .catch(() => undefined);
    void lineApi
      .onMcProgress(instanceId, (next) => {
        if (cancelled || !mounted.current) return;
        if (!next.finished) setProgress(next);
      })
      .then((fn) => (cancelled ? fn() : (unlistenProgress = fn)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlistenStatus?.();
      unlistenProgress?.();
    };
  }, [instanceId, refreshProfiles]);

  const running = status?.phase === "running" || status?.phase === "starting";
  const working = busy === "installing" || busy === "launching";
  const locked = disabled || working || busy === "stopping";

  async function play(testMode = false) {
    if (locked || operationActive.current) return;
    updateBusy("launching");
    setProgress({
      instanceId,
      stage: "resolve",
      label: "",
      receivedBytes: 0,
      finished: false,
    });
    setError(undefined);
    setNotice(undefined);
    try {
      await onRefreshConfig?.();
      const next = await lineApi.mcPlay({ serverId: instanceId, testMode });
      if (!mounted.current) return;
      setStatus(next);
      // A resolved promise means the process was spawned; the running phase and
      // its later exit both arrive as events.
      if (next.phase === "running") setNotice(undefined);
    } catch (cause) {
      if (!mounted.current) return;
      if (toLineErrorCode(cause) === "AUTH_REQUIRED") onAuthRequired?.();
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) {
        updateBusy("idle");
        setProgress(null);
      }
    }
  }

  /** Download and verify without launching: the same path minus the last step. */
  async function prepare() {
    if (locked || operationActive.current) return;
    updateBusy("installing");
    setProgress({
      instanceId,
      stage: "resolve",
      label: "",
      receivedBytes: 0,
      finished: false,
    });
    setError(undefined);
    setNotice(undefined);
    try {
      await onRefreshConfig?.();
      const installed = await lineApi.mcPlay({
        serverId: instanceId,
        prepareOnly: true,
      });
      if (!mounted.current) return;
      setNotice(t("mc.profilePrepared", { version: installed.versionId }));
      await refreshProfiles();
    } catch (cause) {
      if (!mounted.current) return;
      if (toLineErrorCode(cause) === "AUTH_REQUIRED") onAuthRequired?.();
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) {
        updateBusy("idle");
        setProgress(null);
      }
    }
  }

  async function stop() {
    if (locked || operationActive.current) return;
    updateBusy("stopping");
    setError(undefined);
    try {
      await lineApi.mcStop(instanceId);
      // The exited phase arrives as an event; nothing is assumed here.
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) updateBusy("idle");
    }
  }

  const percent = progress?.filesTotal
    ? Math.min(
        100,
        Math.round(((progress.filesDone ?? 0) / progress.filesTotal) * 100),
      )
    : progress?.totalBytes
      ? Math.min(
          100,
          Math.round((progress.receivedBytes / progress.totalBytes) * 100),
        )
      : null;
  const formatBytes = (bytes: number) =>
    `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const stageNames: Record<string, string> = {
    resolve: t("mc.stageResolve"),
    libraries: t("mc.stageLibraries"),
    assets: t("mc.stageAssets"),
    runtime: t("mc.stageRuntime"),
    natives: t("mc.stageNatives"),
    loader: t("mc.stageLoader"),
    verify: t("mc.stageVerify"),
    extract: t("mc.stageExtract"),
    commit: t("mc.stageCommit"),
    cached: t("mc.stageCached"),
    task: t("mc.stageTask"),
    download: t("mc.stageDownload"),
    "source-files": t("mc.stageFiles"),
    completed: t("mc.stageVerify"),
  };

  return (
    <ServerDock name={server.name}>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span
          className={cn(
            "inline-flex items-center gap-1",
            running && "text-primary",
            status?.phase === "failed" && "text-destructive",
          )}
        >
          <Wifi className="size-3" aria-hidden="true" />
          <span role="status">
            {working
              ? t("mc.busyPreparing")
              : status
                ? phaseHint(t, status.phase)
                : t("minecraft.checking")}
          </span>
        </span>
        {server.minecraft_version && (
          <span className="font-mono text-[12px] opacity-80">
            MC {server.minecraft_version}
          </span>
        )}
        {username && <span className="font-mono text-[11px]">{username}</span>}
      </div>

      <div className="flex items-center gap-2">
        <ServerDockPrimary
          disabled={locked}
          active={running}
          onClick={() => void (running ? stop() : play(false))}
        >
          {working || busy === "stopping" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : running ? (
            <Square className="size-4 fill-current" aria-hidden="true" />
          ) : (
            <Play className="size-4 fill-current" aria-hidden="true" />
          )}
          {running ? t("detail.stopGame") : t("detail.play")}
        </ServerDockPrimary>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!running && server.test_mode_enabled !== false && (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => void play(true)}
            className="cursor-pointer gap-1.5 text-xs"
          >
            <Gamepad2 className="size-3.5" aria-hidden="true" />
            {t("mc.testMode")}
          </Button>
        )}

        {/* The secondary path is only useful while nothing is running. */}
        {!running && (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => void prepare()}
            className="text-muted-foreground hover:text-foreground cursor-pointer gap-1.5 text-xs"
          >
            {busy === "installing" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-3.5" aria-hidden="true" />
            )}
            {t("mc.prepare")}
          </Button>
        )}
      </div>

      {/* One continuous progress line: stage label on the left, bytes on the
          right. It is a bar rather than a spinner because a first install is
          hundreds of megabytes and "it is working" is not enough information. */}
      {progress && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground truncate text-[12px]">
              {stageNames[progress.stage] ??
                progress.label ??
                t("minecraft.installing")}
            </span>
            {percent !== null && (
              <span className="text-muted-foreground font-mono text-[11px]">
                {percent}%
              </span>
            )}
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-label={t("minecraft.installing")}
            className="bg-fill h-2 w-full overflow-hidden rounded-full"
          >
            <div
              className={cn(
                "bg-primary h-full rounded-full transition-[width] duration-200",
                percent === null && "w-1/3 animate-pulse",
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <div
            className="text-muted-foreground flex flex-wrap justify-between gap-1 font-mono text-[11px]"
            role="status"
          >
            <span>
              {progress.filesTotal
                ? t("mc.filesProgress", {
                    done: progress.filesDone ?? 0,
                    total: progress.filesTotal,
                  })
                : progress.receivedBytes > 0
                  ? `${formatBytes(progress.receivedBytes)}${progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ""}`
                  : t("mc.stageWorking")}
            </span>
            {progress.label && !progress.filesTotal && (
              <span className="max-w-full truncate">{progress.label}</span>
            )}
          </div>
        </div>
      )}

      {server.test_mode_enabled !== false && !running && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {t("mc.testModeHint")}
        </p>
      )}

      {profiles && profiles.length > 0 && (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <Check
            className="size-3 shrink-0 text-[var(--line-online)]"
            aria-hidden="true"
          />
          {t("mc.profiles", { count: profiles.length })}
          {profiles.length <= 3 && ` · ${profiles.join(", ")}`}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="text-line-online text-[12px] leading-relaxed"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-destructive text-[12px] leading-relaxed"
        >
          {error}
        </p>
      )}

      <p className="text-muted-foreground flex items-center gap-1.5 text-[12px] leading-relaxed">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        {t("mc.onlineMode")}
      </p>
    </ServerDock>
  );
}

/** `toLineError().code` without importing the whole error module here. */
function toLineErrorCode(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
