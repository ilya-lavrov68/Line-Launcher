import { useEffect, useRef, useState } from "react";
import SkinPreview from "@/components/line/SkinPreview";
import { cn } from "@/lib/utils";
import type { SkinModel } from "@/types/line";

export interface SkinViewer3DProps {
  /** Provider HTTPS texture URL, or an object URL for a local file. */
  src?: string | null;
  model: SkinModel;
  className?: string;
  /** Height of the viewport, in pixels. The box keeps a 3:4 ratio. */
  height?: number;
}

/**
 * The player's active skin, in 3D.
 *
 * `skinview3d` is the library the Minecraft community uses for exactly this, and
 * it is the reason the dependency exists. Three things matter about how it is
 * wired here:
 *
 * 1. **It is loaded on demand.** `skinview3d` pulls in all of `three` (~600 KB).
 *    The servers screen — the one a player actually lands on — must not pay for
 *    a viewer they may never open, so the import is dynamic and the component
 *    shows a placeholder until the module arrives.
 * 2. **It always has a way out.** If WebGL is unavailable (a VM, software
 *    rendering disabled, a broken driver) or the texture is not CORS-readable,
 *    it falls over to the flat preview the wardrobe already uses instead of an
 *    empty black box. That is also the reduced-motion path: a slowly spinning
 *    model is exactly the decorative motion that setting asks us to drop.
 * 3. **It disposes.** A WebGL context is a scarce resource; `dispose()` frees
 *    it, and it is called on unmount and whenever the skin changes.
 *
 * The spin is a slow product-shot turn — a skin has a back, and it is worth
 * seeing. `autoRotateSpeed` is frames-based inside the library, so it is capped
 * low enough that 144 Hz does not turn it into a fan.
 */
export default function SkinViewer3D({
  src,
  model,
  className,
  height = 288,
}: SkinViewer3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "flat">(
    src ? "loading" : "flat",
  );

  // The skin usually arrives *after* the first render: the profile screen has to
  // read it out of the library first. Without this reset the component kept the
  // "flat" answer it gave while `src` was still undefined.
  useEffect(() => {
    setStatus(src ? "loading" : "flat");
  }, [src]);

  useEffect(() => {
    const host = hostRef.current;
    if (!src) return;
    // A `null` host here means the placeholder is still on screen; the status
    // reset above re-runs this effect once the host is mounted.
    if (!host) return;

    let cancelled = false;
    let dispose: (() => void) | undefined;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    void (async () => {
      try {
        const { SkinViewer } = await import("skinview3d");

        // The texture must be CORS-readable before three can upload it, and
        // `skinview3d` throws deep inside when it is not. Probing with a plain
        // <img> gives a clean yes/no, and the decoded image is reusable as the
        // skin source, so the fetch happens once.
        const texture = await new Promise<HTMLImageElement | null>(
          (resolve) => {
            const image = new Image();
            image.crossOrigin = "anonymous";
            image.referrerPolicy = "no-referrer";
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = src;
          },
        );
        if (cancelled) return;
        if (!texture) {
          setStatus("flat");
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.className = "h-full w-full";
        canvas.setAttribute("aria-hidden", "true");
        host.replaceChildren(canvas);

        const width = Math.max(160, Math.round(height * 0.75));
        const viewer = new SkinViewer({
          canvas,
          width,
          height,
          skin: texture,
          // The library calls the wide-arm layout "default"; the launcher calls
          // it "classic", which is what the game's own UI says.
          model: model === "slim" ? "slim" : "default",
        });
        // Lighting is left at the library's defaults (global 3.0, camera 0.6).
        // They look high next to a typical three.js scene, but skinview3d lights
        // with a plain ambient + camera pair and the skin textures are authored
        // for exactly that: halving them turned every model into a black
        // silhouette. `zoom` is the only knob worth touching — 0.9 frames the
        // body without clipping the feet.
        viewer.zoom = 0.9;
        viewer.autoRotate = !reduced;
        // A slow turn: a skin has a back, and it is worth seeing. The library
        // rotates per frame, so this stays a shot, not a fan.
        viewer.autoRotateSpeed = 0.6;

        dispose = () => {
          viewer.dispose();
          host.replaceChildren();
        };
        if (!cancelled) setStatus("ready");
      } catch (cause) {
        // A viewer that fails quietly is a viewer nobody can fix. The message
        // goes to the console (a developer's problem) while the player gets the
        // flat preview (not their problem).
        console.warn("3D skin viewer unavailable:", cause);
        if (!cancelled) setStatus("flat");
      }
    })();

    return () => {
      cancelled = true;
      try {
        dispose?.();
      } catch {
        // Disposal can race with context loss; there is nothing to recover.
      }
    };
  }, [src, model, height]);

  return (
    <div
      className={cn(
        "bg-fill-subtle relative overflow-hidden rounded-[var(--radius-item)]",
        "bg-[radial-gradient(120%_100%_at_50%_0%,rgba(255,255,255,0.09),transparent_70%)]",
        className,
      )}
      style={{ height }}
      data-line-skin-viewer={status}
    >
      {/* Mounted whenever there is a texture, *independently* of `status`.
          This is load-bearing: the effect that creates the viewer runs after the
          commit that first sees `src`, and it needs this ref by then. Gating the
          element on `status` meant the ref was null on that commit, the effect
          returned early, and nothing ever re-ran it — the viewer sat on
          "Готовим 3D…" forever. */}
      {src && <div ref={hostRef} className="absolute inset-0" />}
      {status === "loading" && (
        <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-xs">
          Готовим 3D…
        </div>
      )}
      {status === "flat" &&
        (src ? (
          <div className="absolute inset-0 flex items-center justify-center">
            {/* Same texture, flat projection — the fallback, not an empty box. */}
            <SkinPreview
              src={src}
              model={model}
              scale={Math.max(2, height / 42)}
            />
          </div>
        ) : (
          <div className="text-muted-foreground absolute inset-0 flex items-center justify-center text-xs">
            Скин не выбран
          </div>
        ))}
    </div>
  );
}
