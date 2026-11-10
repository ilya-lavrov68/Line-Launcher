import { m, useReducedMotion } from "framer-motion";
import { Check, CloudDownload, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ServerCardProps {
  name: string;
  description: string;
  iconUrl?: string;
  bannerUrl?: string;
  version?: string;
  minecraftVersion?: string;
  installed?: boolean;
  /** Short status badge: «Готов», «Обновление», «Загрузка 45%». */
  statusLabel?: string;
  /** Server has a provider pack (`pack_manifest_url`): badge wording differs. */
  hasPack?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * One server tile.
 *
 * What used to be here: a banner, an icon, an «Установлен» chip, the name, a
 * version chip, a two-line description, a `Minecraft 1.21.1` chip and a
 * pack-manifest chip. Seven pieces of chrome for a card whose only job is
 * «open this server». The chips repeated what the provider config already says
 * and what the detail screen shows properly, and the boxed badges made the
 * catalogue look like a dashboard.
 *
 * Now: artwork, name, one line of description, one quiet meta line, and the
 * state as a dot beside the name. A missing state is the normal state, so an
 * idle card carries no badge at all rather than an arrow glyph pretending to be
 * information.
 */
export default function ServerCard({
  name,
  description,
  iconUrl,
  bannerUrl,
  version,
  minecraftVersion,
  installed = false,
  hasPack = false,
  statusLabel,
  disabled = false,
  onClick,
}: ServerCardProps) {
  const reducedMotion = useReducedMotion();
  const [imageFailed, setImageFailed] = useState(false);
  const [bannerFailed, setBannerFailed] = useState(false);

  useEffect(() => setImageFailed(false), [iconUrl]);
  useEffect(() => setBannerFailed(false), [bannerUrl]);

  const showBanner = Boolean(bannerUrl) && !bannerFailed;
  // Busy state wins over "installed": «Загрузка 45%» is the current truth.
  const state = statusLabel
    ? { label: statusLabel, tone: "busy" as const }
    : installed
      ? { label: "Установлен", tone: "ready" as const }
      : null;

  return (
    <m.div
      whileHover={disabled || reducedMotion ? undefined : { scale: 1.008 }}
      whileTap={disabled || reducedMotion ? undefined : { scale: 0.996 }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
      className="h-full"
    >
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        onClick={onClick}
        aria-label={`Открыть сервер ${name}`}
        data-line-card
        className={cn(
          // A tinted surface instead of a border. `fill-subtle` is one step above
          // the page, which is enough separation on a flat backdrop and gives the
          // grid an even rhythm without drawing eight rectangles.
          "hover:bg-fill-strong/70 bg-fill-subtle h-full w-full",
          "flex-col items-stretch justify-start gap-3 overflow-hidden rounded-[var(--radius-item)] p-0",
          "text-left whitespace-normal hover:border-transparent",
        )}
      >
        {showBanner ? (
          <div className="relative h-24 w-full shrink-0 overflow-hidden">
            <img
              src={bannerUrl}
              alt=""
              className="h-full w-full object-cover opacity-70"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setBannerFailed(true)}
            />
            {/* The state chip floats on the artwork: it is the one place on the
                card where a readable label beats another row of text. */}
            {state && (
              <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                {state.tone === "busy" ? (
                  <CloudDownload className="size-3" aria-hidden="true" />
                ) : (
                  <Check className="size-3" aria-hidden="true" />
                )}
                {state.label}
              </span>
            )}
          </div>
        ) : null}

        <div className="flex w-full flex-col gap-2 p-3.5">
          <div className="flex items-center gap-2.5">
            {/* The icon keeps its own row under the banner rather than
                overlapping it: an overlap needs a cut-out ring, and a ring here
                would be decoration pretending to be structure. */}
            <div
              data-line-icon
              className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)]"
            >
              {iconUrl && !imageFailed ? (
                <img
                  src={iconUrl}
                  alt=""
                  className="size-full object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => setImageFailed(true)}
                />
              ) : (
                <Server
                  className="text-muted-foreground size-4"
                  aria-hidden="true"
                />
              )}
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="text-foreground truncate text-sm font-semibold">
                {name}
              </span>
              {version && (
                <span className="text-muted-foreground font-mono text-[10px]">
                  v{version}
                </span>
              )}
            </div>
            {/* No banner means the state has nowhere to float, so it sits here. */}
            {!showBanner && state && (
              <span
                className={cn(
                  "ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium",
                  state.tone === "busy"
                    ? "text-line-update"
                    : "text-line-online",
                )}
              >
                {state.tone === "busy" ? (
                  <CloudDownload className="size-3" aria-hidden="true" />
                ) : (
                  <Check className="size-3" aria-hidden="true" />
                )}
                {state.label}
              </span>
            )}
          </div>

          <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
            {description}
          </p>

          {(minecraftVersion || hasPack) && (
            <p className="text-muted-foreground/80 flex items-center gap-1.5 font-mono text-[10px]">
              {minecraftVersion && <span>Minecraft {minecraftVersion}</span>}
              {minecraftVersion && hasPack && <span aria-hidden="true">·</span>}
              {hasPack && (
                <span title="Провайдер публикует pack.json">pack.json</span>
              )}
            </p>
          )}
        </div>
      </Button>
    </m.div>
  );
}
