import {
  Check,
  CloudUpload,
  History,
  Plus,
  RotateCcw,
  Shirt,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import SkinPreview from "@/components/line/SkinPreview";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage, lineApi } from "@/lib/line/api";
import { MAX_SKIN_BYTES, validateSkinFile } from "@/lib/line/skin";
import type {
  LineServer,
  SkinLibrarySnapshot,
  SkinModel,
  SkinState,
} from "@/types/line";

export interface WardrobeScreenProps {
  /** Absent when no server is selected: the local library still works. */
  server?: LineServer | null;
  username?: string;
  /** True when the signed-in server exposes skin endpoints. */
  canSync: boolean;
  disabled?: boolean;
}

/**
 * Local-first wardrobe.
 *
 * The history lives on this machine and is usable before login, offline, and on
 * servers with no skin API. Only the skin marked active is ever uploaded, and
 * only when the player asks — choosing a texture never silently contacts the
 * provider.
 */
export default function WardrobeScreen({
  server,
  username,
  canSync,
  disabled = false,
}: WardrobeScreenProps) {
  const [snapshot, setSnapshot] = useState<SkinLibrarySnapshot | null>(null);
  const [remote, setRemote] = useState<SkinState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [model, setModel] = useState<SkinModel>("classic");
  const [name, setName] = useState("");
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    url: string;
    name: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  const serverId = server?.id;
  const activeId = serverId ? snapshot?.library.active[serverId] : undefined;
  const active = snapshot?.library.skins.find((s) => s.id === activeId);

  useEffect(() => {
    const ticket = ++generation.current;
    setLoading(true);
    setError(undefined);
    void lineApi
      .skinLibrary()
      .then((value) => {
        if (generation.current === ticket) setSnapshot(value);
      })
      .catch((cause) => {
        if (generation.current === ticket) setError(errorMessage(cause));
      })
      .finally(() => {
        if (generation.current === ticket) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
  }, []);

  // The provider's current skin is informational only. Failing to read it must
  // not take the local library down with it.
  useEffect(() => {
    setRemote(null);
    if (!serverId || !canSync) return;
    let cancelled = false;
    void lineApi
      .skin(serverId)
      .then((skin) => {
        if (!cancelled) setRemote(skin);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverId, canSync]);

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
      setSnapshot(next);
      // Adding a texture makes it active locally, but never uploads it.
      if (serverId) {
        const entry = next.library.skins[0];
        if (entry) setSnapshot(await lineApi.setActiveSkin(serverId, entry.id));
      }
      setNotice(
        canSync
          ? "Скин сохранён в истории и выбран активным. Отправьте его на сервер кнопкой ниже."
          : "Скин сохранён в локальной истории и выбран активным.",
      );
      URL.revokeObjectURL(pending.url);
      setPending(null);
      setName("");
      if (inputRef.current) inputRef.current.value = "";
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    if (!serverId) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setSnapshot(await lineApi.setActiveSkin(serverId, id));
      setNotice("Активный скин изменён локально. История сохранена.");
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
      setSnapshot(await lineApi.deleteSkin(id));
      setNotice("Скин удалён из локальной истории.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    if (!serverId) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setRemote(await lineApi.syncActiveSkin(serverId));
      setNotice(
        "Активный скин отправлен на сервер. Остальные остались локально.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resetRemote() {
    if (!serverId) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await lineApi.resetSkin(serverId);
      setRemote(null);
      setNotice(
        "На сервере возвращён стандартный скин. Локальная история цела.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const controlsDisabled = disabled || busy || loading;
  const skins = snapshot?.library.skins ?? [];
  const limit = snapshot?.limit ?? 64;

  const syncHint = !server
    ? "Откройте сервер, чтобы отправить скин провайдеру"
    : !canSync
      ? username
        ? "Провайдер этого сервера не настроил гардероб — скины хранятся только локально"
        : "Войдите в аккаунт, чтобы отправить скин на сервер"
      : !active
        ? "Сначала выберите активный скин в истории"
        : undefined;

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          Гардероб
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          История скинов хранится на этом компьютере
          {server ? ` · активный выбирается для «${server.name}»` : ""}. На
          сервер отправляется только активный скин и только по вашей кнопке.
        </p>
      </div>

      <div className="min-h-10" aria-live="polite">
        {error && (
          <p
            role="alert"
            className="text-destructive border-destructive/20 bg-destructive/5 rounded-lg border p-3 text-xs"
          >
            {error}
          </p>
        )}
        {!error && notice && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-400"
          >
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </p>
        )}
      </div>

      <div className="border-border/40 bg-card/60 flex flex-col gap-4 rounded-xl border p-4 backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <div className="bg-primary/10 text-primary border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
            <Plus className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-foreground text-sm font-semibold">
              Добавить скин в историю
            </h3>
            <p className="text-muted-foreground text-xs leading-relaxed">
              PNG 64×64 или 64×32, до 256 КБ. Работает без входа и без
              интернета.
            </p>
          </div>
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
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {busy ? "Сохраняем…" : "В историю"}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="border-border/40 bg-card/60 flex flex-col gap-4 rounded-xl border p-4 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="bg-primary/10 text-primary border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
              <History className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-foreground text-sm font-semibold">
                Локальная история
              </h3>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {loading
                  ? "Загрузка…"
                  : `${skins.length} из ${limit}. Старые скины остаются здесь и никуда не отправляются.`}
              </p>
            </div>
          </div>
        </div>

        {!loading && skins.length === 0 && (
          <p className="text-muted-foreground border-border/40 rounded-lg border border-dashed p-6 text-center text-xs">
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
                      ? "border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-lg border p-2"
                      : "border-border/40 bg-card/40 flex flex-col gap-2 rounded-lg border p-2"
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
                      {isActive && (
                        <span className="text-primary flex items-center gap-1 text-[10px]">
                          <Check className="h-3 w-3" aria-hidden="true" />
                          активный
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={controlsDisabled || isActive || !server}
                      onClick={() => void activate(skin.id)}
                      aria-label={`Сделать активным: ${skin.name}`}
                      className="flex-1 cursor-pointer text-[10px]"
                    >
                      {isActive ? "Выбран" : "Выбрать"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={controlsDisabled}
                      onClick={() => void remove(skin.id)}
                      aria-label={`Удалить из истории: ${skin.name}`}
                      className="text-muted-foreground hover:text-destructive cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-border/40 bg-card/60 flex flex-col gap-3 rounded-xl border p-4 backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <div className="bg-primary/10 text-primary border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
            <Shirt className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-foreground text-sm font-semibold">
              Скины на сервере
            </h3>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {canSync && username
                ? `${server?.name} · ${username}. Отправляется только активный скин.`
                : (syncHint ?? "Локальный режим")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {syncHint ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    disabled
                    focusableWhenDisabled
                    className="items-center gap-1.5 text-xs opacity-50"
                  >
                    <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />
                    Отправить на сервер
                  </Button>
                }
              />
              <TooltipContent className="max-w-64">{syncHint}</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              disabled={controlsDisabled}
              onClick={() => void sync()}
              className="cursor-pointer items-center gap-1.5 text-xs"
            >
              <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />
              {busy ? "Отправка…" : "Отправить на сервер"}
            </Button>
          )}
          {canSync && remote && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlsDisabled}
              onClick={() => void resetRemote()}
              className="cursor-pointer items-center gap-1.5 text-xs"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Сбросить на стандартный
            </Button>
          )}
          {canSync && (
            <span className="text-muted-foreground font-mono text-[10px]">
              {remote
                ? `на сервере: ${remote.model}`
                : "на сервере: стандартный"}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
