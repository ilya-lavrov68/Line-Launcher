import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domAnimation,
  m,
} from "framer-motion";
import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { brand } from "@/brand/generated";
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
import ConfigUrlInput from "./ConfigUrlInput";
import ConnectingScreen from "./ConnectingScreen";
import { bakedProvider } from "@/brand/provider.generated";
import { connectionMode, isAllowedCachedUrl } from "@/lib/line/provider-flow";
import AnimatedBackdrop from "./AnimatedBackdrop";
import ProfileScreen from "./ProfileScreen";
import SignInScreen from "./SignInScreen";
import ServerDetail from "./ServerDetail";
import ServerList from "./ServerList";
import { ServerCatalogRail } from "./ServerCatalogRail";
import SettingsScreen from "./SettingsScreen";
import SideNav, { type LineSection } from "./SideNav";
import TitleBar from "./TitleBar";
import WardrobeScreen from "./WardrobeScreen";
import WelcomeScreen from "./WelcomeScreen";
import {
  closeWindow,
  hideWindow,
  minimizeWindow,
  restoreWindow,
} from "@/lib/line/window";
import { toLineError, type SettingsSnapshot } from "@/types/line";
import { initialLanguage, setLanguage, useT } from "@/lib/line/i18n";
import { displayVersion, isPrerelease } from "@/lib/line/version";
import {
  SkeletonServerGrid,
  SkeletonSettings,
} from "@/components/line/Skeleton";

type Screen = "config" | "account" | "servers" | "detail";

/**
 * Injected by Vite from `version.json` (see `define` in vite.config.ts). It is
 * checked once, when the module loads, rather than trusted: a build that lost
 * the define would otherwise render the string "undefined" in the footer and
 * «О программе» instead of failing loudly.
 */
const LAUNCHER_VERSION: string =
  typeof __LAUNCHER_VERSION__ === "string" ? __LAUNCHER_VERSION__ : "0.0.0";

