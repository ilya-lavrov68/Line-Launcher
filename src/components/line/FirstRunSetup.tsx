import { useState } from "react";
import { Button } from "@/components/ui/button";
import { resolveLanguage } from "@/lib/line/languages";
import { setLanguage, useT } from "@/lib/line/i18n";
import { LANGUAGES, LANGUAGE_NAMES, type Language } from "@/lib/line/languages";
import BackdropPicker from "@/components/line/BackdropPicker";
import type { LauncherSettings, SettingsSnapshot } from "@/types/line";

export default function FirstRunSetup({
  snapshot,
  onComplete,
}: {
  snapshot: SettingsSnapshot;
  onComplete: (settings: LauncherSettings) => Promise<void>;
}) {
  const t = useT();
  const [language, setSelectedLanguage] = useState<Language>(() =>
    resolveLanguage(
      snapshot.settings.language,
      typeof navigator === "undefined" ? undefined : navigator.language,
    ),
  );
  const [backdrop, setBackdrop] = useState(
    snapshot.settings.backdrop ?? "aurora",
  );
  const [motion, setMotion] = useState<"static" | "live">(
    snapshot.settings.backdropMotion === "static" ? "static" : "live",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onComplete({
        ...snapshot.settings,
        language,
        backdrop,
        backdropMotion: motion,
        onboardingCompleted: true,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      data-line-first-run-setup
      className="relative z-40 flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8"
    >
      <section className="bg-popover/95 border-border w-full max-w-xl rounded-[var(--radius-panel)] border p-6 shadow-2xl sm:p-8">
        <header className="mb-7 flex flex-col gap-2">
          <p className="text-muted-foreground text-xs font-medium tracking-[0.12em] uppercase">
            {t("onboarding.step")}
          </p>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
            {t("onboarding.title")}
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("onboarding.description")}
          </p>
        </header>

        <div className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-foreground mb-2 text-sm font-medium">
              {t("onboarding.language")}
            </legend>
            <div
              role="radiogroup"
              aria-label={t("onboarding.language")}
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {LANGUAGES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={language === option}
                  disabled={busy}
                  onClick={() => {
                    setSelectedLanguage(option);
                    setLanguage(option);
                  }}
                  className={`focus-visible:ring-ring min-h-10 rounded-[var(--radius-control)] border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${language === option ? "border-foreground/50 bg-fill text-foreground" : "border-border bg-fill-subtle text-muted-foreground hover:bg-fill"}`}
                >
                  {LANGUAGE_NAMES[option]}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-2">
            <h2 className="text-foreground text-sm font-medium">
              {t("onboarding.gradient")}
            </h2>
            <BackdropPicker
              value={backdrop}
              disabled={busy}
              onChange={setBackdrop}
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-foreground mb-2 text-sm font-medium">
              {t("onboarding.motion")}
            </legend>
            <div
              role="radiogroup"
              aria-label={t("onboarding.motion")}
              className="grid grid-cols-2 gap-2"
            >
              {(["static", "live"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={motion === option}
                  disabled={busy}
                  onClick={() => setMotion(option)}
                  className={`focus-visible:ring-ring min-h-10 rounded-[var(--radius-control)] border px-3 text-start text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${motion === option ? "border-foreground/50 bg-fill text-foreground" : "border-border bg-fill-subtle text-muted-foreground hover:bg-fill"}`}
                >
                  <span className="block font-medium">
                    {t(`onboarding.${option}`)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t(`onboarding.${option}Hint`)}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {error && (
          <p role="alert" className="text-destructive mt-5 text-sm">
            {error}
          </p>
        )}
        <Button
          type="button"
          size="lg"
          disabled={busy}
          onClick={() => void finish()}
          className="mt-7 w-full"
        >
          {busy ? t("onboarding.saving") : t("onboarding.continue")}
        </Button>
      </section>
    </main>
  );
}
