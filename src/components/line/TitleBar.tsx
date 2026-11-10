import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { brand } from "@/brand/generated";
import BrandMark from "@/components/line/BrandMark";
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

export interface TitleBarProps {
  /** Breadcrumb shown next to the product name. */
  context?: string;
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
export default function TitleBar({ context }: TitleBarProps) {
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
        "justify-between gap-3 pr-1 pl-3 select-none",
      )}
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex min-w-0 items-center gap-2"
      >
        <BrandMark className="h-5 w-5" />
        <span
          data-tauri-drag-region
          className="text-foreground truncate text-xs font-semibold tracking-tight"
        >
          {brand.name}
        </span>
        {context && (
          <>
            <span
              aria-hidden="true"
              className="text-muted-foreground/60 text-xs"
            >
              /
            </span>
            <span
              data-tauri-drag-region
              className="text-muted-foreground truncate text-xs"
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
            aria-label="Свернуть окно"
            className="text-muted-foreground hover:text-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void toggleMaximizeWindow()}
            aria-label={maximized ? "Восстановить окно" : "Развернуть окно"}
            className="text-muted-foreground hover:text-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            {maximized ? (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void closeWindow()}
            aria-label="Закрыть окно"
            className="text-muted-foreground hover:bg-destructive hover:text-destructive-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </header>
  );
}
