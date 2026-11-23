import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import {
  ChevronDown,
  LogOut,
  RefreshCw,
  Shirt,
  UserRound,
} from "@/components/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import SkinViewer3D from "@/components/line/SkinViewer3D";
import { Button } from "@/components/ui/button";
import { errorMessage, lineApi } from "@/lib/line/api";
import type { AuthSessionInfo, LineServer, SkinState } from "@/types/line";
import { useT } from "@/lib/line/i18n";
import { SkeletonProfile } from "@/components/line/Skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ProfileScreenProps {
  session: AuthSessionInfo;
  providerName: string;
  /** True when the provider exposes wardrobe endpoints at all. */
  canSync: boolean;
  onLogout: () => void;
  onOpenWardrobe: () => void;
  disabled?: boolean;
  servers?: LineServer[];
  recentServerId?: string;
}

/**
 * The account page: who you are, and what you look like in game.
 *
 * The launcher has one project account shared by every server, so this page has
 * nothing to choose — it is a fingerprint, not a picker. What it does add is the
 * one thing the wardrobe could not show: the skin as a body, not a texture.
 *
 * The active skin is read from the same local index the wardrobe writes, so the
 * two screens can never disagree. When the project supports the wardrobe the
 * provider's copy wins (it is what the game will actually load); otherwise the
 * local active skin is shown and the sync line says so in one sentence rather
 * than pretending.
 */
