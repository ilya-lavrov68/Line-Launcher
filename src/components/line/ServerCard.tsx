import { m, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Check, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ServerCardProps {
  name: string;
  description: string;
  logoUrl?: string;
  version?: string;
  minecraftVersion?: string;
  installed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Server card. Directly follows Obsy's StoreAddonCard / InstalledAddonCard:
 * `border-border/40 bg-card/60 rounded-xl border p-3.5 backdrop-blur-sm`,
 * `bg-primary/10 text-primary border-primary/20` icon tile, muted meta text and
 * the emerald update/status badge. A real Button supplies keyboard, focus and
 * disabled semantics; there are no nested interactive elements.
 */
export default function ServerCard({
  name,
  description,
  logoUrl,
  version,
  minecraftVersion,
  installed = false,
  disabled = false,
  onClick,
}: ServerCardProps) {
  const reducedMotion = useReducedMotion();
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [logoUrl]);

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
          "flex-col items-stretch justify-start gap-3 rounded-xl border p-3.5",
          "text-left whitespace-normal backdrop-blur-sm transition-colors",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="bg-primary/10 text-primary border-primary/20 flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
            {logoUrl && !imageFailed ? (
              <img
                src={logoUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <Server className="h-5 w-5" />
            )}
          </div>
          {installed ? (
            <span className="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400">
              <Check className="h-3 w-3" aria-hidden="true" />
              <span>Установлен</span>
            </span>
          ) : (
            <ArrowUpRight
              className="text-muted-foreground h-4 w-4"
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

        {minecraftVersion && (
          <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-1.5 pt-1 font-mono text-[10px] font-normal">
            <span className="bg-muted/40 border-border/30 rounded border px-1.5 py-0.5">
              Minecraft {minecraftVersion}
            </span>
          </div>
        )}
      </Button>
    </m.div>
  );
}
