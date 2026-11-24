import { m } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent } from "react";
import { RefreshCw, Search, ShieldAlert } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LineServer } from "@/types/line";
import {
  filterServerCatalog,
  type ServerCatalogFilter,
} from "@/lib/line/server-catalog";
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
   * The player's grouping. Absent = one flat directory, which is what a fresh
   * install has and what the provider's contract describes.
   */
  layout?: ServerLayout;
  onLayoutChange?: (next: ServerLayout) => void;
}

/**
 * Provider directory. A single compact row layout keeps the server list
 * scannable; the last-opened server remains the artwork-led continuation above.
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
}: ServerListProps) {
  const t = useT();
  const [searchTerm, setSearchTerm] = useState("");
  const [catalogFilter, setCatalogFilter] =
    useState<ServerCatalogFilter>("all");
  const hasCatalogFilter = searchTerm.trim() !== "" || catalogFilter !== "all";
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
    !hasCatalogFilter &&
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
  const visibleServers = filterServerCatalog(servers, {
    query: searchTerm,
    filter: catalogFilter,
    installedIds,
  });
  const groups =
    layout === undefined
      ? groupServers(visibleServers, EMPTY_LAYOUT)
      : groupServers(visibleServers, layout);
  // Hide empty sections only while narrowing the catalogue; otherwise the
  // player's intentionally created empty sections remain available to manage.
  const visibleGroups = hasCatalogFilter
    ? groups.filter((group) => group.servers.length > 0)
    : groups;
  // The implicit group normally disappears when empty, but it must remain a
  // drop target while dragging so every server can be moved back out.
  const targets =
    dragging && !visibleGroups.some((group) => group.id === NO_SECTION)
      ? [
          ...visibleGroups,
          { id: NO_SECTION, name: "", collapsed: false, servers: [] },
        ]
      : visibleGroups;
  return (
    <section
      ref={listRef}
      aria-labelledby="server-list-title"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <h2
            id="server-list-title"
            className="text-foreground text-3xl font-bold tracking-tight"
          >
            {providerName}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm leading-relaxed">
            {t("catalog.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing || actionsDisabled}
            className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs"
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

      {rail}

      <div className="flex flex-wrap items-center gap-2">
        <div role="search" className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={t("catalog.search")}
            placeholder={t("catalog.search")}
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            className="h-9 rounded-lg pl-9"
          />
        </div>
        <div
          role="group"
          aria-label={t("catalog.filter")}
          className="border-border/50 bg-fill-subtle flex items-center gap-0.5 rounded-lg border p-0.5"
        >
          {(
            [
              ["all", t("catalog.all")],
              ["installed", t("catalog.installed")],
              ["not-installed", t("catalog.notInstalled")],
            ] as const
          ).map(([filter, label]) => (
            <button
              key={filter}
              type="button"
              aria-pressed={catalogFilter === filter}
              onClick={() => setCatalogFilter(filter)}
              className={cn(
                "h-8 cursor-pointer rounded-lg px-2.5 text-[11px] font-medium transition-colors",
                catalogFilter === filter
                  ? "bg-fill-strong text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
          {t("catalog.resultCount", {
            shown: visibleServers.length,
            total: servers.length,
          })}
        </span>
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

      {visibleServers.length > 0 &&
        layout !== undefined &&
        layout.sections.length === 0 && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("sections.emptyHint")}
          </p>
        )}

      {visibleServers.length > 0 &&
        !hasCatalogFilter &&
        layout !== undefined &&
        layout.sections.length > 0 && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("sections.dragHint")}
          </p>
        )}

      {visibleServers.length === 0 && (
        <p
          role="status"
          className="text-muted-foreground bg-fill-subtle rounded-[var(--radius-item)] p-6 text-center text-sm"
        >
          {servers.length === 0 ? t("servers.empty") : t("catalog.noResults")}
        </p>
      )}

      {visibleServers.length > 0 && (
        <div
          role="list"
          aria-label={t("catalog.servers")}
          className="flex flex-col gap-2"
        >
          {targets.map((group) => (
            <div
              key={group.id || "unsorted"}
              data-section-drop={group.id || "unassigned"}
              data-section-id={group.id}
              className={`flex flex-col rounded-[var(--radius-item)] ${dropTarget === group.id ? "bg-primary/10 ring-primary/60 ring-2" : ""}`}
            >
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
                <div className="flex flex-col gap-2">
                  {group.servers.map((server) => (
                    <m.div
                      key={server.id}
                      role="listitem"
                      data-server-drag={server.id}
                      onPointerDown={(event) => beginDrag(event, server)}
                      onDragStart={(event) => event.preventDefault()}
                      className={`${canMove ? "cursor-grab select-none active:cursor-grabbing" : ""} ${dragging?.server.id === server.id ? "opacity-30" : ""}`}
                      initial={false}
                      animate={{
                        opacity: dragging?.server.id === server.id ? 0.3 : 1,
                      }}
                      transition={{ duration: 0.14 }}
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
        </div>
      )}

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

      {!hasCatalogFilter && layout !== undefined && (
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
