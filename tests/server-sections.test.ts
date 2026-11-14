// The grouping rules for player-owned server sections.
//
// These run against the pure module, which is the point: "what does the list
// look like" is decided in one function, and the component only renders its
// answer. A section feature that needed the DOM to verify would be a section
// feature nobody can verify offline.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assignServer,
  groupServers,
  MAX_SECTION_NAME,
  MAX_SECTIONS,
  moveServerToSection,
  newSection,
  NO_SECTION,
  normalizeLayout,
  pluralBucket,
  pruneLayout,
  removeSection,
  renameSection,
  sameLayout,
  sectionOf,
  setCollapsed,
  type ServerLayout,
} from "../src/lib/line/server-layout.ts";
import type { LineServer } from "../src/types/line.ts";

function server(id: string): LineServer {
  return {
    id,
    name: id.toUpperCase(),
    description: "",
    version: "1.0.0",
    distribution: { url: "https://example.com/pack.zip" },
  };
}

const servers = [server("a"), server("b"), server("c"), server("d")];

function layout(
  sections: [string, string][],
  assignments: Record<string, string> = {},
): ServerLayout {
  return {
    sections: sections.map(([id, name]) => ({
      id,
      name,
      collapsed: false,
    })),
    assignments,
  };
}

test("with no layout every server is one flat group", () => {
  const groups = groupServers(servers, { sections: [], assignments: {} });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, NO_SECTION);
  assert.deepEqual(
    groups[0].servers.map((s) => s.id),
    ["a", "b", "c", "d"],
  );
});

test("sections keep the player's order, servers keep the catalogue's", () => {
  const groups = groupServers(
    servers,
    layout(
      [
        ["survival", "Выживание"],
        ["mini", "Мини-игры"],
      ],
      { c: "mini", a: "survival", d: "mini" },
    ),
  );
  assert.deepEqual(
    groups.map((g) => [g.id, g.servers.map((s) => s.id)]),
    [
      ["survival", ["a"]],
      ["mini", ["c", "d"]],
      [NO_SECTION, ["b"]],
    ],
  );
});

test("an empty named section stays; an empty unsorted group does not", () => {
  const full = groupServers(
    servers,
    layout([["empty", "Пусто"]], {
      a: "empty",
      b: "empty",
      c: "empty",
      d: "empty",
    }),
  );
  // The player made "Пусто" deliberately: it must not vanish while they are
  // about to put something in it.
  assert.deepEqual(
    full.map((g) => g.id),
    ["empty"],
  );
  const nothing = groupServers([], { sections: [], assignments: {} });
  // Nothing at all to show: one empty group, not zero (the screen still needs a
  // place for its "no servers" state).
  assert.deepEqual(
    nothing.map((g) => g.id),
    [NO_SECTION],
  );
});

test("a server the provider removed loses its assignment, not the section", () => {
  const stored = layout([["fav", "Мои"]], { gone: "fav", a: "fav" });
  const pruned = pruneLayout(stored, servers);
  assert.deepEqual(pruned.assignments, { a: "fav" });
  assert.deepEqual(
    pruned.sections.map((s) => s.id),
    ["fav"],
  );
  // And the rendered list never mentions the removed server.
  const groups = groupServers(servers, pruned);
  assert.deepEqual(
    groups[0].servers.map((s) => s.id),
    ["a"],
  );
});

test("a damaged layout degrades to a readable list, it does not throw", () => {
  // Hand-edited settings.json: duplicate ids, a control character in a name, an
  // assignment to a section that does not exist, junk instead of objects.
  const normalized = normalizeLayout({
    sections: [
      { id: "dup", name: "First", collapsed: true },
      { id: "dup", name: "Second", collapsed: false },
      { id: "ctl", name: "bad\u0007name", collapsed: false },
      { id: "", name: "empty id", collapsed: false },
      { id: "ok", name: "Fine", collapsed: false },
      null,
      "not an object",
    ],
    assignments: { a: "dup", b: "missing", c: 42, d: "ok" },
  });
  assert.deepEqual(
    normalized.sections.map((s) => [s.id, s.name, s.collapsed]),
    [
      ["dup", "First", true],
      ["ok", "Fine", false],
    ],
  );
  // Only the assignments that point at a surviving section are kept.
  assert.deepEqual(normalized.assignments, { a: "dup", d: "ok" });
});

test("normalizeLayout accepts absence, null and non-objects", () => {
  for (const input of [undefined, null, 42, "x", [], { sections: "no" }]) {
    assert.deepEqual(normalizeLayout(input), { sections: [], assignments: {} });
  }
});

test("the section count is capped at what settings.rs accepts", () => {
  const many = Array.from({ length: MAX_SECTIONS + 5 }, (_, index) => ({
    id: `s${index}`,
    name: `S${index}`,
    collapsed: false,
  }));
  assert.equal(
    normalizeLayout({ sections: many, assignments: {} }).sections.length,
    MAX_SECTIONS,
  );
  // MAX_SECTIONS must match `MAX_SECTIONS` in settings.rs, or Rust rejects a
  // document the UI was happy to produce.
  assert.equal(MAX_SECTIONS, 32);
});

