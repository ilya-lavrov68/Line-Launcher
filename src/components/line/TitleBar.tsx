import { Copy, CropSquare, Minus, X } from "@/components/ui/icons";
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
  /** Breadcrumb shown after the fixed brand mark. */
  context?: string;
  /** App-level feature actions, such as official news; omitted until implemented. */
  actions?: React.ReactNode;
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
export default function TitleBar({ context, actions }: TitleBarProps) {
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
        {/* A fixed-width mark pins the logo to the rail's corner regardless of
            its expanded width. Keep the product name off this compact chrome. */}
        <div
          data-tauri-drag-region
          className="flex w-12 shrink-0 items-center justify-center"
        >
          <BrandMark className="h-5 w-5 shrink-0" />
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
      {(actions || hasCustomFrame) && (
        <div className="flex shrink-0 items-center gap-2">
          {actions && (
            <div
              data-window-actions
              role="group"
              aria-label={t("window.actions")}
              className="flex items-center gap-1"
            >
              {actions}
            </div>
          )}
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
                aria-label={
                  maximized ? t("window.restore") : t("window.maximize")
                }
                className="text-muted-foreground hover:text-foreground h-9 w-11 cursor-pointer rounded-none"
              >
                {maximized ? (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <CropSquare className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>
              {/* Keep the close control quiet at rest like its neighbors; reveal
                  the destructive red surface on hover and keyboard focus. */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void closeWindow()}
                aria-label={t("window.close")}
                className="text-muted-foreground hover:bg-destructive-strong hover:text-destructive-foreground focus-visible:bg-destructive-strong focus-visible:text-destructive-foreground h-9 w-11 cursor-pointer rounded-none"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
