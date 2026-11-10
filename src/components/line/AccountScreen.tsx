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
        {/* One sentence. The provider name is the heading right above it, so
            naming it again read as a third title on the same card. */}
        <p className="text-muted-foreground text-xs leading-relaxed">
          Один вход — все серверы проекта.
          {serverCount > 0 && ` Серверов в проекте: ${serverCount}.`}
        </p>
      </div>

      {/* The login card is the first screen after the provider connects, so it
          uses the same panel surface as the server dock. Under the old design
          `data-line-glass` degrades to the previous plain card. */}
      <div data-line-glass className="flex flex-col gap-4 p-6">
        <AuthForm
          registrationAvailable={registrationAvailable}
          loading={loading}
          error={error}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}
