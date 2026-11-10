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
    // No movement on hover at all — not a lift, not a scale.
    //
    // A card that rises under the cursor is a common pattern and a bad one here:
    // the grid is a list of destinations, and moving the target by a pixel while
    // the pointer is on it re-aims the click. The tint change below is the whole
    // affordance, and it is enough — the surface is distinguishable at a glance
    // and nothing about the geometry moves.
    //
    // This also removes the class of bug that a lift caused: any transform on
    // this subtree combined with the shared Button's `transition-all` re-wrapped
    // the label column and made the text jitter.
    <div className="h-full">
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
          //
          // `transition-colors` is set explicitly and replaces the Button's
          // `transition-all`: nothing inside a card may animate geometry on
          // hover, or the text rewraps while the pointer is over it.
          // The only hover signal: the surface gets visibly darker. With the
          // lift gone this has to carry the affordance by itself, so it is a
          // step stronger than before rather than a nudge nobody notices.
          "hover:bg-fill-strong/85 bg-fill-subtle h-full w-full transition-colors duration-150",
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
              <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[12px] font-medium text-white backdrop-blur-sm">
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
                <span className="text-muted-foreground font-mono text-[12px]">
                  v{version}
                </span>
              )}
            </div>
            {/* No banner means the state has nowhere to float, so it sits here. */}
            {!showBanner && state && (
              <span
                className={cn(
                  "ml-auto flex shrink-0 items-center gap-1 text-[12px] font-medium",
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
            <p className="text-muted-foreground/80 flex items-center gap-1.5 font-mono text-[12px]">
              {minecraftVersion && <span>Minecraft {minecraftVersion}</span>}
              {minecraftVersion && hasPack && <span aria-hidden="true">·</span>}
              {hasPack && (
                <span title="Провайдер публикует pack.json">pack.json</span>
              )}
            </p>
          )}
        </div>
      </Button>
    </div>
  );
}
