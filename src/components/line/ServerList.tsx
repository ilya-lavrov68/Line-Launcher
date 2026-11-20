import { m } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent } from "react";
import { LayoutGrid, ListCollapse, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CatalogView, LineServer } from "@/types/line";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/line/i18n";
import {
  EMPTY_LAYOUT,
  NO_SECTION,
  groupServers,
  moveServerToSection,
  newSection,
  removeSection,
  renameSection,
  setCollapsed,
  type ServerLayout,
} from "@/lib/line/server-layout";
import HarmonyCatalog from "./HarmonyCatalog";
import ServerCard from "./ServerCard";
import StableActionLabel from "./StableActionLabel";
import SectionHeader, { AddSectionButton } from "./SectionHeader";

export interface ServerListProps {
  providerName: string;
  servers: LineServer[];
  installedIds?: ReadonlySet<string>;
  stale?: boolean;
  refreshing?: boolean;
  actionsDisabled?: boolean;
  onSelect: (server: LineServer) => void;
  onRefresh: () => void;
  /** The rail above the catalogue: last opened server and its one action. */
  rail?: React.ReactNode;
  /**
   * Per-server status text. The catalogue must not infer "installed" from an
   * id alone: a newer published revision means the server needs an update.
   */
  statusFor?: (server: LineServer) => string | undefined;
  /**
   * The player's grouping. Absent = one flat grid, which is what a fresh
   * install has and what the provider's contract describes.
   */
  layout?: ServerLayout;
  onLayoutChange?: (next: ServerLayout) => void;
  /**
   * `grid` draws every server as a card; `harmony` folds all but one into rows.
   * The control that switches it lives in the header, next to Refresh.
   */
  view?: CatalogView;
  onViewChange?: (next: CatalogView) => void;
}

/**
 * Provider showcase. The stale-config warning is a tinted surface with an icon
 * and amber text — no outline, because the colour and the icon already carry it.
 */
