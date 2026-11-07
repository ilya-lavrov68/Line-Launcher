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
          <Info className="h-4 w-4" />
          <span className="sr-only">О программе / About</span>
        </DialogTrigger>
      )}
      <DialogContent className="p-5 sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <BrandMark className="h-5 w-5" />
            {brand.name}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-xs leading-relaxed">
            {brand.description}
          </p>
          <div className="border-border/40 bg-card/50 flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-xs">Версия</span>
              <span className="text-foreground font-mono text-xs">
                v{version}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-xs">Издатель</span>
              <span className="text-foreground text-xs">{brand.publisher}</span>
            </div>
          </div>
          <div className="border-border/40 border-t pt-3">
            <Attribution placement="about" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
