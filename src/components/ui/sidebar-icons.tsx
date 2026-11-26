import type { CSSProperties } from "react";
import {
  ChevronLeft,
  Info,
  Server,
  Settings,
  Shirt,
  UserRound,
  type LineIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** The replaceable icon slots used by the primary navigation rail. */
export type SidebarIconName =
  "servers" | "wardrobe" | "account" | "settings" | "about" | "collapse";

interface SidebarIconEntry {
  /** Set this only after the matching SVG is checked into public/icons/navigation/. */
  customAsset?: string;
  lucideFallback: LineIcon;
}

/**
 * Keep the shell's icon contract in one place. Until custom artwork is supplied,
 * every slot uses the existing Lucide glyph. Custom SVGs are monochrome alpha
 * masks, so the active/inactive icon color continues to follow `currentColor`.
 */
const sidebarIconRegistry: Record<SidebarIconName, SidebarIconEntry> = {
  servers: { lucideFallback: Server },
  wardrobe: { lucideFallback: Shirt },
  account: { lucideFallback: UserRound },
  settings: { lucideFallback: Settings },
  about: { lucideFallback: Info },
  collapse: { lucideFallback: ChevronLeft },
};

export interface SidebarIconProps {
  name: SidebarIconName;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}

export function SidebarIcon({
  name,
  className,
  "aria-hidden": ariaHidden = true,
}: SidebarIconProps) {
  const entry = sidebarIconRegistry[name];
  if (!entry.customAsset) {
    const Fallback = entry.lucideFallback;
    return <Fallback className={className} aria-hidden={ariaHidden} />;
  }

  const mask = `url("${entry.customAsset}")`;
  const style: CSSProperties = {
    maskImage: mask,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
    WebkitMaskImage: mask,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
  };
  return (
    <span
      aria-hidden={ariaHidden}
      className={cn("inline-block shrink-0 bg-current", className)}
      data-sidebar-icon={name}
      style={style}
    />
  );
}
