import { PackageX, RotateCcw, ShieldCheck } from "@/components/ui/icons";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/line/i18n";
import { lineApi } from "@/lib/line/api";

export interface QuarantineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  /** Exactly what the launch scan refused — never a guess, never a superset. */
  paths: string[];
  /** Called after a successful batch so the caller can re-check or relaunch. */
  onChanged?: (moved: string[]) => void;
}

/**
 * The decision a blocked launch asks for.
 *
 * Two things this dialog deliberately does *not* do. It does not pre-select
 * anything: the box starts empty, so accepting the prompt is a choice about
 * specific files rather than a click-through. And it does not offer "delete":
 * the files are moved, the message says so, and the same dialog is where they
 * come back from.
 *
 * The list is the launch scan's own output (`PackScan::unproved`). Showing
 * anything else — a directory scan, a heuristic, "all jars in mods" — would
 * invite people to approve files the launcher never actually examined.
 */
export default function QuarantineDialog({
  open,
  onOpenChange,
  serverId,
  paths,
  onChanged,
}: QuarantineDialogProps) {
  const t = useT();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [refused, setRefused] = useState<string[]>([]);

  const toggle = (path: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const run = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    setRefused([]);
    try {
      const outcome = await lineApi.quarantineMods(serverId, [...selected]);
      setRefused(outcome.refused);
      if (outcome.moved.length > 0) {
        onChanged?.(outcome.moved);
        onOpenChange(false);
      }
      if (outcome.moved.length === 0 && outcome.refused.length === 0) {
        setError(t("quarantine.nothingMoved"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-5 sm:max-w-[520px]"
        data-testid="quarantine-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <PackageX className="size-4 shrink-0" aria-hidden="true" />
            {t("quarantine.title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
            {t("quarantine.description")}
          </DialogDescription>
        </DialogHeader>

        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
          {paths.map((path) => (
            <li key={path}>
              <label
                className="hover:bg-fill-subtle flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 transition-colors"
                title={path}
              >
                <input
                  type="checkbox"
                  checked={selected.has(path)}
                  onChange={() => toggle(path)}
                  className="accent-primary size-3.5 shrink-0 cursor-pointer"
                />
                <span className="text-foreground truncate font-mono text-[12px]">
                  {path}
                </span>
              </label>
            </li>
          ))}
        </ul>

        {refused.length > 0 && (
          <ul
            className="text-destructive flex flex-col gap-1 text-[12px] leading-relaxed"
            role="alert"
          >
            {refused.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}

        {error && (
          <p
            className="text-destructive text-[12px] leading-relaxed"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-[11px]">
            {t("quarantine.restoreHint")}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer text-xs"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              className="cursor-pointer gap-1.5 text-xs"
              onClick={() => void run()}
              disabled={busy || selected.size === 0}
            >
              {busy ? (
                <RotateCcw
                  className="size-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <ShieldCheck className="size-3.5" aria-hidden="true" />
              )}
              {busy
                ? t("quarantine.moving")
                : t("quarantine.confirm", { count: selected.size })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
