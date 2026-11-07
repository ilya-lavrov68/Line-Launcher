import { Server } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface ServerBannerProps {
  name: string;
  bannerUrl?: string;
  iconUrl?: string;
  className?: string;
}

/**
 * Wide provider-supplied header image with an optional square icon. Both are
 * optional; a missing or broken image falls back to the same primary-tinted tile
 * and muted surface the rest of the launcher uses, so the layout never shifts.
 */
export default function ServerBanner({
  name,
  bannerUrl,
  iconUrl,
  className,
}: ServerBannerProps) {
  const [bannerFailed, setBannerFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => setBannerFailed(false), [bannerUrl]);
  useEffect(() => setIconFailed(false), [iconUrl]);

  const showBanner = bannerUrl && !bannerFailed;
  const showIcon = iconUrl && !iconFailed;
  if (!showBanner && !showIcon) return null;

  return (
    <div className={cn("relative", className)}>
      {showBanner && (
        <div className="bg-muted/40 h-36 w-full overflow-hidden rounded-xl">
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setBannerFailed(true)}
          />
        </div>
      )}
      {showIcon && (
        <div
          className={cn(
            "bg-card border-border/50 flex h-14 w-14 items-center justify-center",
            "overflow-hidden rounded-xl border shadow-lg backdrop-blur-md",
            showBanner ? "-mt-7 ml-4" : "",
          )}
        >
          <img
            src={iconUrl}
            alt={name}
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setIconFailed(true)}
          />
        </div>
      )}
      {!showIcon && showBanner && (
        <Server className="sr-only" aria-hidden="true" />
      )}
    </div>
  );
}
