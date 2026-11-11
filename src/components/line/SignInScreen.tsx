import { m, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { brand } from "@/brand/generated";
import BrandMark from "@/components/line/BrandMark";
import TitleBar from "@/components/line/TitleBar";
import type { AuthMode } from "@/types/line";
import Attribution from "./Attribution";
import AuthForm from "./AuthForm";

/**
 * The sign-in page.
 *
 * It replaces the whole window rather than sitting inside the launcher: no rail,
 * no panels, no section to navigate to. Before this, signing in was one screen
 * among five, reachable only after the shell had drawn its chrome around an
 * empty catalogue — which read as "you are in the app" a step before you were.
 *
 * What stays is the way out: the window is frameless, so without the controls in
 * the top right a player who lands here by mistake has no way to close the
 * launcher except the task bar. `TitleBar` is reused for that, with its caption
 * buttons, not a hand-rolled copy.
 *
 * The card is deliberately the only raised surface on the page. Two panels (one
 * for the wordmark, one for the fields) on the first screen of a product is a
 * page of boxes; one panel with the mark above it reads as the inside of the
 * window, which is what it is.
 */
export interface SignInScreenProps {
  providerName: string;
  serverCount: number;
  registrationAvailable: boolean;
  loading: boolean;
  error?: string;
  onSubmit: (mode: AuthMode, username: string, password: string) => void;
}

export default function SignInScreen({
  providerName,
  serverCount,
  registrationAvailable,
  loading,
  error,
  onSubmit,
}: SignInScreenProps) {
  const reduced = useReducedMotion();
  const [entered, setEntered] = useState(false);

  // One entrance, once. Re-running it when the player types would be a blink
  // per keystroke if the form ever re-mounted, and the form does not: the
  // animation lives on this wrapper, above it.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      data-line-signin
      // No background of its own: the shell paints the animated backdrop behind
      // this layer, and an opaque page on top of it made the one screen with the
      // most empty space the only one that showed no colour.
      className="text-foreground relative flex h-dvh min-h-0 w-full flex-col overflow-hidden font-sans"
    >
      {/* The launcher's own frame, for its drag region and caption buttons:
          without them a frameless window opened on this page could not be
          moved, maximised or closed except from the task bar.

          The breadcrumb is deliberately left off. In the shell it names the
          section you are in; here there is no section yet, and "Line Launcher /
          Plus In Plus Demo" next to a page whose heading is already the
          provider's name put the same words on screen twice. */}
      <div className="relative z-10 shrink-0 px-1.5 pt-1.5">
        <TitleBar />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-6">
        <m.div
          initial={reduced ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: entered ? 1 : 0, y: entered ? 0 : 14 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="flex w-full max-w-[380px] flex-col items-center"
        >
          <BrandMark className="mb-4 h-11" />
          <h1 className="text-foreground text-center text-[24px] leading-tight font-semibold tracking-tight">
            {providerName}
          </h1>
          <p className="text-muted-foreground mt-2 mb-6 text-center text-[13px] leading-relaxed">
            Один вход — все серверы проекта.
            {serverCount > 0 && ` Серверов: ${serverCount}.`}
          </p>

          <div
            data-line-glass
            className="flex w-full flex-col gap-4 rounded-[var(--radius-panel)] p-6"
          >
            <AuthForm
              registrationAvailable={registrationAvailable}
              loading={loading}
              error={error}
              onSubmit={onSubmit}
            />
          </div>

          <p className="text-muted-foreground/70 mt-5 text-center text-[11px] leading-relaxed">
            {brand.attribution.placement === "footer" ? (
              <Attribution />
            ) : (
              <>Вход только через аккаунт проекта.</>
            )}
          </p>
        </m.div>
      </div>
    </div>
  );
}
