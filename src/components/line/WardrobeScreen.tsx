import { Check, RotateCcw, Shirt, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import SkinPreview from "@/components/line/SkinPreview";
import { Button } from "@/components/ui/button";
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
import type { LineServer, SkinModel, SkinState } from "@/types/line";

export interface WardrobeScreenProps {
  server: LineServer;
  username: string;
  disabled?: boolean;
}

/**
 * Skin management for the signed-in account.
 *
 * The provider owns storage and the account binding: the launcher validates the
 * PNG locally, then Rust forwards it under the existing bearer session. No second
 * credential is introduced and the access token never reaches the WebView.
 */
export default function WardrobeScreen({
  server,
  username,
  disabled = false,
}: WardrobeScreenProps) {
  const [current, setCurrent] = useState<SkinState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [model, setModel] = useState<SkinModel>("classic");
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    url: string;
    name: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  useEffect(() => {
    const ticket = ++generation.current;
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    setCurrent(null);
    void lineApi
      .skin(server.id)
      .then((skin) => {
        if (generation.current !== ticket) return;
        setCurrent(skin);
        if (skin) setModel(skin.model);
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
  }, [server.id]);

  // Revoke the object URL so switching servers cannot leak blobs.
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
    });
  }

  async function upload() {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const skin = await lineApi.uploadSkin(
        server.id,
        model,
        Array.from(pending.bytes),
      );
      setCurrent(skin);
      setNotice("Скин обновлён и синхронизирован с сервером.");
      URL.revokeObjectURL(pending.url);
      setPending(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await lineApi.resetSkin(server.id);
      setCurrent(null);
      setNotice("Скин сброшен на стандартный.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const controlsDisabled = disabled || busy || loading;

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          Гардероб
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {server.name} · {username}. Скин хранится у провайдера и применяется к
          вашему аккаунту на сервере.
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

      <div className="border-border/40 bg-card/60 flex flex-col gap-5 rounded-xl border p-4 backdrop-blur-sm sm:flex-row">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <Label className="text-muted-foreground text-xs">Текущий</Label>
          <SkinPreview
            src={current?.textureUrl}
            model={current?.model ?? "classic"}
            className="h-52 w-28"
          />
          <span className="text-muted-foreground font-mono text-[10px]">
            {loading ? "загрузка…" : current ? current.model : "стандартный"}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="bg-primary/10 text-primary border-primary/20 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
            <Shirt className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="skin-file"
              className="text-muted-foreground text-xs"
            >
              Текстура PNG, 64×64 или 64×32, до 256 КБ
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
            {pending && (
              <p className="text-muted-foreground truncate font-mono text-[10px]">
                {pending.name}
              </p>
            )}
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

          {pending && (
            <div className="flex items-center gap-3">
              <SkinPreview
                src={pending.url}
                model={model}
                scale={4}
                className="h-36 w-20"
              />
              <div className="flex flex-col gap-2">
                <span className="text-muted-foreground text-[10px]">
                  Предпросмотр
                </span>
                <Button
                  size="sm"
                  disabled={controlsDisabled}
                  onClick={() => void upload()}
                  className="cursor-pointer items-center gap-1.5 text-xs"
                >
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  {busy ? "Отправка…" : "Применить скин"}
                </Button>
              </div>
            </div>
          )}

          {current && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlsDisabled}
              onClick={() => void reset()}
              className="cursor-pointer items-center gap-1.5 self-start text-xs"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Сбросить на стандартный
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
