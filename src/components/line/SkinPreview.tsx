import { useEffect, useRef, useState } from "react";
import { isLegacySkin, readPngHeader, skinLayout } from "@/lib/line/skin";
import { cn } from "@/lib/utils";
import type { SkinModel } from "@/types/line";

export interface SkinPreviewProps {
  /** Object URL or provider HTTPS texture URL. */
  src?: string | null;
  model: SkinModel;
  /** Rendered pixel scale. The silhouette is 16x32 skin pixels. */
  scale?: number;
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
  className,
}: SkinPreviewProps) {
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
        "flex items-center justify-center overflow-hidden",
        className,
      )}
    >
      {failed || !src ? (
        <span className="text-muted-foreground p-4 text-center text-[12px] leading-relaxed">
          {failed ? "Не удалось показать текстуру" : "Скин не выбран"}
        </span>
      ) : (
        <canvas
          ref={canvasRef}
          width={16 * scale}
          height={32 * scale}
          role="img"
          aria-label={`Предпросмотр скина, модель ${model === "slim" ? "slim" : "classic"}`}
          className="[image-rendering:pixelated]"
        />
      )}
    </div>
  );
}

/** Exposed for the wardrobe so it can pick the layout without decoding twice. */
export function previewIsLegacy(bytes: Uint8Array): boolean {
  const header = readPngHeader(bytes);
  return header ? isLegacySkin(header) : false;
}
