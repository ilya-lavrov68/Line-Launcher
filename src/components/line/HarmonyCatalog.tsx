import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, CloudDownload, Server } from "lucide-react";
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

/**
 * The catalogue as an accordion: one server open, the rest folded to a line.
 *
 * The grid is the right default — a catalogue of six servers is a wall of
 * artwork you read at a glance. It stops working past roughly a dozen servers
 * and on a narrow window: every card is 96px of banner plus two lines, only
 * three fit across, and the one the player actually plays is somewhere in the
 * middle of the scroll.
 *
 * The accordion answers a different question. It assumes the player is not
 * browsing but *returning*: they know which server they came for, and want a
 * list they can scan by name. One row is open, the rest are 44px lines with an
 * icon and a name, so the whole list fits on one screen and the open one still
 * shows its description and state without a click.
 *
 * Which one is open: the first server by default, because the provider's list
 * is "most popular first" — that is what the ordering means. The player's own
 * choice wins for the rest of the session and is not remembered: which server
 * you looked at last is not a preference.
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

  // `null` means "nobody has chosen", which is not the same as "nothing is
  // open": the first row stays unfolded until the player picks another one.
  // Keeping the choice separate means a provider refresh does not collapse the
  // row the player just opened.
  const [chosen, setChosen] = useState<string | null>(null);

  const firstId = servers[0]?.id;
  const openId = chosen ?? firstId ?? null;

  // A server the provider removed must not stay selected: the id would point at
  // a row that no longer exists and every row would render collapsed.
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
      className="flex flex-col gap-1.5"
    >
      {/* A disclosure group, not a tab set: nothing here is mutually exclusive
          in the way tabs imply. A heading carries the group name regardless. */}
      <h2 id="harmony-title" className="sr-only">
        {t("harmony.title")}
      </h2>

      {rows.map(({ server, installed, status }) => {
        const open = server.id === openId;
        const state = status
          ? { label: status, busy: true as const }
          : installed
            ? { label: t("servers.installed"), busy: false as const }
            : null;

        return (
          <div
            key={server.id}
            data-harmony-row={server.id}
            data-open={open ? "" : undefined}
            className={cn(
              "overflow-hidden rounded-[var(--radius-item)] transition-colors duration-150",
              open ? "bg-fill-subtle" : "hover:bg-fill-subtle/60",
            )}
          >
            {/* The header is the row a player scans. A real <button> with
                `aria-expanded`, so the whole row is one target and the state is
                announced — the disclosure pattern, not a div with a click. */}
            <button
              type="button"
              disabled={disabled}
              aria-expanded={open}
              onClick={() => setChosen(open ? "" : server.id)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left",
                "focus-visible:ring-ring/40 focus-visible:ring-3 focus-visible:outline-none",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <span
                data-line-icon
                className="bg-fill flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)]"
              >
                {server.icon_url || server.logo_url ? (
                  <img
                    src={server.icon_url ?? server.logo_url ?? ""}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <Server
                    className="text-muted-foreground size-4"
                    aria-hidden="true"
                  />
                )}
              </span>

              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground truncate text-sm font-semibold">
                  {server.name}
                </span>
                {/* One line of description while folded — enough to tell two
                    servers apart, not enough to need a second row. */}
                {!open && (
                  <span className="text-muted-foreground truncate text-[12px]">
                    {server.description}
                  </span>
                )}
              </span>

              {state && (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 text-[12px] font-medium",
                    state.busy ? "text-line-update" : "text-line-online",
                  )}
                >
                  {state.busy ? (
                    <CloudDownload className="size-3" aria-hidden="true" />
                  ) : (
                    <Check className="size-3" aria-hidden="true" />
                  )}
                  {state.label}
                </span>
              )}

              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "text-muted-foreground size-4 shrink-0 transition-transform duration-200",
                  open && "rotate-180",
                )}
              />
            </button>

            <AnimatePresence initial={false}>
              {open && (
                <m.div
                  key="body"
                  initial={reduced ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{
                    duration: reduced ? 0 : 0.2,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-3 px-3 pb-3">
                    {server.description && (
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        {server.description}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {server.version && (
                        <span className="text-muted-foreground/80 font-mono text-[12px]">
                          v{server.version}
                        </span>
                      )}
                      {server.minecraft_version && (
                        <span className="text-muted-foreground/80 font-mono text-[12px]">
                          Minecraft {server.minecraft_version}
                        </span>
                      )}
                      {server.pack_manifest_url && (
                        <span
                          title={t("servers.packJson")}
                          className="text-muted-foreground/80 font-mono text-[12px]"
                        >
                          pack.json
                        </span>
                      )}
                    </div>

                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() => onSelect(server)}
                      aria-label={t("servers.open", { name: server.name })}
                      className="w-fit cursor-pointer text-xs"
                    >
                      {t("harmony.open")}
                    </Button>
                  </div>
                </m.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </section>
  );
}
