import {
  ArrowUpRight,
  Check,
  CloudDownload,
  Server,
} from "@/components/ui/icons";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/line/i18n";

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

/** Artwork-led server tile. The full card opens details; launch stays there. */
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
  const t = useT();
  const [imageFailed, setImageFailed] = useState(false);
  const [bannerFailed, setBannerFailed] = useState(false);

  useEffect(() => setImageFailed(false), [iconUrl]);
  useEffect(() => setBannerFailed(false), [bannerUrl]);

  const showBanner = Boolean(bannerUrl) && !bannerFailed;
  const state = statusLabel
    ? { label: statusLabel, tone: "busy" as const }
    : installed
      ? { label: t("servers.installed"), tone: "ready" as const }
      : null;

  const mark = (
    <div
      data-line-icon
      className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] border border-white/15 bg-black/35 backdrop-blur-sm"
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
        <Server className="size-4 text-white/80" aria-hidden="true" />
      )}
    </div>
  );

  const stateBadge = state && (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm",
        state.tone === "busy" && "text-amber-100",
      )}
    >
      {state.tone === "busy" ? (
        <CloudDownload className="size-3" aria-hidden="true" />
      ) : (
        <Check className="size-3" aria-hidden="true" />
      )}
      {state.label}
    </span>
  );

  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onClick}
      aria-label={t("servers.open", { name })}
      data-line-card
      className={cn(
        "group border-border/50 bg-fill hover:border-border hover:bg-fill-strong/85 h-full w-full border p-0 text-left whitespace-normal transition-colors duration-150",
        "flex-col items-stretch justify-start gap-0 overflow-hidden rounded-[var(--radius-item)]",
      )}
    >
      {showBanner && (
        <div className="bg-background relative h-40 w-full shrink-0 overflow-hidden">
          <img
            src={bannerUrl}
            alt=""
            className="size-full object-cover opacity-90 transition-transform duration-300 group-hover:scale-[1.025]"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBannerFailed(true)}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-black/15"
          />
          <div className="absolute inset-x-4 bottom-4 flex items-end gap-3">
            {mark}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-base font-semibold text-white">
                {name}
              </span>
              {version && (
                <span className="font-mono text-[11px] text-white/70">
                  v{version}
                </span>
              )}
            </div>
          </div>
          {stateBadge && (
            <div className="absolute top-3 right-3">{stateBadge}</div>
          )}
        </div>
      )}

      <div className="flex w-full flex-1 flex-col gap-3.5 p-4">
        {!showBanner && (
          <div className="flex min-w-0 items-center gap-3">
            <div
              data-line-icon
              className="border-border/50 bg-fill-subtle flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] border"
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
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-foreground truncate text-base font-semibold">
                {name}
              </span>
              {version && (
                <span className="text-muted-foreground font-mono text-[11px]">
                  v{version}
                </span>
              )}
            </div>
            {state && (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
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
        )}

        <p className="text-muted-foreground line-clamp-2 min-h-10 text-xs leading-relaxed">
          {description}
        </p>

        <div className="border-border/40 mt-auto flex items-center justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground/80 flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px]">
            {minecraftVersion && <span>Minecraft {minecraftVersion}</span>}
            {minecraftVersion && hasPack && <span aria-hidden="true">·</span>}
            {hasPack && <span title={t("servers.packJson")}>pack.json</span>}
          </p>
          <span className="text-foreground flex shrink-0 items-center gap-1.5 text-[11px] font-semibold">
            {t("catalog.details")}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </span>
        </div>
      </div>
    </Button>
  );
}
