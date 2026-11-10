import { Info } from "lucide-react";
import { brand } from "@/brand/generated";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import Attribution from "./Attribution";
import BrandMark from "./BrandMark";

export interface AboutDialogProps {
  version: string;
  /** Controlled mode: the side navigation owns the trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * About dialog built from Obsy's existing Dialog primitive and the same header
 * pattern as Obsy's UrlInstallModal (icon + bold title + muted description).
 * The mandatory Line Launcher | Plus In Plus credit is repeated here.
 * This is additional to the persistent footer/header credit, never a replacement.
 */
export default function AboutDialog({
  version,
  open,
  onOpenChange,
}: AboutDialogProps) {
  const controlled = open !== undefined;
  return (
    <Dialog {...(controlled ? { open, onOpenChange } : {})}>
      {!controlled && (
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-8 w-8 cursor-pointer"
              title="О программе / About"
            />
          }
        >
          <Info data-line-icon className="h-6 w-6" />
          <span className="sr-only">О программе / About</span>
        </DialogTrigger>
      )}
      {/* A small, centred card — not a sheet. The dialog primitive caps its
          width (see `dialog.tsx`), and everything inside is centred on one
          vertical axis, so the whole thing reads as a card you could hold.
          There is no `DialogHeader` here: a left-aligned title bar over a
          centred stack pulls the eye twice. */}
      <DialogContent className="max-w-[360px] p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{brand.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-5 text-center">
          <BrandMark className="h-9 w-9" />
          <div className="flex flex-col gap-0.5">
            <h2 className="text-foreground text-[15px] font-semibold tracking-tight">
              {brand.name}
            </h2>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {brand.description}
            </p>
          </div>
          <div className="bg-fill-subtle flex flex-col gap-1.5 self-stretch rounded-[var(--radius-control)] px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-[11px]">Версия</span>
              <span className="text-foreground font-mono text-[11px]">
                v{version}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-[11px]">
                Издатель
              </span>
              <span className="text-foreground text-[11px]">
                {brand.publisher}
              </span>
            </div>
          </div>
          <Attribution
            placement="about"
            className="border-border/40 w-full items-center! border-t pt-3"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
