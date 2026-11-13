/**
 * Player-owned sections of the server catalogue.
 *
 * The provider ships a flat list; how those servers are grouped is the player's
 * business. So this module is deliberately outside the provider contract: it
 * reads the catalogue and the player's layout, and answers one question — "what
 * does the list look like now". No React, no IPC, no filesystem: the grouping
 * has exactly one implementation, and it is testable on its own.
 *
 * Four rules decide the shape:
 *
 *  1. **Nothing the player arranged may disappear because the provider
 *     reordered a list.** Sections keep the player's order, not the catalogue's.
 *  2. **A server the provider removed cannot keep a place in a section.** Its
 *     assignment is dropped on the next write, so the layout cannot grow into a
 *     museum of ids nobody can see.
 *  3. **A server with no section is visible.** There is always an implicit
 *     "no section" group, and it is where new servers land — a provider adding a
 *     server must not mean the player never notices it.
 *  4. **Every function tolerates a damaged layout.** `settings.json` can be
 *     hand-edited; a collided id or an unknown section degrades to a sensible
 *     list instead of an empty screen.
 */
import type { LineServer } from "@/types/line";

export const MAX_SECTIONS = 32;
export const MAX_SECTION_NAME = 40;
/** The implicit group. Not a real section: it cannot be renamed or removed. */
export const NO_SECTION = "";

export interface ServerSection {
  /** `crypto.randomUUID()` in the UI; never used as a path. */
  id: string;
  name: string;
  collapsed: boolean;
}

export interface ServerLayout {
  sections: ServerSection[];
  /** server id -> section id. Missing = `NO_SECTION`. */
  assignments: Record<string, string>;
}

export const EMPTY_LAYOUT: ServerLayout = { sections: [], assignments: {} };

/** One rendered group: a real section, or the implicit unsorted one. */
export interface ServerGroup {
  /** `NO_SECTION` for the implicit group. */
  id: string;
  name: string;
  collapsed: boolean;
  servers: LineServer[];
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f]/.test(value)
  );
}

/**
 * Reads whatever `settings.json` held and returns a layout that can be rendered.
 *
 * This is the only place that trusts stored JSON, so it repairs instead of
 * throwing: duplicated ids are dropped (the first wins), sections with unusable
 * names are dropped, assignments to sections that did not survive are dropped.
 * The alternative — rejecting the document — would send the whole settings file
 * back to defaults because of one bad section name.
 */
export function normalizeLayout(raw: unknown): ServerLayout {
  if (!raw || typeof raw !== "object") return { ...EMPTY_LAYOUT };
  const source = raw as Partial<ServerLayout>;
  const sections: ServerSection[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(source.sections) ? source.sections : []) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<ServerSection>;
    const id = candidate.id;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 64 ||
      seen.has(id) ||
      !text(candidate.name, MAX_SECTION_NAME) ||
      sections.length >= MAX_SECTIONS
    ) {
      continue;
    }
    seen.add(id);
    sections.push({
      id,
      name: candidate.name,
      collapsed: candidate.collapsed === true,
    });
  }
  const assignments: Record<string, string> = {};
  const rawAssignments =
    source.assignments && typeof source.assignments === "object"
      ? source.assignments
      : {};
  for (const [serverId, sectionId] of Object.entries(rawAssignments)) {
    if (!serverId || serverId.length > 64) continue;
    if (typeof sectionId !== "string" || !seen.has(sectionId)) continue;
    assignments[serverId] = sectionId;
  }
  return { sections, assignments };
}

/**
 * The catalogue as groups, in the player's order.
 *
 * Sections render in the order stored, servers inside a section in catalogue
 * order (the provider's own ranking is the only ranking we have). The implicit
 * group comes last and only appears when it has servers: an empty "Без секции"
 * heading is noise, while an empty named section is something the player made on
 * purpose and can still drag a server into.
 */
export function groupServers(
  servers: readonly LineServer[],
  layout: ServerLayout,
): ServerGroup[] {
  const buckets = new Map<string, LineServer[]>();
  for (const section of layout.sections) buckets.set(section.id, []);
  const loose: LineServer[] = [];
  for (const server of servers) {
    const section = layout.assignments[server.id];
    const bucket = section ? buckets.get(section) : undefined;
    if (bucket) bucket.push(server);
    else loose.push(server);
  }
  const groups: ServerGroup[] = layout.sections.map((section) => ({
    id: section.id,
    name: section.name,
    collapsed: section.collapsed,
    servers: buckets.get(section.id) ?? [],
  }));
  if (loose.length > 0 || groups.length === 0) {
    groups.push({
      id: NO_SECTION,
      name: "",
      collapsed: false,
      servers: loose,
    });
  }
  return groups;
}

