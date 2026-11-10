import { Check, Download, Gamepad2, Loader2, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage, lineApi } from "@/lib/line/api";
import type {
  GamePhase,
  LineServer,
  McGameStatus,
  McInstallProgress,
  McInstalled,
} from "@/types/line";
import { cn } from "@/lib/utils";

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
 * `mc_install` backs the "prepare without playing" path for someone who wants
 * the download done before they have time to play.
 */
export interface MinecraftPanelProps {
  server: LineServer;
  /** Nickname of the signed-in project account; the offline identity. */
  username?: string;
  /** The shell already knows whether the provider enabled launch at all. */
  disabled?: boolean;
  onAuthRequired?: () => void;
}

type Busy = "idle" | "installing" | "launching" | "stopping";

const PHASE_HINT: Record<GamePhase, string> = {
  idle: "Готов к запуску",
  starting: "Запуск Minecraft…",
  running: "Игра запущена",
  exited: "Игра завершилась",
  failed: "Запуск не удался",
};

export default function MinecraftPanel({
  server,
  username,
  disabled = false,
  onAuthRequired,
}: MinecraftPanelProps) {
  const instanceId = server.id;
  const [status, setStatus] = useState<McGameStatus | null>(null);
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const [progress, setProgress] = useState<McInstallProgress | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
          setBusy("idle");
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
        setProgress(next.finished ? null : next);
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

  async function play() {
    setBusy("launching");
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await lineApi.mcPlay({ serverId: instanceId });
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
      if (mounted.current) setBusy("idle");
    }
  }

  /** Download and verify without launching: the same path minus the last step. */
  async function prepare() {
    setBusy("installing");
    setError(undefined);
    setNotice(undefined);
    try {
      const installed: McInstalled = await lineApi.mcInstall({
        instanceId,
        minecraftVersion: server.minecraft_version ?? "",
      });
      if (!mounted.current) return;
      setNotice(
        `Профиль ${installed.versionId} подготовлен. «Играть» запустит его без загрузки.`,
      );
      await refreshProfiles();
    } catch (cause) {
      if (!mounted.current) return;
      if (toLineErrorCode(cause) === "AUTH_REQUIRED") onAuthRequired?.();
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) setBusy("idle");
    }
  }

  async function stop() {
    setBusy("stopping");
    setError(undefined);
    try {
      await lineApi.mcStop(instanceId);
      // The exited phase arrives as an event; nothing is assumed here.
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) setBusy("idle");
    }
  }

  const percent =
    progress && progress.totalBytes
      ? Math.min(
          100,
          Math.round((progress.receivedBytes / progress.totalBytes) * 100),
        )
      : null;

  return (
    <div
      data-line-glass
      className="flex flex-col gap-4 rounded-[var(--radius-panel)] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            data-line-icon
            className="bg-fill flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)]"
          >
            <Gamepad2 className="size-4" aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-foreground text-sm font-semibold">
              Minecraft
            </span>
            <span className="text-muted-foreground text-[12px]">
              {status ? PHASE_HINT[status.phase] : "Проверяем состояние…"}
              {server.minecraft_version && ` · ${server.minecraft_version}`}
            </span>
          </div>
        </div>
        {username && (
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
            {username}
          </span>
        )}
      </div>

      {/* One continuous progress line: stage label on the left, bytes on the
          right. It is a bar rather than a spinner because a first install is
          hundreds of megabytes and "it is working" is not enough information. */}
      {progress && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground truncate text-[12px]">
              {progress.label}
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
            aria-label="Загрузка Minecraft"
            className="bg-fill h-1 w-full overflow-hidden rounded-full"
          >
            <div
              className={cn(
                "bg-primary h-full rounded-full transition-[width] duration-200",
                percent === null && "w-1/3 animate-pulse",
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => void stop()}
            className="cursor-pointer gap-1.5 text-xs"
          >
            {busy === "stopping" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Square className="size-3.5" aria-hidden="true" />
            )}
            Остановить игру
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={locked}
            onClick={() => void play()}
            className="cursor-pointer gap-1.5 text-xs"
          >
            {busy === "launching" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="size-3.5" aria-hidden="true" />
            )}
            Играть
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
            Подготовить заранее
          </Button>
        )}
      </div>

      {profiles && profiles.length > 0 && (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <Check
            className="size-3 shrink-0 text-[var(--line-online)]"
            aria-hidden="true"
          />
          Установлено профилей: {profiles.length}
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

      <p className="text-muted-foreground flex items-center gap-1.5 text-[11px] leading-relaxed">
        Вход под ником аккаунта проекта. Сервер должен принимать такие входы
        (online-mode=false).
      </p>
    </div>
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
