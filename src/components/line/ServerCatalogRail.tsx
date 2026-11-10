import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Play, Server as ServerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { InstallProgress, LineServer } from "@/types/line";

export interface ServerCatalogRailProps {
  server: LineServer | null;
  /** Short, translated state of that server. */
  status: string;
  progress?: InstallProgress | null;
  busy?: boolean;
  onOpen: (server: LineServer) => void;
}

/**
 * tryliner's "now playing" strip, rebuilt for the catalogue.
 *
 * It sits above the server grid and answers one question — "what was I doing?"
 * — without a modal. There is no play button: launching belongs to the server
 * screen (an install may be needed first), so the strip offers exactly one
 * action, «Открыть», and the build progress as a hairline.
 *
 * Rendered only in the new design; the old design has no equivalent strip and
 * must not gain one silently.
 */
export function ServerCatalogRail({
  server,
  status,
  progress,
  busy = false,
  onOpen,
}: ServerCatalogRailProps) {
  const reducedMotion = useReducedMotion();
  const percent =
    progress && Number.isFinite(progress.percent)
      ? Math.min(100, Math.max(0, Math.round(progress.percent)))
      : null;

  return (
    <AnimatePresence initial={false}>
      {server && (
        <m.div
          key={server.id}
          initial={reducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? undefined : { opacity: 0, y: 8 }}
          transition={{
            duration: reducedMotion ? 0 : 0.2,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <section
            data-line-glass
            role="region"
            aria-label="Текущий сервер"
            className="flex items-center gap-3 p-3"
          >
            <div
              data-line-icon
              className="bg-fill flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)]"
            >
              {server.icon_url || server.logo_url ? (
                <img
                  src={server.icon_url ?? server.logo_url}
                  alt=""
                  className="size-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <ServerIcon
                  className="text-muted-foreground size-4"
                  aria-hidden="true"
                />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-muted-foreground font-mono text-[9px] tracking-wide uppercase">
                Текущий сервер
              </span>
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="text-foreground truncate text-[13px] font-medium">
                  {server.name}
                </span>
                <span
                  role="status"
                  className="text-muted-foreground truncate text-[11px]"
                >
                  {status}
                  {percent === null ? "" : ` · ${percent}%`}
                </span>
              </div>
              {percent !== null && (
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label="Загрузка сборки"
                  className="bg-fill mt-1 h-1 w-full overflow-hidden rounded-full"
                >
                  <m.div
                    className="bg-primary h-full rounded-full"
                    initial={false}
                    animate={{ width: `${percent}%` }}
                    transition={{
                      duration: reducedMotion ? 0 : 0.2,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  />
                </div>
              )}
            </div>

            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onOpen(server)}
              className="h-7 shrink-0 gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[11px] font-semibold"
            >
              <Play className="size-3 fill-current" aria-hidden="true" />
              <span>Открыть</span>
            </Button>
          </section>
        </m.div>
      )}
    </AnimatePresence>
  );
}
