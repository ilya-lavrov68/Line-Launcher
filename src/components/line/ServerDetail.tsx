import { m } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  GameStatus,
  InstallProgress,
  InstallReceipt,
  LineServer,
  ReleaseHistory,
} from "@/types/line";
import InstallProgressView from "./InstallProgress";
import LaunchControls from "./LaunchControls";
import ReleaseHistoryDialog from "./ReleaseHistoryDialog";
import ServerActionPanel, {
  type ServerActionPhase,
  type ServerAvailability,
} from "./ServerActionPanel";
import ServerBanner from "./ServerBanner";
import { useTheme } from "./ThemeProvider";

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
  if (receipt.sha256 !== server.distribution.sha256) return "needs-update";
  if (status?.phase === "exited") return "exited";
  return "installed";
}

/**
 * One server, one decision.
 *
 * The two designs are rendered as two branches rather than as one markup with
 * swapped classes: duplicating the dock into the DOM under `hidden` would give
 * assistive tech (and `getByRole`) two «Играть» buttons. Tokens still come from
 * CSS — the branch only decides structure, exactly like tryliner's own
 * `isEdgeToEdge` fullscreen/maximised split.
 */
export default function ServerDetail(props: ServerDetailProps) {
  const { theme } = useTheme();
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
  const phase = phaseOf(server, receipt, progress, status);
  const legacy = actionsBusy || installing || launching;

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
        <span>Все серверы</span>
      </Button>

      {theme === "line" && (
        <>
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

          {hasSession && phase === "needs-install" && (
            <p className="text-muted-foreground px-2 text-[12px] leading-relaxed">
              Сборка скачается целиком: архив провайдера, проверка sha256 и
              распаковка. Прогресс виден здесь же, меню не блокируется.
            </p>
          )}
        </>
      )}

      {theme === "old" && <LegacyDetail {...props} />}
    </section>
  );
}

/** The previous design, kept byte-for-byte inside its own component. */
function LegacyDetail({
  server,
  providerName,
  hasSession,
  receipt,
  progress,
  status,
  installing,
  actionsBusy,
  installError,
  launchError,
  historyOpen,
  history,
  historyLoading,
  historyError,
  onInstall,
  onCancel,
  onLaunch,
  onStop,
  onHistory,
  onRollback,
}: ServerDetailProps) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <ServerBanner
        name={server.name}
        bannerUrl={server.banner_url}
        iconUrl={server.icon_url ?? server.logo_url}
      />
      <div className="bg-card border-border/50 relative flex flex-col gap-6 overflow-hidden rounded-xl border p-6 shadow-2xl backdrop-blur-md">
        <div className="from-primary/5 pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent" />
        <div className="relative z-10 flex flex-col gap-1">
          <span className="text-muted-foreground font-mono text-[12px]">
            {providerName} / v{server.version}
          </span>
          <h2 className="text-foreground text-2xl font-bold tracking-tight">
            {server.name}
          </h2>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {server.description}
          </p>
        </div>
        {hasSession &&
          !progress &&
          (!receipt || receipt.sha256 !== server.distribution.sha256) && (
            <Button
              disabled={actionsBusy}
              onClick={onInstall}
              className="relative z-10 h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl text-sm font-semibold shadow-sm"
            >
              {installing
                ? "Подготовка установки…"
                : receipt
                  ? "Обновить сборку"
                  : "Установить сборку"}
            </Button>
          )}
        {progress && (
          <div className="relative z-10">
            <InstallProgressView
              progress={progress}
              error={installError}
              onCancel={onCancel}
              onRetry={onInstall}
            />
          </div>
        )}
        {receipt && (!progress || progress.phase === "completed") && (
          <LaunchControls
            server={server}
            receipt={receipt}
            status={status}
            busy={actionsBusy}
            error={launchError}
            historyOpen={historyOpen}
            history={history}
            historyLoading={historyLoading}
            historyError={historyError}
            onHistoryOpenChange={onHistory}
            onRollback={onRollback}
            onLaunch={onLaunch}
            onStop={onStop}
          />
        )}
        {installError && !progress && (
          <p role="alert" className="text-destructive relative z-10 text-xs">
            {installError}
          </p>
        )}
      </div>
    </div>
  );
}