export default function LineLauncher() {
  const [screen, setScreen] = useState<Screen>("config");
  /**
   * The prologue. `intro` is the drawn greeting, `ready` is everything after it.
   * The greeting is not skippable and not tied to the network: it runs once per
   * launch, for a fixed length, so the window always opens the same way.
   */
  const [introDone, setIntroDone] = useState(false);
  /**
   * One provider per build. A configured build connects to its baked address and
   * never shows an address field; only an unconfigured template under `npm run
   * dev` lets a developer type one.
   */
  const mode = connectionMode(bakedProvider, import.meta.env.DEV);
  const t = useT();
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
  // Catalogue rail: "what was I doing?" answered without opening a server.
  // It reads the catalogue's own knowledge (installed ids + the live job for
  // that id), never the detail screen's transient receipt.
  const railServer = selected;
  const railProgress =
    selected && progress?.serverId === selected.id ? progress : null;
  const railStatus = !railServer
    ? ""
    : railProgress
      ? t("servers.railDownloading")
      : installedIds.has(railServer.id)
        ? t("servers.railInstalled")
        : t("servers.railMissing");
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
      // `account` is the state that raises the sign-in gate (`gateSignIn`), so
      // a signed-out launcher has to be named that way — it is not a failure to
      // connect. What used to happen is that the account branch drew the
      // connecting screen for the frame before the gate mounted; that branch is
      // now a dev-template-only state, so the name is all the gate needs.
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
        if (cancelled) return;
        // The stored language wins; with no stored choice the system language
        // decides, and Russian is the floor. Applied before the first paint of
        // any translated screen — the intro is still running at this point.
        setLanguage(initialLanguage(value.settings.language));
        setSettings(value);
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
      setError(t("detail.refreshFirst"));
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
        // The error is shown first and withdrawn if it turns out to be a dead
        // session: `authExpired` now has to confirm the session is gone before
        // it ends it, and that is a round trip.
        setInstallError(errorMessage(cause));
        if (await authExpired(cause)) {
          if (mounted.current && generation === detailGeneration.current)
            setInstallError(undefined);
        }
      }
    }
  }

  /**
   * The backend refuses launch, install and wardrobe work against a provider
   * config older than its own `cache_ttl_seconds` — five minutes by default.
   * A launcher window is routinely open longer than that, so the first press
   * after a pause used to fail with an auth error the player could do nothing
   * about on that screen. Refresh before the action instead of reporting it.
   * A failed refresh is not fatal: the action itself then reports the real
   * reason, which is more useful than "refresh failed".
   */
  async function refreshConfigIfStale() {
    const refreshed = await lineApi.ensureFreshConfig().catch(() => null);
    if (refreshed && mounted.current) setSnapshot(refreshed);
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
      // Sign-in is the third action with the same prerequisite, and the one
      // where an expired config used to surface as a message the player could
      // not act on from that screen.
      await refreshConfigIfStale();
      if (!mounted.current) return;
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
   * account is gone, go back to the single sign-in screen instead of leaving
   * the player on a button that cannot work.
   *
   * `AUTH_REQUIRED` is a claim, not proof. Several unrelated failures used to
   * be reported with it — a stale provider config, a launch ticket that the
   * mod never asked for, a closed IPC socket — and every one of them logged
   * the player out with «Сессия истекла» while their session still had hours
   * left. Those have been given their own error codes in the backend, but a
   * false positive here is expensive enough that the session is confirmed
   * gone before it is thrown away: the token is only discarded when the
   * backend no longer holds an unexpired one.
   */
  async function authExpired(cause: unknown): Promise<boolean> {
    if (toLineError(cause).code !== "AUTH_REQUIRED") return false;
    const stillThere = await lineApi.session().catch(() => null);
    if (!mounted.current) return true;
    if (stillThere && stillThere.expiresAt > Date.now()) {
      // The provider rejected one request, but the session itself is alive.
      // Report the failure where it happened; do not end the session.
      setSession(
        (previous) =>
          previous ?? {
            username: stillThere.username,
            expiresAt: stillThere.expiresAt,
          },
      );
      return false;
    }
    endSession(t("status.authExpired"));
    return true;
  }

  /** Drop the session and land on the single sign-in screen. */
  function endSession(message: string) {
    setSession(null);
    setSelected(null);
    setScreen("account");
    setSection("servers");
    setAuthError(message);
    void lineApi.forgetSyncedSkin().catch(() => undefined);
  }

  async function install() {
    if (!selected || !session || operation.current || gameActive) return;
    if (session.expiresAt <= Date.now()) {
      setSession(null);
      setScreen("account");
      setAuthError(t("status.authExpired"));
      return;
    }
    const id = crypto.randomUUID();
    operation.current = id;
    setInstalling(true);
    setInstallError(undefined);
    setProgress(null);
    await refreshConfigIfStale();
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
      // An install can fail because the session died mid-download; it can also
      // fail for a dozen reasons that have nothing to do with the account.
      // Show the reason, and let `authExpired` decide whether the session is
      // actually gone before anything is thrown away.
      const expired = await authExpired(cause);
      if (!mounted.current) return;
      setInstallError(expired ? undefined : message);
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

  /**
   * Subscribed for the whole session, not only on the detail screen: the
   * catalogue rail has to notice that a running game exited while the player
   * was browsing another section. The handler is id-filtered by `onGame`.
   */
  useEffect(() => {
    if (!selected) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    lineApi
      .onGame(selected.id, (status) => {
        if (!mounted.current || cancelled) return;
        setGameStatus((previous) =>
          isNewerGameStatus(previous, status) ? status : previous,
        );
        // The other half of "Лаунчер при запуске": whatever the window did
        // when the game started (hidden to the tray, minimised, left alone),
        // a player who just quit the game should be looking at the launcher
        // again. Doing it here rather than in the launch promise means it also
        // fires when the game exits minutes later, or when the player closed
        // it from the game's own menu.
        if (status.phase === "exited" || status.phase === "failed")
          void restoreWindow();
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
  }, [selected]);

  async function launch() {
    if (!selected || !session || actionsBusy) return;
    const generation = detailGeneration.current;
    setLaunching(true);
    setLaunchError(undefined);
    try {
      await refreshConfigIfStale();
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
        if (behaviour === "tray") void hideWindow();
        else if (behaviour === "minimize") void minimizeWindow();
        else if (behaviour === "close") void closeWindow();
      }
    } catch (cause) {
      if (mounted.current && generation === detailGeneration.current) {
        setLaunchError(errorMessage(cause));
        if (await authExpired(cause)) {
          if (mounted.current && generation === detailGeneration.current)
            setLaunchError(undefined);
        }
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

  /**
   * A child screen reporting `AUTH_REQUIRED` asks the shell to sign the player
   * out — but only the shell can confirm that the session is actually gone.
   * The child only knows its own request failed; that is not the same thing,
   * and acting on it directly is how pressing a button on a server page could
   * log the player out over a failure that had nothing to do with their
   * account. Confirm before ending the session.
   */
  const requireAuth = () => {
    void confirmSignOut();
  };

  async function confirmSignOut() {
    const stillThere = await lineApi.session().catch(() => null);
    if (!mounted.current) return;
    if (stillThere && stillThere.expiresAt > Date.now()) {
      setSession(
        (previous) =>
          previous ?? {
            username: stillThere.username,
            expiresAt: stillThere.expiresAt,
          },
      );
      return;
    }
    endSession(t("status.authExpired"));
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
      ? t("nav.settings")
      : section === "wardrobe"
        ? t("nav.wardrobe")
        : section === "account"
          ? t("nav.account")
          : screen === "detail" && selected
            ? selected.name
            : (snapshot?.config.provider.name ?? t("window.connecting"));

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
   *
   * The dev template is the exception: it may have no baked address at all, and
   * in that case the address field is the only screen it can offer. It used to
   * offer it *always* — `screen` was reset to "config" regardless of mode, and
   * only an `auto` build then went on to connect, so in a dev run the sign-in
   * screen became unreachable after one press: the player was left staring at a
   * URL field with no way back to their account.
   */
  function reconnect() {
    if (actionsBusy || loading) return;
    void lineApi.logout().catch(() => undefined);
    detailGeneration.current += 1;
    setSelected(null);
    setSession(null);
    setError(undefined);
    setSection("servers");
    if (mode === "auto") {
      setScreen("config");
      void loadConfig(bakedProvider.configUrl, true);
      return;
    }
    // A dev run that already has a working config stays connected to it and
    // lands on the sign-in page; only one with nothing to reconnect to falls
    // back to the address field.
    if (snapshot) {
      setScreen("account");
      return;
    }
    setScreen("config");
  }

  /**
   * Signing in is a page, not a panel.
   *
   * It covers the whole window — no rail, no title bar of ours, no catalogue
   * behind it — and it is shown until the provider has accepted the account.
   * The dev-only address field keeps the shell, because it runs before there is
   * a provider to sign in to: `screen` is still `"config"` at that point, so the
   * gate simply is not reached yet.
   */
  const gateSignIn = introDone && !session && screen === "account";

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <div className="bg-background text-foreground relative flex h-dvh min-h-0 w-full flex-col overflow-hidden font-sans">
            {/* The haze is the only colour field in the design; every surface
                above it is glass. It is decoration and nothing depends on it:
                without WebGL2 or with reduced motion the window falls back to
                the flat canvas and stays exactly as legible. */}
            <AnimatedBackdrop
              imageUrl={selected?.banner_url}
              themeId={settings?.settings.backdrop ?? undefined}
            />
            {/* The gate sits on the same backdrop as the app. It is painted
                after the shell in DOM order and given its own stacking context,
                so it covers the rail and the panels rather than sitting beside
                them in the layout. */}
            <AnimatePresence mode="wait" initial={false}>
              {gateSignIn && snapshot ? (
                <m.div
                  key="signin"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="fixed inset-0 z-40"
                >
                  <SignInScreen
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
                </m.div>
              ) : null}
            </AnimatePresence>
            <AnimatePresence>
              {!introDone && (
                <WelcomeScreen
                  key="welcome"
                  onDone={() => setIntroDone(true)}
                />
              )}
            </AnimatePresence>
            {/* Floating frame: one 6px inset around the whole window, and the
                header shares it instead of being banded off by a hairline.
                Hidden, not unmounted, while the gate is up: the sign-in page is
                the whole window, and a rail sliding under it read as a modal.
                Keeping it mounted means the catalogue behind it is already
                loaded when the player signs in.

                It fades rather than being cut. `invisible` took the whole shell
                out of paint in a single frame, while the gate above it spent
                300ms fading in — so for a third of a second the window showed
                nothing but backdrop, and the brighter field left behind read as
                a flash. It was worst on the left, where the rail and the account
                card are the only large surfaces: they vanished first and left
                the widest empty strip. Both sides now run the same 300ms on the
                same curve, so the two layers cross and no bare frame is shown.

                The fade is a plain CSS transition, not motion: it still runs
                with reduced motion (where it is the only thing that hides the
                shell), and `inert` drops input and focus on the first frame,
                before the fade finishes. */}
            <div
              aria-hidden={gateSignIn || !introDone ? true : undefined}
              inert={gateSignIn || !introDone ? true : undefined}
              className={cn(
                "relative z-10 flex min-h-0 w-full flex-1 flex-col gap-1.5 overflow-hidden p-1.5",
                "transition-opacity duration-300 ease-[var(--ease-line)]",
                (gateSignIn || !introDone) && "pointer-events-none opacity-0",
              )}
            >
              <TitleBar context={titleContext} />
              <div className="flex min-h-0 w-full flex-1 gap-1.5 overflow-hidden">
                <SideNav
                  section={section}
                  collapsed={settings?.settings.sidebarCollapsed ?? true}
                  providerName={snapshot?.config.provider.name}
                  actionsDisabled={actionsBusy || loading}
                  onNavigate={navigate}
                  onToggleCollapsed={() => void toggleSidebar()}
                  onChangeProvider={reconnect}
                  onAbout={() => setAboutOpen(true)}
                />
                <main
                  data-line-glass
                  className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[var(--radius-item)] p-6"
                >
                  {/* A stretched column all the way down. Pages that pin a
                      control to the bottom edge (the server dock) need the
                      scroll box's real height; a plain block wrapper collapses
                      to its content and the dock floats upwards. */}
                  <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col">
                    {/* Signing out closes every server at once, and the
                        request that carried it can fail on the way back. That
                        failure is not something the player can act on: they are
                        already out, and the gate is coming up over this panel.
                        Reporting it put a red line on screen for the frame
                        before the gate mounted — the same flash as the retry
                        card, in a smaller box. */}
                    {error &&
                      !(section === "servers" && screen === "config") &&
                      session && (
                        <p
                          role="alert"
                          className="text-destructive bg-destructive/10 mb-5 rounded-[var(--radius-control)] p-3 text-xs"
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
                        className="flex min-h-full flex-1 flex-col"
                      >
                        {/* The snapshot arrives a moment after the shell does.
                            Until it does, the page shows its own geometry instead
                            of an empty panel — the row of sections is the shape
                            a player learns on first visit. */}
                        {section === "settings" && !settings && (
                          <SkeletonSettings />
                        )}
                        {section === "settings" && settings && (
                          <SettingsScreen
                            snapshot={settings}
                            onChange={setSettings}
                            disabled={actionsBusy}
                          />
                        )}
                        {section === "account" && session && (
                          <ProfileScreen
                            session={session}
                            providerName={
                              snapshot?.config.provider.name ??
                              t("common.project")
                            }
                            canSync={canSyncSkin}
                            onLogout={() => void logout()}
                            onOpenWardrobe={() => navigate("wardrobe")}
                            disabled={actionsBusy}
                          />
                        )}
                        {section === "account" && !session && (
                          // Signing out while this page is open must not leave a
                          // blank panel; the sign-in screen is the honest state.
                          <div className="text-muted-foreground mx-auto flex w-full max-w-3xl flex-col items-start gap-2 py-10 text-xs">
                            <p>{t("status.noSession")}</p>
                          </div>
                        )}
                        {section === "wardrobe" && (
                          <WardrobeScreen
                            username={session?.username}
                            canSync={canSyncSkin}
                            accountKey={session?.username ?? "signed-out"}
                            onAuthRequired={requireAuth}
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
                          // Not unreachable, and it used to be wrong. Signing in
                          // is a page of its own (`gateSignIn`), but this branch
                          // still paints for the frame in which a session ends:
                          // the gate is an `AnimatePresence` child and mounts a
                          // render later, so the shell is drawn once with no
                          // session first. It showed "Нет соединения" with a
                          // retry button — a full-opacity lie, measured at five
                          // frames — because a signed-out launcher was wired to
                          // the same state as a failed fetch.
                          //
                          // There is nothing to report here and nothing to
                          // retry: the gate covers the window. It stays only for
                          // a dev template with no provider at all, where it is
                          // the honest state and the gate never comes.
                          (mode === "unconfigured" ? (
                            <div className="flex min-h-full items-center justify-center py-4">
                              <ConnectingScreen
                                loading={false}
                                unconfigured
                                onRetry={() =>
                                  void loadConfig(bakedProvider.configUrl, true)
                                }
                              />
                            </div>
                          ) : null)}
                        {section === "servers" &&
                          screen === "servers" &&
                          !snapshot &&
                          loading && <SkeletonServerGrid />}
                        {section === "servers" &&
                          screen === "servers" &&
                          snapshot && (
                            <ServerList
                              rail={
                                <ServerCatalogRail
                                  server={selected}
                                  status={railStatus}
                                  progress={railProgress}
                                  busy={actionsBusy}
                                  onOpen={(server) => void selectServer(server)}
                                />
                              }
                              statusFor={(server) =>
                                installedIds.has(server.id)
                                  ? t("servers.ready")
                                  : undefined
                              }
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
                            <ServerDetail
                              server={selected}
                              providerName={snapshot?.config.provider.name}
                              hasSession={Boolean(session)}
                              receipt={receipt}
                              progress={progress}
                              status={gameStatus}
                              installing={installing}
                              launching={launching}
                              actionsBusy={actionsBusy}
                              installError={installError}
                              launchError={launchError}
                              availability={
                                selected.launch_mode === "offline" ||
                                selected.launch_mode === "minecraft" ||
                                Boolean(
                                  selected.auth?.launch_ticket_url &&
                                  selected.auth?.session_exchange_url,
                                )
                                  ? "ready"
                                  : "unconfigured"
                              }
                              onBack={() => {
                                detailGeneration.current += 1;
                                setScreen("servers");
                                setSelected(null);
                              }}
                              onInstall={() => void install()}
                              onCancel={() => void cancel()}
                              onLaunch={() => void launch()}
                              onStop={() => void stopGame()}
                              onHistory={(open) => void openHistory(open)}
                              onRollback={(target) => void rollback(target)}
                              username={session?.username}
                              onAuthRequired={requireAuth}
                              historyOpen={historyOpen}
                              history={history}
                              historyLoading={historyLoading}
                              historyError={historyError}
                            />
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
            </div>
            {/* Persistent rail: the last opened server stays one click away from
                the catalogue, the wardrobe and settings. */}
            <footer className="text-muted-foreground/70 relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 px-2 pb-1.5 text-[12px]">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>
                  {brand.shortName} | {displayVersion(LAUNCHER_VERSION)}
                </span>
                {/* A pre-1.0 build says so where a player already looks for the
                    version, so a screenshot of a bug can be matched to the
                    build it came from. */}
                {isPrerelease(LAUNCHER_VERSION) && (
                  <span
                    className="border-border/50 text-muted-foreground rounded-[4px] border px-1.5 py-px text-[10px] leading-normal uppercase"
                    title={t("about.channelPreview")}
                  >
                    {t("about.channelPreviewShort")}
                  </span>
                )}
                {brand.attribution.placement === "footer" && <Attribution />}
              </span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                {t("status.offlineOnly")}
              </span>
            </footer>
          </div>
        </TooltipProvider>
      </MotionConfig>
    </LazyMotion>
  );
}
