import { ArrowUpRight, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/line/i18n";
import type { InstallProgress, McInstallProgress } from "@/types/line";

export default function DownloadWidget({
  serverName,
  active,
  minecraft,
  progress,
  error,
  onOpen,
  onDismiss,
  onCancel,
}: {
  serverName: string;
  active: boolean;
  minecraft: McInstallProgress | null;
  progress: InstallProgress | null;
  error: string | null;
  onOpen: () => void;
  onDismiss: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const fraction = minecraft?.filesTotal
    ? (minecraft.filesDone ?? 0) / minecraft.filesTotal
    : minecraft?.totalBytes
      ? minecraft.receivedBytes / minecraft.totalBytes
      : null;
  const percent = minecraft
    ? fraction === null
      ? null
      : Math.max(0, Math.min(100, Math.round(fraction * 100)))
    : progress && Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, Math.round(progress.percent)))
      : null;
  const phase: Record<string, string> = {
    resolve: t("mc.stageResolve"),
    download: t("mc.stageDownload"),
    "source-files": t("mc.stageFiles"),
    verify: t("mc.stageVerify"),
    extract: t("mc.stageExtract"),
    commit: t("mc.stageCommit"),
    cached: t("mc.stageCached"),
    libraries: t("mc.stageLibraries"),
    assets: t("mc.stageAssets"),
    runtime: t("mc.stageRuntime"),
    natives: t("mc.stageNatives"),
    loader: t("mc.stageLoader"),
    task: t("mc.stageTask"),
  };
  const stage = minecraft
    ? (phase[minecraft.stage] ?? t("mc.stageWorking"))
    : t("download.backgroundWorking");
  const caption =
    error ||
    (active
      ? stage
      : progress?.phase === "cancelled"
        ? t("download.cancelled")
        : t("download.finished"));
  return (
    <aside
      aria-label={t("download.widgetTitle")}
      data-testid="download-widget"
      data-line-glass
      className="absolute right-4 bottom-4 z-30 w-[min(22rem,calc(100%-2rem))] rounded-[var(--radius-panel)] p-3"
    >
      <div className="flex items-start gap-3">
        <Download
          className="text-primary mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-xs font-semibold">
            {serverName}
          </div>
          <div
            role="status"
            className="text-muted-foreground mt-1 text-[11px] leading-relaxed break-words"
          >
            {caption}
            {active && percent !== null ? ` · ${percent}%` : ""}
          </div>
          {active && (
            <div
              role="progressbar"
              aria-label={t("download.widgetTitle")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              className="bg-fill mt-2 h-1.5 overflow-hidden rounded-full"
            >
              <div
                className={
                  percent === null
                    ? "bg-primary h-full w-1/3 animate-pulse"
                    : "bg-primary h-full transition-[width]"
                }
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
          )}
        </div>
        {!active && (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onDismiss}
            aria-label={t("download.dismiss")}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        {active && onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("detail.cancelDownload")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onOpen}>
          {t("download.open")}{" "}
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </aside>
  );
}
