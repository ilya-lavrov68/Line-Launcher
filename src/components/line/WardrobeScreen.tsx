import {
  Check,
  CloudOff,
  History,
  Loader2,
  Plus,
  Shirt,
  Trash2,
  UserRound,
} from "@/components/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import SkinPreview from "@/components/line/SkinPreview";
import SectionIcon from "@/components/line/SectionIcon";
import StableActionLabel from "@/components/line/StableActionLabel";
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
import { cn } from "@/lib/utils";
import { MAX_SKIN_BYTES, validateSkinFile } from "@/lib/line/skin";
import { decodePng } from "@/lib/line/png";
import { detectSkinModel } from "@/lib/line/skin-model";
import { useT } from "@/lib/line/i18n";
import { SkeletonWardrobe } from "@/components/line/Skeleton";
import type { SkinLibrarySnapshot, SkinModel, SkinState } from "@/types/line";

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
 * History lives on this machine, so it works offline and needs no provider call
 * of its own. The section is reached after signing in — the sign-in page covers
 * the whole window — and the active skin is pushed to the provider by itself:
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
  const t = useT();
  const [snapshot, setSnapshot] = useState<SkinLibrarySnapshot | null>(null);
  const [remote, setRemote] = useState<SkinState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [sync, setSync] = useState<SyncPhase>("idle");
  const [syncError, setSyncError] = useState<string>();
  const [model, setModel] = useState<SkinModel>("classic");
  /** True while `model` was read from the picked file and not chosen by hand. */
  const [modelDetected, setModelDetected] = useState(false);
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
      // Deliberately NOT calling `onAuthRequired` here.
      //
      // This is the background sync that runs by itself when the screen mounts.
      // Signing the player out on it made opening the wardrobe a logout: any
      // rejection from the provider — an expired token, a 403 from a proxy in
      // front of it, a wardrobe endpoint that answers 401 because it is not
      // configured — came back as AUTH_REQUIRED and cleared the session, taking
      // the whole screen with it, mid-edit, without the player pressing
      // anything. The failure is already shown in the sync status above; a
      // genuine expiry is caught by the next *user-initiated* action, which is
      // where a sign-out is expected.
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

  /**
   * Best-effort read of the arm width from the file the player just picked.
   * Never throws: an unreadable file leaves the dropdown where it was, which is
   * no worse than the old behaviour.
   */
  async function detectModel(
    bytes: Uint8Array,
  ): Promise<SkinModel | "unknown"> {
    const image = await decodePng(bytes);
    return image ? detectSkinModel(image) : "unknown";
  }

  function chooseFile(file: File | undefined) {
    setError(undefined);
    setNotice(undefined);
    if (!file) return;
    if (file.size > MAX_SKIN_BYTES) {
      setError(t("wardrobe.fileTooBig"));
      return;
    }
    // Seed the name field *synchronously*, before the decode starts. Both
    // halves of this used to run inside the async callback, so a rename typed
    // while the bytes were being read was silently replaced by the file name a
    // moment later — «Второй» became «second» under the player's cursor. The
    // file name is already known here; there is nothing to wait for.
    if (!name.trim()) setName(file.name.replace(/\.png$/i, "").slice(0, 64));
    void file.arrayBuffer().then(async (buffer) => {
      const bytes = new Uint8Array(buffer);
      const problem = validateSkinFile(bytes);
      if (problem) {
        setError(problem);
        return;
      }
      // The model comes from the file, not from a dropdown the player has to
      // get right. A Minecraft skin does not name its own arm width, but the
      // pixels do (see `detectSkinModel`); the select stays below so an
      // ambiguous texture can still be corrected by hand.
      const detected = await detectModel(bytes);
      if (detected !== "unknown") {
        setModel(detected);
        setModelDetected(true);
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
      setNotice(t("wardrobe.saved"));
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
      setNotice(id ? t("wardrobe.activated") : t("wardrobe.defaultSelected"));
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
      setNotice(t("wardrobe.removed"));
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
        text: username ? t("wardrobe.noProvider") : t("wardrobe.signInToSync"),
      }
    : sync === "sending"
      ? {
          icon: Loader2,
          tone: "text-muted-foreground",
          text: t("wardrobe.syncing"),
        }
      : sync === "failed"
        ? {
            icon: CloudOff,
            tone: "text-destructive",
            // Says what failed and what happens next, in one clause.
            text: `${t("wardrobe.syncFailed")} ${syncError ?? t("wardrobe.syncRetry")}`,
          }
        : {
            icon: Check,
            tone: "text-line-online",
            // The panel title already says "на серверах проекта"; repeating it
            // in the status line was the third time on one screen.
            text: active
              ? t("wardrobe.syncedAuto", { name: active.name })
              : t("wardrobe.serverDefault"),
          };
  const SyncIcon = syncStatus.icon;

  // The library, the remote state and the sync answer all arrive after mount.
  // The upload card and the rows keep their places instead of appearing under
  // the player's cursor once the reads land.
  if (loading && !snapshot) {
    return (
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-xl font-bold tracking-tight">
            {t("wardrobe.title")}
          </h2>
        </div>
        <SkeletonWardrobe />
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-xl font-bold tracking-tight">
          {t("wardrobe.title")}
        </h2>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("wardrobe.subtitle")}
        </p>
      </div>

      <div className="min-h-5" aria-live="polite">
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

      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="bg-fill-subtle flex min-w-0 flex-col gap-4 rounded-[var(--radius-item)] p-4">
          <div className="border-border/40 flex flex-col items-center gap-2 rounded-[var(--radius-control)] border p-4">
            <p className="text-muted-foreground self-start text-xs">
              {t("wardrobe.activePreview")}
            </p>
            {active ? (
              <SkinThumb
                skinId={active.id}
                model={active.model}
                scale={5}
                className="h-44 w-24"
              />
            ) : (
              <div className="text-muted-foreground flex h-44 items-center justify-center text-xs">
                {t("wardrobe.standardSkin")}
              </div>
            )}
            <p className="text-foreground max-w-full truncate text-xs font-medium">
              {active?.name ?? t("wardrobe.standardSkin")}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-foreground text-sm font-semibold">
              {t("wardrobe.add")}
            </h3>
            <span className="text-muted-foreground shrink-0 font-mono text-[12px]">
              {t("wardrobe.pngHint")}
            </span>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label
                  htmlFor="skin-file"
                  className="text-muted-foreground text-xs"
                >
                  {t("wardrobe.fileLabel")}
                </Label>
                {/* A real <input type="file">, kept for the keyboard path and
                  for `setInputFiles` in the smoke test. It is `sr-only` rather
                  than `hidden`: `display:none` cannot receive focus or a click,
                  which is exactly what the label below forwards. */}
                <input
                  id="skin-file"
                  ref={inputRef}
                  type="file"
                  accept="image/png"
                  disabled={controlsDisabled}
                  onChange={(event) => chooseFile(event.target.files?.[0])}
                  className="peer sr-only"
                />
                <label
                  htmlFor="skin-file"
                  className={cn(
                    "border-input flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border bg-transparent px-1.5 text-xs",
                    "hover:bg-fill-subtle hover:border-foreground/25 transition-colors",
                    "peer-focus-visible:border-ring peer-focus-visible:ring-ring/40 peer-focus-visible:ring-3",
                    controlsDisabled && "pointer-events-none opacity-50",
                  )}
                >
                  <span className="bg-fill text-foreground flex h-[26px] shrink-0 items-center rounded-[6px] px-3 font-medium">
                    {t("wardrobe.chooseFile")}
                  </span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {pending?.name ?? t("wardrobe.noFile")}
                  </span>
                </label>
              </div>
              <div className="flex flex-col gap-2">
                <Label
                  htmlFor="skin-name"
                  className="text-muted-foreground text-xs"
                >
                  {t("wardrobe.nameLabel")}
                </Label>
                <Input
                  id="skin-name"
                  value={name}
                  maxLength={64}
                  disabled={controlsDisabled}
                  placeholder={t("wardrobe.namePlaceholder")}
                  onChange={(event) => setName(event.target.value)}
                  className="text-xs"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground text-xs">
                  {t("wardrobe.modelLabel")}
                </Label>
                <Select
                  value={model}
                  disabled={controlsDisabled}
                  onValueChange={(value) => {
                    setModel(value as SkinModel);
                    // Chosen by hand from here on: stop claiming it was read.
                    setModelDetected(false);
                  }}
                >
                  <SelectTrigger className="w-full text-xs">
                    <SelectValue>
                      {(value: SkinModel | null) =>
                        value === "slim"
                          ? t("wardrobe.slim")
                          : t("wardrobe.classic")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="classic">
                      {t("wardrobe.classic")}
                    </SelectItem>
                    <SelectItem value="slim">{t("wardrobe.slim")}</SelectItem>
                  </SelectContent>
                </Select>
                {/* Says where the value came from. The player did not pick it and
                  should not have to wonder whether it is right. Placed under
                  the field rather than between it and its label: above, it
                  pushed this one field out of line with the button beside it. */}
                {pending && modelDetected && (
                  <p className="text-muted-foreground text-[11px] leading-relaxed">
                    {t("wardrobe.modelDetected")}
                  </p>
                )}
              </div>
            </div>
            {pending && (
              <div className="flex shrink-0 flex-col items-center gap-2">
                <Label className="text-muted-foreground text-xs">
                  {t("wardrobe.previewLabel")}
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
                  <StableActionLabel
                    busy={busy}
                    idle={t("wardrobe.toHistory")}
                    active={t("wardrobe.saving")}
                  />
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="bg-fill-subtle flex min-w-0 flex-col gap-4 rounded-[var(--radius-item)] p-4">
          <div className="flex items-start gap-3">
            <SectionIcon icon={History} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-foreground text-sm font-semibold">
                {t("wardrobe.local")}
              </h3>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {loading ? t("common.loading") : `${skins.length} / ${limit}`}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={controlsDisabled || !activeId}
            onClick={() => void activate(null)}
            aria-label={t("wardrobe.pickDefault")}
            className={
              !activeId
                ? "bg-primary/10 flex cursor-pointer items-center gap-3 rounded-lg p-2 text-left disabled:cursor-default"
                : "hover:bg-fill/60 flex cursor-pointer items-center gap-3 rounded-lg p-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
            }
          >
            <UserRound
              data-line-icon
              className="text-muted-foreground h-6 w-6 shrink-0"
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-foreground text-xs font-medium">
                {t("wardrobe.standardSkin")}
              </span>
              <span className="text-muted-foreground text-[12px]">
                {!activeId
                  ? t("wardrobe.isActive")
                  : t("wardrobe.backToDefault")}
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
              {t("wardrobe.emptyHistory")}
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
                        <span className="text-muted-foreground font-mono text-[12px]">
                          {skin.width}×{skin.height} · {skin.model}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        disabled={controlsDisabled || isActive}
                        onClick={() => void activate(skin.id)}
                        aria-label={t("wardrobe.activateNamed", {
                          name: skin.name,
                        })}
                        aria-pressed={isActive}
                        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 px-1 py-0.5 text-[12px] font-medium enabled:hover:bg-transparent disabled:cursor-default disabled:opacity-60"
                      >
                        {isActive ? t("wardrobe.active") : t("wardrobe.select")}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={controlsDisabled}
                        onClick={() => void remove(skin.id)}
                        aria-label={t("wardrobe.removeNamed", {
                          name: skin.name,
                        })}
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
      </div>

      <div className="bg-fill-subtle flex items-start gap-3 rounded-[var(--radius-item)] p-4">
        <SectionIcon icon={Shirt} />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-foreground text-sm font-semibold">
            {t("wardrobe.onServersTitle")}
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
            <span className="text-muted-foreground font-mono text-[12px]">
              {remote
                ? t("wardrobe.model", { model: remote.model })
                : t("wardrobe.modelDefault")}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
