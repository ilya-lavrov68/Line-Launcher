import { AlertTriangle, Loader2, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  if (unconfigured) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2 className="text-foreground text-lg font-bold tracking-tight">
          Сборка не настроена
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          В этой сборке не указан адрес провайдера. Сообщите об этом тому, кто
          её распространяет: перед сборкой установщика нужно заполнить
          <span className="text-foreground font-mono">
            {" "}
            branding/provider.json
          </span>
          . Вводить адрес вручную игроку не требуется.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 text-center">
      <div className="bg-primary/10 text-primary border-primary/20 flex h-10 w-10 items-center justify-center rounded-xl border">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <Server className="h-5 w-5" aria-hidden="true" />
        )}
      </div>
      <h2 className="text-foreground text-lg font-bold tracking-tight">
        {loading ? "Подключение к проекту" : "Нет соединения"}
      </h2>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {loading
          ? "Загружаем список серверов. Адрес уже настроен в этой сборке — вводить ничего не нужно."
          : "Не удалось загрузить список серверов. Проверьте интернет и попробуйте снова."}
      </p>

      <div className="min-h-12 w-full" aria-live="polite">
        {error && (
          <p
            role="alert"
            className="text-destructive border-destructive/20 bg-destructive/5 rounded-lg border p-3 text-xs"
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
          Повторить
        </Button>
      )}
    </div>
  );
}