/**
 * Drops assignments to servers the provider no longer lists.
 *
 * Called before saving, not while rendering: the renderer has to tolerate the
 * stale entries anyway (the catalogue can change between two reads), and doing
 * it here means the file on disk stays clean without a second code path.
 */
export function pruneLayout(
  layout: ServerLayout,
  servers: readonly LineServer[],
): ServerLayout {
  const present = new Set(servers.map((server) => server.id));
  const assignments: Record<string, string> = {};
  for (const [serverId, sectionId] of Object.entries(layout.assignments)) {
    if (present.has(serverId)) assignments[serverId] = sectionId;
  }
  return { sections: layout.sections, assignments };
}

/** `true` when the two layouts describe the same arrangement. */
export function sameLayout(a: ServerLayout, b: ServerLayout): boolean {
  if (a.sections.length !== b.sections.length) return false;
  for (let index = 0; index < a.sections.length; index += 1) {
    const left = a.sections[index];
    const right = b.sections[index];
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.collapsed !== right.collapsed
    ) {
      return false;
    }
  }
  const leftKeys = Object.keys(a.assignments);
  if (leftKeys.length !== Object.keys(b.assignments).length) return false;
  return leftKeys.every((key) => a.assignments[key] === b.assignments[key]);
}

/** A new, empty section. The name is the caller's (translated) default. */
export function newSection(name: string, id: string): ServerSection {
  return {
    id,
    name: name.trim().slice(0, MAX_SECTION_NAME) || name,
    collapsed: false,
  };
}

/**
 * Puts a server into a section, or back into "no section" when `section` is
 * null. Returns a new layout; the caller decides whether to save it.
 */
export function assignServer(
  layout: ServerLayout,
  serverId: string,
  section: string | null,
): ServerLayout {
  const assignments = { ...layout.assignments };
  if (section === null || section === NO_SECTION) delete assignments[serverId];
  else assignments[serverId] = section;
  return { sections: layout.sections, assignments };
}

/**
 * Removes a section. Its servers do not vanish: they return to "no section",
 * because deleting a folder is not deleting what is inside it.
 */
export function removeSection(
  layout: ServerLayout,
  sectionId: string,
): ServerLayout {
  const sections = layout.sections.filter(
    (section) => section.id !== sectionId,
  );
  const assignments = Object.fromEntries(
    Object.entries(layout.assignments).filter(([, id]) => id !== sectionId),
  );
  return { sections, assignments };
}

export function renameSection(
  layout: ServerLayout,
  sectionId: string,
  name: string,
): ServerLayout {
  const trimmed = name.trim().slice(0, MAX_SECTION_NAME);
  if (!trimmed) return layout;
  return {
    sections: layout.sections.map((section) =>
      section.id === sectionId ? { ...section, name: trimmed } : section,
    ),
    assignments: layout.assignments,
  };
}

export function setCollapsed(
  layout: ServerLayout,
  sectionId: string,
  collapsed: boolean,
): ServerLayout {
  return {
    sections: layout.sections.map((section) =>
      section.id === sectionId ? { ...section, collapsed } : section,
    ),
    assignments: layout.assignments,
  };
}

/**
 * Which plural bucket a count falls into: 0 = one, 1 = few, 2 = many.
 *
 * Russian (and the other Slavic languages the catalogue may grow into) needs
 * three forms: «1 сервер», «2 сервера», «5 серверов». English and German need
 * two, and map the middle bucket onto the same string. Doing this here rather
 * than with `Intl.PluralRules` keeps the result identical across the WebView
 * builds this launcher ships on — and testable without a locale.
 */
export function pluralBucket(count: number): 0 | 1 | 2 {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return 2;
}

/** Section id a server belongs to, or `null` for "no section". */
export function sectionOf(
  layout: ServerLayout,
  serverId: string,
): string | null {
  return layout.assignments[serverId] ?? null;
}
