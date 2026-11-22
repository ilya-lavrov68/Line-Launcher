import { m, useReducedMotion } from "framer-motion";
import { Check, CloudDownload, Server } from "@/components/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/line/i18n";
import type { LineServer } from "@/types/line";

export interface HarmonyCatalogProps {
  servers: LineServer[];
  installedIds: ReadonlySet<string>;
  statusFor?: (server: LineServer) => string | undefined;
  disabled?: boolean;
  onSelect: (server: LineServer) => void;
}

function ServerBanner({ server, open }: { server: LineServer; open: boolean }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [server.banner_url]);

  const showArtwork = Boolean(server.banner_url) && !failed;

  return (
    <div aria-hidden="true" className="absolute inset-0 bg-[#1d1f23]">
      {showArtwork ? (
        <>
          <img
            src={server.banner_url}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-black/10" />
        </>
      ) : (
        open && (
          <span
            data-harmony-art-fallback
            className="absolute top-7 left-1/2 flex size-20 -translate-x-1/2 items-center justify-center rounded-[18px] bg-[#34363b] text-white/55 ring-1 ring-white/10"
          >
            <Server className="size-9" />
          </span>
        )
      )}
    </div>
  );
}

function ServerLogo({
  server,
  className,
}: {
  server: LineServer;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = server.icon_url ?? server.logo_url;

  useEffect(() => setFailed(false), [src]);

  return src && !failed ? (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("object-cover", className)}
    />
  ) : (
    <span
      data-harmony-logo-fallback
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center bg-[#34363b] text-white/65 ring-1 ring-white/10",
        className,
      )}
    >
      <Server className="size-1/2" />
    </span>
  );
}

/**
 * A horizontal, artwork-led accordion for scanning a provider's servers.
 *
 * The wide banner is the panel's canvas; its square server logo stays legible
 * above the image, while closed panels fold down to a compact logo and vertical
 * name. Expanding one panel gives it the remaining row width, so the player can
 * compare artwork at a glance without turning the catalogue back into a stack
 * of cards. On narrow windows the row scrolls horizontally instead of squeezing
 * the artwork and controls into unreadable slivers.
 */
