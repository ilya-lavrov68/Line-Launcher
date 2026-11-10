import {
  Check,
  ChevronDown,
  ChevronUp,
  Coffee,
  MemoryStick,
  Palette,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { errorMessage, lineApi } from "@/lib/line/api";
import { applyWindowSize } from "@/lib/line/window";
import type {
  AfterLaunch,
  JavaRuntimeInfo,
  LauncherSettings,
  SettingsSnapshot,
} from "@/types/line";
import { cn } from "@/lib/utils";
import BackdropPicker from "@/components/line/BackdropPicker";
import SectionIcon from "@/components/line/SectionIcon";

export interface SettingsScreenProps {
  snapshot: SettingsSnapshot;
  onChange: (snapshot: SettingsSnapshot) => void;
  /** Signing out / installing must not race a settings write. */
  disabled?: boolean;
}

const AFTER_LAUNCH: { value: AfterLaunch; label: string; hint: string }[] = [
  {
    value: "tray",
    label: "Скрывать в трей",
    hint: "Окно исчезает из панели задач, лаунчер ждёт в трее",
  },
  {
    value: "minimize",
    label: "Свернуть",
    hint: "Окно остаётся на панели задач",
  },
  {
    value: "close",
    label: "Закрыть лаунчер",
    hint: "Процесс завершается вместе с игрой",
  },
  {
    value: "keep",
    label: "Оставить как есть",
    hint: "Окно не трогаем",
  },
];

/** Base UI renders the raw value unless SelectValue formats it. */
function runtimeLabel(
  runtimes: JavaRuntimeInfo[],
  path: string,
): string | undefined {
  const runtime = runtimes.find((entry) => entry.path === path);
  return runtime ? `Java ${runtime.major} · ${runtime.version}` : undefined;
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof MemoryStick;
  title: string;
  /** Optional: a section whose label is enough does not get a sentence. */
  description?: string;
  children: React.ReactNode;
}) {
  return (
    // A settings section is a heading and a control, separated from the next by
    // space and a hairline — not a filled card. Four grey boxes stacked down the
    // page were the loudest thing on it.
    <section className="border-border/40 flex flex-col gap-4 border-b pb-6 last:border-b-0 last:pb-0">
      <div className="flex items-start gap-3">
        <SectionIcon icon={Icon} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-foreground text-[15px] font-semibold">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-xs leading-relaxed">
              {description}
            </p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Player settings. Reuses Obsy's card surface, Slider, Select and Button rather
 * than introducing new controls, so the palette presets restyle it for free.
 *
 * Every change is persisted through Rust, which revalidates the heap against
 * this machine's memory and the Java path against the runtimes it can discover.
 * The UI therefore shows the server-confirmed snapshot, never an optimistic guess.
 */
export default function SettingsScreen({
  snapshot,
  onChange,
  disabled = false,
}: SettingsScreenProps) {
  const { settings, heapCeilingMb, suggestedHeapMb, totalMemoryMb } = snapshot;
  const [runtimes, setRuntimes] = useState<JavaRuntimeInfo[]>([]);
  const [javaLoading, setJavaLoading] = useState(true);
  const [javaChecking, setJavaChecking] = useState(false);
  const [javaSearchError, setJavaSearchError] = useState<string>();
  const [javaPathInput, setJavaPathInput] = useState(settings.javaPath ?? "");
  const javaRequest = useRef(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [heap, setHeap] = useState(settings.heapMb ?? suggestedHeapMb);

  useEffect(() => {
    setHeap(settings.heapMb ?? suggestedHeapMb);
  }, [settings.heapMb, suggestedHeapMb]);

  const refreshRuntimes = useCallback(async () => {
    const ticket = ++javaRequest.current;
    setJavaLoading(true);
    setJavaSearchError(undefined);
    try {
      const list = await lineApi.javaRuntimes();
      // A manually verified JDK need not be on PATH or in a vendor directory.
      if (
        settings.javaPath &&
        !list.some((r) => r.path === settings.javaPath)
      ) {
        try {
          list.push(await lineApi.probeJavaPath(settings.javaPath));
        } catch (cause) {
          if (ticket === javaRequest.current)
            setJavaSearchError(errorMessage(cause));
        }
      }
      if (ticket === javaRequest.current) setRuntimes(list);
    } catch (cause) {
      if (ticket === javaRequest.current)
        setJavaSearchError(errorMessage(cause));
    } finally {
      if (ticket === javaRequest.current) setJavaLoading(false);
    }
  }, [settings.javaPath]);

  useEffect(() => {
    void refreshRuntimes();
    return () => {
      javaRequest.current += 1;
    };
  }, [refreshRuntimes]);

  async function chooseJavaPath() {
    if (busy || !javaPathInput.trim()) return;
    setJavaChecking(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const runtime = await lineApi.probeJavaPath(javaPathInput.trim());
      const next = await lineApi.saveSettings({
        ...settings,
        javaPath: runtime.path,
      });
      onChange(next);
      setRuntimes((previous) => [
        runtime,
        ...previous.filter((r) => r.path !== runtime.path),
      ]);
      setJavaPathInput(next.settings.javaPath ?? runtime.path);
      setJavaSearchError(undefined);
      setNotice(
        `Java ${runtime.major} (${runtime.version}) проверена и выбрана для запуска.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setJavaChecking(false);
    }
  }

  async function persist(next: LauncherSettings) {
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      onChange(await lineApi.saveSettings(next));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function commitHeap(value: number) {
    // "Automatic" is stored as null so a machine with different RAM sizes itself.
    const heapMb = value === suggestedHeapMb ? null : value;
    await persist({ ...settings, heapMb });
  }

  async function clearCache() {
    setSaving(true);
    setError(undefined);
    try {
      const removed = await lineApi.clearConfigCache();
      setNotice(
        removed
          ? "Кэш конфигурации очищен. Установленные сборки не затронуты."
          : "Кэш конфигурации уже пуст.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const busy = disabled || saving || javaChecking;
  const automatic = settings.heapMb === null;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          Настройки
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Параметры применяются к следующему запуску игры. Сборки и история
          релизов не изменяются.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="text-destructive bg-destructive/10 rounded-[var(--radius-control)] p-3 text-xs"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="text-line-online bg-line-online/10 flex items-start gap-2 rounded-[var(--radius-control)] p-3 text-xs"
        >
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </p>
      )}

      <div className="flex flex-col gap-8">
        <Section
          icon={MemoryStick}
          title="Память игры"
          description={`Компьютер: ${totalMemoryMb} МБ, доступно до ${heapCeilingMb} МБ.`}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor="heap-slider"
                className="text-muted-foreground text-xs"
              >
                Выделено Java
              </Label>
              <span className="text-foreground font-mono text-xs">
                {heap} МБ
                {automatic && (
                  <span className="text-muted-foreground"> · авто</span>
                )}
              </span>
            </div>
            <Slider
              id="heap-slider"
              min={1024}
              max={heapCeilingMb}
              step={256}
              value={[heap]}
              disabled={busy}
              onValueChange={(value) =>
                setHeap(Array.isArray(value) ? value[0] : value)
              }
              onValueCommitted={(value) =>
                void commitHeap(Array.isArray(value) ? value[0] : value)
              }
              aria-label="Объём памяти для игры, МБ"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy || automatic}
              onClick={() => void commitHeap(suggestedHeapMb)}
              className="cursor-pointer self-start text-xs"
            >
              Вернуть автоматический подбор
            </Button>
          </div>
        </Section>

        <Section
          icon={Palette}
          title="Фон лаунчера"
          description="Двенадцать градиентов, каждый медленно движется. Переключение плавное, выбор сохраняется."
        >
          <BackdropPicker
            value={settings.backdrop}
            disabled={busy}
            onChange={(id) => void persist({ ...settings, backdrop: id })}
          />
        </Section>

        <Section
          icon={Coffee}
          title="Java"
          description="Только проверенные рантаймы, версия под требование сборки."
        >
          <div className="flex flex-col gap-2">
            <Label className="text-muted-foreground text-xs">Рантайм</Label>
            <Select
              value={settings.javaPath ?? "auto"}
              disabled={busy || javaLoading}
              onValueChange={(value) =>
                void persist({
                  ...settings,
                  javaPath: value === "auto" ? null : String(value),
                })
              }
            >
              <SelectTrigger id="java-runtime" className="w-full text-xs">
                <SelectValue>
                  {(value: string | null) =>
                    javaLoading
                      ? "Поиск Java…"
                      : !value || value === "auto"
                        ? "Автоматически по версии сборки"
                        : (runtimeLabel(runtimes, value) ?? value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  Автоматически по версии сборки
                </SelectItem>
                {runtimes.map((runtime) => (
                  <SelectItem key={runtime.path} value={runtime.path}>
                    Java {runtime.major} · {runtime.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {settings.javaPath && (
              <p className="text-muted-foreground font-mono text-[12px] break-all">
                {settings.javaPath}
              </p>
            )}
            {javaSearchError && (
              <p
                role="alert"
                className="text-destructive text-xs leading-relaxed"
              >
                {javaSearchError}
              </p>
            )}
            {!javaLoading && runtimes.length === 0 && !javaSearchError && (
              <p className="text-xs leading-relaxed text-amber-300">
                Автоматический поиск не нашёл доступную Java. Если JDK
                установлен, укажите путь ниже или повторите поиск.
              </p>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || javaLoading}
              onClick={() => void refreshRuntimes()}
              className="text-muted-foreground cursor-pointer self-start text-xs"
            >
              <RefreshCw
                className={javaLoading ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                aria-hidden="true"
              />
              {javaLoading ? "Проверяем Java…" : "Повторить поиск Java"}
            </Button>
            <div className="border-border/40 flex flex-col gap-2 border-t pt-3">
              <Label
                htmlFor="java-path"
                className="text-muted-foreground text-xs"
              >
                Или укажите установленную Java вручную
              </Label>
              <Input
                id="java-path"
                value={javaPathInput}
                disabled={busy}
                onChange={(event) => setJavaPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void chooseJavaPath();
                  }
                }}
                placeholder="C:\Program Files\Eclipse Adoptium\jdk-25…\bin\java.exe"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                aria-describedby="java-path-help"
              />
              <p
                id="java-path-help"
                className="text-muted-foreground text-[12px] leading-relaxed"
              >
                Полный путь к java.exe, папке bin или JDK. Лаунчер проверит его
                запуском java -version; переустанавливать Java не нужно.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !javaPathInput.trim()}
                onClick={() => void chooseJavaPath()}
                className="cursor-pointer self-start text-xs"
              >
                {javaChecking ? "Проверяем путь…" : "Проверить и выбрать"}
              </Button>
            </div>
          </div>
        </Section>

        <Section icon={RefreshCw} title="Поведение и окно">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="setting-after-launch"
                className="text-muted-foreground text-xs"
              >
                Лаунчер при запуске игры
              </Label>
              <Select
                value={settings.afterLaunch}
                disabled={busy}
                onValueChange={(value) =>
                  void persist({
                    ...settings,
                    afterLaunch: value as AfterLaunch,
                  })
                }
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue>
                    {(value: AfterLaunch | null) =>
                      AFTER_LAUNCH.find((option) => option.value === value)
                        ?.label ?? "Скрывать в трей"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {AFTER_LAUNCH.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {AFTER_LAUNCH.find(
                  (option) => option.value === settings.afterLaunch,
                )?.hint ?? ""}{" "}
                Когда игра закроется, лаунчер вернётся сам — выбранное действие
                применяется только к запуску.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {(
                [
                  ["windowWidth", "Ширина", settings.windowWidth],
                  ["windowHeight", "Высота", settings.windowHeight],
                ] as const
              ).map(([key, label, value]) => (
                <div key={key} className="flex flex-col gap-1.5">
                  <Label
                    htmlFor={`setting-${key}`}
                    className="text-muted-foreground text-xs"
                  >
                    {label}
                  </Label>
                  {/* Still `type="number"`: arrow keys step, the browser keeps
                      the range, and the value may be typed. Only the platform
                      spinner is hidden (index.css) and replaced with a pair of
                      buttons that sit on the same fill ladder as every other
                      control — the OS arrows were black-on-black and unthemed. */}
                  <div className="relative">
                    <input
                      id={`setting-${key}`}
                      type="number"
                      min={key === "windowWidth" ? 800 : 560}
                      max={15360}
                      step={20}
                      defaultValue={value}
                      disabled={busy}
                      onBlur={(event) => {
                        const parsed = Number(event.target.value);
                        if (!Number.isInteger(parsed) || parsed === value)
                          return;
                        void persist({ ...settings, [key]: parsed });
                      }}
                      className={cn(
                        "border-input focus-visible:border-ring bg-transparent",
                        "focus-visible:ring-ring/50 h-9 w-28 rounded-[var(--radius-control)] border py-0 pr-8 pl-3",
                        "font-mono text-xs outline-none focus-visible:ring-3",
                      )}
                    />
                    <div className="absolute inset-y-1 right-1 flex flex-col">
                      {(
                        [
                          ["Увеличить", ChevronUp],
                          ["Уменьшить", ChevronDown],
                        ] as const
                      ).map(([hint, Icon]) => (
                        <button
                          key={hint}
                          type="button"
                          aria-label={`${hint} ${label.toLowerCase()}`}
                          disabled={busy}
                          onClick={() => {
                            const input = document.getElementById(
                              `setting-${key}`,
                            ) as HTMLInputElement | null;
                            if (!input) return;
                            // Native stepping, so `min`/`max`/`step` stay the
                            // single source of truth for the allowed value.
                            if (hint === "Увеличить") input.stepUp();
                            else input.stepDown();
                            const parsed = Number(input.value);
                            if (Number.isInteger(parsed) && parsed !== value)
                              void persist({ ...settings, [key]: parsed });
                          }}
                          className="text-muted-foreground hover:bg-fill-hover hover:text-foreground flex flex-1 items-center justify-center rounded-[4px] px-1 transition-colors disabled:opacity-40"
                        >
                          <Icon className="h-3 w-3" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void applyWindowSize(
                    settings.windowWidth,
                    settings.windowHeight,
                  )
                }
                className="cursor-pointer text-xs"
              >
                Применить размер
              </Button>
            </div>
          </div>
        </Section>

        <Section
          icon={Trash2}
          title="Кэш конфигурации"
          description="Удалит только сохранённый config.json. Сборки, история и входы останутся."
        >
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void clearCache()}
            className="cursor-pointer self-start text-xs"
          >
            Очистить кэш конфигурации
          </Button>
        </Section>
      </div>
    </section>
  );
}
