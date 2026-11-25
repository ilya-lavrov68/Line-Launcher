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
  /** Short inline status: «Готов», «Обновление», «Загрузка 45%». */
  statusLabel?: string;
  /** Server publishes a pack manifest. */
  hasPack?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** A compact, artwork-led directory row. Launch/install stays on server details. */
export default function ServerCard({
  name,
  description,
  iconUrl,
  bannerUrl,
  version,
  minecraftVersion,
  installed = false,
  statusLabel,
  hasPack = false,
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

  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onClick}
      aria-label={t("servers.open", { name })}
      data-line-card
      className={cn(
        "group bg-fill-subtle hover:bg-fill flex min-h-[6.5rem] w-full items-center gap-3 rounded-[var(--radius-item)] p-2.5 text-left whitespace-normal transition-colors duration-150 sm:gap-4 sm:p-3",
        "focus-visible:ring-primary focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2",
      )}
    >
      <div className="bg-background relative h-[4.5rem] w-28 shrink-0 overflow-hidden rounded-[calc(var(--radius-item)-11px)] sm:h-[4.75rem] sm:w-40 sm:rounded-none md:w-48">
        {showBanner ? (
          <img
            src={bannerUrl}
            alt=""
            width={1600}
            height={400}
            className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.025]"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBannerFailed(true)}
          />
        ) : (
          <div className="bg-fill relative flex size-full items-center justify-center overflow-hidden">
            <div
              aria-hidden="true"
              className="border-primary/30 absolute size-16 rotate-45 rounded-xl border"
            />
            <div
              aria-hidden="true"
              className="bg-primary/10 absolute inset-y-0 right-0 w-1/3"
            />
            <div
              data-line-icon
              className="bg-fill-strong relative flex size-10 items-center justify-center overflow-hidden rounded-[var(--radius-control)]"
            >
              {iconUrl && !imageFailed ? (
                <img
                  src={iconUrl}
                  alt=""
                  width={40}
                  height={40}
                  className="size-full object-contain p-1"
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
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 py-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-foreground min-w-0 truncate text-[15px] font-semibold tracking-[-0.02em]">
            {name}
          </span>
          {state && (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
                state.tone === "busy" ? "text-line-update" : "text-line-online",
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
        <p className="text-muted-foreground line-clamp-1 max-w-3xl text-xs leading-relaxed sm:line-clamp-2">
          {description}
        </p>
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-[10px] font-medium tabular-nums">
          {minecraftVersion && (
            <span className="truncate">Minecraft {minecraftVersion}</span>
          )}
          {minecraftVersion && version && <span aria-hidden="true">/</span>}
          {version && <span className="truncate">v{version}</span>}
          {(minecraftVersion || version) && hasPack && (
            <span aria-hidden="true">/</span>
          )}
          {hasPack && <span className="truncate">pack.json</span>}
        </div>
      </div>

      <span className="text-foreground flex shrink-0 items-center gap-1.5 px-1 text-[11px] font-semibold sm:px-2">
        <span className="hidden sm:inline">{t("catalog.details")}</span>
        <ArrowUpRight className="size-4" aria-hidden="true" />
      </span>
    </Button>
  );
}
