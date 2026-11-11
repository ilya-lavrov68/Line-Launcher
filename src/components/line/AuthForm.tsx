import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Eye, EyeOff, LogIn, RefreshCw, UserPlus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/lib/line/i18n";
import type { AuthMode } from "@/types/line";

export interface AuthFormProps {
  /** The project name: one account unlocks all of its servers. */
  /** False means the provider does not offer registration. */
  registrationAvailable?: boolean;
  loading?: boolean;
  error?: string;
  onSubmit: (mode: AuthMode, username: string, password: string) => void;
}

/**
 * Provider auth. Uses Obsy's Tabs primitive for the login/register switch (its
 * own data-active styling supplies the indicator, so no custom pill is drawn),
 * plus the standard Label/Input/Button stack from ProfileSelector and
 * ConfigFieldRow. Colours and radii are inherited, never redefined.
 */
export default function AuthForm({
  registrationAvailable = true,
  loading = false,
  error,
  onSubmit,
}: AuthFormProps) {
  const id = useId();
  const reducedMotion = useReducedMotion();
  const t = useT();
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [validation, setValidation] = useState<string>();

  function changeMode(value: string | number | null) {
    if (loading || (value !== "login" && value !== "register")) return;
    setMode(value);
    setPassword("");
    setShowPassword(false);
    setValidation(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      setValidation(t("auth.usernameHint"));
      return;
    }
    if (
      !password ||
      password.length > 1024 ||
      (mode === "register" && Array.from(password).length < 8)
    ) {
      setValidation(
        mode === "register"
          ? t("auth.passwordShort")
          : t("auth.passwordRequired"),
      );
      return;
    }
    setValidation(undefined);
    onSubmit(mode, username, password);
    setPassword("");
  }

  const message = validation ?? error;
  return (
    <div className="flex flex-col gap-4">
      {/* No heading and no explainer: the screen above already says which
          account this is and that one sign-in covers every server. The card
          starts with the switch, which is what a person came here to use. */}

      {registrationAvailable && (
        <Tabs value={mode} onValueChange={changeMode}>
          <TabsList className="w-full">
            {(["login", "register"] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                disabled={loading}
                // The indicator slides with the theme's own easing instead of
                // snapping: a segmented control that jumps between two states
                // is the "sharp switch" the switch itself was accused of.
                className="transition-colors duration-200"
              >
                {value === "login" ? t("auth.login") : t("auth.register")}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`${id}-username`}
              className="text-muted-foreground text-xs font-medium"
            >
              {t("auth.username")}
            </Label>
            <Input
              id={`${id}-username`}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setValidation(undefined);
              }}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={32}
              required
              disabled={loading}
              placeholder="Player_name"
              className="text-xs"
              aria-invalid={Boolean(message)}
              aria-describedby={message ? `${id}-error` : undefined}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`${id}-password`}
              className="text-muted-foreground text-xs font-medium"
            >
              {t("auth.password")}
            </Label>
            <div className="relative">
              <Input
                id={`${id}-password`}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setValidation(undefined);
                }}
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                required
                maxLength={1024}
                disabled={loading}
                className="pr-9 text-xs"
                aria-invalid={Boolean(message)}
                aria-describedby={message ? `${id}-error` : undefined}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground absolute top-0.5 right-0.5 cursor-pointer"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={
                  showPassword ? t("auth.hidePassword") : t("auth.showPassword")
                }
                aria-pressed={showPassword}
                disabled={loading}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            {/* The only sentence that differs between the two modes. It
                fades where it stands, in a fixed-height slot, so the button
                below never moves when the text changes length. */}
            <div className="min-h-4">
              <AnimatePresence initial={false} mode="wait">
                <m.p
                  key={mode}
                  initial={reducedMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={reducedMotion ? undefined : { opacity: 0 }}
                  transition={{ duration: 0.14, ease: "easeOut" }}
                  className="text-muted-foreground/80 text-[12px] leading-relaxed"
                >
                  {mode === "register"
                    ? t("auth.registerHint")
                    : t("auth.loginHint")}
                </m.p>
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/*
          Reserved slot, same reason as ConfigUrlInput: mounting/unmounting the
          error moved the submit button on every attempt. The height is fixed so
          clearing the message while the request runs cannot shift the layout.
        */}
        <div className="min-h-4" aria-live="polite">
          {message && (
            <p
              id={`${id}-error`}
              role="alert"
              className="text-destructive text-xs leading-relaxed"
            >
              {message}
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={loading}
          className="h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-item)] text-sm font-semibold"
        >
          {loading ? (
            <RefreshCw className="h-5 w-5 animate-spin" />
          ) : mode === "login" ? (
            <LogIn className="h-5 w-5" />
          ) : (
            <UserPlus className="h-5 w-5" />
          )}
          {/* One swapped word, faded rather than replaced: `mode` is the only
              thing that changes here, so a 140ms cross-fade is all the motion
              this needs. Position is fixed by the flex row, so nothing moves. */}
          <span className="relative grid place-items-center">
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 whitespace-nowrap"
            >
              {t("auth.submitRegister")}
            </span>
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={loading ? "loading" : mode}
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
                className="col-start-1 row-start-1 whitespace-nowrap"
              >
                {loading
                  ? t("auth.submitting")
                  : mode === "login"
                    ? t("auth.submitLogin")
                    : t("auth.submitRegister")}
              </m.span>
            </AnimatePresence>
          </span>
        </Button>
      </form>

      <p className="text-muted-foreground/80 text-[12px] leading-relaxed">
        {t("auth.privacy")}
      </p>
    </div>
  );
}
