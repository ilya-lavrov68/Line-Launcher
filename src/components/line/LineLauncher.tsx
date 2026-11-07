import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domAnimation,
  m,
} from "framer-motion";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { brand } from "@/brand/generated";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { errorMessage, lineApi } from "@/lib/line/api";
import { isNewerGameStatus } from "@/types/line";
import type {
  AuthMode,
  AuthSessionInfo,
  ConfigSnapshot,
  InstallProgress as ProgressData,
  InstallReceipt,
  LineServer,
  GameStatus,
  ReleaseHistory,
} from "@/types/line";
import AboutDialog from "./AboutDialog";
import Attribution from "./Attribution";
import AccountScreen from "./AccountScreen";
import ConfigUrlInput from "./ConfigUrlInput";
import ConnectingScreen from "./ConnectingScreen";
import { bakedProvider } from "@/brand/provider.generated";
import { connectionMode, isAllowedCachedUrl } from "@/lib/line/provider-flow";
import InstallProgress from "./InstallProgress";
import LaunchControls from "./LaunchControls";
import ServerBanner from "./ServerBanner";
import ServerList from "./ServerList";
import SettingsScreen from "./SettingsScreen";
import SideNav, { type LineSection } from "./SideNav";
import TitleBar from "./TitleBar";
import WardrobeScreen from "./WardrobeScreen";
import { closeWindow, minimizeWindow } from "@/lib/line/window";
import { toLineError, type SettingsSnapshot } from "@/types/line";

type Screen = "config" | "account" | "servers" | "detail";

const LAUNCHER_VERSION = "0.1.0";