test("long and empty section names are cut or refused, never stored broken", () => {
  const long = "x".repeat(MAX_SECTION_NAME + 10);
  assert.equal(newSection(long, "id").name.length, MAX_SECTION_NAME);
  // Renaming to whitespace changes nothing: an unnamed section is unusable.
  const base = layout([["a", "Alpha"]]);
  assert.deepEqual(renameSection(base, "a", "   "), base);
  assert.deepEqual(
    renameSection(base, "a", "  Beta  ").sections[0].name,
    "Beta",
  );
});

test("assigning, collapsing and removing behave like folder operations", () => {
  const base = layout(
    [
      ["a", "Alpha"],
      ["b", "Beta"],
    ],
    { x: "a" },
  );

  const moved = assignServer(base, "y", "b");
  assert.equal(sectionOf(moved, "y"), "b");
  assert.equal(sectionOf(moved, "x"), "a");

  // Back to unsorted: the key is dropped, not stored as "".
  const loose = assignServer(moved, "y", null);
  assert.equal(sectionOf(loose, "y"), null);
  assert.ok(!("y" in loose.assignments));

  const collapsed = setCollapsed(base, "a", true);
  assert.equal(collapsed.sections[0].collapsed, true);
  assert.equal(collapsed.sections[1].collapsed, false);
  // Immutability: the input is untouched, so React state updates are honest.
  assert.equal(base.sections[0].collapsed, false);

  // Deleting a folder does not delete what is inside it: "x" was in "Alpha",
  // and after the section is gone it is back in the unsorted group that follows
  // the surviving "Beta".
  const withBeta = assignServer(base, "z", "b");
  const removed = removeSection(withBeta, "a");
  assert.deepEqual(
    removed.sections.map((s) => s.id),
    ["b"],
  );
  assert.deepEqual(removed.assignments, { z: "b" });
  assert.deepEqual(
    groupServers([server("x"), server("z")], removed).map((g) => [
      g.id,
      g.servers.map((s) => s.id),
    ]),
    [
      ["b", ["z"]],
      [NO_SECTION, ["x"]],
    ],
  );
});

test("sameLayout ignores key order but not meaning", () => {
  const one = layout([["a", "Alpha"]], { x: "a", y: "a" });
  const other = layout([["a", "Alpha"]], { y: "a", x: "a" });
  assert.equal(sameLayout(one, other), true);
  assert.equal(sameLayout(one, layout([["a", "Alpha"]], { x: "a" })), false);
  assert.equal(
    sameLayout(one, layout([["a", "Alpha "]], { x: "a", y: "a" })),
    false,
  );
  assert.equal(
    sameLayout(one, {
      sections: [{ id: "a", name: "Alpha", collapsed: true }],
      assignments: { x: "a", y: "a" },
    }),
    false,
  );
});

test("a section that still carries a removed server renders nothing for it", () => {
  // The catalogue arrives before the prune runs (both can happen in one tick).
  const stale = layout([["a", "Alpha"]], { gone: "a" });
  const groups = groupServers(servers, stale);
  assert.equal(groups[0].servers.length, 0);
  // No ghost cards, no crash, and the section is still there for its owner.
  assert.equal(groups[0].id, "a");
});

test("the count reads as a sentence in every plural bucket", () => {
  // «1 серверов» is the mistake this prevents. The rule is Slavic because
  // Russian is the catalogue's source language; English and German map the
  // middle bucket to their single plural form.
  const cases: [number, 0 | 1 | 2][] = [
    [1, 0],
    [21, 0],
    [11, 2],
    [2, 1],
    [3, 1],
    [4, 1],
    [14, 2],
    [5, 2],
    [0, 2],
    [100, 2],
    [102, 1],
  ];
  for (const [count, bucket] of cases) {
    assert.equal(pluralBucket(count), bucket, `count ${count}`);
  }
});

test("drag moves only existing servers to existing sections or back to no section", () => {
  const initial = layout(
    [
      ["a", "Alpha"],
      ["b", "Beta"],
    ],
    { a: "a" },
  );
  const moved = moveServerToSection(initial, servers, "a", "b");
  assert.equal(moved.assignments.a, "b");
  assert.equal(initial.assignments.a, "a");
  assert.equal(moveServerToSection(moved, servers, "a", "b"), moved);
  assert.equal(moveServerToSection(moved, servers, "missing", "a"), moved);
  assert.equal(moveServerToSection(moved, servers, "a", "missing"), moved);
  const returned = moveServerToSection(moved, servers, "a", NO_SECTION);
  assert.equal(returned.assignments.a, undefined);
  assert.equal(
    groupServers(servers, returned)
      .at(-1)
      ?.servers.some((s) => s.id === "a"),
    true,
  );
});
