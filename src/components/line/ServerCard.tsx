import { m, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Check, CloudDownload, Server } from "lucide-react";
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
 * Server card. Directly follows Obsy's StoreAddonCard / InstalledAddonCard:
 * `border-border/40 bg-card/60 rounded-xl border p-3.5 backdrop-blur-sm`,
 * an unframed provider logo, muted meta text and
 * the emerald update/status badge. A real Button supplies keyboard, focus and
 * disabled semantics; there are no nested interactive elements.
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

  return (
    <m.div
      whileHover={disabled || reducedMotion ? undefined : { scale: 1.01 }}
      whileTap={disabled || reducedMotion ? undefined : { scale: 0.99 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className="h-full"
    >
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={onClick}
        aria-label={`Открыть сервер ${name}`}
        className={cn(
          "border-border/40 bg-card/60 hover:border-border/70 h-full w-full",
          "flex-col items-stretch justify-start gap-3 overflow-hidden rounded-xl border p-3.5",
          "text-left whitespace-normal backdrop-blur-sm transition-colors",
        )}
      >
        {bannerUrl && !bannerFailed && (
          <div className="bg-muted/40 -mx-3.5 -mt-3.5 mb-0.5 h-24 w-[calc(100%+1.75rem)] overflow-hidden">
            <img
              src={bannerUrl}
              alt=""
              className="h-full w-full object-contain"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setBannerFailed(true)}
            />
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div
            data-line-icon
            className="text-primary flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden"
          >
            {iconUrl && !imageFailed ? (
              <img
                src={iconUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <Server className="h-7 w-7" />
            )}
          </div>
          {statusLabel ? (
            <span className="inline-flex items-center gap-0.5 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-300">
              <CloudDownload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{statusLabel}</span>
            </span>
          ) : installed ? (
            <span className="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Установлен</span>
            </span>
          ) : (
            <ArrowUpRight
              className="text-muted-foreground h-5 w-5"
              aria-hidden="true"
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-sm font-semibold">
              {name}
            </span>
            {version && (
              <span className="text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5 font-mono text-[10px]">
                v{version}
              </span>
            )}
          </div>
          <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed font-normal">
            {description}
          </p>
        </div>

        {(minecraftVersion || hasPack) && (
          <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-1.5 pt-1 font-mono text-[10px] font-normal">
            {minecraftVersion && (
              <span className="bg-muted/40 border-border/30 rounded border px-1.5 py-0.5">
                Minecraft {minecraftVersion}
              </span>
            )}
            {hasPack && (
              <span
                className="border-border/30 rounded border px-1.5 py-0.5"
                title="Провайдер публикует pack.json: сборка скачивается сама"
              >
                ZIP + pack.json
              </span>
            )}
          </div>
        )}
      </Button>
    </m.div>
  );
}
