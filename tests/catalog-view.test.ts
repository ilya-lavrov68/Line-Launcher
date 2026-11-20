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
  // One row is open at a time: clicking the open row closes it, clicking
  // another opens that one.
  assert.match(
    catalog,
    /onClick=\{\(\) => setChosen\(open \? "" : server\.id\)\}/,
  );
});

test("harmony respects reduced motion instead of refusing to open", () => {
  const catalog = read("src/components/line/HarmonyCatalog.tsx");

  // The row still opens — the box is what carries the information, and a
  // reduced-motion user needs it just as much. Only the tween is dropped.
  assert.match(catalog, /const reduced = useReducedMotion\(\)/);
  assert.match(
    catalog,
    /initial=\{reduced \? false : \{ height: 0, opacity: 0 \}\}/,
  );
  assert.match(catalog, /duration: reduced \? 0 : 0\.2/);
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

test("the switch is offered only where it can work", () => {
  const list = read("src/components/line/ServerList.tsx");

  // Sections and harmony are different answers to the same question — how the
  // list is grouped — so the switch is hidden while sections exist. Drawing a
  // player's sections as an accordion would silently drop their arrangement.
  assert.match(
    list,
    /\{layout === undefined \|\| layout\.sections\.length === 0 \? \(/,
  );
  // And the grouped grid is not drawn underneath the accordion: its drag hints
  // and "add section" button would be gestures over a list that ignores them.
  assert.match(list, /\{view === "harmony" \? \(/);
  assert.match(list, /\{view === "grid" &&\s*targets\.map/);
  assert.match(list, /\{view === "grid" && layout !== undefined && \(/);
});

test("the workspace finish is a setting with a solid default", () => {
  const rust = read("src-tauri/src/line/settings.rs");
  const types = read("src/types/line.ts");
  const launcher = read("src/components/line/LineLauncher.tsx");
  const css = read("src/index.css");

  assert.match(rust, /pub workspace: Option<String>/);
  assert.match(rust, /if workspace != "glass" && workspace != "solid"/);

  assert.match(types, /export type WorkspaceFinish = "glass" \| "solid"/);
  assert.match(types, /workspace\?: WorkspaceFinish \| null/);

  // The attribute lives on <html>, not on a component's div: the page
  // background comes from `:root`, and six surfaces paint from it.
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
  // The JetBrains pair, and the haze switched off rather than left running
  // behind an opaque field.
  assert.match(css, /--line-solid-workspace: #1e1f22/);
  assert.match(css, /--line-solid-panel: #2b2d30/);
  assert.match(
    css,
    /:root:not\(\[data-line-workspace="glass"\]\) \[data-line-haze\],/,
  );
});
