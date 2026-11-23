import { m } from "framer-motion";
import { Link2, RefreshCw } from "@/components/ui/icons";
import { useId, useState, type FormEvent } from "react";
import { useT } from "@/lib/line/i18n";
import { Button } from "@/components/ui/button";
import StableActionLabel from "./StableActionLabel";
import FieldMessage from "./FieldMessage";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ConfigUrlInputProps {
  initialUrl?: string;
  loading?: boolean;
  error?: string;
  onSubmit: (url: string) => void;
}

/**
 * Provider URL entry. A filled panel with no outline, an unframed icon, and
 * the Input/Label/Button primitives. No new colours or radii.
 */
export default function ConfigUrlInput({
  initialUrl = "",
  loading = false,
  error,
  onSubmit,
}: ConfigUrlInputProps) {
  const id = useId();
  const t = useT();
  const [url, setUrl] = useState(initialUrl);
  const [validation, setValidation] = useState<string>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const trimmed = url.trim();
    try {
      const parsed = new URL(trimmed);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      ) {
        throw new Error("invalid");
      }
      setValidation(undefined);
      onSubmit(parsed.toString());
    } catch {
      setValidation(t("connect.urlInvalid"));
    }
  }

  const message = validation ?? error;
  return (
    <m.section
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, type: "spring", bounce: 0.3 }}
      className="bg-fill-subtle flex w-full max-w-md flex-col items-center justify-center gap-6 rounded-[var(--radius-item)] p-10 text-center"
      aria-labelledby={`${id}-title`}
    >
      <Link2
        data-line-icon
        className="text-primary h-10 w-10"
        aria-hidden="true"
      />
      <div>
        <h2 id={`${id}-title`} className="mb-2 text-2xl font-bold">
          {t("connect.urlTitle")}
        </h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("connect.urlBody")}
        </p>
      </div>

      <form
        noValidate
        onSubmit={submit}
        className="flex w-full flex-col gap-4 text-left"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={id} className="text-xs">
            {t("connect.urlLabel")}
          </Label>
          <Input
            id={id}
            type="url"
            required
            maxLength={2048}
            autoComplete="url"
            spellCheck={false}
            placeholder={t("connect.urlPlaceholder")}
            value={url}
            disabled={loading}
            onChange={(event) => {
              setUrl(event.target.value);
              setValidation(undefined);
            }}
            aria-invalid={Boolean(validation)}
            aria-describedby={`${id}-help${message ? ` ${id}-error` : ""}`}
            className="text-xs"
          />
          {/*
            One fixed-height slot for help *and* error. Rendering the error as an
            extra block changed the card height, and because the card is centred
            the submit button jumped 24px on every submit (the error is cleared
            while the request runs, then comes back). Swapping the content of a
            reserved slot keeps the button perfectly still. min-h covers the
            longest provider message at the narrowest supported window.
          */}
          <div
            className="flex min-h-12 items-start gap-1.5 text-[12px] leading-relaxed"
            aria-live="polite"
          >
            {message ? (
              <FieldMessage id={`${id}-error`}>{message}</FieldMessage>
            ) : (
              <FieldMessage tone="hint" id={`${id}-help`}>
                {t("connect.urlHelp")}
              </FieldMessage>
            )}
          </div>
        </div>
        <Button
          type="submit"
          disabled={loading || !url.trim()}
          className="h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg text-sm font-semibold"
        >
          {loading ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="h-4 w-4" />
          )}
          <StableActionLabel
            busy={loading}
            idle={t("connect.submit")}
            active={t("connect.submitting")}
          />
        </Button>
      </form>
    </m.section>
  );
}
