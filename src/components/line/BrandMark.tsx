import { Layers2 } from "lucide-react";
import { brand } from "@/brand/generated";
import { cn } from "@/lib/utils";

export interface BrandMarkProps {
  /** Tailwind size classes. Defaults to Obsy's header mark size. */
  className?: string;
}

/**
 * Product mark. Uses the configured branding logo when present, otherwise the
 * built-in Lucide mark tinted with `text-primary` exactly like Obsy's header
 * logo (`className="text-primary h-8 w-auto"`).
 */
export default function BrandMark({ className }: BrandMarkProps) {
  if (brand.logo) {
    return (
      <img
        src={brand.logo}
        alt=""
        aria-hidden="true"
        className={cn("h-8 w-auto object-contain", className)}
      />
    );
  }
  return (
    <Layers2
      className={cn("text-primary h-8 w-8", className)}
      aria-hidden="true"
    />
  );
}
