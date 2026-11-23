import type { LineServer } from "@/types/line";

export type ServerCatalogFilter = "all" | "installed" | "not-installed";

export interface ServerCatalogQuery {
  query: string;
  filter: ServerCatalogFilter;
  installedIds: ReadonlySet<string>;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

/** Search only provider-published fields and apply a local installation filter. */
export function filterServerCatalog(
  servers: readonly LineServer[],
  { query, filter, installedIds }: ServerCatalogQuery,
): LineServer[] {
  const needle = normalizeSearchText(query.trim());
  return servers.filter((server) => {
    const installed = installedIds.has(server.id);
    if (filter === "installed" && !installed) return false;
    if (filter === "not-installed" && installed) return false;
    if (!needle) return true;
    return [
      server.name,
      server.description,
      server.id,
      server.version,
      server.minecraft_version ?? "",
    ].some((value) => normalizeSearchText(value).includes(needle));
  });
}