export default function HarmonyCatalog({
  servers,
  installedIds,
  statusFor,
  disabled = false,
  onSelect,
}: HarmonyCatalogProps) {
  const t = useT();
  const reduced = useReducedMotion();
  const [chosen, setChosen] = useState<string | null>(null);

  const firstId = servers[0]?.id;
  const openId = chosen ?? firstId ?? null;

  // If a refresh removes the open server, return to the provider's first entry.
  useEffect(() => {
    if (chosen && !servers.some((server) => server.id === chosen)) {
      setChosen(null);
    }
  }, [chosen, servers]);

  const rows = useMemo(
    () =>
      servers.map((server) => ({
        server,
        installed: installedIds.has(server.id),
        status: statusFor?.(server),
      })),
    [servers, installedIds, statusFor],
  );

  return (
    <section
      aria-labelledby="harmony-title"
      data-line-harmony
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 id="harmony-title" className="sr-only">
        {t("harmony.title")}
      </h2>

      <div
        role="list"
        aria-label={t("harmony.title")}
        className="flex h-[min(390px,58vh)] min-h-[280px] w-full min-w-0 gap-2 overflow-x-auto overscroll-x-contain pb-1"
      >
        {rows.map(({ server, installed, status }) => {
          const open = server.id === openId;
          const state = status
            ? { label: status, busy: true }
            : installed
              ? { label: t("servers.installed"), busy: false }
              : null;
          const panelId = `harmony-panel-${server.id}`;

          return (
            <m.article
              key={server.id}
              role="listitem"
              data-harmony-row={server.id}
              data-open={open ? "" : undefined}
              initial={false}
              animate={{ flexGrow: open ? 1 : 0, flexBasis: open ? 0 : 68 }}
              transition={{
                duration: reduced ? 0 : 0.28,
                ease: [0.22, 1, 0.36, 1],
              }}
              style={{
                minWidth: open ? "min(72vw, 320px)" : 68,
                flexShrink: open ? 1 : 0,
              }}
              className="relative h-full overflow-hidden rounded-[var(--radius-item)]"
            >
              <ServerBanner server={server} open={open} />

              <button
                type="button"
                disabled={disabled}
                aria-expanded={open}
                aria-controls={panelId}
                aria-label={
                  state ? `${server.name} · ${state.label}` : server.name
                }
                onClick={() => {
                  if (!open) setChosen(server.id);
                }}
                className={cn(
                  "absolute inset-0 z-10 flex cursor-pointer flex-col items-center justify-center gap-3 p-2 text-center text-white",
                  "focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none focus-visible:ring-inset",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                {!open ? (
                  <>
                    <ServerLogo
                      server={server}
                      className="size-10 shrink-0 overflow-hidden rounded-[10px] ring-1 ring-white/25"
                    />
                    <span
                      className="max-h-[72%] truncate text-[11px] font-semibold tracking-wide"
                      style={{
                        writingMode: "vertical-rl",
                        transform: "rotate(180deg)",
                      }}
                    >
                      {server.name}
                    </span>
                    {state && <span className="sr-only">{state.label}</span>}
                  </>
                ) : (
                  <m.span
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: reduced ? 0 : 0.2,
                      delay: reduced ? 0 : 0.05,
                    }}
                    className="absolute inset-x-5 bottom-[145px] flex items-end gap-3 text-left"
                  >
                    <ServerLogo
                      server={server}
                      className="size-14 shrink-0 overflow-hidden rounded-[12px] shadow-xl ring-1 ring-white/30"
                    />
                    <span className="min-w-0 pb-0.5">
                      <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.16em] text-white/75 uppercase">
                        {state && (
                          <>
                            {state.busy ? (
                              <CloudDownload
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            ) : (
                              <Check className="size-3.5" aria-hidden="true" />
                            )}
                            {state.label}
                          </>
                        )}
                      </span>
                      <span className="block truncate text-xl font-bold tracking-tight sm:text-2xl">
                        {server.name}
                      </span>
                    </span>
                  </m.span>
                )}
              </button>

              <div
                id={panelId}
                aria-hidden={!open}
                className={cn(
                  "pointer-events-none absolute inset-x-5 bottom-4 z-20 flex flex-col gap-3 text-white",
                  !open && "invisible",
                )}
              >
                <m.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                  animate={{
                    opacity: open ? 1 : 0,
                    y: open || reduced ? 0 : 8,
                  }}
                  transition={{
                    duration: reduced ? 0 : 0.2,
                    delay: reduced ? 0 : 0.08,
                  }}
                  className="flex flex-col gap-3"
                >
                  {server.description && (
                    <p className="line-clamp-2 text-xs leading-relaxed text-white/85">
                      {server.description}
                    </p>
                  )}
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    {server.version && (
                      <span className="font-mono text-[11px] text-white/65">
                        v{server.version}
                      </span>
                    )}
                    {server.minecraft_version && (
                      <span className="font-mono text-[11px] text-white/65">
                        Minecraft {server.minecraft_version}
                      </span>
                    )}
                    {server.pack_manifest_url && (
                      <span className="font-mono text-[11px] text-white/65">
                        pack.json
                      </span>
                    )}
                    <Button
                      size="sm"
                      type="button"
                      disabled={disabled}
                      onClick={() => onSelect(server)}
                      aria-label={t("servers.open", { name: server.name })}
                      className="pointer-events-auto ml-auto min-h-9 cursor-pointer bg-white text-black hover:bg-white/90"
                    >
                      {t("harmony.open")}
                    </Button>
                  </div>
                </m.div>
              </div>
            </m.article>
          );
        })}
      </div>
    </section>
  );
}
