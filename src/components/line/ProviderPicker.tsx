import { ChevronRight, Link2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BakedProvider } from "@/brand/provider-types";

export interface ProviderPickerProps {
  providers: BakedProvider[];
  /** True when the build also permits typing an arbitrary config URL. */
  allowManualUrl: boolean;
  loading: boolean;
  error?: string;
  activeUrl?: string;
  onSelect: (provider: BakedProvider) => void;
  onManual: () => void;
}

/**
 * Connection screen for a build whose providers were declared in
 * `branding/provider.json`. No URL field: the player picks a server project and
 * then registers or signs in. Addresses ship inside the binary.
 */
export default function ProviderPicker({
  providers,
  allowManualUrl,
  loading,
  error,
  activeUrl,
  onSelect,
  onManual,
}: ProviderPickerProps) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="bg-primary/10 text-primary border-primary/20 flex h-10 w-10 items-center justify-center rounded-xl border">
          <Server className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2 className="text-foreground text-lg font-bold tracking-tight">
          Выберите проект
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Адреса уже настроены в этой сборке. Выберите проект, затем
          зарегистрируйтесь или войдите — ничего вводить вручную не нужно.
        </p>
      </div>

      <div className="min-h-12" aria-live="polite">
        {error && (
          <p
            role="alert"
            className="text-destructive border-destructive/20 bg-destructive/5 rounded-lg border p-3 text-xs"
          >
            {error}
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {providers.map((provider) => (
          <li key={provider.id}>
            <button
              type="button"
              disabled={loading}
              onClick={() => onSelect(provider)}
              aria-label={`Подключиться к ${provider.name}`}
              className="border-border/40 bg-card/60 hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-ring flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-foreground truncate text-sm font-semibold">
                  {provider.name}
                </span>
                <span className="text-muted-foreground font-mono text-[10px]">
                  {provider.configUrl === activeUrl
                    ? "подключён"
                    : "готов к подключению"}
                </span>
              </span>
              <ChevronRight
                className="text-muted-foreground h-4 w-4 shrink-0"
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ul>

      {loading && (
        <p className="text-muted-foreground text-center text-xs" role="status">
          Проверяем конфигурацию…
        </p>
      )}

      {allowManualUrl && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={onManual}
          className="text-muted-foreground cursor-pointer items-center gap-1.5 self-center text-xs"
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          Указать другой адрес
        </Button>
      )}
    </div>
  );
}
