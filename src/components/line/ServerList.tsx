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
}

/**
 * Provider showcase. Header row and the stale-config warning reuse Obsy's
 * tokens: muted meta text, `border-amber-500/30 bg-amber-500/10 text-amber-300`
 * for warnings (as in AddonSecurityReviewModal), and the ghost/outline Buttons.
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
}: ServerListProps) {
  return (
    <section
      aria-labelledby="server-list-title"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-[10px] font-medium">
            Провайдер
          </span>
          <h2
            id="server-list-title"
            className="text-foreground text-xl font-bold tracking-tight"
          >
            {providerName}
          </h2>
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
          <span>{refreshing ? "Обновление…" : "Обновить"}</span>
        </Button>
      </div>

      {stale && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-300"
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
              disabled={refreshing || actionsDisabled}
              onClick={() => onSelect(server)}
            />
          </m.div>
        ))}
      </div>
    </section>
  );
}
