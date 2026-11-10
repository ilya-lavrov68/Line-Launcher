import { LogOut, RefreshCw, Shirt, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import SectionIcon from "@/components/line/SectionIcon";
import SkinViewer3D from "@/components/line/SkinViewer3D";
import { Button } from "@/components/ui/button";
import { errorMessage, lineApi } from "@/lib/line/api";
import type { AuthSessionInfo, SkinState } from "@/types/line";

export interface ProfileScreenProps {
  session: AuthSessionInfo;
  providerName: string;
  /** True when the provider exposes wardrobe endpoints at all. */
  canSync: boolean;
  onLogout: () => void;
  onOpenWardrobe: () => void;
  disabled?: boolean;
}

/**
 * The account page: who you are, and what you look like in game.
 *
 * The launcher has one project account shared by every server, so this page has
 * nothing to choose — it is a fingerprint, not a picker. What it does add is the
 * one thing the wardrobe could not show: the skin as a body, not a texture.
 *
 * The active skin is read from the same local index the wardrobe writes, so the
 * two screens can never disagree. When the project supports the wardrobe the
 * provider's copy wins (it is what the game will actually load); otherwise the
 * local active skin is shown and the sync line says so in one sentence rather
 * than pretending.
 */
export default function ProfileScreen({
  session,
  providerName,
  canSync,
  onLogout,
  onOpenWardrobe,
  disabled = false,
}: ProfileScreenProps) {
  const [skin, setSkin] = useState<SkinState | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  /**
   * The active skin, in whichever form exists.
   *
   * The local library stores PNGs as files, not URLs, so the texture is read
   * back and wrapped in an object URL — the same round trip the wardrobe
   * thumbnails use. Object URLs are not garbage collected while they are live,
   * so one ref owns the current URL: it is revoked before a replacement and on
   * unmount, otherwise every refresh would leak a skin into the page.
   *
   * When nothing is active locally the provider is asked instead: the account
   * may have picked a skin before this machine ever existed.
   */
  const objectUrl = useRef<string | undefined>(undefined);
  const disposeUrl = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = undefined;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    disposeUrl();
    try {
      const snapshot = await lineApi.skinLibrary();
      const entry = snapshot.library.skins.find(
        (s) => s.id === snapshot.library.active,
      );
      setActiveName(entry?.name ?? null);
      if (entry) {
        const bytes = await lineApi.skinTexture(entry.id);
        if (!bytes?.length) throw new Error("Текстура не найдена на диске.");
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        );
        objectUrl.current = url;
        setSkin({ model: entry.model, textureUrl: url });
      } else {
        setSkin(await lineApi.skin().catch(() => null));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [disposeUrl]);

  useEffect(() => {
    void load();
    return disposeUrl;
  }, [load, disposeUrl, session.username]);

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          Аккаунт
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Один аккаунт на весь проект {providerName}.
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

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_288px]">
        <div className="bg-fill-subtle flex flex-col gap-4 rounded-[var(--radius-item)] p-4">
          <div className="flex items-start gap-3">
            <SectionIcon icon={UserRound} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-foreground text-sm font-semibold">
                {session.username}
              </h3>
              <p className="text-muted-foreground text-xs">{providerName}</p>
            </div>
          </div>

          {/*
            The session expiry is the only account state the launcher actually
            holds. Shown as a date, not a timestamp: "истекает 12 ноября" is
            something a player can act on; a millisecond epoch is not.
          */}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Сессия истекает</dt>
            <dd className="text-foreground">
              {new Date(session.expiresAt).toLocaleString("ru-RU", {
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </dd>
            <dt className="text-muted-foreground">Скин</dt>
            <dd className="text-foreground truncate">
              {loading ? "Загрузка…" : (activeName ?? "Стандартный")}
            </dd>
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || loading}
              onClick={() => void load()}
              className="cursor-pointer items-center gap-1.5 text-xs"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Обновить
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onOpenWardrobe}
              className="cursor-pointer items-center gap-1.5 text-xs"
            >
              <Shirt className="h-4 w-4" aria-hidden="true" />
              Гардероб
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={onLogout}
              className="text-muted-foreground hover:text-foreground cursor-pointer items-center gap-1.5 text-xs"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Выйти
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <SkinViewer3D
            src={skin?.textureUrl}
            model={skin?.model ?? "classic"}
            height={288}
          />
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            {skin
              ? canSync
                ? "Этот скин отправлен на сервер — вы выглядите так в игре."
                : "Скин активен локально. Проект не поддерживает загрузку скинов."
              : "Выберите скин в гардеробе, чтобы увидеть его здесь."}
          </p>
        </div>
      </div>
    </section>
  );
}