export default function LineLauncher() {
  const [screen, setScreen] = useState<Screen>("config");
  /**
   * One provider per build. A configured build connects to its baked address and
   * never shows an address field; only an unconfigured template under `npm run
   * dev` lets a developer type one.
   */
  const mode = connectionMode(bakedProvider, import.meta.env.DEV);
  const [section, setSection] = useState<LineSection>("servers");
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [selected, setSelected] = useState<LineServer | null>(null);
  const [session, setSession] = useState<AuthSessionInfo | null>(null);
  const [receipt, setReceipt] = useState<InstallReceipt | null>(null);
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [authError, setAuthError] = useState<string>();
  const [installError, setInstallError] = useState<string>();
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const operation = useRef<string | null>(null);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const [installing, setInstalling] = useState(false);
  const [gameStatus, setGameStatus] = useState<GameStatus | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ReleaseHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const gameActive =
    gameStatus?.phase === "starting" || gameStatus?.phase === "running";
  const actionsBusy = installing || authLoading || launching || gameActive;

  const loadConfig = useCallback(async (url: string, force = false) => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await lineApi.fetchConfig(url, force);
      if (!mounted.current || generation !== requestGeneration.current) return;
      detailGeneration.current += 1;
      setSnapshot(next);
      setSelected(null);
      setInstalledIds(new Set());
      // The account belongs to the project, so a config refresh keeps it unless
      // Rust dropped it (provider/auth change). Ask the backend, not the UI.
      const current = await lineApi.session().catch(() => null);
      if (!mounted.current || generation !== requestGeneration.current) return;
      setSession(current);
      setScreen(current ? "servers" : "account");
      const builds = await Promise.all(
        next.config.servers.map(async (server) => {
          try {
            return (await lineApi.installedBuild(server.id))?.serverId;
          } catch {
            return undefined;
          }
        }),
      );
      if (mounted.current && generation === requestGeneration.current) {
        setInstalledIds(
          new Set(builds.filter((id): id is string => Boolean(id))),
        );
      }
    } catch (cause) {
      if (mounted.current && generation === requestGeneration.current)
        setError(errorMessage(cause));
    } finally {
      if (mounted.current && generation === requestGeneration.current)
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void lineApi
      .settings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Per-run guard, not the shared `mounted` ref: StrictMode mounts, cleans up
    // and mounts again, which sets `mounted` back to true. The first run's
    // promise would then pass that check and connect a second time.
    let cancelled = false;
    lineApi
      .cachedConfig()
      .then((cached) => {
        if (cancelled) return;
        if (cached) {
          // A universal build's cache must not carry over into a locked branded
          // build: only a baked address is trusted there.
          if (!isAllowedCachedUrl(bakedProvider, cached.sourceUrl)) {
            void connectBakedDefault();
            return;
          }
          setSnapshot(cached);
          setScreen("servers");
          // Stale-while-revalidate: cached cards are visible immediately; a fresh
          // successful fetch replaces them and clears the offline/stale badge.
          void loadConfig(cached.sourceUrl);
        } else {
          void connectBakedDefault();
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, [loadConfig]);

  /** The build names exactly one provider, so startup connects straight to it. */
  async function connectBakedDefault() {
    if (mode === "auto") await loadConfig(bakedProvider.configUrl);
  }

  async function refresh() {
    if (!snapshot || actionsBusy || refreshing) return;
    setRefreshing(true);
    setError(undefined);
    try {
      const next = await lineApi.fetchConfig(snapshot.sourceUrl, true);
      if (!mounted.current) return;
      setSnapshot(next);
      // Only a provider/auth change drops the account; Rust decides that.
      const current = await lineApi.session().catch(() => null);
      if (!mounted.current) return;
      setSession(current);
      setReceipt(null);
      detailGeneration.current += 1;
      if (!current) {
        setScreen("account");
        setSelected(null);
      } else if (screen === "detail") {
        setScreen("servers");
        setSelected(null);
      }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  async function selectServer(server: LineServer) {
    if (snapshot?.stale) {
      setError("Обновите конфигурацию перед входом и установкой.");
      return;
    }
    const generation = ++detailGeneration.current;
    setSection("servers");
    setSelected(server);
    setScreen("detail");
    setReceipt(null);
    setProgress(null);
    setAuthError(undefined);
    setInstallError(undefined);
    setLaunchError(undefined);
    setGameStatus(null);
    setHistory(null);
    try {
      const [installed, status] = await Promise.all([
        lineApi.installedBuild(server.id),
        lineApi.gameStatus(server.id),
      ]);
      if (mounted.current && generation === detailGeneration.current) {
        setReceipt(installed);
        setGameStatus((previous) =>
          isNewerGameStatus(previous, status) ? status : previous,
        );
      }
    } catch (cause) {
      if (mounted.current && generation === detailGeneration.current) {
        if (authExpired(cause)) setInstallError(undefined);
        else setInstallError(errorMessage(cause));
      }
    }
  }

  /** One sign-in for the whole project: no server id is involved. */
  async function authenticate(
    mode: AuthMode,
    username: string,
    password: string,
  ) {
    if (authLoading) return;
    setAuthLoading(true);
    setAuthError(undefined);
    try {
      const next = await lineApi.authenticate(mode, { username, password });
      if (!mounted.current) return;
      setSession(next);
      setScreen("servers");
      setSection("servers");
      // A different account must not inherit the previous player's uploaded
      // skin marker; the wardrobe re-syncs itself for this account.
      void lineApi.forgetSyncedSkin().catch(() => undefined);
    } catch (cause) {
      if (mounted.current) setAuthError(errorMessage(cause));
    } finally {
      if (mounted.current) setAuthLoading(false);
    }
  }

  /**
   * The backend is the source of truth about the session: when it says the
   * account is gone (expired or invalidated), go back to the single sign-in
   * screen instead of leaving the player on a button that cannot work.
   */
  function authExpired(cause: unknown): boolean {
    if (toLineError(cause).code !== "AUTH_REQUIRED") return false;
    setSession(null);
    setSelected(null);
    setScreen("account");
    setSection("servers");
    setAuthError("Сессия истекла. Войдите повторно.");
    void lineApi.forgetSyncedSkin().catch(() => undefined);
    return true;
  }

  async function install() {
    if (!selected || !session || operation.current || gameActive) return;
    if (session.expiresAt <= Date.now()) {
      setSession(null);
      setScreen("account");
      setAuthError("Сессия истекла. Войдите повторно.");
      return;
    }
    const id = crypto.randomUUID();
    operation.current = id;
    setInstalling(true);
    setInstallError(undefined);
    setProgress(null);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await lineApi.onProgress(id, (next) => {
        if (mounted.current) setProgress(next);
      });
      const result = await lineApi.install(selected.id, id);
      if (!mounted.current) return;
      setReceipt(result);
      setInstalledIds((previous) => new Set(previous).add(result.serverId));
      setProgress(
        (previous) =>
          previous ?? {
            operationId: id,
            serverId: selected.id,
            phase: "completed",
            percent: 100,
            receivedBytes: selected.distribution.size_bytes,
            totalBytes: selected.distribution.size_bytes,
            extractedBytes: selected.distribution.unpacked_size_bytes,
            unpackedBytes: selected.distribution.unpacked_size_bytes,
          },
      );
    } catch (cause) {
      if (!mounted.current) return;
      const message = errorMessage(cause);
      setInstallError(message);
      setProgress((previous) =>
        previous
          ? { ...previous, phase: "failed" }
          : {
              operationId: id,
              serverId: selected.id,
              phase: "failed",
              percent: 0,
              receivedBytes: 0,
              totalBytes: selected.distribution.size_bytes,
              extractedBytes: 0,
              unpackedBytes: selected.distribution.unpacked_size_bytes,
            },
      );
    } finally {
      unlisten?.();
      operation.current = null;
      if (mounted.current) setInstalling(false);
    }
  }

  async function cancel() {
    if (!operation.current) return;
    try {
      await lineApi.cancel(operation.current);
    } catch (cause) {
      if (mounted.current) setInstallError(errorMessage(cause));
    }
  }

  /** Signing out is account-wide: it closes access to every server at once. */
  async function logout() {
    if (actionsBusy) return;
    try {
      await lineApi.logout();
      setSession(null);
      setAuthError(undefined);
      setSelected(null);
      setScreen("account");
      setSection("servers");
      void lineApi.forgetSyncedSkin().catch(() => undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    if (!selected || screen !== "detail") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    lineApi
      .onGame(selected.id, (status) => {
        if (mounted.current && !cancelled)
          setGameStatus((previous) =>
            isNewerGameStatus(previous, status) ? status : previous,
          );
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [selected, screen]);

  async function launch() {
    if (!selected || !session || actionsBusy) return;
    const generation = detailGeneration.current;
    setLaunching(true);
    setLaunchError(undefined);
    try {
      const status = await lineApi.launch(selected.id);
      if (mounted.current && generation === detailGeneration.current)
        setGameStatus((previous) =>
          isNewerGameStatus(previous, status) ? status : previous,
        );
      if (
        mounted.current &&
        generation === detailGeneration.current &&
        (status.phase === "starting" || status.phase === "running")
      ) {
        const behaviour = settings?.settings.afterLaunch ?? "keep";
        if (behaviour === "minimize") void minimizeWindow();
        else if (behaviour === "close") void closeWindow();
      }
    } catch (cause) {
      if (mounted.current && generation === detailGeneration.current) {
        if (authExpired(cause)) setLaunchError(undefined);
        else setLaunchError(errorMessage(cause));
      }
    } finally {
      if (mounted.current && generation === detailGeneration.current)
        setLaunching(false);
    }
  }

  async function stopGame() {
    if (!selected || !gameActive) return;
    try {
      await lineApi.stopGame(selected.id);
    } catch (cause) {
      setLaunchError(errorMessage(cause));
    }
  }

  async function openHistory(open: boolean) {
    setHistoryOpen(open);
    if (!open || !selected || actionsBusy) return;
    const generation = detailGeneration.current;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const next = await lineApi.history(selected.id);
      if (mounted.current && generation === detailGeneration.current)
        setHistory(next);
    } catch (cause) {
      if (mounted.current && generation === detailGeneration.current)
        setHistoryError(errorMessage(cause));
    } finally {
      if (mounted.current && generation === detailGeneration.current)
        setHistoryLoading(false);
    }
  }

  async function rollback(target: InstallReceipt) {
    if (!selected || actionsBusy || historyLoading) return;
    const generation = detailGeneration.current;
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const result = await lineApi.rollback(selected.id, target.sha256);
      if (!mounted.current || generation !== detailGeneration.current) return;
      setReceipt(result.receipt);
      setHistory(await lineApi.history(selected.id));
      setHistoryOpen(false);
    } catch (cause) {
      if (mounted.current && generation === detailGeneration.current)
        setHistoryError(errorMessage(cause));
    } finally {
      if (mounted.current && generation === detailGeneration.current)
        setHistoryLoading(false);
    }
  }

  /**
   * Local-first: history works signed out. The automatic upload needs the
   * project account and the project's wardrobe endpoints — not a selected server.
   */
  const canSyncSkin = Boolean(session && snapshot?.config.provider.wardrobe);

  const titleContext =
    section === "settings"
      ? "Настройки"
      : section === "wardrobe"
        ? "Гардероб"
        : screen === "detail" && selected
          ? selected.name
          : (snapshot?.config.provider.name ?? "Подключение");

  function navigate(next: LineSection) {
    setSection(next);
    setError(undefined);
  }

  async function toggleSidebar() {
    if (!settings) return;
    const next = {
      ...settings.settings,
      sidebarCollapsed: !settings.settings.sidebarCollapsed,
    };
    // Optimistic: collapsing must feel instant. A failed write reverts it.
    setSettings({ ...settings, settings: next });
    try {
      setSettings(await lineApi.saveSettings(next));
    } catch {
      setSettings(settings);
    }
  }

  /**
   * There is no other provider to switch to. This signs out and reconnects to the
   * same baked address, which is what a player actually wants after an outage.
   */
  function reconnect() {
    if (actionsBusy || loading) return;
    void lineApi.logout().catch(() => undefined);
    detailGeneration.current += 1;
    setScreen("config");
    setSection("servers");
    setSelected(null);
    setSession(null);
    setError(undefined);
    if (mode === "auto") void loadConfig(bakedProvider.configUrl, true);
  }

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <div className="bg-background text-foreground flex h-dvh min-h-0 w-full flex-col overflow-hidden font-sans">
            <TitleBar context={titleContext} />
            <div className="flex min-h-0 w-full flex-1 overflow-hidden">
              <SideNav
                section={section}
                collapsed={settings?.settings.sidebarCollapsed ?? false}
                providerName={snapshot?.config.provider.name}
                username={session?.username}
                onLogout={() => void logout()}
                actionsDisabled={actionsBusy || loading}
                onNavigate={navigate}
                onToggleCollapsed={() => void toggleSidebar()}
                onChangeProvider={reconnect}
                onAbout={() => setAboutOpen(true)}
              />
              <main className="relative z-10 min-h-0 flex-1 overflow-y-auto p-6">
                <div className="mx-auto max-w-5xl">
                  {error && !(section === "servers" && screen === "config") && (
                    <p
                      role="alert"
                      className="text-destructive border-destructive/20 bg-destructive/5 mb-5 rounded-lg border p-3 text-xs"
                    >
                      {error}
                    </p>
                  )}
                  <AnimatePresence mode="wait" initial={false}>
                    <m.div
                      key={
                        section === "servers"
                          ? screen === "detail"
                            ? `detail-${selected?.id}`
                            : screen
                          : section
                      }
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.18 }}
                    >
                      {section === "settings" && settings && (
                        <SettingsScreen
                          snapshot={settings}
                          onChange={setSettings}
                          disabled={actionsBusy}
                        />
                      )}
                      {section === "wardrobe" && (
                        <WardrobeScreen
                          username={session?.username}
                          canSync={canSyncSkin}
                          accountKey={session?.username ?? "signed-out"}
                          onAuthRequired={() => {
                            setSession(null);
                            setSelected(null);
                            setScreen("account");
                            setSection("servers");
                            setAuthError("Сессия истекла. Войдите повторно.");
                          }}
                          disabled={actionsBusy}
                        />
                      )}
                      {section === "servers" && screen === "config" && (
                        <div className="flex min-h-full items-center justify-center py-4">
                          {mode === "dev-url" ? (
                            <ConfigUrlInput
                              initialUrl={snapshot?.sourceUrl}
                              loading={loading}
                              error={error}
                              onSubmit={(url) => void loadConfig(url)}
                            />
                          ) : (
                            <ConnectingScreen
                              loading={loading}
                              error={error}
                              unconfigured={mode === "unconfigured"}
                              onRetry={() =>
                                void loadConfig(bakedProvider.configUrl, true)
                              }
                            />
                          )}
                        </div>
                      )}
                      {section === "servers" &&
                        screen === "account" &&
                        snapshot && (
                          <div className="flex min-h-full items-center justify-center py-4">
                            <AccountScreen
                              providerName={snapshot.config.provider.name}
                              serverCount={snapshot.config.servers.length}
                              registrationAvailable={Boolean(
                                snapshot.config.provider.auth.register_url,
                              )}
                              loading={authLoading}
                              error={authError}
                              onSubmit={(mode, username, password) =>
                                void authenticate(mode, username, password)
                              }
                            />
                          </div>
                        )}
                      {section === "servers" &&
                        screen === "servers" &&
                        snapshot && (
                          <ServerList
                            providerName={snapshot.config.provider.name}
                            servers={snapshot.config.servers}
                            installedIds={installedIds}
                            stale={snapshot.stale}
                            refreshing={refreshing}
                            actionsDisabled={actionsBusy}
                            onSelect={(server) => void selectServer(server)}
                            onRefresh={() => void refresh()}
                          />
                        )}
                      {section === "servers" &&
                        screen === "detail" &&
                        selected && (
                          <section className="mx-auto flex max-w-xl flex-col gap-4">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={actionsBusy}
                              onClick={() => {
                                detailGeneration.current += 1;
                                setScreen("servers");
                                setSelected(null);
                              }}
                              className="flex cursor-pointer items-center gap-1.5 self-start text-xs"
                            >
                              <ArrowLeft
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              <span>Все серверы</span>
                            </Button>
                            <ServerBanner
                              name={selected.name}
                              bannerUrl={selected.banner_url}
                              iconUrl={selected.icon_url ?? selected.logo_url}
                            />
                            <div className="bg-card border-border/50 relative flex flex-col gap-6 overflow-hidden rounded-xl border p-6 shadow-2xl backdrop-blur-md">
                              <div className="from-primary/5 pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent" />
                              <div className="relative z-10 flex flex-col gap-1">
                                <span className="text-muted-foreground font-mono text-[10px]">
                                  {snapshot?.config.provider.name} / v
                                  {selected.version}
                                </span>
                                <h2 className="text-foreground text-2xl font-bold tracking-tight">
                                  {selected.name}
                                </h2>
                                <p className="text-muted-foreground text-xs leading-relaxed">
                                  {selected.description}
                                </p>
                              </div>
                              {session &&
                                !progress &&
                                (!receipt ||
                                  receipt.sha256 !==
                                    selected.distribution.sha256) && (
                                  <Button
                                    disabled={actionsBusy}
                                    onClick={() => void install()}
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
                                  <InstallProgress
                                    progress={progress}
                                    error={installError}
                                    onCancel={() => void cancel()}
                                    onRetry={() => void install()}
                                  />
                                </div>
                              )}
                              {receipt &&
                                (!progress ||
                                  progress.phase === "completed") && (
                                  <LaunchControls
                                    server={selected}
                                    receipt={receipt}
                                    status={gameStatus}
                                    busy={actionsBusy}
                                    error={launchError}
                                    historyOpen={historyOpen}
                                    history={history}
                                    historyLoading={historyLoading}
                                    historyError={historyError}
                                    onHistoryOpenChange={(open) =>
                                      void openHistory(open)
                                    }
                                    onRollback={(target) =>
                                      void rollback(target)
                                    }
                                    onLaunch={() => void launch()}
                                    onStop={() => void stopGame()}
                                  />
                                )}
                              {installError && !progress && (
                                <p
                                  role="alert"
                                  className="text-destructive relative z-10 text-xs"
                                >
                                  {installError}
                                </p>
                              )}
                            </div>
                          </section>
                        )}
                    </m.div>
                  </AnimatePresence>
                </div>
              </main>
            </div>
            <AboutDialog
              version={LAUNCHER_VERSION}
              open={aboutOpen}
              onOpenChange={setAboutOpen}
            />
            <footer className="border-border/50 text-muted-foreground flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-[10px]">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>
                  {brand.shortName} | {LAUNCHER_VERSION}
                </span>
                {brand.attribution.placement === "footer" && <Attribution />}
              </span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                Только авторизация провайдера
              </span>
            </footer>
          </div>
        </TooltipProvider>
      </MotionConfig>
    </LazyMotion>
  );
}
