import { Download, Gamepad2, Loader2, Play, Square, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ServerDock, ServerDockPrimary } from "./ServerDock";
import { errorMessage, lineApi } from "@/lib/line/api";
import type {
  GamePhase,
  JavaDownloadPlan,
  LineServer,
  McGameStatus,
  McInstallProgress,
  ZipRepairPlan,
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
 * and the server uses either a provider ZIP or a configured source. The two
 * docks do not render together. A provider that does not opt in sees exactly the launcher it had
 * before this component existed.
 *
 * `mc_play` does resolve → download-or-verify → sync → request consent for
 * ZIP gaps → install as needed → launch + auto-join. Preparation and optional
 * test mode use the same guarded pipeline. The related commands are:
 * `mc_status` restores state after a screen change, `mc_stop` is the
 * running-game action, and
 * `mc_play` with `prepareOnly` runs the same pack preparation without launching.
 */
export interface MinecraftPanelProps {
  server: LineServer;
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
    idle: t("minecraft.notRunning"),
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
  const [progress, setProgress] = useState<McInstallProgress | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingRepair, setPendingRepair] = useState<ZipRepairPlan | null>(
    null,
  );
  const [pendingJava, setPendingJava] = useState<{ plan: JavaDownloadPlan; zip?: ZipRepairPlan } | null>(null);
  const [pendingRepairJava, setPendingRepairJava] = useState<JavaDownloadPlan | undefined>();
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
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

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
  }, [instanceId]);

  const running = status?.phase === "running" || status?.phase === "starting";
  const working = busy === "installing" || busy === "launching";
  const locked =
    disabled || working || busy === "stopping" || pendingRepair !== null || pendingJava !== null;

  async function play(testMode = false, approved?: ZipRepairPlan, approvedJava?: JavaDownloadPlan) {
    if (
      disabled ||
      working ||
      busy === "stopping" ||
      operationActive.current ||
      (pendingRepair && !approved)
    )
      return;
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
      const next = await lineApi.mcPlay({
        serverId: instanceId,
        testMode,
        approveZipRepair: approved,
        approveJavaDownload: approvedJava,
      });
      if (!mounted.current) return;
      setStatus(next);
      // A resolved promise means the process was spawned; the running phase and
      // its later exit both arrive as events.
      if (next.phase === "running") setNotice(undefined);
    } catch (cause) {
      if (!mounted.current) return;
      const plan = getZipRepairPlan(cause);
      const javaPlan = getJavaDownloadPlan(cause);
      if (plan) { setPendingRepairJava(approvedJava); setPendingRepair(plan); }
      else if (javaPlan) setPendingJava({ plan: javaPlan, zip: approved });
      else {
        if (toLineErrorCode(cause) === "AUTH_REQUIRED") onAuthRequired?.();
        setError(errorMessage(cause));
      }
    } finally {
      if (mounted.current) {
        updateBusy("idle");
        setProgress(null);
      }
    }
  }

  /** Download and verify without launching: the same path minus the last step. */
  async function prepare(approved?: ZipRepairPlan, approvedJava?: JavaDownloadPlan) {
    if (
      disabled ||
      working ||
      busy === "stopping" ||
      operationActive.current ||
      (pendingRepair && !approved)
    )
      return;
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
      await lineApi.mcPlay({
        serverId: instanceId,
        prepareOnly: true,
        approveZipRepair: approved,
        approveJavaDownload: approvedJava,
      });
      if (!mounted.current) return;
      setNotice(t("mc.profilePrepared"));
    } catch (cause) {
      if (!mounted.current) return;
      const plan = getZipRepairPlan(cause);
      const javaPlan = getJavaDownloadPlan(cause);
      if (plan) { setPendingRepairJava(approvedJava); setPendingRepair(plan); }
      else if (javaPlan) setPendingJava({ plan: javaPlan, zip: approved });
      else {
        if (toLineErrorCode(cause) === "AUTH_REQUIRED") onAuthRequired?.();
        setError(errorMessage(cause));
      }
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
            (status?.phase === "failed" || (error && !running)) &&
              "text-destructive",
          )}
        >
          <Wifi className="size-3" aria-hidden="true" />
          <span role="status">
            {working
              ? t("mc.busyPreparing")
              : !running && error
                ? t("minecraft.failed")
                : !running && pendingRepair
                  ? t("minecraft.confirmationNeeded")
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
      </div>

      <div className="flex items-center gap-2">
        <ServerDockPrimary
          disabled={locked}
          active={running}
          onClick={() => void (running ? stop() : play(false))}
          progress={progress ? { label: stageNames[progress.stage] ?? t("mc.stageWorking"), percent } : undefined}
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

      <Dialog
        open={pendingRepair !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRepair(null);
            setNotice(t("zipRepair.declined"));
          }
        }}
      >
        <DialogContent className="p-5 sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t("zipRepair.title")}</DialogTitle>
          </DialogHeader>
          {pendingRepair && (
            <div className="text-muted-foreground space-y-3 text-xs leading-relaxed">
              <p>{t("zipRepair.explanation")}</p>
              <p>
                {t("zipRepair.version", {
                  version: pendingRepair.minecraftVersion,
                })}{" "}
                · {pendingRepair.releaseSha256.slice(0, 12)}
              </p>
              {pendingRepair.missingFromArchive.length > 0 && (
                <>
                  <p>{t("zipRepair.archiveHints")}</p>
                  <ul className="list-inside list-disc">
                    {pendingRepair.missingFromArchive.map((part) => (
                      <li key={part}>{zipPartLabel(t, part)}</li>
                    ))}
                  </ul>
                </>
              )}
              {pendingRepair.liveAssetIssues > 0 && (
                <>
                  <p>
                    {t("zipRepair.liveAssets", {
                      count: pendingRepair.liveAssetIssues,
                      size: formatBytes(pendingRepair.liveAssetBytes),
                    })}
                  </p>
                  <details>
                    <summary>{t("zipRepair.assetPreview")}</summary>
                    <ul className="mt-2 max-h-36 overflow-auto break-all">
                      {pendingRepair.liveAssetPreview.map((path) => <li key={path}>{path}</li>)}
                    </ul>
                    {pendingRepair.liveAssetIssues > pendingRepair.liveAssetPreview.length && <p>{t("zipRepair.assetPreviewLimit")}</p>}
                  </details>
                </>
              )}
              {pendingRepair.liveRuntimeIssues > 0 && (
                <>
                  <p>{t("zipRepair.liveRuntime", { count: pendingRepair.liveRuntimeIssues, size: formatBytes(pendingRepair.liveRuntimeBytes) })}</p>
                  <details>
                    <summary>{t("zipRepair.runtimeFiles")}</summary>
                    <ul className="mt-2 max-h-36 overflow-auto break-all">
                      {pendingRepair.liveRuntimeFiles.map((entry) => <li key={entry}>{entry.split("\t").slice(3).join("\t")}</li>)}
                    </ul>
                  </details>
                </>
              )}
              {pendingRepair.liveRuntimeSkipped > 0 && <p>{t("zipRepair.runtimePartial", { count: pendingRepair.liveRuntimeSkipped })}</p>}
              {pendingRepair.installLoader && <p>{t("zipRepair.loader")}</p>}
              <p>{t("zipRepair.unknownSize")}</p>
              <p>{t("zipRepair.java")}</p>
              <p>{t("zipRepair.refusal")}</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPendingRepair(null);
                setNotice(t("zipRepair.declined"));
              }}
            >
              {t("zipRepair.cancel")}
            </Button>
            <Button
              onClick={() => {
                const plan = pendingRepair;
                if (!plan) return;
                setPendingRepair(null);
                if (plan.prepareOnly) void prepare(plan, pendingRepairJava);
                else void play(plan.testMode, plan, pendingRepairJava);
                setPendingRepairJava(undefined);
              }}
            >
              {t("zipRepair.accept")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingJava !== null} onOpenChange={(open) => { if (!open) { setPendingJava(null); setNotice(t("javaConsent.declined")); } }}>
        <DialogContent className="p-5 sm:max-w-[460px]">
          <DialogHeader><DialogTitle>{t("javaConsent.title")}</DialogTitle></DialogHeader>
          {pendingJava && <div className="text-muted-foreground space-y-3 text-xs leading-relaxed">
            <p>{t("javaConsent.description", { major: pendingJava.plan.major })}</p>
            <p>{pendingJava.plan.purpose === "loader" ? t("javaConsent.loader") : t("javaConsent.launch")}</p>
            <p>{pendingJava.plan.source === "adoptium" ? t("javaConsent.adoptium") : t("javaConsent.mojang")}</p>
            <p>{t("javaConsent.details")}</p>
          </div>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setPendingJava(null); setNotice(t("javaConsent.declined")); }}>{t("zipRepair.cancel")}</Button>
            <Button onClick={() => { const pending = pendingJava; if (!pending) return; setPendingJava(null); if (pending.plan.prepareOnly) void prepare(pending.zip, pending.plan); else void play(pending.plan.testMode, pending.zip, pending.plan); }}>{t("javaConsent.accept")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <details className="text-muted-foreground text-[11px] leading-relaxed">
        <summary className="hover:text-foreground w-fit cursor-pointer">
          {t("mc.launchDetails")}
        </summary>
        <div className="mt-2 flex flex-col gap-1.5">
          {server.test_mode_enabled !== false && <p>{t("mc.testModeHint")}</p>}
          <p>{t("mc.onlineMode")}</p>
        </div>
      </details>
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

function getJavaDownloadPlan(cause: unknown): JavaDownloadPlan | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "CONFIRMATION_REQUIRED" || !("javaDownload" in cause)) return null;
  const plan = cause.javaDownload;
  if (typeof plan !== "object" || plan === null) return null;
  const value = plan as Record<string, unknown>;
  if (value.schema !== 1 || typeof value.serverId !== "string" || typeof value.instanceId !== "string" || typeof value.releaseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.releaseSha256) || typeof value.major !== "number" || !Number.isInteger(value.major) || value.major < 8 || value.major > 26 || (value.purpose !== "loader" && value.purpose !== "launch") || (value.source !== "adoptium" && value.source !== "mojang") || typeof value.prepareOnly !== "boolean" || typeof value.testMode !== "boolean") return null;
  return plan as JavaDownloadPlan;
}

