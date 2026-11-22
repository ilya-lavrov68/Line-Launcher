import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Eye, EyeOff, LogIn, RefreshCw, UserPlus } from "@/components/ui/icons";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import FieldMessage from "./FieldMessage";
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
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [validation, setValidation] = useState<string>();
  // Only complains once the player has typed something in the second field:
  // an empty confirmation on a half-filled form is not a mistake yet, it is
  // just a form being filled in.
  const confirmMismatch =
    mode === "register" && confirm.length > 0 && confirm !== password;

  function changeMode(value: string | number | null) {
    if (loading || (value !== "login" && value !== "register")) return;
    setMode(value);
    setPassword("");
    setConfirm("");
    setShowPassword(false);
    setShowConfirm(false);
    setValidation(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      setValidation(t("auth.usernameHint"));
      return;
    }
    if (mode === "register" && confirm !== password) {
      setValidation(t("auth.passwordMismatch"));
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
    setConfirm("");
    setShowConfirm(false);
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

      <form
        // Native validation bubbles are not this app's design; `submit` does
        // the same checks and shows them in the field's own message slot.
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-4"
      >
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
                // `appearance-none` suppresses the platform's own reveal
                // control (Edge/WebView2 and macOS both draw one inside a
                // password input); the eye on the right is the app's, and two
                // of them were showing side by side.
                className="appearance-none pr-9 text-xs"
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
              {/* The hint and the error said the same sentence at the same
                  moment ("not shorter than 8 characters" twice), so the hint
                  steps aside while a message is showing — and it steps aside
                  completely. Keeping it mounted with a blank string left its
                  icon behind: an orphaned ⓘ above the error's own ⓘ, which
                  looked like a doubled marker. The wrapper keeps the height,
                  which is what actually stops the button from moving. */}
              {!message && (
                <AnimatePresence initial={false} mode="wait">
                  <m.p
                    key={mode}
                    initial={reducedMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={reducedMotion ? undefined : { opacity: 0 }}
                    transition={{ duration: 0.14, ease: "easeOut" }}
                    className="text-muted-foreground/80 text-[12px] leading-relaxed"
                  >
                    <FieldMessage tone="hint">
                      {mode === "register"
                        ? t("auth.registerHint")
                        : t("auth.loginHint")}
                    </FieldMessage>
                  </m.p>
                </AnimatePresence>
              )}
            </div>
          </div>

          {/* The confirmation is only part of registering: a second copy of the
              password that must match the first, so a typo is caught here and
              not by a login attempt that cannot work. It has its own eye:
              comparing two strings you cannot read is what this field exists
              to avoid, but revealing one and not the other is also a legitimate
              way to check a typo, so the two are independent. */}
          {mode === "register" && (
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor={`${id}-confirm`}
                className="text-muted-foreground text-xs font-medium"
              >
                {t("auth.confirmPassword")}
              </Label>
              <div className="relative">
                <Input
                  id={`${id}-confirm`}
                  type={showConfirm ? "text" : "password"}
                  value={confirm}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    setValidation(undefined);
                  }}
                  autoComplete="new-password"
                  required
                  maxLength={1024}
                  disabled={loading}
                  className="appearance-none pr-9 text-xs"
                  aria-invalid={confirmMismatch || undefined}
                  aria-describedby={`${id}-confirm-note`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground absolute top-0.5 right-0.5 cursor-pointer"
                  onClick={() => setShowConfirm((value) => !value)}
                  aria-label={
                    showConfirm
                      ? t("auth.hidePassword")
                      : t("auth.showPassword")
                  }
                  aria-pressed={showConfirm}
                  disabled={loading}
                >
                  {showConfirm ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {/* Reserved height for the same reason as everywhere else on this
                  form: the message appears and disappears while the player
                  types, and a slot that grows would move the button under the
                  pointer mid-click. */}
              <div id={`${id}-confirm-note`} className="min-h-4">
                {confirmMismatch ? (
                  <FieldMessage tone="error">
                    {t("auth.passwordMismatch")}
                  </FieldMessage>
                ) : confirm.length > 0 && confirm === password ? (
                  <FieldMessage tone="success">
                    {t("auth.passwordMatch")}
                  </FieldMessage>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/*
          Reserved slot, same reason as ConfigUrlInput: mounting/unmounting the
          error moved the submit button on every attempt. The height is fixed so
          clearing the message while the request runs cannot shift the layout.
        */}
        <div className="min-h-4" aria-live="polite" aria-atomic="true">
          {message && <FieldMessage id={`${id}-error`}>{message}</FieldMessage>}
        </div>

        <Button
          type="submit"
          disabled={loading}
          className="h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-item)] text-sm font-semibold"
        >
          {/* The icon and the label are one group, and one invisible copy of
              every state is laid out beneath it in the same grid cell. That
              reserve — not a spacer inside the label — is what keeps the
              contents still: the cell is already as wide as the widest state,
              so switching tabs or submitting cannot resize it. The visible
              group is centred inside that cell, which is the part that was
              broken: the old code reserved "Create account" *inside* the
              label, so in login mode the icon sat one gap from a box that was
              far wider than "Sign in", leaving a 48px hole that read as a
              clipped glyph. Reserving the whole group holds the gap at 8px in
              every state while still never moving anything. */}
          <span className="grid place-items-center">
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 inline-flex items-center gap-2"
            >
              <UserPlus className="h-5 w-5 shrink-0" />
              <span className="whitespace-nowrap">
                {t("auth.submitRegister")}
              </span>
            </span>
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1 inline-flex items-center gap-2"
            >
              <RefreshCw className="h-5 w-5 shrink-0" />
              <span className="whitespace-nowrap">{t("auth.submitting")}</span>
            </span>
            <span className="col-start-1 row-start-1 inline-flex items-center gap-2">
              {loading ? (
                <RefreshCw className="h-5 w-5 shrink-0 animate-spin" />
              ) : mode === "login" ? (
                <LogIn className="h-5 w-5 shrink-0" />
              ) : (
                <UserPlus className="h-5 w-5 shrink-0" />
              )}
              {/* One swapped word, faded rather than replaced: `mode` is the
                  only thing that changes here, so a 140ms cross-fade is all the
                  motion this needs. The two labels share a grid cell, so the
                  outgoing word cannot push the icon while it fades. */}
              <span className="relative grid place-items-center">
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
            </span>
          </span>
        </Button>
      </form>

      <p className="text-muted-foreground/80 text-[12px] leading-relaxed">
        {t("auth.privacy")}
      </p>
    </div>
  );
}
