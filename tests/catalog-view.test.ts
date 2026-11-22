// The catalogue's two views.
//
// The accordion has one decision in it that is worth pinning: *which* row is
// open. Everything else is markup. That decision has three cases — nobody has
// chosen (the first server opens), the player chose (their choice wins), and the
// chosen server disappeared (fall back to the first, never to a dead id) — and a
// regression in any of them is invisible until a player reports "the list is
// collapsed and I cannot open anything".
//
// The component is checked by reading it, in the style the rest of this suite
// uses for JSX: the runtime behaviour that matters is a stored string, and the
// assertions below name the strings rather than rendering a DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("the harmony view opens the first server until the player chooses", () => {
  const catalog = read("src/components/line/HarmonyCatalog.tsx");

  // The default is derived, not stored: storing `servers[0].id` in state would
  // freeze the fallback against the list as it was on first render, so a
  // provider that reorders the catalogue would leave the accordion open on a
  // server that is no longer first, for a reason the player cannot see.
  assert.match(
    catalog,
    /const \[chosen, setChosen\] = useState<string \| null>\(null\)/,
  );
  assert.match(catalog, /const firstId = servers\[0\]\?\.id/);
  assert.match(catalog, /const openId = chosen \?\? firstId \?\? null/);
});

test("a server the provider removed does not stay selected", () => {
  const catalog = read("src/components/line/HarmonyCatalog.tsx");

  // Without this the stored id points at a row that no longer exists and every
  // row renders collapsed — the accordion looks broken and nothing opens.
  assert.match(
    catalog,
    /if \(chosen && !servers\.some\(\(server\) => server\.id === chosen\)\) \{/,
  );
  assert.match(catalog, /setChosen\(null\)/);
});

test("the accordion is a disclosure, not a div with a click", () => {
  const catalog = read("src/components/line/HarmonyCatalog.tsx");

  // A real <button> with aria-expanded is what makes the row announced and
  // reachable by keyboard; `aria-pressed` would describe a toggle of a value
  // rather than the opening of a panel.
  assert.match(catalog, /<button\b/);
  assert.match(catalog, /aria-expanded=\{open\}/);
  assert.doesNotMatch(catalog, /aria-pressed/);
  // One row is always open when servers exist: clicking a folded row opens it,
  // while clicking the already-open row cannot collapse the whole accordion.
  assert.match(catalog, /if \(!open\) setChosen\(server\.id\)/);
  assert.doesNotMatch(catalog, /setChosen\(""\)/);
});

test("harmony is a horizontal artwork accordion with a reduced-motion fallback", () => {
  const catalog = read("src/components/line/HarmonyCatalog.tsx");

  assert.match(catalog, /role="list"/);
  assert.match(catalog, /flex h-\[min\(390px,58vh\)\][^\"]*overflow-x-auto/);
  assert.match(
    catalog,
    /animate=\{\{ flexGrow: open \? 1 : 0, flexBasis: open \? 0 : 68 \}\}/,
  );
  assert.match(catalog, /server\.banner_url/);
  assert.match(catalog, /server\.icon_url \?\? server\.logo_url/);
  assert.match(catalog, /bg-\[#1d1f23\]/);
  assert.match(catalog, /showArtwork \? \(/);
  const fallbackClass = /data-harmony-art-fallback\s+className="([^"]+)"/.exec(
    catalog,
  )?.[1];
  assert.ok(
    fallbackClass,
    "missing artwork must render its server-icon placeholder",
  );
  assert.doesNotMatch(
    fallbackClass,
    /gradient/,
    "the no-art placeholder must be flat",
  );
  assert.match(catalog, /data-harmony-logo-fallback/);
  assert.match(catalog, /open && \([\s\S]*?<Server className="size-9" \/>/);
  assert.match(catalog, /aria-controls=\{panelId\}/);
  assert.match(catalog, /const reduced = useReducedMotion\(\)/);
  assert.match(catalog, /duration: reduced \? 0 : 0\.28/);
  assert.match(catalog, /reduced \? \{ opacity: 0 \} : \{ opacity: 0, y: 8 \}/);
});

test("the view is a setting, so it survives a restart", () => {
  const rust = read("src-tauri/src/line/settings.rs");
  const types = read("src/types/line.ts");
  const launcher = read("src/components/line/LineLauncher.tsx");

  // A plain optional string, like `backdrop` and `language`: the catalogue of
  // views lives in TypeScript, and a view this build does not know falls back
  // to the grid instead of blanking the catalogue.
  assert.match(rust, /pub catalog_view: Option<String>/);
  assert.match(
    rust,
    /serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub catalog_view/,
  );
  // Validated on the way in, so the file on disk always names a view the UI
  // will honour rather than being silently ignored.
  assert.match(rust, /if view != "grid" && view != "harmony"/);

  assert.match(types, /export type CatalogView = "grid" \| "harmony"/);
  assert.match(types, /catalogView\?: CatalogView \| null/);

  // Written through the same settings call everything else uses.
  assert.match(
    launcher,
    /async function changeCatalogView\(view: CatalogView\)/,
  );
  assert.match(launcher, /catalogView: view/);
});

test("the view switch stays visible with saved sections and restores the grouped grid", () => {
  const list = read("src/components/line/ServerList.tsx");

  // The accordion is an alternate presentation, not a destructive edit to the
  // player's saved group layout, so the control must not disappear when groups
  // exist. Text labels make this non-standard view discoverable in the UI.
  assert.match(list, /aria-label=\{t\("catalog\.view"\)\}/);
  assert.match(list, /<span>\{t\("catalog\.harmony"\)\}<\/span>/);
  assert.doesNotMatch(
    list,
    /layout === undefined \|\| layout\.sections\.length === 0 \?/,
  );
  assert.match(list, /\{view === "harmony" \? \(/);
  assert.match(list, /\{view === "grid" &&\s*targets\.map/);
  assert.match(
    list,
    /view === "grid" &&\s*layout !== undefined &&\s*layout\.sections\.length === 0/,
  );
});

test("the workspace finish is a setting with a solid default", () => {
  const rust = read("src-tauri/src/line/settings.rs");
  const types = read("src/types/line.ts");
  const launcher = read("src/components/line/LineLauncher.tsx");
  const settings = read("src/components/line/SettingsScreen.tsx");
  const css = read("src/index.css");

  assert.match(rust, /pub workspace: Option<String>/);
  assert.match(rust, /if workspace != "glass" && workspace != "solid"/);

  assert.match(types, /export type WorkspaceFinish = "glass" \| "solid"/);
  assert.match(types, /workspace\?: WorkspaceFinish \| null/);

  // The attribute lives on <html>, not on a component's div: the animated
  // backdrop is global, and the main page/gate finishes derive from its tokens.
  assert.match(
    launcher,
    /root\.setAttribute\("data-line-workspace", "glass"\)/,
  );
  assert.match(
    launcher,
    /root\.setAttribute\("data-line-workspace", "solid"\)/,
  );
  // Removed while the answer is unknown, so someone who chose glass does not
  // watch the window start solid and then change under the greeting.
  assert.match(launcher, /root\.removeAttribute\("data-line-workspace"\)/);

  // Solid is the default: the rule matches "no attribute at all", which is
  // what the root carries before settings arrive.
  assert.match(
    css,
    /:root:not\(\[data-line-workspace="glass"\]\) \{/,
    "solid must be the finish with no attribute",
  );
  // The main plates become opaque charcoal, while the selected animated
  // backdrop remains the page background in both finishes.
  assert.doesNotMatch(css, /--line-solid-workspace/);
  assert.match(css, /--line-solid-panel: #222326/);
  assert.match(
    css,
    /:root:not\(\[data-line-workspace="glass"\]\) \{\s*--glass-surface-shell: var\(--line-solid-panel\);\s*--glass-surface-gate: var\(--line-solid-panel\);\s*\}/,
  );
  assert.doesNotMatch(
    css,
    /:root:not\(\[data-line-workspace="glass"\]\)\s+\[data-line-(?:haze|backdrop|canvas|glass)\]/,
  );
  assert.match(
    css,
    /:root\[data-line-workspace="glass"\] \[data-line-glass="main"\][\s\S]*?background-color: rgba\(10, 12, 16, 0\.225\);/,
    "glass must visibly paint the translucent wash on the separate page panel",
  );
  assert.match(
    css,
    /:root:not\(\[data-line-workspace="glass"\]\) \[data-line-glass="main"\][\s\S]*?background-color: var\(--line-solid-panel\);/,
    "solid must paint the opaque panel directly on the main page",
  );
  assert.doesNotMatch(
    css,
    /backdrop-filter:\s*blur\(/,
    "the workspace surfaces must not use a frost-glass blur",
  );
  assert.match(
    settings,
    /className="line-workspace-swatch relative flex size-10[^\"]*"/,
    "both finish previews retain the animated backdrop swatch",
  );
});
