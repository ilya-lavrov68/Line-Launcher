import {
  Check,
  ChevronDown,
  ChevronUp,
  Coffee,
  FileText,
  Languages,
  Layers,
  MemoryStick,
  Download,
  Palette,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import SupportSection from "@/components/line/SupportSection";
import StableActionLabel from "@/components/line/StableActionLabel";
import SectionIcon from "@/components/line/SectionIcon";
import { LANGUAGES, LANGUAGE_NAMES, isLanguage } from "@/lib/line/languages";
import { setLanguage, useT, type Translator } from "@/lib/line/i18n";

export interface SettingsScreenProps {
  snapshot: SettingsSnapshot;
  onChange: (snapshot: SettingsSnapshot) => void;
  /** Signing out / installing must not race a settings write. */
  disabled?: boolean;
  /** The provider's own support address, from its config; absent = no button. */
  providerEmail?: string;
}

/**
 * The four after-launch choices, built from the translator on each render.
 *
 * These used to be a module constant. A constant would freeze whatever language
 * was current when the module was first imported, which is precisely the bug an
 * instant switch would then show: the picker in Russian, the list in German.
 */
function afterLaunchOptions(
  t: Translator,
): { value: AfterLaunch; label: string; hint: string }[] {
  return [
    {
      value: "tray",
      label: t("settings.afterLaunch.tray"),
      hint: t("settings.afterLaunch.trayHint"),
    },
    {
      value: "minimize",
      label: t("settings.afterLaunch.minimize"),
      hint: t("settings.afterLaunch.minimizeHint"),
    },
    {
      value: "close",
      label: t("settings.afterLaunch.close"),
      hint: t("settings.afterLaunch.closeHint"),
    },
    {
      value: "keep",
      label: t("settings.afterLaunch.keep"),
      hint: t("settings.afterLaunch.keepHint"),
    },
  ];
}

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
 * than introducing new controls, so it needs no colour of its own.
 *
 * Every change is persisted through Rust, which revalidates the heap against
 * this machine's memory and the Java path against the runtimes it can discover.
 * The UI therefore shows the server-confirmed snapshot, never an optimistic guess.
 */
export default function SettingsScreen({
  snapshot,
  onChange,
  disabled = false,
  providerEmail,
}: SettingsScreenProps) {
  const t = useT();
  const afterLaunch = afterLaunchOptions(t);
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
      // The command is typed `JavaRuntimeInfo[]`, but a null or malformed
      // answer from a stale backend must not take the whole settings screen
      // down with "Cannot read properties of null (reading 'some')" — which is
      // what happened: the screen rendered black with no explanation.
      const list = (await lineApi.javaRuntimes()) ?? [];
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
        t("settings.javaPicked", {
          major: runtime.major,
          version: runtime.version,
        }),
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

  /**
   * The slider writes a number; the switch writes the *mode*.
   *
   * These used to be one function that inferred the mode from the value
   * (`value === suggestedHeapMb ? null : value`), and that made the switch
   * unable to move at all: turning automatic *off* passes the value the slider
   * happens to hold, which is the suggested heap while the mode is on, so the
   * write stored `null` again — automatic stayed on and the switch snapped back
   * on every click. The mode is a separate decision from the number, so it is a
   * separate call.
   */
  async function commitHeap(value: number, automatic = false) {
    // "Automatic" is stored as null so a machine with different RAM sizes itself.
    await persist({ ...settings, heapMb: automatic ? null : value });
  }

  async function clearCache() {
    setSaving(true);
    setError(undefined);
    try {
      const removed = await lineApi.clearConfigCache();
      setNotice(
        removed ? t("settings.cacheCleared") : t("settings.cacheEmpty"),
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
    <section
      data-line-settings
      className="mx-auto flex w-full max-w-2xl flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          {t("settings.title")}
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("settings.subtitle")}
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
        {/* Language comes first, above memory. It is the one setting that
            changes what every other label on this page says, so a player who
            cannot read the screen has to be able to reach it without scrolling
            past three sections they cannot read either. It is also the first
            thing people look for, and looking for it at the top is the whole
            of the reason. */}

        <Section
          icon={Languages}
          title={t("settings.lang")}
          description={t("settings.langHint")}
        >
          <div className="flex flex-col gap-2">
            <Select
              value={t.language}
              disabled={busy}
              onValueChange={(value) => {
                if (!isLanguage(value) || value === t.language) return;
                // The store notifies first, so every string on this page is
                // already in the new language before the write is sent; the
                // picker itself re-renders from the same store a moment later.
                setLanguage(value);
                void persist({ ...settings, language: value });
              }}
            >
              <SelectTrigger
                id="setting-language"
                className="w-full text-xs"
                aria-label={t("settings.lang")}
              >
                <SelectValue>
                  {(value: string | null) =>
                    LANGUAGE_NAMES[isLanguage(value) ? value : t.language]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {LANGUAGE_NAMES[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Section>

        <Section
          icon={Download}
          title={t("settings.downloadLimit")}
          description={t("settings.downloadLimitHint")}
        >
          <Select
            value={String(settings.downloadLimitKib ?? 0)}
            disabled={saving}
            onValueChange={(value) => {
              const kib = Number(value);
              if (Number.isInteger(kib) && kib >= 0 && kib <= 1_048_576) {
                void persist({ ...settings, downloadLimitKib: kib });
              }
            }}
          >
            <SelectTrigger
              className="w-full text-xs"
              aria-label={t("settings.downloadLimit")}
            >
              <SelectValue>
                {(value: string | null) =>
                  Number(value) === 0
                    ? t("settings.downloadUnlimited")
                    : `${Number(value) / 1024} MiB/s`
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {[0, 256, 512, 1024, 2048, 5120, 10240, 20480, 51200, 102400].map(
                (kib) => (
                  <SelectItem key={kib} value={String(kib)}>
                    {kib === 0
                      ? t("settings.downloadUnlimited")
                      : `${kib / 1024} MiB/s`}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </Section>

        <Section
          icon={MemoryStick}
          title={t("settings.memory")}
          description={t("settings.memoryHint", {
            total: totalMemoryMb,
            ceiling: heapCeilingMb,
          })}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor="heap-slider"
                className="text-muted-foreground text-xs"
              >
                {t("settings.heapLabel")}
              </Label>
              {/* In the automatic mode the number is the pack's, and it
                  differs per pack — the exact figure is settled at launch, so
                  showing one here would be a guess dressed as a fact. */}
              <span className="text-foreground font-mono text-xs">
                {automatic
                  ? t("settings.auto")
                  : t("settings.heapValue", { heap })}
              </span>
            </div>
            <Slider
              id="heap-slider"
              min={1024}
              max={heapCeilingMb}
              step={256}
              value={[heap]}
              disabled={busy || automatic}
              onValueChange={(value) =>
                setHeap(Array.isArray(value) ? value[0] : value)
              }
              onValueCommitted={(value) =>
                void commitHeap(Array.isArray(value) ? value[0] : value)
              }
              aria-label={t("settings.memoryLabel")}
            />
            {/* A checkbox, not a button: this is a mode the player is *in*, and
                a button reads as a one-off action that has to be pressed again
                after every change. The slider below is the manual mode, so it
                greys out while the mode is on rather than disappearing — the
                bar still shows roughly what the machine will allocate. */}
            <label
              htmlFor="heap-auto"
              className="flex cursor-pointer items-start gap-2.5"
            >
              <Switch
                id="heap-auto"
                checked={automatic}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void commitHeap(checked ? suggestedHeapMb : heap, checked)
                }
                className="mt-0.5 cursor-pointer"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-foreground text-xs font-medium">
                  {t("settings.memoryAuto")}
                </span>
                <span className="text-muted-foreground text-[11px] leading-relaxed">
                  {t("settings.memoryAutoHint")}
                </span>
              </span>
            </label>
            {/* The heap is the one setting a player is most likely to have been
                told to "just raise" by a forum post. Raising it past what the
                machine can spare is how a launcher starts competing with Windows
                for RAM while the game boots — so the ceiling above is a real
                ceiling, and this says so without a warning colour, because for
                most players the automatic value is already right. */}
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {t("settings.memoryStability")}
            </p>
          </div>
        </Section>

        <Section
          icon={Layers}
          title={t("settings.workspace")}
          description={t("settings.workspaceHint")}
        >
          {/* Two cards, not a select: this is a look, and a look has to be
              seen to be chosen. Each option paints a swatch of exactly what it
              produces — the backdrop is the same in both, and the difference
              is the plate in the middle: a translucent one for glass, the
              deep charcoal for solid — so the choice is made by
              looking rather than by reading a word.

              The default is solid, and it is the default only when nobody has
              chosen: `workspace` stays absent until the player picks. */}
          <div
            role="radiogroup"
            aria-label={t("settings.workspace")}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {[
              {
                id: "glass" as const,
                label: "workspace.glass",
                hint: "workspace.glassHint",
              },
              {
                id: "solid" as const,
                label: "workspace.solid",
                hint: "workspace.solidHint",
              },
            ].map((option) => {
              const active = (settings.workspace ?? "solid") === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy}
                  onClick={() =>
                    void persist({ ...settings, workspace: option.id })
                  }
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border p-2 text-left transition-colors",
                    active
                      ? "border-foreground/30 bg-fill-subtle"
                      : "border-border/40 hover:border-foreground/20 hover:bg-fill-subtle/60",
                    busy && "cursor-not-allowed opacity-60",
                  )}
                >
                  {/* The swatch is the thing itself, not a picture of it:
                      the backdrop bands stand in for the haze in both, and
                      the plate in the middle is what changes — translucent
                      for glass, the opaque charcoal value for solid. */}
                  <span
                    aria-hidden="true"
                    className="line-workspace-swatch relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-white/10"
                  >
                    <span
                      className={cn(
                        "block size-6 rounded-[3px] border border-white/15",
                        option.id === "solid"
                          ? "bg-[var(--line-solid-panel)]"
                          : "bg-white/15 backdrop-blur-[2px]",
                      )}
                    />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-foreground text-xs font-medium">
                      {t(option.label)}
                    </span>
                    <span className="text-muted-foreground text-[11px] leading-relaxed">
                      {t(option.hint)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section
          icon={Palette}
          title={t("settings.backdrop")}
          description={t("settings.backdropHint")}
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
          description={t("settings.javaHint")}
        >
          <div className="flex flex-col gap-2">
            <Label className="text-muted-foreground text-xs">
              {t("settings.runtime")}
            </Label>
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
                      ? t("settings.javaSearching")
                      : !value || value === "auto"
                        ? t("settings.javaAuto")
                        : (runtimeLabel(runtimes, value) ?? value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("settings.javaAuto")}</SelectItem>
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
              <p className="text-xs leading-relaxed text-amber-700">
                {t("settings.javaNotFound")}
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
              <StableActionLabel
                busy={javaLoading}
                idle={t("settings.javaResearch")}
                active={t("settings.javaChecking")}
              />
            </Button>
            <div className="border-border/40 flex flex-col gap-2 border-t pt-3">
              <Label
                htmlFor="java-path"
                className="text-muted-foreground text-xs"
              >
                {t("settings.javaManual")}
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
                {t("settings.javaPathHelp")}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !javaPathInput.trim()}
                onClick={() => void chooseJavaPath()}
                className="cursor-pointer self-start text-xs"
              >
                {javaChecking
                  ? t("settings.javaCheckingPath")
                  : t("settings.javaPick")}
              </Button>
            </div>
          </div>
        </Section>

        <Section icon={RefreshCw} title={t("settings.window")}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="setting-after-launch"
                className="text-muted-foreground text-xs"
              >
                {t("settings.windowHint")}
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
                      afterLaunch.find((option) => option.value === value)
                        ?.label ?? t("settings.afterLaunch.tray")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {afterLaunch.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {afterLaunch.find(
                  (option) => option.value === settings.afterLaunch,
                )?.hint ?? ""}{" "}
                {t("settings.afterLaunch.note")}
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {(
                [
                  ["windowWidth", t("settings.width"), settings.windowWidth],
                  ["windowHeight", t("settings.height"), settings.windowHeight],
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
                          ["increase", t("settings.increase"), ChevronUp],
                          ["decrease", t("settings.decrease"), ChevronDown],
                        ] as const
                      ).map(([step, hint, Icon]) => (
                        <button
                          key={step}
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
                            if (step === "increase") input.stepUp();
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
                {t("settings.applySize")}
              </Button>
            </div>
          </div>
        </Section>

        <Section
          icon={Trash2}
          title={t("settings.cache")}
          description={t("settings.cacheHint")}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void clearCache()}
            className="cursor-pointer self-start text-xs"
          >
            {t("settings.cacheClear")}
          </Button>
        </Section>

        {/* Support last, and after the cache: it is what a player reaches for
            when something above did not work, and it is the only section whose
            buttons leave the app (the two mails). */}
        <Section
          icon={FileText}
          title={t("settings.logs")}
          description={t("settings.logsHint")}
        >
          <SupportSection
            providerEmail={providerEmail}
            disabled={busy}
            onNotice={(message) => {
              setNotice(message);
              setError(undefined);
            }}
            onError={(message) => {
              setError(message);
              setNotice(undefined);
            }}
          />
        </Section>
      </div>
    </section>
  );
}
