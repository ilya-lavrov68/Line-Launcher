import {
  Check,
  CloudOff,
  History,
  Loader2,
  Plus,
  Shirt,
  Trash2,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import SkinPreview from "@/components/line/SkinPreview";
import SectionIcon from "@/components/line/SectionIcon";
import SkinThumb from "@/components/line/SkinThumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorMessage, lineApi } from "@/lib/line/api";
import { MAX_SKIN_BYTES, validateSkinFile } from "@/lib/line/skin";
import {
  toLineError,
  type SkinLibrarySnapshot,
  type SkinModel,
  type SkinState,
} from "@/types/line";

export interface WardrobeScreenProps {
  username?: string;
  /** True when the signed-in project exposes wardrobe endpoints. */
  canSync: boolean;
  /** Bumped after sign-in/out so the automatic sync runs for the new account. */
  accountKey?: string;
  /** The backend rejected the session: the shell must ask for a new sign-in. */
  onAuthRequired?: () => void;
  disabled?: boolean;
}

type SyncPhase = "idle" | "sending" | "done" | "failed";

/**
 * Local-first wardrobe with automatic upload.
 *
 * History lives on this machine and works signed out and offline. The active
 * skin belongs to the project account and is pushed to the provider by itself —
 * there is no send button. `active` vs `synced` in the index makes that
 * idempotent, so mounting this screen or signing in again does not re-upload.
 */
export default function WardrobeScreen({
  username,
  canSync,
  accountKey,
  onAuthRequired,
  disabled = false,
}: WardrobeScreenProps) {
  const [snapshot, setSnapshot] = useState<SkinLibrarySnapshot | null>(null);
  const [remote, setRemote] = useState<SkinState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [sync, setSync] = useState<SyncPhase>("idle");
  const [syncError, setSyncError] = useState<string>();
  const [model, setModel] = useState<SkinModel>("classic");
  const [name, setName] = useState("");
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    url: string;
    name: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const syncGeneration = useRef(0);
  // Kept in a ref on purpose: putting the callback in autoSync's dependencies
  // would re-run the mount effect on every parent render (an inline arrow is a
  // new function each time) and fetch the library in a loop.
  const authRequired = useRef(onAuthRequired);
  useEffect(() => {
    authRequired.current = onAuthRequired;
  }, [onAuthRequired]);

  const activeId = snapshot?.library.active ?? undefined;
  const active = snapshot?.library.skins.find((s) => s.id === activeId);
  const syncedId = snapshot?.library.synced ?? undefined;

  /**
   * Pushes the active skin without being asked. Safe to call repeatedly: Rust
   * compares active with synced and does nothing when they already match.
   */
  const autoSync = useCallback(async () => {
    if (!canSync) return;
    const ticket = ++syncGeneration.current;
    setSync("sending");
    setSyncError(undefined);
    try {
      const result = await lineApi.syncActiveSkin();
      if (syncGeneration.current !== ticket) return;
      // "unchanged" carries no skin: the account keeps what it already had, so
      // overwriting the known state with null would show a wrong status.
      if (result.status === "synced") setRemote(result.skin);
      setSnapshot(await lineApi.skinLibrary());
      setSync("done");
    } catch (cause) {
      if (syncGeneration.current !== ticket) return;
      // A failed upload keeps the local choice; the next mount/sign-in retries.
      setSync("failed");
      setSyncError(errorMessage(cause));
      if (toLineError(cause).code === "AUTH_REQUIRED") authRequired.current?.();
    }
  }, [canSync]);

  useEffect(() => {
    const ticket = ++generation.current;
    setLoading(true);
    setError(undefined);
    void lineApi
      .skinLibrary()
      .then((value) => {
        if (generation.current !== ticket) return;
        setSnapshot(value);
        // Signing in, opening the screen or coming back online all settle the
        // account's skin automatically.
        if (canSync && value.library.active !== value.library.synced) {
          void autoSync();
        }
      })
      .catch((cause) => {
        if (generation.current === ticket) setError(errorMessage(cause));
      })
      .finally(() => {
        if (generation.current === ticket) setLoading(false);
      });
    return () => {
      generation.current += 1;
      syncGeneration.current += 1;
    };
  }, [canSync, accountKey, autoSync]);

  // What the account currently wears is informational; failing to read it must
  // not take the local library down.
  useEffect(() => {
    if (!canSync) {
      setRemote(null);
      return;
    }
    let cancelled = false;
    void lineApi
      .skin()
      .then((skin) => {
        if (!cancelled) setRemote(skin);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canSync, accountKey]);

  useEffect(() => {
    return () => {
      if (pending) URL.revokeObjectURL(pending.url);
    };
  }, [pending]);

  function chooseFile(file: File | undefined) {
    setError(undefined);
    setNotice(undefined);
    if (!file) return;
    if (file.size > MAX_SKIN_BYTES) {
      setError("Скин больше 256 КБ. Используйте текстуру 64×64 или 64×32.");
      return;
    }
    void file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      const problem = validateSkinFile(bytes);
      if (problem) {
        setError(problem);
        return;
      }
      setPending((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return {
          bytes,
          url: URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
          name: file.name,
        };
      });
      if (!name.trim()) setName(file.name.replace(/\.png$/i, "").slice(0, 64));
    });
  }

  async function save() {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await lineApi.addSkin(
        name.trim() || pending.name,
        model,
        Array.from(pending.bytes),
      );
      // The newest texture becomes active and uploads itself.
      const entry = next.library.skins[0];
      setSnapshot(entry ? await lineApi.setActiveSkin(entry.id) : next);
      setNotice("Скин сохранён в истории и сделан активным.");
      URL.revokeObjectURL(pending.url);
      setPending(null);
      setName("");
      if (inputRef.current) inputRef.current.value = "";
      await autoSync();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string | null) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSnapshot(await lineApi.setActiveSkin(id));
      setNotice(
        id
          ? "Активный скин изменён."
          : "Выбран стандартный скин. Прежние остались в истории.",
      );
      await autoSync();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await lineApi.deleteSkin(id);
      setSnapshot(next);
      setNotice("Скин удалён из локальной истории.");
      // Deleting the worn texture falls back to the standard look on the account.
      if (activeId === id || syncedId === id) await autoSync();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const controlsDisabled = disabled || busy || loading;
  const skins = snapshot?.library.skins ?? [];
  const limit = snapshot?.limit ?? 64;

  const syncStatus = !canSync
    ? {
        icon: CloudOff,
        tone: "text-muted-foreground",
        text: username
          ? "Проект не настроил гардероб — скины хранятся только локально."
          : "Войдите в аккаунт проекта, чтобы скин применился на серверах.",
      }
    : sync === "sending"
      ? {
          icon: Loader2,
          tone: "text-muted-foreground",
          text: "Отправляем активный скин на сервер…",
        }
      : sync === "failed"
        ? {
            icon: CloudOff,
            tone: "text-destructive",
            // Says what failed and what happens next, in one clause.
            text: `Скин не отправлен. ${syncError ?? "Повторим при следующем подключении."}`,
          }
        : {
            icon: Check,
            tone: "text-line-online",
            // The panel title already says "на серверах проекта"; repeating it
            // in the status line was the third time on one screen.
            text: active
              ? `«${active.name}» отправлен автоматически.`
              : "На сервере стандартный скин.",
          };
  const SyncIcon = syncStatus.icon;

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          Гардероб
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Активный скин отправляется на сервер сам.
        </p>
      </div>

      <div className="min-h-10" aria-live="polite">
        {error && (
          <p
            role="alert"
            className="text-destructive bg-destructive/10 rounded-[var(--radius-control)] p-3 text-xs"
          >
            {error}
          </p>
        )}
        {!error && notice && (
          <p
            role="status"
            className="text-line-online bg-line-online/10 flex items-start gap-2 rounded-[var(--radius-control)] p-3 text-xs"
          >
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </p>
        )}
      </div>

      <div className="bg-fill-subtle flex flex-col gap-4 rounded-[var(--radius-item)] p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-foreground text-sm font-semibold">
            Добавить скин
          </h3>
          <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
            PNG 64×64 · до 256 КБ
          </span>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="skin-file"
                className="text-muted-foreground text-xs"
              >
                Файл текстуры
              </Label>
              <input
                id="skin-file"
                ref={inputRef}
                type="file"
                accept="image/png"
                disabled={controlsDisabled}
                onChange={(event) => chooseFile(event.target.files?.[0])}
                className="border-input text-muted-foreground file:bg-muted file:text-foreground w-full cursor-pointer rounded-md border p-2 text-xs file:mr-2 file:cursor-pointer file:rounded file:border-0 file:px-2 file:py-1 file:text-xs"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="skin-name"
                className="text-muted-foreground text-xs"
              >
                Название
              </Label>
              <Input
                id="skin-name"
                value={name}
                maxLength={64}
                disabled={controlsDisabled}
                placeholder="Например, зимний"
                onChange={(event) => setName(event.target.value)}
                className="text-xs"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground text-xs">Модель</Label>
              <Select
                value={model}
                disabled={controlsDisabled}
                onValueChange={(value) => setModel(value as SkinModel)}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue>
                    {(value: SkinModel | null) =>
                      value === "slim"
                        ? "Slim — узкие руки (3 px)"
                        : "Classic — широкие руки (4 px)"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="classic">
                    Classic — широкие руки (4 px)
                  </SelectItem>
                  <SelectItem value="slim">Slim — узкие руки (3 px)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {pending && (
            <div className="flex shrink-0 flex-col items-center gap-2">
              <Label className="text-muted-foreground text-xs">
                Предпросмотр
              </Label>
              <SkinPreview
                src={pending.url}
                model={model}
                scale={4}
                className="h-36 w-20"
              />
              <Button
                size="sm"
                disabled={controlsDisabled}
                onClick={() => void save()}
                className="cursor-pointer items-center gap-1.5 text-xs"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {busy ? "Сохраняем…" : "В историю"}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="bg-fill-subtle flex flex-col gap-4 rounded-[var(--radius-item)] p-4">
        <div className="flex items-start gap-3">
          <SectionIcon icon={History} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-foreground text-sm font-semibold">
              Локальная история
            </h3>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {loading ? "Загрузка…" : `${skins.length} из ${limit}`}
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={controlsDisabled || !activeId}
          onClick={() => void activate(null)}
          aria-label="Выбрать стандартный скин"
          className={
            !activeId
              ? "bg-primary/10 flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] p-2 text-left disabled:cursor-default"
              : "hover:bg-fill/60 flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] p-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
          }
        >
          <UserRound
            data-line-icon
            className="text-muted-foreground h-6 w-6 shrink-0"
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-foreground text-xs font-medium">
              Стандартный скин
            </span>
            <span className="text-muted-foreground text-[10px]">
              {!activeId ? "активен" : "вернуть обычный вид"}
            </span>
          </span>
          {!activeId && (
            <Check
              className="text-primary h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          )}
        </button>

        {!loading && skins.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-xs">
            История пуста. Добавьте PNG выше — он сохранится локально.
          </p>
        )}

        {skins.length > 0 && (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {skins.map((skin) => {
              const isActive = skin.id === activeId;
              return (
                <li
                  key={skin.id}
                  className={
                    isActive
                      ? "bg-primary/10 flex flex-col gap-2 rounded-[var(--radius-control)] p-2"
                      : "bg-fill/60 flex flex-col gap-2 rounded-[var(--radius-control)] p-2"
                  }
                >
                  <div className="flex items-center gap-2">
                    <SkinThumb
                      skinId={skin.id}
                      model={skin.model}
                      scale={2}
                      className="h-16 w-8"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-foreground truncate text-xs font-medium">
                        {skin.name}
                      </span>
                      <span className="text-muted-foreground font-mono text-[10px]">
                        {skin.width}×{skin.height} · {skin.model}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <button
                      type="button"
                      disabled={controlsDisabled || isActive}
                      onClick={() => void activate(skin.id)}
                      aria-label={`Сделать активным: ${skin.name}`}
                      aria-pressed={isActive}
                      className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 px-1 py-0.5 text-[10px] font-medium enabled:hover:bg-transparent disabled:cursor-default disabled:opacity-60"
                    >
                      {isActive ? "Активен" : "Выбрать"}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={controlsDisabled}
                      onClick={() => void remove(skin.id)}
                      aria-label={`Удалить из истории: ${skin.name}`}
                      className="text-muted-foreground hover:text-destructive cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="bg-fill-subtle flex items-start gap-3 rounded-[var(--radius-item)] p-4">
        <SectionIcon icon={Shirt} />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-foreground text-sm font-semibold">
            Скин на серверах проекта
          </h3>
          <p
            role="status"
            aria-live="polite"
            className={`flex items-start gap-1.5 text-xs leading-relaxed ${syncStatus.tone}`}
          >
            <SyncIcon
              className={`mt-0.5 h-4 w-4 shrink-0 ${sync === "sending" ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            <span>{syncStatus.text}</span>
          </p>
          {canSync && (
            <span className="text-muted-foreground font-mono text-[10px]">
              {remote ? `Модель: ${remote.model}` : "Модель: стандартная"}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