function getZipRepairPlan(cause: unknown): ZipRepairPlan | null {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("code" in cause) ||
    cause.code !== "CONFIRMATION_REQUIRED" ||
    !("zipRepair" in cause)
  )
    return null;
  const plan = cause.zipRepair;
  if (typeof plan !== "object" || plan === null) return null;
  const value = plan as Record<string, unknown>;
  if (
    value.schema !== 1 ||
    typeof value.serverId !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.releaseSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.releaseSha256) ||
    typeof value.minecraftVersion !== "string" ||
    typeof value.profileId !== "string" ||
    !Array.isArray(value.missingFromArchive) ||
    !value.missingFromArchive.every((v) => typeof v === "string") ||
    !Array.isArray(value.liveRuntimeFiles) || value.liveRuntimeFiles.length > 2000 || !value.liveRuntimeFiles.every((entry) => typeof entry === "string" && entry.length <= 1200) ||
    typeof value.liveRuntimeIssues !== "number" || !Number.isSafeInteger(value.liveRuntimeIssues) || value.liveRuntimeIssues < 0 ||
    typeof value.liveRuntimeBytes !== "number" || !Number.isSafeInteger(value.liveRuntimeBytes) || value.liveRuntimeBytes < 0 ||
    typeof value.liveRuntimeSkipped !== "number" || !Number.isSafeInteger(value.liveRuntimeSkipped) || value.liveRuntimeSkipped < 0 ||
    !(value.liveAssetDigest === null || (typeof value.liveAssetDigest === "string" && /^[a-f0-9]{64}$/.test(value.liveAssetDigest))) ||
    !Array.isArray(value.liveAssetPreview) || value.liveAssetPreview.length > 32 || !value.liveAssetPreview.every((path) => typeof path === "string" && /^assets\/objects\/[a-f0-9]{2}\/[a-f0-9]{40}$/.test(path)) ||
    typeof value.liveAssetIssues !== "number" ||
    !Number.isSafeInteger(value.liveAssetIssues) ||
    value.liveAssetIssues < 0 ||
    typeof value.liveAssetBytes !== "number" ||
    !Number.isSafeInteger(value.liveAssetBytes) ||
    value.liveAssetBytes < 0 ||
    typeof value.installLoader !== "boolean" ||
    typeof value.generatedProfile !== "boolean" ||
    typeof value.prepareOnly !== "boolean" ||
    typeof value.testMode !== "boolean"
  )
    return null;
  return plan as ZipRepairPlan;
}

function zipPartLabel(t: Translator, part: string): string {
  switch (part) {
    case "client-jar":
      return t("zipRepair.client");
    case "libraries":
      return t("zipRepair.libraries");
    case "asset-index":
      return t("zipRepair.assetIndex");
    case "assets":
      return t("zipRepair.assets");
    default:
      return t("zipRepair.other");
  }
}
