import AuthForm from "@/components/line/AuthForm";
import BrandMark from "@/components/line/BrandMark";
import type { AuthMode } from "@/types/line";

export interface AccountScreenProps {
  providerName: string;
  serverCount: number;
  registrationAvailable: boolean;
  loading: boolean;
  error?: string;
  onSubmit: (mode: AuthMode, username: string, password: string) => void;
}

/**
 * The one sign-in gate for the whole launcher.
 *
 * The provider address is already baked into the build, so this is the first and
 * only thing a new player fills in. After it, every server in the config is
 * available — there is no per-server login.
 */
export default function AccountScreen({
  providerName,
  serverCount,
  registrationAvailable,
  loading,
  error,
  onSubmit,
}: AccountScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <BrandMark className="h-9" />
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">
          {providerName}
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Войдите один раз — и все серверы проекта будут доступны.
          {serverCount > 0 && ` Сейчас в проекте ${serverCount} серверов.`}
        </p>
      </div>

      {/* The login card is the first screen after the provider connects, so it
          uses the same glass surface as the server dock. Under the old design
          `data-line-glass` degrades to the previous plain card. */}
      <div
        data-line-glass
        className="relative flex flex-col gap-4 overflow-hidden p-6"
      >
        <div className="from-primary/5 pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent" />
        <div className="relative z-10">
          <AuthForm
            providerName={providerName}
            registrationAvailable={registrationAvailable}
            loading={loading}
            error={error}
            onSubmit={onSubmit}
          />
        </div>
      </div>
    </div>
  );
}
