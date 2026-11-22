import type { ReactElement, ReactNode } from "react";
import { History, RefreshCw } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { InstallReceipt, ReleaseHistory } from "@/types/line";
import { useT } from "@/lib/line/i18n";
import { SkeletonHistoryRows } from "@/components/line/Skeleton";

export interface ReleaseHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  history: ReleaseHistory | null;
  currentSha?: string;
  loading: boolean;
  error?: string;
  onRollback: (receipt: InstallReceipt) => void;
  /** Optional: the dock opens the dialog from its own history button. */
  trigger?: ReactNode;
}

/** Reuses Obsy Dialog/UrlInstallModal header and InstalledAddonCard row styling. */
export default function ReleaseHistoryDialog({
  open,
  onOpenChange,
  history,
  currentSha,
  loading,
  error,
  onRollback,
  trigger,
}: ReleaseHistoryDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger render={trigger as ReactElement} />}
      <DialogContent className="p-5 sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-bold">
            <History className="h-6 w-6" />
            {t("history.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
          {loading && !history && <SkeletonHistoryRows />}
          {!loading && !history?.releases.length ? (
            <p className="text-muted-foreground text-xs">
              {t("history.empty")}
            </p>
          ) : null}
          {history?.releases.length
            ? history.releases.map((receipt) => {
                const current = receipt.sha256 === currentSha;
                return (
                  <div
                    key={receipt.sha256}
                    className="bg-fill-subtle flex items-center justify-between gap-3 rounded-[var(--radius-item)] p-3.5"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-foreground truncate text-xs font-semibold">
                        {receipt.version}
                      </span>
                      <span className="text-muted-foreground font-mono text-[12px]">
                        {receipt.sha256.slice(0, 12)}
                      </span>
                    </div>
                    {current ? (
                      <span className="text-muted-foreground text-xs">
                        {t("history.current")}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={loading}
                        onClick={() => onRollback(receipt)}
                        className="cursor-pointer text-xs"
                      >
                        <RefreshCw
                          className={
                            loading
                              ? "h-4 w-4 animate-spin"
                              : "invisible h-4 w-4"
                          }
                          aria-hidden="true"
                        />
                        {t("history.rollback")}
                      </Button>
                    )}
                  </div>
                );
              })
            : null}
        </div>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
