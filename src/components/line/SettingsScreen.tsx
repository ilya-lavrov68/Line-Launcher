import { Check, Coffee, MemoryStick, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

export interface SettingsScreenProps {
  snapshot: SettingsSnapshot;
  onChange: (snapshot: SettingsSnapshot) => void;
  /** Signing out / installing must not race a settings write. */
  disabled?: boolean;
}

const AFTER_LAUNCH: { value: AfterLaunch; label: string }[] = [
  { value: "keep", label: "Оставить окно открытым" },
  { value: "minimize", label: "Свернуть окно" },
  { value: "close", label: "Закрыть лаунчер" },
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
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border/40 bg-card/60 flex flex-col gap-4 rounded-xl border p-4 backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-foreground text-sm font-semibold">{title}</h3>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {description}
          </p>
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [heap, setHeap] = useState(settings.heapMb ?? suggestedHeapMb);

  useEffect(() => {
    setHeap(settings.heapMb ?? suggestedHeapMb);
  }, [settings.heapMb, suggestedHeapMb]);

  useEffect(() => {
    let mounted = true;
    void lineApi
      .javaRuntimes()
      .then((list) => {
        if (mounted) setRuntimes(list);
      })
      .catch((cause) => {
        if (mounted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted) setJavaLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

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

  const busy = disabled || saving;
  const automatic = settings.heapMb === null;

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4">
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
          className="text-destructive border-destructive/20 bg-destructive/5 rounded-lg border p-3 text-xs"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-400"
        >
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </p>
      )}

      <Section
        icon={MemoryStick}
        title="Память игры"
        description={`Автоматически подбирается ${suggestedHeapMb} МБ. Всего на компьютере ${totalMemoryMb} МБ, доступно до ${heapCeilingMb} МБ.`}
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
        icon={Coffee}
        title="Java"
        description="Лаунчер использует только те рантаймы, которые нашёл и проверил сам. Версия должна совпадать с требованием сборки."
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
            <SelectTrigger className="w-full text-xs">
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
            <p className="text-muted-foreground font-mono text-[10px] break-all">
              {settings.javaPath}
            </p>
          )}
          {!javaLoading && runtimes.length === 0 && (
            <p className="text-xs text-amber-300">
              Java не найдена. Установите JDK или задайте JAVA_HOME.
            </p>
          )}
        </div>
      </Section>

      <Section
        icon={RefreshCw}
        title="Поведение и окно"
        description="Что делает окно лаунчера после старта игры и какой размер использовать."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label className="text-muted-foreground text-xs">
              После запуска игры
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
                      ?.label ?? "Оставить окно открытым"
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
                    if (!Number.isInteger(parsed) || parsed === value) return;
                    void persist({ ...settings, [key]: parsed });
                  }}
                  className={cn(
                    "border-input focus-visible:border-ring bg-transparent",
                    "focus-visible:ring-ring/50 h-9 w-28 rounded-md border px-3",
                    "font-mono text-xs outline-none focus-visible:ring-3",
                  )}
                />
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
        description="Удаляет только сохранённый config.json провайдера. Установленные сборки, история релизов и входы остаются на месте."
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
    </section>
  );
}
