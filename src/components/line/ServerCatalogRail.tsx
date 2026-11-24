import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { ChevronRight, Server as ServerIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import type { InstallProgress, LineServer } from "@/types/line";
import { useT } from "@/lib/line/i18n";

export interface ServerCatalogRailProps {
  /** The last server opened in this session. */
  server: LineServer | null;
  /** Short, translated state of that server. */
  status: string;
  progress?: InstallProgress | null;
  busy?: boolean;
  /** Opens the server details; launch/install actions stay on that page. */
  onOpen: (server: LineServer) => void;
}

/** A large, artwork-led continuation card for the last server the player opened. */
export function ServerCatalogRail({
  server,
  status,
  progress,
  busy = false,
  onOpen,
}: ServerCatalogRailProps) {
  const reducedMotion = useReducedMotion();
  const t = useT();
  const [bannerFailed, setBannerFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => setBannerFailed(false), [server?.banner_url]);
  useEffect(() => setIconFailed(false), [server?.icon_url, server?.logo_url]);
  const percent =
    progress && Number.isFinite(progress.percent)
      ? Math.min(100, Math.max(0, Math.round(progress.percent)))
      : null;

  return (
    <AnimatePresence initial={false}>
      {server && (
        <m.div
          key={server.id}
          initial={reducedMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? undefined : { opacity: 0, y: 10 }}
          transition={{
            duration: reducedMotion ? 0 : 0.22,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <section
            data-line-server-featured
            role="region"
            aria-label={t("catalog.lastSelected")}
            className="border-border/50 bg-fill relative isolate flex aspect-[4/1] min-h-64 overflow-hidden rounded-[var(--radius-panel)] border sm:min-h-72"
          >
            {server.banner_url && !bannerFailed ? (
              <img
                src={server.banner_url}
                alt=""
                width={1600}
                height={400}
                className="absolute inset-0 size-full object-cover"
                loading="eager"
                fetchPriority="high"
                referrerPolicy="no-referrer"
                onError={() => setBannerFailed(true)}
              />
            ) : (
              <div className="bg-fill-strong absolute inset-0">
                <ServerIcon
                  className="text-foreground/10 absolute -right-3 -bottom-16 size-64"
                  aria-hidden="true"
                />
                <div
                  aria-hidden="true"
                  className="bg-primary/20 absolute inset-y-0 right-1/4 w-px"
                />
              </div>
            )}
            <div
              aria-hidden="true"
              className="bg-background/75 absolute inset-y-0 left-0 w-full sm:w-[72%]"
            />

            <div className="relative flex min-h-64 w-full flex-col justify-end gap-6 p-6 sm:min-h-72 sm:flex-row sm:items-end sm:justify-between sm:p-8">
              <div className="flex max-w-2xl min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[10px] font-semibold tracking-[0.1em] text-white/70 uppercase">
                    {t("catalog.lastSelected")}
                  </span>
                  <span
                    role="status"
                    className="text-[11px] font-medium text-white/80"
                  >
                    {status}
                  </span>
                </div>

                <div className="flex min-w-0 items-center gap-3">
                  <div
                    data-line-icon
                    className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] border border-white/20 bg-black/30 backdrop-blur-sm"
                  >
                    {(server.icon_url || server.logo_url) && !iconFailed ? (
                      <img
                        src={server.icon_url ?? server.logo_url}
                        alt=""
                        width={48}
                        height={48}
                        className="size-full object-contain p-1"
                        referrerPolicy="no-referrer"
                        onError={() => setIconFailed(true)}
                      />
                    ) : (
                      <ServerIcon
                        className="size-5 text-white/75"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <h3 className="truncate text-2xl font-bold tracking-tight text-white sm:text-3xl">
                      {server.name}
                    </h3>
                    <p className="text-[11px] font-medium text-white/65">
                      {server.minecraft_version
                        ? `Minecraft ${server.minecraft_version} · `
                        : ""}
                      v{server.version}
                    </p>
                  </div>
                </div>

                <p className="line-clamp-2 max-w-2xl text-sm leading-relaxed text-white/80">
                  {server.description}
                </p>

                {percent !== null && (
                  <div className="max-w-lg">
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-white/75">
                      <span>{t("servers.railDownloading")}</span>
                      <span className="tabular-nums">{percent}%</span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                      aria-label={t("servers.railDownloading")}
                      className="h-1.5 w-full overflow-hidden rounded-full bg-white/20"
                    >
                      <m.div
                        className="h-full rounded-full bg-white"
                        initial={false}
                        animate={{ width: `${percent}%` }}
                        transition={{
                          duration: reducedMotion ? 0 : 0.2,
                          ease: [0.22, 1, 0.36, 1],
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => onOpen(server)}
                className="text-background h-10 shrink-0 gap-2 rounded-lg bg-white px-4 text-sm font-semibold hover:bg-white/90"
              >
                <span>{t("catalog.details")}</span>
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </section>
        </m.div>
      )}
    </AnimatePresence>
  );
}
