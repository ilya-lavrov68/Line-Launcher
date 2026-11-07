import { useEffect, useState } from "react";
import SkinPreview from "@/components/line/SkinPreview";
import { lineApi } from "@/lib/line/api";
import { cn } from "@/lib/utils";
import type { SkinModel } from "@/types/line";

export interface SkinThumbProps {
  /** SHA-256 id of a texture in the local library. */
  skinId: string;
  model: SkinModel;
  className?: string;
  scale?: number;
}

/**
 * Renders a texture from the local library. Bytes come from Rust and are turned
 * into an object URL here, so no file:// access or asset protocol permission is
 * needed. Every URL is revoked on change/unmount — a grid of 64 skins must not
 * leak blobs while the player scrolls.
 */
export default function SkinThumb({
  skinId,
  model,
  className,
  scale = 3,
}: SkinThumbProps) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let revoked: string | undefined;
    let cancelled = false;
    setUrl(undefined);
    void lineApi
      .skinTexture(skinId)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [skinId]);

  return (
    <SkinPreview
      src={url}
      model={model}
      scale={scale}
      className={cn("shrink-0", className)}
    />
  );
}
