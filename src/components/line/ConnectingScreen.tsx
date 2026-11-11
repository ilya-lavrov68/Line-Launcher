import { AlertTriangle, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/line/i18n";
import { SkeletonAuthCard } from "@/components/line/Skeleton";

export interface ConnectingScreenProps {
  loading: boolean;
  error?: string;
  /** Set when the build was shipped without branding/provider.json filled in. */
  unconfigured?: boolean;
  onRetry: () => void;
}

/**
 * Startup screen for a configured build. There is no address field and no
 * provider choice: the launcher belongs to one provider and connects to the
 * address baked in at build time. The player only registers or signs in.
 */
export default function ConnectingScreen({
  loading,
  error,
  unconfigured = false,
  onRetry,
}: ConnectingScreenProps) {
  const t = useT();
  if (unconfigured) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
        <AlertTriangle
          data-line-icon
          className="h-7 w-7 text-amber-400"
          aria-hidden="true"
        />
        <h2 className="text-foreground text-lg font-bold tracking-tight">
          {t("connect.unconfiguredTitle")}
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("connect.unconfiguredBody")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
      {/* The retry path keeps its icon — there is nothing to sketch there: the
          player is waiting for a request they already know the shape of. The
          skeleton belongs to the very first load, where the shell is still
          empty and the sign-in card is what will appear (see `LineLauncher`). */}
      {loading ? (
        <SkeletonAuthCard />
      ) : (
        <Server
          data-line-icon
          className="text-primary h-7 w-7"
          aria-hidden="true"
        />
      )}
      <h2 className="text-foreground text-lg font-bold tracking-tight">
        {loading ? t("connect.title") : t("connect.titleFailed")}
      </h2>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {loading ? t("connect.body") : t("connect.bodyFailed")}
      </p>

      <div className="min-h-12 w-full" aria-live="polite">
        {error && (
          <p
            role="alert"
            className="text-destructive bg-destructive/10 rounded-[var(--radius-control)] p-3 text-xs"
          >
            {error}
          </p>
        )}
      </div>

      {!loading && (
        <Button
          size="sm"
          onClick={onRetry}
          className="cursor-pointer items-center gap-1.5 text-xs"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}
