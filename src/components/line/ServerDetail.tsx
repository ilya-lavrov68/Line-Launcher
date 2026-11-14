import { m } from "framer-motion";
import { useState } from "react";
import { ArrowLeft, FolderInput, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/line/i18n";
import { errorMessage } from "@/lib/line/api";
import { NO_SECTION, type ServerSection } from "@/lib/line/server-layout";
import type {
  GameStatus,
  InstallProgress,
  InstallReceipt,
  LineServer,
  McInstallProgress,
  PackCheckResult,
  ReleaseHistory,
} from "@/types/line";
import ReleaseHistoryDialog from "./ReleaseHistoryDialog";
import ServerActionPanel, {
  type ServerActionPhase,
  type ServerAvailability,
} from "./ServerActionPanel";
import MinecraftPanel from "./MinecraftPanel";
import StableActionLabel from "./StableActionLabel";

export interface ServerDetailProps {
  server: LineServer;
  providerName?: string;
  onReportPacks?: () => Promise<void>;
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
  onRefreshConfig?: () => Promise<void>;
  onMinecraftBusyChange?: (busy: boolean) => void;
  onMinecraftProgressChange?: (progress: McInstallProgress | null) => void;
  onMinecraftFeedbackChange?: (message: string | null) => void;
  allowBackground?: boolean;
  onBack: () => void;
  onInstall: () => void;
  onCancel: () => void;
  onLaunch: () => void;
  onStop: () => void;
  onHistory: (open: boolean) => void;
  onRollback: (receipt: InstallReceipt) => void;
  /** Player-owned sections; absent when the player has not made any yet. */
  sections?: ServerSection[];
  /** Section this server is in, or null for "no section". */
  section?: string | null;
  onSectionChange?: (section: string | null) => void;
  /** Runs the same pack check a launch runs, without launching. */
  onCheckPacks?: () => Promise<PackCheckResult>;
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
  if (status?.phase === "blocked") return "blocked";
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
    // Keep controls in normal document flow: dynamic progress below them must
    // not pull the entire dock upward as its height changes.
    <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        disabled={legacy && !props.allowBackground}
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
          {props.onSectionChange && (props.sections?.length ?? 0) > 0 && (
            /* Player-owned, so it is placed with the server's own details and
               not with the provider's — and it says so, because a control that
               moves a server in *your* list should not look like a provider
               setting. */
            <div className="mt-1 flex items-center gap-2">
              <FolderInput
                className="text-muted-foreground/70 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <Select
                disabled={actionsBusy}
                value={props.section ?? NO_SECTION}
                onValueChange={(value) =>
                  props.onSectionChange?.(
                    value === NO_SECTION ? null : (value as string),
                  )
                }
              >
                <SelectTrigger
                  aria-label={t("sections.move")}
                  className="h-7 w-auto min-w-40 cursor-pointer text-xs"
                >
                  {/* The trigger must show the section's name, not its id:
                      `fav` in the closed control was a real bug the first
                      render caught, not a cosmetic one. */}
                  <SelectValue>
                    {(value: string | null) => {
                      if (!value || value === NO_SECTION) {
                        return t("sections.none");
                      }
                      return (
                        props.sections?.find((section) => section.id === value)
                          ?.name ?? t("sections.none")
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SECTION}>
                    {t("sections.none")}
                  </SelectItem>
                  {props.sections?.map((section) => (
                    <SelectItem key={section.id} value={section.id}>
                      {section.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground/60 text-[11px]">
                {t("sections.moveHint")}
              </span>
            </div>
          )}
        </div>
      </header>

      <m.div
        key={server.id}
        className="w-full"
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
            onRefreshConfig={props.onRefreshConfig}
            onBusyChange={props.onMinecraftBusyChange}
            onProgressChange={props.onMinecraftProgressChange}
            onFeedbackChange={props.onMinecraftFeedbackChange}
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

      {/* The check the launch runs, offered before the launch. Two reasons it is
          a button and not automatic: hashing a large folder on every visit is
          wasted work, and a player who just installed a pack wants to know now,
          not by being refused at the dock. */}
      {hasSession && (
        <PackCheckPanel
          onCheck={props.onCheckPacks}
          onReport={props.onReportPacks}
          blocked={
            phase === "blocked" ? (props.launchError ?? undefined) : undefined
          }
          disabled={actionsBusy}
        />
      )}

      {/* A source-backed build is not "a ZIP you have not downloaded yet", and
          the dock's «Скачать» wording would be misleading: there is no archive
          to fetch, the launcher fetches the files. One line, with the reason it
          is different, and only for the two source kinds. */}
      {server.source && (
        <p
          className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-[12px] leading-relaxed"
          data-testid="source-line"
        >
          <span className="text-foreground/80 font-medium">
            {server.source.kind === "packwiz"
              ? t("source.packwiz")
              : t("source.modrinth")}
          </span>
          {server.source.version && (
            <span className="font-mono text-[11px]">
              {t("source.version", { version: server.source.version })}
            </span>
          )}
          <span className="basis-full">{t("source.hint")}</span>
        </p>
      )}
    </section>
  );
}

export interface PackCheckPanelProps {
  onCheck?: () => Promise<PackCheckResult>;
  onReport?: () => Promise<void>;
  /** Set when a launch was already refused, so the reason survives a reload. */
  blocked?: string;
  disabled?: boolean;
}

/**
 * «Проверить сборку» and the explanation of a blocked launch.
 *
 * The panel never deletes anything and never offers a "launch anyway" button.
 * Deletion is the player's, done in the folder — the launcher tells them which
 * file and why, which is the part they cannot work out alone.
 */
export function PackCheckPanel({
  onCheck,
  onReport,
  blocked,
  disabled = false,
}: PackCheckPanelProps) {
  const t = useT();
  const [state, setState] = useState<"idle" | "running">("idle");
  const [result, setResult] = useState<PackCheckResult | null>(null);
  const [error, setError] = useState<string>();

  async function run() {
    if (!onCheck || state === "running") return;
    setState("running");
    setError(undefined);
    setResult(null);
    try {
      setResult(await onCheck());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setState("idle");
    }
  }

  const suspicious = (result?.findings.length ?? 0) > 0;

  return (
    <div className="bg-fill-subtle flex flex-col gap-2 rounded-[var(--radius-item)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || state === "running" || !onCheck}
          onClick={() => void run()}
          className="cursor-pointer text-xs"
        >
          {suspicious || blocked ? (
            <ShieldX
              className="h-4 w-4 shrink-0 text-amber-400"
              aria-hidden="true"
            />
          ) : (
            <ShieldCheck
              className="text-line-online h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <StableActionLabel
            busy={state === "running"}
            idle={t("packs.check")}
            active={t("packs.checking")}
          />
        </Button>
        {result && !suspicious && (
          <span
            role="status"
            data-testid="pack-check-result"
            className="text-muted-foreground text-[11px]"
          >
            {t("packs.clean")}
            {result.foreign.length > 0
              ? ` ${t("packs.foreign", { count: result.foreign.length })}`
              : ""}
          </span>
        )}
      </div>

      {(blocked || suspicious) && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-[var(--radius-control)] bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-300"
        >
          <span className="font-medium">
            {blocked ? t("packs.blocked") : t("packs.found", { list: "" })}
          </span>
          {blocked && <span>{blocked}</span>}
          {suspicious && (
            <span className="font-mono text-[11px] break-all">
              {t("packs.found", {
                list: (result?.findings ?? []).slice(0, 5).join("; "),
              })}
            </span>
          )}
          <span>{t("packs.blockedHint")}</span>
          {onReport && (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={disabled || state === "running"}
              onClick={() => {
                void onReport().catch((cause: unknown) =>
                  setError(errorMessage(cause)),
                );
              }}
            >
              {t("packs.reportProvider")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive text-[11px]">
          {error}
        </p>
      )}
    </div>
  );
}
