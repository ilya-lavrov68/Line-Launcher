import { useState } from "react";
import {
  Check,
  ClipboardCopy,
  FolderOpen,
  Mail,
  MessageSquare,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { errorMessage, lineApi } from "@/lib/line/api";
import { useT } from "@/lib/line/i18n";
import { OWNER } from "@/brand/owner.generated";
import { cn } from "@/lib/utils";

export interface SupportSectionProps {
  /** The provider's own address from its config, when it advertises one. */
  providerEmail?: string;
  disabled?: boolean;
  /** Shared with the rest of Settings: one status line, not three. */
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * The support block in Settings: the folder, the bundle, and the two mails.
 *
 * Two addresses, deliberately separate:
 *
 * - **The publisher's** (`branding/owner.ts`) — where a launcher bug goes. It is
 *   not in the brand config and cannot be edited by whoever re-brands a build,
 *   so a player's diagnostics cannot be redirected by re-branding.
 * - **The provider's** (`config.json` → `provider.support_email`) — where a
 *   server or account problem goes. Optional; the button is absent, not
 *   disabled-and-mysterious, when they do not offer one.
 *
 * Both buttons send the same bundle «Скопировать диагностику» produces, so a
 * provider and a publisher never argue about which report is authoritative.
 */
export default function SupportSection({
  providerEmail,
  disabled = false,
  onNotice,
  onError,
}: SupportSectionProps) {
  const t = useT();
  const [busy, setBusy] = useState<"copy" | "open" | "owner" | "provider">();
  const [copied, setCopied] = useState(false);

  const run = async (
    which: "copy" | "open" | "owner" | "provider",
    action: () => Promise<string | void>,
    done?: string,
  ) => {
    if (busy) return;
    setBusy(which);
    onError("");
    try {
      const result = await action();
      if (done) onNotice(done);
      return result;
    } catch (cause) {
      onError(errorMessage(cause));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  async function copy() {
    // Clipboard access is the one step that can fail for a reason the launcher
    // cannot fix (a locked-down WebView), so the fallback is honest: the bundle
    // is still returned, and the player is told it could not be copied rather
    // than shown a success tick on a failed copy.
    await run("copy", async () => {
      const bundle = await lineApi.diagnostics();
      try {
        await navigator.clipboard.writeText(bundle);
        setCopied(true);
        onNotice(t("support.copied", { bytes: bundle.length }));
        window.setTimeout(() => setCopied(false), 4000);
      } catch {
        onError(t("support.copyFailed"));
      }
      return bundle;
    });
  }

  async function openFolder() {
    await run(
      "open",
      async () => {
        const path = await lineApi.openLogsFolder();
        onNotice(t("support.opened", { path }));
      },
      undefined,
    );
  }

  async function mail(address: string, which: "owner" | "provider") {
    await run(
      which,
      async () => {
        await lineApi.mailDiagnostics(address);
        onNotice(t("support.mailOpened", { address }));
      },
      undefined,
    );
  }

  const ownerEmail = OWNER.support_email;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || Boolean(busy)}
          onClick={() => void openFolder()}
          className="cursor-pointer text-xs"
        >
          <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("support.openFolder")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || Boolean(busy)}
          onClick={() => void copy()}
          className="cursor-pointer text-xs"
        >
          {copied ? (
            <Check
              className="text-line-online h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <ClipboardCopy className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {copied ? t("support.copiedShort") : t("support.copy")}
        </Button>
      </div>

      {/* The two mails are a separate row: they leave the machine, the two
          above do not, and the difference matters to a player deciding what to
          press. A build without a publisher address simply has no such button
          rather than one that opens an empty draft. */}
      {(ownerEmail || providerEmail) && (
        <div className="flex flex-wrap gap-2">
          {ownerEmail && (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || Boolean(busy)}
              onClick={() => void mail(ownerEmail, "owner")}
              className="cursor-pointer text-xs"
            >
              <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t("support.mailOwner", { name: OWNER.support_name })}
            </Button>
          )}
          {providerEmail && (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || Boolean(busy)}
              onClick={() => void mail(providerEmail, "provider")}
              className="cursor-pointer text-xs"
            >
              <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t("support.mailProvider")}
            </Button>
          )}
        </div>
      )}

      <p
        className={cn(
          "text-muted-foreground/80 text-[11px] leading-relaxed",
          !ownerEmail && !providerEmail && "mb-0",
        )}
      >
        {t("support.hint")}
      </p>
    </div>
  );
}
