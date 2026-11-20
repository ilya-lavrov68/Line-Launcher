import { Copy, Minus, Square, X } from "lucide-react";
import { brand } from "@/brand/generated";
import BrandMark from "@/components/line/BrandMark";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  closeWindow,
  hasCustomFrame,
  isWindowMaximized,
  minimizeWindow,
  onMaximizeChanged,
  toggleMaximizeWindow,
} from "@/lib/line/window";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/line/i18n";

export interface TitleBarProps {
  /** Breadcrumb shown next to the product name. */
  context?: string;
  /**
   * Width of the rail below, in pixels.
   *
   * The brand lockup sits directly above the rail, and the rail animates its
   * own width between 60 and 208. Giving this row the same number and the same
   * transition is what keeps the two in step: the logo stays over the rail
   * instead of drifting across it while it opens, and the name unfolds as the
   * row grows rather than appearing at the end of a jump.
   */
  railWidth: number;
  /** Whether the rail is collapsed: below this width the name is not drawn. */
  collapsed: boolean;
}

/**
 * Custom window frame. Transparent by design: it floats in the window's 6px
 * inset over the page's colour field, and the only thing separating it from the
 * content is space. A bar with a background and a hairline under it read as the
 * third strip in a row and cut the window into bands.
 *
 * `data-tauri-drag-region` marks the draggable area; interactive children opt out
 * automatically because Tauri ignores the drag region on interactive elements.
 */
export default function TitleBar({
  context,
  railWidth,
  collapsed,
}: TitleBarProps) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!hasCustomFrame) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void isWindowMaximized().then((value) => {
      if (!disposed) setMaximized(value);
    });
    void onMaximizeChanged((value) => {
      if (!disposed) setMaximized(value);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <header
      data-tauri-drag-region
      // No background and no hairline under it: the header floats in the same
      // 6px inset as the panels, over the page's colour. A full-width bar with a
      // border was the third strip in a row and cut the window in two.
      className={cn(
        "flex h-11 w-full shrink-0 items-center",
        "justify-between gap-3 pr-1 select-none",
      )}
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex min-w-0 items-center gap-3"
      >
        {/* The lockup: the mark alone over a collapsed rail, the mark and the
            product name over an open one. It sits here rather than inside the
            rail so the brand is *above* the navigation, and it tracks the
            rail's animated width so the two never drift apart mid-toggle.
            The name is not unmounted when collapsed — it keeps its place and
            simply is not drawn, so the mark does not slide when it reappears. */}
        <div
          data-tauri-drag-region
          style={{ width: railWidth }}
          className={cn(
            "flex shrink-0 items-center gap-2 transition-[width] duration-180 ease-out",
            collapsed ? "justify-center" : "pl-4",
          )}
        >
          <BrandMark className="h-5 w-5 shrink-0" />
          {!collapsed && (
            <span
              data-tauri-drag-region
              className="text-foreground truncate text-xs font-semibold tracking-tight"
            >
              {brand.name}
            </span>
          )}
        </div>
        {context && (
          <>
            <span
              aria-hidden="true"
              className="text-muted-foreground/60 shrink-0 text-xs"
            >
              /
            </span>
            <span
              data-tauri-drag-region
              className="text-muted-foreground min-w-0 truncate text-xs"
            >
              {context}
            </span>
          </>
        )}
      </div>
      {hasCustomFrame && (
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void minimizeWindow()}
            aria-label={t("window.minimize")}
            className="text-muted-foreground hover:text-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void toggleMaximizeWindow()}
            aria-label={maximized ? t("window.restore") : t("window.maximize")}
            className="text-muted-foreground hover:text-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            {maximized ? (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
          {/*
            Grey at rest like the other two, red on hover — the hover was the
            complaint, and it had two faults. The fill was `--destructive`, a
            pale coral chosen for error *text*; and `--destructive-foreground`
            pointed at a red of its own, so the ✕ was drawn red-on-red (1.23:1,
            invisible) and the square read as one dim smudge instead of a red
            button. Both are fixed: `--destructive-strong` fills the square,
            `--destructive-foreground` is near-white, and this button is the
            only consumer of either.
          */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void closeWindow()}
            aria-label={t("window.close")}
            className="text-muted-foreground hover:bg-destructive-strong hover:text-destructive-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </header>
  );
}
