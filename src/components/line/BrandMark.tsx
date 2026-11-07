import { Layers2 } from "lucide-react";
import { brand } from "@/brand/generated";
import { cn } from "@/lib/utils";

export interface BrandMarkProps {
  /** Tailwind size classes. Defaults to Obsy's header mark size. */
  className?: string;
}

/**
 * Product mark, supplied as a standalone transparent SVG/PNG via
 * `branding/assets.logo`.
 *
 * A monochrome SVG authored with `currentColor` is painted through a CSS mask so
 * it inherits `text-primary` and therefore follows every branding preset — the
 * same tint Obsy applies to its own header logo. Colour artwork keeps its own
 * fills and is rendered as a plain image. Neither path introduces a background.
 */
export default function BrandMark({ className }: BrandMarkProps) {
  if (brand.logo && brand.logoTinted) {
    // Vite inlines small SVGs as a data: URL containing single quotes. An
    // unquoted CSS url(...) with quotes inside is invalid and silently dropped,
    // which leaves a solid colour block instead of the mark. Always quote.
    const mask = `url("${brand.logo.replace(/"/g, '\\"')}")`;
    return (
      <span
        data-line-brand-mark="tinted"
        aria-hidden="true"
        className={cn("bg-primary inline-block h-8 w-8 shrink-0", className)}
        style={{
          maskImage: mask,
          maskRepeat: "no-repeat",
          maskPosition: "center",
          maskSize: "contain",
          WebkitMaskImage: mask,
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          WebkitMaskSize: "contain",
        }}
      />
    );
  }
  if (brand.logo) {
    return (
      <img
        data-line-brand-mark="image"
        src={brand.logo}
        alt=""
        aria-hidden="true"
        className={cn("h-8 w-auto object-contain", className)}
      />
    );
  }
  return (
    <Layers2
      data-line-brand-mark="fallback"
      className={cn("text-primary h-8 w-8", className)}
      aria-hidden="true"
    />
  );
}
