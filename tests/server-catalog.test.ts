import assert from "node:assert/strict";
import test from "node:test";
import {
  filterServerCatalog,
  type ServerCatalogFilter,
} from "../src/lib/line/server-catalog.ts";
import type { LineServer } from "../src/types/line.ts";

function server(id: string, name: string, description = ""): LineServer {
  return {
    id,
    name,
    description,
    version: "2.4.1",
    minecraft_version: "1.21.1",
    distribution: { url: `https://example.com/${id}.zip` },
  };
}

function search(
  servers: readonly LineServer[],
  query = "",
  filter: ServerCatalogFilter = "all",
  installedIds: ReadonlySet<string> = new Set(),
) {
  return filterServerCatalog(servers, { query, filter, installedIds });
}

test("catalog search matches names, descriptions and version fields", () => {
  const servers = [
    server("survival", "Survival", "Мир для приключений"),
    server("creative", "Creative", "Стройте без ограничений"),
  ];
  assert.deepEqual(
    search(servers, "ПРИКЛЮЧЕНИЙ").map(({ id }) => id),
    ["survival"],
  );
  assert.deepEqual(
    search(servers, "1.21.1").map(({ id }) => id),
    ["survival", "creative"],
  );
  assert.deepEqual(
    search(servers, "creative").map(({ id }) => id),
    ["creative"],
  );
});

test("catalog status filters use local installed ids and keep provider order", () => {
  const servers = [
    server("first", "First"),
    server("second", "Second"),
    server("third", "Third"),
  ];
  const installed = new Set(["first", "third"]);
  assert.deepEqual(
    search(servers, "", "installed", installed).map(({ id }) => id),
    ["first", "third"],
  );
  assert.deepEqual(
    search(servers, "", "not-installed", installed).map(({ id }) => id),
    ["second"],
  );
  assert.deepEqual(
    search(servers).map(({ id }) => id),
    ["first", "second", "third"],
  );
});