export default function ServerList({
  providerName,
  servers,
  installedIds = new Set(),
  stale = false,
  refreshing = false,
  actionsDisabled = false,
  onSelect,
  onRefresh,
  rail,
  statusFor,
  layout,
  onLayoutChange,
  view = "grid",
  onViewChange,
}: ServerListProps) {
  const t = useT();
  const listRef = useRef<HTMLElement>(null);
  const cleanupDrag = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<{
    server: LineServer;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    width: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const canMove = Boolean(
    layout &&
    onLayoutChange &&
    layout.sections.length > 0 &&
    !refreshing &&
    !actionsDisabled,
  );
  const current = useRef({ canMove, layout, servers, onLayoutChange });
  current.current = { canMove, layout, servers, onLayoutChange };
  useEffect(() => () => cleanupDrag.current?.(), []);

  function beginDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    server: LineServer,
  ) {
    // Keep touch scrolling and keyboard activation intact; the section selector
    // remains available for non-mouse input. A normal click still opens the card.
    if (
      !canMove ||
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      !layout
    )
      return;
    cleanupDrag.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const bounds = event.currentTarget.getBoundingClientRect();
    let active = false;
    const targetAt = (x: number, y: number): string | null => {
      const node = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-section-id]");
      return node && listRef.current?.contains(node)
        ? (node.dataset.sectionId ?? null)
        : null;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("blur", blur);
      cleanupDrag.current = null;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) < 6)
        return;
      active = true;
      e.preventDefault();
      setDragging({
        server,
        x: e.clientX,
        y: e.clientY,
        offsetX: startX - bounds.left,
        offsetY: startY - bounds.top,
        width: bounds.width,
      });
      setDropTarget(targetAt(e.clientX, e.clientY));
    };
    const cancel = (e?: PointerEvent) => {
      if (e && e.pointerId !== pointerId) return;
      if (active) {
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
      setDragging(null);
      setDropTarget(null);
      cleanup();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (active && current.current.canMove && current.current.layout) {
        const target = targetAt(e.clientX, e.clientY);
        if (target !== null) {
          const latest = current.current;
          const next = moveServerToSection(
            latest.layout!,
            latest.servers,
            server.id,
            target,
          );
          if (next !== latest.layout) latest.onLayoutChange?.(next);
        }
      }
      cancel(e);
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    const blur = () => cancel();
    cleanupDrag.current = cleanup;
    window.addEventListener("blur", blur);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keydown);
  }
  // One call decides the shape; the component only renders it. `layout`
  // undefined means the flat catalogue, so grouping is opt-in by the caller.
  const groups =
    layout === undefined
      ? groupServers(servers, EMPTY_LAYOUT)
      : groupServers(servers, layout);
  // The implicit group normally disappears when empty, but it must remain a
  // drop target while dragging so every server can be moved back out.
  const targets =
    dragging && !groups.some((group) => group.id === NO_SECTION)
      ? [...groups, { id: NO_SECTION, name: "", collapsed: false, servers: [] }]
      : groups;
  return (
    <section
      ref={listRef}
      aria-labelledby="server-list-title"
      className="flex flex-col gap-6"
    >
      {rail}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The provider name is the section title. A «Провайдер» kicker above
            it named the same thing twice and pushed the name down a line. */}
        <h2
          id="server-list-title"
          className="text-foreground text-xl font-bold tracking-tight"
        >
          {providerName}
        </h2>
        <div className="flex items-center gap-2">
          {/* Keep both catalogue layouts available even when the player has
              sections: Harmony is a temporary presentation choice, not an edit
              to those saved groups. Labeled buttons make the less familiar
              horizontal accordion discoverable without relying on tooltips. */}
          <div
            role="group"
            aria-label={t("catalog.view")}
            className="border-border/50 bg-fill-subtle flex items-center gap-0.5 rounded-[var(--radius-control)] border p-0.5"
          >
            <button
              type="button"
              aria-pressed={view === "grid"}
              aria-label={t("catalog.grid")}
              title={t("catalog.grid")}
              onClick={() => onViewChange?.("grid")}
              className={cn(
                "flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2 text-[11px] font-medium transition-colors",
                view === "grid"
                  ? "bg-fill-strong text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LayoutGrid className="size-3.5" aria-hidden="true" />
              <span>{t("catalog.grid")}</span>
            </button>
            <button
              type="button"
              aria-pressed={view === "harmony"}
              aria-label={t("catalog.harmony")}
              title={t("catalog.harmony")}
              onClick={() => onViewChange?.("harmony")}
              className={cn(
                "flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2 text-[11px] font-medium transition-colors",
                view === "harmony"
                  ? "bg-fill-strong text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ListCollapse className="size-3.5" aria-hidden="true" />
              <span>{t("catalog.harmony")}</span>
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing || actionsDisabled}
            className="flex cursor-pointer items-center gap-1.5 text-xs"
          >
            <RefreshCw
              className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              aria-hidden="true"
            />
            <StableActionLabel
              busy={refreshing}
              idle={t("servers.refresh")}
              active={t("servers.refreshing")}
            />
          </Button>
        </div>
      </div>

      {stale && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-[var(--radius-control)] bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("servers.staleBody")}</span>
        </p>
      )}

      {view === "grid" &&
        layout !== undefined &&
        layout.sections.length === 0 && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("sections.emptyHint")}
          </p>
        )}

      {view === "grid" &&
        layout !== undefined &&
        layout.sections.length > 0 && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("sections.dragHint")}
          </p>
        )}

      {/* Harmony temporarily replaces the grouped grid; the saved sections
          remain untouched and return when the player switches back. Keep grid
          editing controls out of this presentation so every visible gesture
          continues to work. */}
      {view === "harmony" ? (
        <HarmonyCatalog
          servers={servers}
          installedIds={installedIds}
          statusFor={statusFor}
          disabled={refreshing || actionsDisabled}
          onSelect={onSelect}
        />
      ) : null}

      {view === "grid" &&
        targets.map((group) => (
          <div
            key={group.id || "unsorted"}
            data-section-drop={group.id || "unassigned"}
            data-section-id={group.id}
            className={`flex flex-col rounded-lg ${dropTarget === group.id ? "bg-primary/10 ring-primary/60 ring-2" : ""}`}
          >
            {/* A single flat group with no name is the pre-sections catalogue;
              a heading saying "No section" over every server would be noise. */}
            {(layout !== undefined || group.id !== "") && (
              <SectionHeader
                name={group.name}
                count={group.servers.length}
                collapsed={group.collapsed}
                implicit={group.id === ""}
                disabled={refreshing || actionsDisabled}
                onToggle={() =>
                  onLayoutChange?.(
                    setCollapsed(
                      layout ?? EMPTY_LAYOUT,
                      group.id,
                      !group.collapsed,
                    ),
                  )
                }
                onRename={(name) =>
                  onLayoutChange?.(
                    renameSection(layout ?? EMPTY_LAYOUT, group.id, name),
                  )
                }
                onRemove={() =>
                  onLayoutChange?.(
                    removeSection(layout ?? EMPTY_LAYOUT, group.id),
                  )
                }
              />
            )}
            {!group.collapsed && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.servers.map((server, index) => (
                  <m.div
                    key={server.id}
                    data-server-drag={server.id}
                    onPointerDown={(event) => beginDrag(event, server)}
                    onDragStart={(event) => event.preventDefault()}
                    className={`${canMove ? "cursor-grab select-none active:cursor-grabbing" : ""} ${dragging?.server.id === server.id ? "opacity-30" : ""}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{
                      opacity: dragging?.server.id === server.id ? 0.3 : 1,
                      y: 0,
                    }}
                    transition={{
                      duration: 0.2,
                      delay: Math.min(index * 0.035, 0.2),
                    }}
                  >
                    <ServerCard
                      name={server.name}
                      description={server.description}
                      iconUrl={server.icon_url ?? server.logo_url}
                      bannerUrl={server.banner_url}
                      version={server.version}
                      minecraftVersion={server.minecraft_version}
                      installed={installedIds.has(server.id)}
                      statusLabel={statusFor?.(server)}
                      hasPack={Boolean(server.pack_manifest_url)}
                      disabled={refreshing || actionsDisabled}
                      onClick={() => {
                        if (!suppressClick.current) onSelect(server);
                      }}
                    />
                  </m.div>
                ))}
              </div>
            )}
          </div>
        ))}

      {dragging &&
        createPortal(
          <div
            aria-hidden="true"
            data-drag-preview
            className="pointer-events-none fixed z-[9999] opacity-90 shadow-2xl"
            style={{
              left: dragging.x - dragging.offsetX,
              top: dragging.y - dragging.offsetY,
              width: dragging.width,
            }}
          >
            <ServerCard
              name={dragging.server.name}
              description={dragging.server.description}
              iconUrl={dragging.server.icon_url ?? dragging.server.logo_url}
              bannerUrl={dragging.server.banner_url}
              version={dragging.server.version}
              minecraftVersion={dragging.server.minecraft_version}
              installed={installedIds.has(dragging.server.id)}
              statusLabel={statusFor?.(dragging.server)}
              hasPack={Boolean(dragging.server.pack_manifest_url)}
              disabled
              onClick={() => {}}
            />
          </div>,
          document.body,
        )}

      {view === "grid" && layout !== undefined && (
        <AddSectionButton
          layout={layout}
          disabled={actionsDisabled || refreshing}
          onAdd={(name) =>
            onLayoutChange?.({
              sections: [
                ...layout.sections,
                newSection(name, `sec-${crypto.randomUUID()}`),
              ],
              assignments: layout.assignments,
            })
          }
        />
      )}
    </section>
  );
}
