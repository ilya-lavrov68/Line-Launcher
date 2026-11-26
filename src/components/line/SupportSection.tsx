import { useState } from "react";
import {
  FileText,
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
 * The support block in Settings: the folder, a TXT export, and the two mails.
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
 * Both mail buttons send the same report as the saved TXT export, so a
 * provider and a publisher never argue about which report is authoritative.
 */
export default function SupportSection({
  providerEmail,
  disabled = false,
  onNotice,
  onError,
}: SupportSectionProps) {
  const t = useT();
  const [busy, setBusy] = useState<"export" | "open" | "owner" | "provider">();

  const run = async (
    which: "export" | "open" | "owner" | "provider",
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

  async function saveTxt() {
    await run("export", async () => {
      const path = await lineApi.exportDiagnostics();
      onNotice(t("support.exported", { path }));
      return path;
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
          onClick={() => void saveTxt()}
          className="cursor-pointer text-xs"
        >
          <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("support.exportTxt")}
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
