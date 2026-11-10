import { m } from "framer-motion";
import { CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress, ProgressValue } from "@/components/ui/progress";
import { formatSize } from "@/lib/utils";
import type {
  InstallPhase,
  InstallProgress as ProgressData,
} from "@/types/line";

export interface InstallProgressProps {
  progress: ProgressData;
  error?: string;
  onCancel?: () => void;
  onRetry?: () => void;
}

const labels: Record<InstallPhase, string> = {
  downloading: "Скачивание сборки",
  verifying: "Проверка SHA-256",
  extracting: "Распаковка сборки",
  committing: "Подготовка к запуску",
  completed: "Сборка установлена",
  cancelled: "Установка отменена",
  failed: "Установка не завершена",
};

/**
 * Installation progress. Reuses Obsy's Progress primitive exactly as
 * LaunchButton does (`value` + thin track), with Obsy's emerald success and
 * amber/destructive problem states. Framer only fades the container.
 */
export default function InstallProgress({
  progress,
  error,
  onCancel,
  onRetry,
}: InstallProgressProps) {
  const finished = progress.phase === "completed";
  const failed = progress.phase === "failed";
  const active =
    progress.phase === "downloading" || progress.phase === "extracting";
  const percent = Math.min(100, Math.max(0, progress.percent));
  const extracting = ["extracting", "committing", "completed"].includes(
    progress.phase,
  );
  const extractedBytes = finished
    ? progress.unpackedBytes
    : progress.extractedBytes;
  const bytes = extracting
    ? `${formatSize(extractedBytes)} / ${formatSize(progress.unpackedBytes)}`
    : `${formatSize(progress.receivedBytes)} / ${formatSize(progress.totalBytes)}`;

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-fill/50 flex flex-col gap-3 rounded-[var(--radius-control)] p-3"
    >
      <div className="flex items-center gap-2">
        {finished ? (
          <CheckCircle2
            className="text-line-online h-5 w-5"
            aria-hidden="true"
          />
        ) : failed ? (
          <ShieldAlert
            className="text-destructive h-5 w-5"
            aria-hidden="true"
          />
        ) : (
          <RefreshCw
            className="text-primary h-5 w-5 animate-spin"
            aria-hidden="true"
          />
        )}
        <span className="text-foreground text-sm font-semibold" role="status">
          {labels[progress.phase]}
        </span>
      </div>

      <Progress
        value={percent}
        aria-label={labels[progress.phase]}
        aria-valuetext={`${labels[progress.phase]}, ${bytes}`}
        className="h-1.5 w-full transition-[width]"
      >
        <ProgressValue className="sr-only" />
      </Progress>

      <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs tabular-nums">
        <span>{bytes}</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px]">{Math.round(percent)}%</span>
          {active && onCancel && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              className="cursor-pointer text-xs"
            >
              Отменить
            </Button>
          )}
          {failed && onRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="cursor-pointer text-xs"
            >
              Повторить
            </Button>
          )}
        </span>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-xs leading-relaxed">
          {error}
        </p>
      )}
      {finished && (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          Файлы проверены. Если провайдер настроил запуск, кнопка «Играть»
          доступна ниже.
        </p>
      )}
    </m.div>
  );
}
