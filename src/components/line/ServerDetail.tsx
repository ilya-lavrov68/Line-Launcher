import { m } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/line/i18n";
import type {
  GameStatus,
  InstallProgress,
  InstallReceipt,
  LineServer,
  ReleaseHistory,
} from "@/types/line";
import ReleaseHistoryDialog from "./ReleaseHistoryDialog";
import ServerActionPanel, {
  type ServerActionPhase,
  type ServerAvailability,
} from "./ServerActionPanel";
import MinecraftPanel from "./MinecraftPanel";

export interface ServerDetailProps {
  server: LineServer;
  providerName?: string;
  hasSession: boolean;
  receipt: InstallReceipt | null;
  progress: InstallProgress | null;
  status: GameStatus | null;
  installing: boolean;
  launching: boolean;
  actionsBusy: boolean;
  installError?: string;
  launchError?: string;
  historyOpen: boolean;
  history: ReleaseHistory | null;
  historyLoading: boolean;
  historyError?: string;
  /** Honest availability: the provider either enabled launching or it did not. */
  availability: ServerAvailability;
  /** Project account nickname: the offline identity of the Minecraft mode. */
  username?: string;
  /** The shell sent the player back to the single sign-in screen. */
  onAuthRequired?: () => void;
  onBack: () => void;
  onInstall: () => void;
  onCancel: () => void;
  onLaunch: () => void;
  onStop: () => void;
  onHistory: (open: boolean) => void;
  onRollback: (receipt: InstallReceipt) => void;
}

/**
 * Which single action the dock offers. The launcher does not merge install and
 * launch into one button yet: they have separate cancel and rollback semantics,
 * so the panel fronts the next step in order instead of guessing.
 */
export function phaseOf(
  server: LineServer,
  receipt: InstallReceipt | null,
  progress: InstallProgress | null,
  status: GameStatus | null,
): ServerActionPhase {
  if (
    progress &&
    progress.phase !== "completed" &&
    progress.phase !== "cancelled"
  ) {
    return progress.phase === "failed" ? "failed" : "installing";
  }
  if (status?.phase === "starting") return "starting";
  if (status?.phase === "running") return "running";
  if (status?.phase === "failed") return "failed";
  if (!receipt) return "needs-install";
  // Compared only against a pin. A bare link carries no digest to compare, and
  // the receipt's own digest came from the bytes that were installed — treating
  // "unknown" as "different" would offer an update forever.
  if (
    server.distribution.sha256 &&
    receipt.sha256 !== server.distribution.sha256
  ) {
    return "needs-update";
  }
  if (status?.phase === "exited") return "exited";
  return "installed";
}

/**
 * One server, one decision.
 *
 * One page, one dock, one «Играть». The dock is not duplicated anywhere (not
 * under `hidden`, not in a second variant): a duplicate would give assistive
 * tech — and the smoke test — two buttons for the same action.
 */
export default function ServerDetail(props: ServerDetailProps) {
  const {
    server,
    providerName,
    hasSession,
    receipt,
    progress,
    status,
    installing,
    launching,
    actionsBusy,
    installError,
    launchError,
    availability,
    onBack,
  } = props;
  const t = useT();
  const phase = phaseOf(server, receipt, progress, status);
  const legacy = actionsBusy || installing || launching;
  // Explicit opt-in from the provider, never inferred from the presence of an
  // address: a config that has not been changed must keep the old dock.
  const isMinecraft = server.launch_mode === "minecraft";

  return (
    // The page is a column with the dock pinned to its bottom edge: the one
    // action a player came for is always reachable without scrolling, and the
    // empty space above it reads as room, not as a missing layout.
    // `flex-1` rather than `min-h-full`: a percentage height resolves against
    // the parent's *definite* height, and the shell above is a flex child, so
    // `min-h-full` silently collapsed to the content height and the dock never
    // reached the bottom edge.
    <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        disabled={legacy}
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 self-start text-xs"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span>{t("detail.allServers")}</span>
      </Button>

      {/* The page opens on the server's own artwork, full width, the way
              Liner opens on the cover of what you are about to play. Without it
              the top of the screen was a heading over an empty field. */}
      {server.banner_url && (
        <div className="bg-fill-subtle relative aspect-[16/5] w-full overflow-hidden rounded-[var(--radius-panel)]">
          <img
            src={server.banner_url}
            alt=""
            className="size-full object-cover"
            referrerPolicy="no-referrer"
          />
        </div>
      )}

      <header className="flex items-start gap-4 px-1">
        <div
          data-line-icon
          className="bg-fill flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-item)]"
        >
          {server.icon_url || server.logo_url ? (
            <img
              src={server.icon_url ?? server.logo_url}
              alt=""
              className="size-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="text-muted-foreground text-lg font-semibold">
              {server.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground font-mono text-[12px]">
            {providerName ? `${providerName} · ` : ""}v{server.version}
          </span>
          <h1 className="text-foreground text-[28px] leading-tight font-semibold tracking-tight">
            {server.name}
          </h1>
          <p className="text-muted-foreground max-w-prose text-[13px] leading-relaxed">
            {server.description}
          </p>
        </div>
      </header>

      <m.div
        key={server.id}
        // `mt-auto` is what makes the dock sit on the bottom edge instead of
        // floating in the middle of the page when the content is short.
        className="mt-auto"
        initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {isMinecraft ? (
          /* A minecraft-mode server has no provider archive, so the ZIP dock
                 would only ever say «Провайдер не настроил запуск». It is
                 replaced — not supplemented — by the mc_* panel, which is why
                 the two never appear together. */
          <MinecraftPanel
            server={server}
            username={props.username}
            disabled={actionsBusy}
            onAuthRequired={props.onAuthRequired}
          />
        ) : (
          <ServerActionPanel
            server={server}
            phase={phase}
            availability={availability}
            progress={progress}
            status={status}
            error={installError ?? launchError}
            // Every phase owns a different action, and routing them all to
            // `onLaunch` made «Остановить игру» start a second launch: the
            // dock said the game was running and the button did nothing the
            // player could see. Install/update fetch the build, a running or
            // starting game stops it, everything else launches.
            onPrimary={
              phase === "needs-install" || phase === "needs-update"
                ? props.onInstall
                : phase === "running" || phase === "starting"
                  ? props.onStop
                  : props.onLaunch
            }
            onCancel={phase === "installing" ? props.onCancel : undefined}
            onHistory={receipt ? () => props.onHistory(true) : undefined}
          />
        )}
      </m.div>

      <ReleaseHistoryDialog
        open={props.historyOpen}
        onOpenChange={props.onHistory}
        history={props.history}
        currentSha={receipt?.sha256}
        loading={props.historyLoading}
        error={props.historyError}
        onRollback={props.onRollback}
      />

      {!isMinecraft && hasSession && phase === "needs-install" && (
        <p className="text-muted-foreground px-2 text-[12px] leading-relaxed">
          {t("detail.installHint")}
        </p>
      )}

      {/* Minecraft mode replaces the ZIP dock, not the whole page: the banner,
          the status line and the history dialog above are the same controls for
          both, and the buttons that cannot work for this server (install from a
          distribution archive, rollback to a previous release) are the ones left
          out. */}
      {isMinecraft && (
        <MinecraftPanel
          server={server}
          username={props.username}
          disabled={actionsBusy}
          onAuthRequired={props.onAuthRequired}
        />
      )}
    </section>
  );
}