export default function ProfileScreen({
  session,
  providerName,
  canSync,
  onLogout,
  onOpenWardrobe,
  disabled = false,
  servers = [],
  recentServerId,
}: ProfileScreenProps) {
  const t = useT();
  const [skin, setSkin] = useState<SkinState | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [viewerPose, setViewerPose] = useState<"walk" | "wave" | "manual">(
    "walk",
  );
  const [statsServerId, setStatsServerId] = useState(
    recentServerId ?? servers[0]?.id ?? "",
  );
  useEffect(() => {
    if (
      recentServerId &&
      servers.some((server) => server.id === recentServerId)
    ) {
      setStatsServerId(recentServerId);
    } else if (!servers.some((server) => server.id === statsServerId)) {
      setStatsServerId(servers[0]?.id ?? "");
    }
  }, [recentServerId, servers, statsServerId]);

  /**
   * The active skin, in whichever form exists.
   *
   * The local library stores PNGs as files, not URLs, so the texture is read
   * back and wrapped in an object URL — the same round trip the wardrobe
   * thumbnails use. Object URLs are not garbage collected while they are live,
   * so one ref owns the current URL: it is revoked before a replacement and on
   * unmount, otherwise every refresh would leak a skin into the page.
   *
   * When nothing is active locally the provider is asked instead: the account
   * may have picked a skin before this machine ever existed.
   */
  const objectUrl = useRef<string | undefined>(undefined);
  const disposeUrl = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = undefined;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    disposeUrl();
    try {
      const snapshot = await lineApi.skinLibrary();
      const entry = snapshot.library.skins.find(
        (s) => s.id === snapshot.library.active,
      );
      setActiveName(entry?.name ?? null);
      if (entry) {
        const bytes = await lineApi.skinTexture(entry.id);
        if (!bytes?.length) throw new Error(t("profile.textureMissing"));
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        );
        objectUrl.current = url;
        setSkin({ model: entry.model, textureUrl: url });
      } else {
        setSkin(await lineApi.skin().catch(() => null));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [disposeUrl]);

  useEffect(() => {
    void load();
    return disposeUrl;
  }, [load, disposeUrl, session.username]);

  // The skin is a library read plus a texture decode, so the first paint of this
  // page has no picture and no skin name. Showing the page's own two-column
  // geometry during that beat is why the skeleton exists: the viewer box is
  // square and already in place when the texture lands.
  if (loading && !skin) {
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-xl font-bold tracking-tight">
            {t("profile.title")}
          </h2>
        </div>
        <SkeletonProfile />
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          {t("profile.title")}
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("profile.subtitle", { provider: providerName })}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="text-destructive bg-destructive/10 rounded-[var(--radius-control)] p-3 text-xs"
        >
          {error}
        </p>
      )}

      <div className="border-border/40 bg-fill-subtle overflow-hidden rounded-[var(--radius-panel)] border">
        <div className="relative">
          <SkinViewer3D
            src={skin?.textureUrl}
            model={skin?.model ?? "classic"}
            height={420}
            animation={viewerPose}
            className="skin-hero-viewer rounded-none"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/30 to-transparent"
          />
          <div className="absolute bottom-4 left-4 flex max-w-[calc(100%-2rem)] flex-col gap-0.5">
            <span className="text-[10px] font-medium tracking-[0.12em] text-white/65 uppercase">
              {t("profile.skin")}
            </span>
            {activeName && (
              <span className="text-xs font-medium text-white">
                {activeName}
              </span>
            )}
          </div>
        </div>

        <div className="border-border/40 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <div
            className="bg-fill-subtle relative grid grid-cols-3 gap-0.5 rounded-lg p-1"
            role="group"
            aria-label={t("profile.viewer.controls")}
          >
            <span
              aria-hidden="true"
              className="bg-fill-strong pointer-events-none absolute top-1 bottom-1 left-1 w-[calc((100%-0.75rem)/3)] rounded-md transition-transform duration-300 ease-[var(--ease-line)] motion-reduce:transition-none"
              style={{
                transform: `translateX(calc(${["walk", "wave", "manual"].indexOf(viewerPose)} * (100% + 0.125rem)))`,
              }}
            />
            {(["walk", "wave", "manual"] as const).map((pose) => (
              <button
                key={pose}
                type="button"
                aria-pressed={viewerPose === pose}
                onClick={() => setViewerPose(pose)}
                className={`relative z-10 min-h-8 cursor-pointer rounded-md px-2.5 text-[11px] font-medium transition-colors ${viewerPose === pose ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t(`profile.viewer.${pose}`)}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground w-full min-w-0 text-left text-[11px] leading-relaxed sm:ml-auto sm:w-auto sm:flex-1 sm:text-right">
            {skin
              ? canSync
                ? t("profile.synced")
                : t("profile.localOnly")
              : t("profile.pickSkin")}
          </p>
        </div>

        <div className="border-border/40 flex flex-col gap-4 border-t p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <UserRound
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <h3 className="text-foreground truncate text-sm font-semibold">
                  {session.username}
                </h3>
                <p className="text-muted-foreground truncate text-[11px]">
                  {providerName}
                </p>
              </div>
            </div>
            <dl className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground text-[10px]">
                {t("profile.sessionExpires")}
              </dt>
              <dd className="text-foreground text-xs">
                {new Date(session.expiresAt).toLocaleString(t.language, {
                  day: "numeric",
                  month: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </dd>
            </dl>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onOpenWardrobe}
              className="cursor-pointer items-center gap-1.5 text-xs"
            >
              <Shirt className="size-4" aria-hidden="true" />
              {t("nav.wardrobe")}
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={t("servers.refresh")}
              disabled={disabled || loading}
              onClick={() => void load()}
            >
              <RefreshCw
                className={loading ? "size-4 animate-spin" : "size-4"}
                aria-hidden="true"
              />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setLogoutOpen(true)}
              className="text-muted-foreground hover:text-foreground cursor-pointer items-center gap-1.5 text-xs"
            >
              <LogOut className="size-4" aria-hidden="true" />
              {t("profile.logout")}
            </Button>
          </div>
        </div>
      </div>

      <details className="group border-border/50 bg-fill-subtle rounded-[var(--radius-item)] border">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="text-foreground text-sm font-semibold">
            {t("profile.statistics")}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
          />
        </summary>
        <div className="border-border/40 flex flex-col gap-4 border-t p-4">
          <div className="flex flex-col gap-2 sm:max-w-sm">
            <label
              className="text-muted-foreground text-xs"
              htmlFor="profile-stats-server"
            >
              {t("profile.statistics.server")}
            </label>
            <Select
              value={statsServerId}
              onValueChange={(value) => {
                if (value) setStatsServerId(value);
              }}
              disabled={servers.length === 0}
            >
              <SelectTrigger
                id="profile-stats-server"
                className="w-full text-xs"
              >
                <SelectValue>
                  {servers.find((server) => server.id === statsServerId)
                    ?.name ?? t("profile.statistics.noServers")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {servers.map((server) => (
                  <SelectItem key={server.id} value={server.id}>
                    {server.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {["blocks", "mobs", "players", "deaths"].map((metric) => (
              <div
                key={metric}
                className="border-border/40 text-muted-foreground rounded-[var(--radius-control)] border px-3 py-2 text-xs"
              >
                {t(`profile.statistics.${metric}`)}
              </div>
            ))}
          </div>
          <p
            className="text-muted-foreground border-border/40 rounded-[var(--radius-control)] border p-3 text-xs leading-relaxed"
            role="status"
          >
            {t("profile.statistics.empty")}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {["minecraft", "mods"].map((group) => (
              <section
                key={group}
                className="border-border/40 flex flex-col gap-2 rounded-[var(--radius-control)] border p-3"
              >
                <h4 className="text-foreground text-xs font-semibold">
                  {t(`profile.advancements.${group}`)}
                </h4>
                <p className="text-muted-foreground text-xs">
                  {t("profile.advancements.empty")}
                </p>
              </section>
            ))}
          </div>
        </div>
      </details>
      <AlertDialogPrimitive.Root open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Backdrop className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/35 supports-backdrop-filter:backdrop-blur-xs" />
          <AlertDialogPrimitive.Popup
            data-line-glass="raised"
            className="text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-full max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-hidden rounded-xl p-5 text-sm ring-1 duration-150 outline-none sm:max-w-sm"
          >
            <AlertDialogPrimitive.Title className="font-heading text-base leading-snug font-semibold">
              {t("profile.logoutConfirmTitle")}
            </AlertDialogPrimitive.Title>
            <div className="border-border/50 flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
              <AlertDialogPrimitive.Close
                render={<Button variant="outline" disabled={disabled} />}
              >
                {t("common.cancel")}
              </AlertDialogPrimitive.Close>
              <Button
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  setLogoutOpen(false);
                  onLogout();
                }}
              >
                {t("profile.logout")}
              </Button>
            </div>
          </AlertDialogPrimitive.Popup>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </section>
  );
}
