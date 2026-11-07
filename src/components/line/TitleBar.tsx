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
 * Custom window frame. Uses the same surface tokens as Obsy's header
 * (`bg-card/50`, `border-border/50`, backdrop blur) so it follows every branding
 * preset, and the caption buttons use the shared Button primitive so keyboard
 * focus and disabled states behave like the rest of the launcher.
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
      className={cn(
        "border-border/50 bg-card/50 flex h-11 w-full shrink-0 items-center",
        "justify-between gap-3 border-b pr-1 pl-3 backdrop-blur-md select-none",
      )}
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex min-w-0 items-center gap-2"
      >
        <BrandMark className="h-4 w-4" />
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
            <Minus className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void toggleMaximizeWindow()}
            aria-label={maximized ? "Восстановить окно" : "Развернуть окно"}
            className="text-muted-foreground hover:text-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            {maximized ? (
              <Copy className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Square className="h-3 w-3" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void closeWindow()}
            aria-label="Закрыть окно"
            className="text-muted-foreground hover:bg-destructive hover:text-destructive-foreground h-9 w-11 cursor-pointer rounded-none"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}
    </header>
  );
}
