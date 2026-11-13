import { useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/line/i18n";
import {
  MAX_SECTIONS,
  pluralBucket,
  type ServerLayout,
} from "@/lib/line/server-layout";
import { cn } from "@/lib/utils";

export interface SectionHeaderProps {
  name: string;
  count: number;
  collapsed: boolean;
  /** The implicit "no section" group: no menu, no delete, no rename. */
  implicit?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}

/**
 * A section heading that is also its control.
 *
 * Collapsing is the heading itself — a separate chevron button next to a label
 * would be two targets for one idea. The menu («…») holds the destructive
 * actions, which is where they belong: renaming and deleting a folder are rare
 * next to opening it.
 *
 * The count is always visible, including on a collapsed section: "3 серверов"
 * is how a player knows there is something inside without expanding it.
 */
export default function SectionHeader({
  name,
  count,
  collapsed,
  implicit = false,
  disabled = false,
  onToggle,
  onRename,
  onRemove,
}: SectionHeaderProps) {
  const t = useT();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const label = implicit ? t("sections.untitled") : name;
  // «1 сервер» / «2 сервера» / «5 серверов» — the count is a sentence, and
  // "1 серверов" is the kind of thing that shows up in every support screenshot.
  const countKey =
    pluralBucket(count) === 0
      ? "sections.countOne"
      : pluralBucket(count) === 1
        ? "sections.countFew"
        : "sections.countMany";
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  function submitRename() {
    onRename(draft);
    setRenaming(false);
  }

  return (
    <div className="mb-3 flex items-center gap-2">
      {renaming ? (
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
          }}
        >
          <input
            autoFocus
            value={draft}
            maxLength={40}
            aria-label={t("sections.renamePrompt")}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
            className="border-input bg-background text-foreground h-7 min-w-0 flex-1 rounded-[var(--radius-control)] border px-2 text-sm"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="cursor-pointer text-xs"
          >
            {t("common.save")}
          </Button>
        </form>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? t("sections.expand", { name: label })
              : t("sections.collapse", { name: label })
          }
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <Chevron
            className="text-muted-foreground group-hover:text-foreground h-4 w-4 shrink-0 transition-colors"
            aria-hidden="true"
          />
          <span
            className={cn(
              "truncate text-sm font-semibold tracking-tight",
              implicit ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {label}
          </span>
          <span className="text-muted-foreground/70 shrink-0 text-[11px] tabular-nums">
            {t(countKey, { count })}
          </span>
        </button>
      )}

      {!implicit && !renaming && (
        <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={t("common.more")}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
            className="h-7 w-7 cursor-pointer p-0"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </Button>
          <AnimatePresence>
            {menu && (
              <m.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.12 }}
                role="menu"
                className="border-border/60 bg-popover text-popover-foreground absolute right-0 z-20 mt-1 w-56 rounded-[var(--radius-control)] border p-1 shadow-sm"
              >
                <button
                  role="menuitem"
                  type="button"
                  className="hover:bg-accent/15 flex w-full cursor-pointer rounded-[var(--radius-control)] px-2 py-1.5 text-left text-xs"
                  onClick={() => {
                    setDraft(name);
                    setMenu(false);
                    setRenaming(true);
                  }}
                >
                  {t("sections.rename")}
                </button>
                <button
                  role="menuitem"
                  type="button"
                  className="hover:bg-destructive/15 text-destructive flex w-full cursor-pointer rounded-[var(--radius-control)] px-2 py-1.5 text-left text-xs"
                  onClick={() => {
                    setMenu(false);
                    onRemove();
                  }}
                >
                  {t("sections.remove")}
                </button>
                <p className="text-muted-foreground/70 px-2 pt-1 pb-1 text-[11px] leading-relaxed">
                  {t("sections.removeHint")}
                </p>
              </m.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

export interface AddSectionButtonProps {
  layout: ServerLayout;
  disabled?: boolean;
  onAdd: (name: string) => void;
}

/** «Добавить секцию». Hidden once the cap is reached, with no error to explain. */
export function AddSectionButton({
  layout,
  disabled = false,
  onAdd,
}: AddSectionButtonProps) {
  const t = useT();
  if (layout.sections.length >= MAX_SECTIONS) return null;
  const next = layout.sections.length + 1;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => onAdd(t("sections.defaultName", { n: next }))}
      className="cursor-pointer self-start text-xs"
    >
      <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
      {t("sections.add")}
    </Button>
  );
}
