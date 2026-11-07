import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Eye, EyeOff, LogIn, RefreshCw, UserPlus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AuthMode } from "@/types/line";

export interface AuthFormProps {
  serverName: string;
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
  serverName,
  registrationAvailable = true,
  loading = false,
  error,
  onSubmit,
}: AuthFormProps) {
  const id = useId();
  const reducedMotion = useReducedMotion();
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
      setValidation("Логин: 3–32 латинских буквы, цифры или _.");
      return;
    }
    if (
      !password ||
      password.length > 1024 ||
      (mode === "register" && Array.from(password).length < 8)
    ) {
      setValidation(
        mode === "register"
          ? "Пароль: не менее 8 символов."
          : "Введите пароль.",
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
      <div className="flex flex-col gap-0.5">
        <span className="text-foreground text-sm font-semibold">
          Аккаунт провайдера
        </span>
        <span className="text-muted-foreground text-[11px] leading-tight">
          {serverName} использует собственную авторизацию. Аккаунт Microsoft не
          нужен.
        </span>
      </div>

      {registrationAvailable && (
        <Tabs value={mode} onValueChange={changeMode}>
          <TabsList>
            {(["login", "register"] as const).map((value) => (
              <TabsTrigger key={value} value={value} disabled={loading}>
                {value === "login" ? "Вход" : "Регистрация"}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={mode}
            initial={reducedMotion ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reducedMotion ? 0 : -5 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col gap-3"
          >
            <div className="border-border/40 bg-card/50 flex flex-col gap-2 rounded-lg border p-3">
              <Label
                htmlFor={`${id}-username`}
                className="text-foreground text-xs font-semibold"
              >
                Логин
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
            <div className="border-border/40 bg-card/50 flex flex-col gap-2 rounded-lg border p-3">
              <Label
                htmlFor={`${id}-password`}
                className="text-foreground text-xs font-semibold"
              >
                Пароль
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
                    showPassword ? "Скрыть пароль" : "Показать пароль"
                  }
                  aria-pressed={showPassword}
                  disabled={loading}
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          </m.div>
        </AnimatePresence>

        {/*
          Reserved slot, same reason as ConfigUrlInput: mounting/unmounting the
          error moved the submit button on every attempt. The height is fixed so
          clearing the message while the request runs cannot shift the layout.
        */}
        <div className="min-h-10" aria-live="polite">
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
          className="h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-xl text-sm font-semibold shadow-sm"
        >
          {loading ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : mode === "login" ? (
            <LogIn className="h-4 w-4" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
          <span>
            {loading
              ? "Проверяем данные…"
              : mode === "login"
                ? "Войти"
                : "Создать аккаунт"}
          </span>
        </Button>
      </form>

      <p className="text-muted-foreground text-[10px] leading-relaxed">
        Пароль передаётся только API провайдера по HTTPS. Токен сессии остаётся
        в Rust и не сохраняется в браузере.
      </p>
    </div>
  );
}
