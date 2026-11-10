import { History, Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  GameStatus,
  InstallReceipt,
  LineServer,
  ReleaseHistory,
} from "@/types/line";
import ReleaseHistoryDialog from "./ReleaseHistoryDialog";

export interface LaunchControlsProps {
  server: LineServer;
  receipt: InstallReceipt;
  status: GameStatus | null;
  busy: boolean;
  error?: string;
  historyOpen: boolean;
  history: ReleaseHistory | null;
  historyLoading: boolean;
  historyError?: string;
  onHistoryOpenChange: (open: boolean) => void;
  onRollback: (receipt: InstallReceipt) => void;
  onLaunch: () => void;
  onStop: () => void;
}

/** Obsy LaunchButton/InstanceControls patterns: full-width CTA + outline icon action. */
export default function LaunchControls({
  server,
  receipt,
  status,
  busy,
  error,
  historyOpen,
  history,
  historyLoading,
  historyError,
  onHistoryOpenChange,
  onRollback,
  onLaunch,
  onStop,
}: LaunchControlsProps) {
  const offline = server.launch_mode === "offline";
  const configured =
    offline ||
    Boolean(
      server.auth?.launch_ticket_url && server.auth?.session_exchange_url,
    );
  const starting = status?.phase === "starting";
  const running = status?.phase === "running";
  const active = starting || running;

  return (
    <div className="relative z-10 flex flex-col gap-3">
      <div className="flex gap-2">
        <Button
          disabled={!configured || (!active && busy) || !receipt}
          onClick={active ? onStop : onLaunch}
          className="h-10 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl text-sm font-semibold shadow-sm"
        >
          {active ? (
            starting ? (
              <RefreshCw className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <Square className="h-5 w-5" aria-hidden="true" />
            )
          ) : (
            <Play className="h-5 w-5 fill-current" aria-hidden="true" />
          )}
          <span>
            {active
              ? starting
                ? "Отменить запуск"
                : "Остановить игру"
              : configured
                ? "Играть"
                : "Запуск не настроен"}
          </span>
        </Button>
        <ReleaseHistoryDialog
          open={historyOpen}
          onOpenChange={onHistoryOpenChange}
          history={history}
          currentSha={receipt.sha256}
          loading={historyLoading}
          error={historyError}
          onRollback={onRollback}
          trigger={
            <Button
              variant="outline"
              size="icon"
              disabled={busy || active}
              title="История сборок"
              className="h-10 w-10 cursor-pointer rounded-xl"
            >
              <History className="h-5 w-5" aria-hidden="true" />
              <span className="sr-only">История сборок</span>
            </Button>
          }
        />
      </div>
      {starting && status?.message && (
        <p
          role="status"
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
        >
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          {status?.message}
        </p>
      )}
      {running && (
        <p
          role="status"
          className="text-line-online bg-line-online/10 flex items-center gap-1.5 rounded-[var(--radius-control)] p-3 text-xs"
        >
          Игра запущена. Установка и откат заблокированы до выхода.
        </p>
      )}
      {status?.phase === "exited" && (
        <p role="status" className="text-muted-foreground text-xs">
          Игра завершилась
          {typeof status.exitCode === "number"
            ? ` с кодом ${status.exitCode}`
            : ""}
          .
        </p>
      )}
      {status?.phase === "failed" && !error && (
        <p role="alert" className="text-destructive text-xs">
          {status.message ??
            "Запуск не завершился. Проверьте Java и мод авторизации провайдера."}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {offline && (
        <p className="text-muted-foreground text-[12px] leading-relaxed">
          Офлайн-сборка провайдера: используется ник аккаунта проекта, отдельный
          билет сервера и Microsoft-вход не требуются.
        </p>
      )}
      {!configured && (
        <p className="text-muted-foreground text-[12px] leading-relaxed">
          Сборка установлена, но провайдер не включил запуск через приватный
          IPC.
        </p>
      )}
    </div>
  );
}
