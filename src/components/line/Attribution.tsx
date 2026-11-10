import { brand } from "@/brand/generated";
import { cn } from "@/lib/utils";

export interface AttributionProps {
  /** Main-interface placement, or the additional copy inside About. */
  placement?: "footer" | "header" | "about";
  className?: string;
}

/**
 * Required by LICENSE: "Работает на Line Launcher | Plus In Plus" /
 * "Powered by Line Launcher | Plus In Plus". Removing or hiding this credit
 * terminates permission to use Line Materials; it is not merely a convention.
 *
 * Configuration selects footer/header and language only. About always repeats
 * the credit. There is no visibility breakpoint or About-only configuration.
 * Styling follows Obsy's muted meta text; the text itself is a fixed constant.
 */
export default function Attribution({
  placement,
  className,
}: AttributionProps) {
  const where = placement ?? brand.attribution.placement;
  const { language, en, ru } = brand.attribution;
  const lines = language === "en" ? [en] : language === "ru" ? [ru] : [ru, en];

  return (
    <span
      data-line-attribution={where}
      className={cn(
        "text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5",
        where === "about"
          ? "flex-col items-start gap-1 text-xs"
          : "text-[12px]",
        className,
      )}
    >
      {lines.map((line, index) => (
        <span key={line} className="flex items-center gap-1.5">
          {index > 0 && where !== "about" && <span aria-hidden="true">|</span>}
          <span>{line}</span>
        </span>
      ))}
    </span>
  );
}
