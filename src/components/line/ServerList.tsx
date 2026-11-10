import { m } from "framer-motion";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LineServer } from "@/types/line";
import ServerCard from "./ServerCard";

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
}: ServerListProps) {
  return (
    <section
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
          <span>{refreshing ? "Обновление…" : "Обновить"}</span>
        </Button>
      </div>

      {stale && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-[var(--radius-control)] bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-300"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Показана сохранённая конфигурация. Для входа и установки требуется
            актуальная конфигурация и доступ к провайдеру.
          </span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {servers.map((server, index) => (
          <m.div
            key={server.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: Math.min(index * 0.035, 0.2) }}
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
              onClick={() => onSelect(server)}
            />
          </m.div>
        ))}
      </div>
    </section>
  );
}
