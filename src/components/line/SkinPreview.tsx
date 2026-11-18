import { useEffect, useRef, useState } from "react";
import { skinLayout } from "@/lib/line/skin";
import { cn } from "@/lib/utils";
import type { SkinModel } from "@/types/line";
import { useT } from "@/lib/line/i18n";

export interface SkinPreviewProps {
  /** Object URL or provider HTTPS texture URL. */
  src?: string | null;
  model: SkinModel;
  /** Rendered pixel scale. The silhouette is 16x32 skin pixels. */
  scale?: number;
  /** Bytes are still in flight: draw nothing rather than a "no skin" mark. */
  loading?: boolean;
  className?: string;
}

/**
 * Flat front-view skin preview.
 *
 * Draws the texture rectangles with smoothing disabled so pixels stay crisp,
 * using the same layout rules as the game (classic/slim arms, mirrored limbs on
 * a legacy 64x32 texture). No 3D dependency is introduced.
 */
export default function SkinPreview({
  src,
  model,
  scale = 6,
  loading = false,
  className,
}: SkinPreviewProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src, model]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!src) return;

    let cancelled = false;
    const image = new Image();
    // Provider textures are cross-origin; without this the canvas would be
    // tainted, which is fine for display but breaks any future export.
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      if (cancelled) return;
      // Trust the decoded image, not the file name.
      const legacy = image.naturalHeight === 32;
      if (
        image.naturalWidth !== 64 ||
        !(image.naturalHeight === 64 || legacy)
      ) {
        setFailed(true);
        return;
      }
      for (const rect of skinLayout(model, legacy)) {
        context.save();
        if (rect.flip) {
          context.translate((rect.dx + rect.sw) * scale, rect.dy * scale);
          context.scale(-1, 1);
          context.drawImage(
            image,
            rect.sx,
            rect.sy,
            rect.sw,
            rect.sh,
            0,
            0,
            rect.sw * scale,
            rect.sh * scale,
          );
        } else {
          context.drawImage(
            image,
            rect.sx,
            rect.sy,
            rect.sw,
            rect.sh,
            rect.dx * scale,
            rect.dy * scale,
            rect.sw * scale,
            rect.sh * scale,
          );
        }
        context.restore();
      }
    };
    image.onerror = () => {
      if (!cancelled) setFailed(true);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, model, scale]);

  return (
    <div
      data-line-icon
      className={cn(
        // `relative` so the failure mark can be positioned instead of flowing.
        // The placeholder used to be a paragraph, and a paragraph in a 32×64
        // box does not shrink: it pushed the wardrobe card's grid row open,
        // clipped the skin name and overran the row below. A mark that cannot
        // affect layout is the only safe shape here — the caller decides the
        // size, and this component must never be the reason a box grows.
        "relative flex items-center justify-center overflow-hidden",
        className,
      )}
    >
      {loading ? null : failed || !src ? (
        /* A slashed cube: says "no texture" without a sentence that has to be
           translated into eleven layouts and does not fit in any of them. */
        <span
          role="img"
          aria-label={failed ? t("skin.previewFailed") : t("skin.none")}
          title={failed ? t("skin.previewFailed") : t("skin.none")}
          className="text-muted-foreground/50 absolute inset-0 flex items-center justify-center"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
            className="size-1/2 max-h-6 max-w-6"
          >
            <path d="M12 3 3 8v8l9 5 9-5V8l-9-5Z" />
            <path d="m3 8 9 5 9-5" />
            <path d="M12 13v8" />
            <path d="M5 19 19 5" />
          </svg>
        </span>
      ) : (
        <canvas
          ref={canvasRef}
          width={16 * scale}
          height={32 * scale}
          role="img"
          aria-label={t("skin.previewAria", {
            model: model === "slim" ? "slim" : "classic",
          })}
          className="[image-rendering:pixelated]"
        />
      )}
    </div>
  );
}
