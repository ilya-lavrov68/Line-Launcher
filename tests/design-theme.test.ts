import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyTheme,
  bootstrapTheme,
  isLineTheme,
  readTheme,
  THEME_LABELS,
  THEME_STORAGE_KEY,
  THEMES,
  writeTheme,
} from "../src/lib/line/theme.ts";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const themes = read("src/styles/themes.css");
const indexCss = read("src/index.css");

test("the theme preference falls back instead of throwing", () => {
  assert.deepEqual([...THEMES], ["line", "old"]);
  assert.equal(THEME_STORAGE_KEY, "line.theme");
  assert.equal(isLineTheme("old"), true);
  assert.equal(isLineTheme("sepia"), false);
  assert.equal(isLineTheme(undefined), false);

  const store = (value: string | null) => ({ getItem: () => value });
  // The design is chosen at build time. A `line.theme` key left behind by an
  // older build is read but not honoured, so a file cannot repaint the window.
  assert.equal(readTheme(store("old")), "line");
  assert.equal(readTheme(store(null)), "line");
  assert.equal(readTheme(store("garbage")), "line");
  // A hardened WebView can throw on storage access; a white screen would be
  // worse than a default theme.
  assert.equal(
    readTheme({
      getItem: () => {
        throw new Error("denied");
      },
    }),
    "line",
  );
  assert.doesNotThrow(() =>
    writeTheme("old", {
      setItem: () => {
        throw new Error("denied");
      },
    }),
  );
});

test("exactly one DOM attribute drives the design", () => {
  const root = { dataset: {} as Record<string, string | undefined> };
  applyTheme("old", root as unknown as HTMLElement);
  assert.equal(root.dataset.theme, "old");
  // Bootstrap applies the build's design and persists nothing: there is no
  // preference to remember any more, only a compiled-in value.
  const written: string[] = [];
  assert.equal(
    bootstrapTheme({
      read: () => "old",
      write: (value) => written.push(value),
      root: root as unknown as HTMLElement,
    }),
    "old",
  );
  assert.equal(root.dataset.theme, "old");
  assert.deepEqual(written, [], "bootstrap must not persist a design");
  assert.deepEqual(Object.keys(THEME_LABELS).sort(), ["line", "old"]);
});

test("the new theme keeps the legacy slots, so old components still work", () => {
  // Same names, new values — that is what makes the migration additive.
  for (const slot of [
    "--background",
    "--foreground",
    "--card",
    "--popover",
    "--primary",
    "--primary-foreground",
    "--secondary",
    "--muted",
    "--muted-foreground",
    "--accent",
    "--destructive",
    "--border",
    "--input",
    "--ring",
    "--sidebar",
    "--sidebar-border",
  ]) {
    assert.match(
      themes,
      new RegExp(`\\n\\s{2}${slot}:`),
      `${slot} must be re-declared for the new theme`,
    );
  }
  // And the new ideas live in their own slots.
  for (const token of [
    "--fill",
    "--fill-subtle",
    "--fill-hover",
    "--fill-strong",
    "--surface-glass",
    "--line-hairline",
    "--line-accent",
    "--line-online",
    "--line-offline",
    "--line-update",
    "--radius-control",
    "--radius-item",
    "--radius-panel",
    "--ease-line",
    "--line-canvas",
  ]) {
    assert.match(themes, new RegExp(`\\n\\s{2}${token}:`), token);
  }
});

test("the old theme is preserved, not copied", () => {
  const block = themes.slice(
    themes.indexOf('[data-theme="old"] {'),
    themes.indexOf("}", themes.indexOf('[data-theme="old"] {')),
  );
  // A copy would drift the first time the old component changed. Only the
  // plumbing the new sheet needs is re-pointed.
  assert.doesNotMatch(block, /--background:/);
  assert.doesNotMatch(block, /--primary:/);
  assert.match(block, /--line-canvas/);
  // The old theme keeps the legacy geometry too, including the window radius.
  assert.match(block, /--radius: 14px/);
  // The legacy sheet still owns the real values.
  assert.match(indexCss, /--background: #0a0a0a;/);
  assert.match(indexCss, /--primary: oklch\(0\.92 0\.004 286\.32\)/);
  // Sheet order decides the winner: themes last, legacy first.
  const legacy = indexCss.indexOf(":root {");
  const sheet = indexCss.indexOf('@import "./styles/themes.css"');
  assert.ok(sheet > legacy, "themes.css must load after the legacy tokens");
});

test("panels in the new design are shadow, not outline", () => {
  assert.match(themes, /\[data-theme="line"\] \[data-line-glass\]/);
  const lineAt = themes.indexOf('[data-theme="line"] [data-line-glass] {');
  const lineGlass = themes.slice(lineAt, themes.indexOf("}", lineAt));
  // Elevation carries depth; a 1px border around every panel drew a frame
  // around every piece of content and made the page read as a grid of boxes.
  assert.match(lineGlass, /box-shadow:/);
  assert.doesNotMatch(lineGlass, /border:/);
  // Blur is deliberate again, and only because the animated backdrop is back:
  // a translucent pane over a moving mesh needs the mesh softened behind it.
  // Asserted so it is not "cleaned up" by someone reading an older comment.
  assert.match(lineGlass, /backdrop-filter: blur/);

  // The old design must get a real panel back, not an unstyled transparent box.
  const legacyAt = themes.lastIndexOf('[data-theme="old"] [data-line-glass]');
  const legacyGlass = themes.slice(legacyAt, themes.indexOf("}", legacyAt));
  assert.match(legacyGlass, /background: var\(--card\)/);
  assert.match(legacyGlass, /border: 1px solid/);
  assert.match(legacyGlass, /box-shadow: none/);
  // The old panel keeps the blur it always had (8px) and none of the new one.
  assert.match(legacyGlass, /backdrop-filter: blur\(8px\)/);
  assert.match(themes, /\[data-theme="line"\] \[data-line-canvas\]/);
  // The new backdrop is one flat colour. Two accent glows over a diagonal ramp
  // read as haze on a tool window and tinted text that had nothing to do with
  // the accent.
  const canvasAt = themes.indexOf("--line-canvas:", themes.indexOf(":root {"));
  const canvasLine = themes.slice(canvasAt, themes.indexOf(";", canvasAt));
  assert.doesNotMatch(canvasLine, /gradient/);
  // `"old"` keeps its animated gradient, so the two themes still differ.
  const oldAt = themes.indexOf('[data-theme="old"] {');
  const oldCanvas = themes.slice(oldAt, themes.indexOf("}", oldAt));
  assert.match(oldCanvas, /--line-canvas: linear-gradient/);
  // The gradient ramp and its animation belong to the old design only, so the
  // new one neither paints a full-screen gradient nor repaints it every frame.
  const oldBodyAt = indexCss.indexOf('[data-theme="old"] body');
  const oldBody = indexCss.slice(oldBodyAt, indexCss.indexOf("}", oldBodyAt));
  assert.match(oldBody, /animation: gradientBg/);
  assert.match(oldBody, /linear-gradient/);
  // Nothing before that rule may paint a gradient of its own.
  assert.doesNotMatch(
    indexCss.slice(0, oldBodyAt),
    /linear-gradient|animation: gradientBg/,
  );
  // Reduced motion stops movement; it must not flatten the window into grey.
  // The shader freezes at its first frame and the glass keeps its blur.
  assert.match(themes, /prefers-reduced-motion: reduce/);
  const stillAt = themes.indexOf("@media (prefers-reduced-motion: reduce)");
  const stillBlock = themes.slice(stillAt, themes.indexOf("}", stillAt) + 1);
  assert.doesNotMatch(
    stillBlock,
    /backdrop-filter/,
    "reduced motion must not change how the glass looks, only how it moves",
  );
  // The one preference that may flatten the glass is reduced transparency.
  assert.match(themes, /prefers-reduced-transparency: reduce/);
});

test("no gradient survives anywhere outside the old design", () => {
  // The user's rule: gradients are the tell of generated UI. The old theme is a
  // frozen historical look and keeps its animated ramp; nothing that ships in
  // the default design may paint one.
  const files = [
    "src/components/line/AccountScreen.tsx",
    "src/components/line/AuthForm.tsx",
    "src/components/line/ServerCard.tsx",
    "src/components/line/ServerList.tsx",
    "src/components/line/ServerDetail.tsx",
    "src/components/line/ServerActionPanel.tsx",
    "src/components/line/ServerCatalogRail.tsx",
    "src/components/line/WardrobeScreen.tsx",
    "src/components/line/SettingsScreen.tsx",
    "src/components/line/SideNav.tsx",
    "src/components/line/TitleBar.tsx",
    "src/components/line/ConfigUrlInput.tsx",
    "src/components/line/InstallProgress.tsx",
    "src/components/line/ReleaseHistoryDialog.tsx",
  ];
  for (const file of files) {
    const src = read(file);
    // The legacy branch of ServerDetail is the frozen design, byte for byte.
    const shipped =
      file === "src/components/line/ServerDetail.tsx"
        ? src.slice(0, src.indexOf("function LegacyDetail"))
        : src;
    assert.doesNotMatch(
      shipped,
      /bg-gradient|from-[a-z]+\/\d+ .*to-/,
      `${file} paints a gradient in the new design`,
    );
  }
  // The new theme's canvas token is a flat colour, not a ramp.
  const canvas = themes.slice(
    themes.indexOf(":root {"),
    themes.indexOf(":root {") + 4000,
  );
  const lineBlock = canvas.slice(
    canvas.indexOf("--line-canvas:"),
    canvas.indexOf(";", canvas.indexOf("--line-canvas:")),
  );
  assert.doesNotMatch(lineBlock, /gradient/);
});

test("the theme is reachable and remembered", () => {
  const launcher = read("src/components/line/LineLauncher.tsx");
  const provider = read("src/components/line/ThemeProvider.tsx");
  const nav = read("src/components/line/SideNav.tsx");
  const settings = read("src/components/line/SettingsScreen.tsx");
  const entry = read("src/index.tsx");
  assert.match(read("src/App.tsx"), /<ThemeProvider>/);
  assert.match(provider, /applyTheme\(theme\)/);
  // The provider resolves the design once, from the build, and exposes no
  // setter: there is nothing in the shipped window that changes it.
  assert.match(provider, /buildTheme\(\)/);
  assert.doesNotMatch(provider, /setTheme|toggleTheme/);
  assert.match(entry, /bootstrapTheme\(\)/);
  assert.match(launcher, /useTheme\(\)/);
  // No control anywhere: not in the shell, the rail or settings. Themed by a
  // build, not by a button is the requirement.
  for (const source of [launcher, nav, settings]) {
    assert.doesNotMatch(source, /toggleTheme|ThemeToggle|ThemeSwitchPill/);
  }
  assert.doesNotMatch(launcher, /onToggleTheme/);
  assert.doesNotMatch(settings, /title="Оформление"/);
  // The rollback build is a documented, real path: an environment variable
  // read at build time, not a runtime toggle.
  assert.match(read("src/lib/line/theme.ts"), /VITE_LINE_THEME/);
  assert.match(
    read("README.md"),
    /VITE_LINE_THEME=old/,
    "the old design must stay buildable and documented",
  );
  assert.match(read("index.html"), /data-theme="line"/);
});

test("ServerActionPanel is the dock: one status, one progress, one button", () => {
  const panel = read("src/components/line/ServerActionPanel.tsx");
  // Requirements from the brief, asserted so a refactor cannot drop them.
  for (const piece of [
    "server.name",
    'role="status"',
    'role="progressbar"',
    "aria-valuenow",
    "Загрузка сборки",
    "Играть",
  ]) {
    assert.ok(panel.includes(piece), `missing ${piece}`);
  }
  assert.match(panel, /data-line-glass="dock"/);
  // A region with the server's name, so the smoke test (and a screen reader)
  // can address this dock instead of the whole page.
  assert.match(panel, /role="region"/);
  assert.match(panel, /aria-labelledby="server-action-title"/);
  assert.match(panel, /useReducedMotion\(\)/);
  assert.match(panel, /ease: \[0\.22, 1, 0\.36, 1\]/);
  // No music-player leftovers: no seek/volume, no canvas visualiser, no
  // window chrome. Electron-era controls are exactly what is being removed.
  for (const banned of [
    /volume/i,
    /seek/i,
    /audio/i,
    /canvas/i,
    /drag-region/i,
    /frame:/i,
  ]) {
    assert.doesNotMatch(panel, banned);
  }
  // Motion primitives must come from the lazy bundle, like the rest of the app.
  assert.doesNotMatch(panel, /from "framer-motion".*\bmotion\b/);
  assert.match(panel, /import \{[^}]*\bm\b[^}]*\} from "framer-motion"/);
});

test("the two designs render one branch each, never both", () => {
  const detail = read("src/components/line/ServerDetail.tsx");
  // Duplicating the dock under `hidden` would give two «Играть» buttons to
  // assistive tech and to the smoke test.
  assert.match(detail, /theme === "line" &&/);
  assert.match(detail, /theme === "old" && <LegacyDetail/);
  assert.doesNotMatch(detail, /\[html\[data-theme=old\]_&\]/);
  assert.match(detail, /function phaseOf\(/);
  for (const phase of [
    '"needs-install"',
    '"needs-update"',
    '"installing"',
    '"starting"',
    '"running"',
    '"failed"',
  ]) {
    assert.ok(detail.includes(phase), `missing phase ${phase}`);
  }
});

test("the catalogue rail is tryliner's now-playing strip, translated", () => {
  const rail = read("src/components/line/ServerCatalogRail.tsx");
  const list = read("src/components/line/ServerList.tsx");
  const launcher = read("src/components/line/LineLauncher.tsx");

  // One region, one action. A play button here would promise a launch that may
  // need an install first, so the strip only opens the server screen.
  assert.match(rail, /role="region"/);
  assert.match(rail, /aria-label="Текущий сервер"/);
  assert.match(rail, /<span>Открыть<\/span>/);
  assert.doesNotMatch(rail, /Играть|Остановить/);
  // Progress is a hairline with a real progressbar role, not a decoration.
  assert.match(rail, /role="progressbar"/);
  assert.match(rail, /aria-valuenow=\{percent\}/);
  assert.match(rail, /useReducedMotion\(\)/);

  // The catalogue mounts it above the grid, and only in the new design.
  assert.match(list, /\{rail\}/);
  // Wrapped in `theme === "line" && (` ... `)` because the old catalogue must
  // keep its exact previous markup and gain no extra strip.
  const railBlock = launcher.slice(
    launcher.indexOf('theme === "line" && ('),
    launcher.indexOf("<ServerCatalogRail"),
  );
  assert.ok(railBlock.length > 0, "the rail is mounted for both designs");
  assert.match(launcher, /<ServerCatalogRail/);
  // Status is derived from the catalogue's own data, not from the detail screen.
  assert.match(
    launcher,
    /progress\?\.serverId === selected\.id \? progress : null/,
  );
  assert.match(launcher, /railStatus/);
});

test("the catalogue says which server needs an update or a download", () => {
  const card = read("src/components/line/ServerCard.tsx");
  const list = read("src/components/line/ServerList.tsx");
  // A status badge is generic text, so the card does not hardcode the states.
  assert.match(card, /statusLabel\?: string/);
  assert.match(card, /statusLabel/);
  assert.match(card, /hasPack\?: boolean/);
  // The chip row is gone: one quiet meta line, and the pack is a word rather
  // than a third boxed badge.
  assert.match(card, /pack\.json/);
  assert.doesNotMatch(
    card,
    /ZIP \+ pack/,
    "the card must not carry a chip row",
  );
  assert.match(list, /hasPack=\{Boolean\(server\.pack_manifest_url\)\}/);
  assert.match(list, /statusFor\?\.\(server\)/);
});

test("the game subscription outlives the detail screen", () => {
  const launcher = read("src/components/line/LineLauncher.tsx");
  // The rail must learn that a running game exited while another section is
  // open, so the effect cannot depend on `screen`.
  const effect = launcher.slice(
    launcher.indexOf("if (!selected) return;"),
    launcher.indexOf("}, [selected]);"),
  );
  assert.ok(effect.length > 0, "the game-status effect is gone");
  assert.match(effect, /lineApi\s*\.onGame\(selected\.id/);
  // The dependency list is part of the contract, not an implementation detail:
  // re-subscribing on navigation would drop events the rail needs.
  assert.match(
    launcher.slice(0, launcher.indexOf("}, [selected]);") + 16),
    /\}, \[selected\]\);/,
  );
  assert.doesNotMatch(effect, /screen !== "detail"/);
});

test("the login screen is one panel, not nested cards", () => {
  const bar = read("src/components/line/TitleBar.tsx");
  const account = read("src/components/line/AccountScreen.tsx");
  const form = read("src/components/line/AuthForm.tsx");

  // The title bar carries the mark and the product name and nothing to the
  // right of them: the design switch used to live there and no longer exists.
  assert.doesNotMatch(bar, /trailing/);

  // The fields are the same in both modes, so switching between them must not
  // remount the stack: it used to fade the whole form out and back in.
  // The form wrapper has no `key={mode}` on it, so the inputs keep their DOM
  // node (and the caret) across the switch.
  assert.doesNotMatch(form, /<m\.div\s+key=\{mode\}/);
  assert.doesNotMatch(form, /mode="wait">\s*<m\.div\s+key=\{mode\}/);
  // Only the strings that actually differ animate, and only their opacity.
  assert.match(form, /mode === "register"/);

  // The login card must use the same surface as the dock, not the old bg-card
  // (which is transparent in the new theme and looked like nothing changed).
  // The attribute itself, not the comment that names it.
  assert.match(account, /data-line-glass/);
  assert.doesNotMatch(account, /bg-card(?!\/)/);
  // And no decorative wash over the card: a gradient tint on top of a panel is
  // what made the first screen look dirty at the corners.
  assert.doesNotMatch(account, /bg-gradient-to-br/);
});

test("the animated backdrop is decoration that cannot take the window down", () => {
  const backdrop = read("src/components/line/AnimatedBackdrop.tsx");
  const launcher = read("src/components/line/LineLauncher.tsx");

  // Mounted once, behind the whole window — not per screen.
  assert.match(launcher, /<AnimatedBackdrop/);
  assert.match(backdrop, /data-line-backdrop/);
  assert.match(backdrop, /aria-hidden="true"/);
  assert.match(backdrop, /pointer-events-none/);

  // Three independent ways it refuses to matter:
  //  1. a capability probe, so a machine without WebGL2 never pays for it;
  assert.match(backdrop, /function hasWebgl2\(/);
  assert.match(backdrop, /getContext\("webgl2"\)/);
  //  2. an error boundary, because a driver can hand out a context and then
  //     fail inside the shader — that used to unmount the entire window;
  assert.match(backdrop, /class BackdropBoundary extends Component/);
  assert.match(backdrop, /getDerivedStateFromError/);
  assert.match(backdrop, /<BackdropBoundary>/);
  //  3. a CSS colour field under the canvas, so the window has colour even
  //     when hazeglow declines the renderer (it refuses software rasterisers).
  assert.match(backdrop, /HAZE_FIELD/);
  assert.match(backdrop, /backgroundImage: HAZE_FIELD/);

  // Reduced motion freezes the shader instead of leaving the page grey.
  assert.match(backdrop, /prefers-reduced-motion: reduce/);
  assert.match(backdrop, /motion: "none"/);

  // The shader is the only WebGL in the app: one dependency, one place.
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
  };
  assert.ok(pkg.dependencies.hazeglow, "hazeglow must be a real dependency");
  assert.deepEqual(
    Object.keys(pkg.dependencies).filter((name) =>
      /shader|gradient/.test(name),
    ),
    [],
    "the backdrop lab's extra engines must not ship",
  );
  assert.match(
    pkg.dependencies.hazeglow,
    /^\^?\d+\.\d+\.\d+$/,
    "a range, so a patch fix can land without a code change",
  );
});

test("the brand mark in the gallery is the real logo file, not a drawing", () => {
  const renderer = read("scripts/render-screens.mjs");
  // The invented "I" glyph was hand-drawn here while the app rendered the SVG.
  // The renderer now reads the same asset the app ships.
  assert.match(renderer, /branding\/assets\/logo\.svg/);
  assert.match(renderer, /function brandMark\(/);
  for (const site of ["brandMark(ctx, 16, 11, 22)", "brandMark(ctx,"]) {
    assert.ok(renderer.includes(site), `missing mark call: ${site}`);
  }
  // No path data of its own: a second copy is how the two drifted apart. The
  // renderer may only mention the thing it replaced to explain why.
  assert.match(renderer, /BRAND_LOGO/);
  assert.doesNotMatch(renderer, /ctx\.moveTo\(3, 3\)/);
  const logo = read("branding/assets/logo.svg");
  assert.match(logo, /fill="#FFFF01"/i);
});

test("the design is a build input, and the flag actually reaches the bundle", () => {
  const theme = read("src/lib/line/theme.ts");
  // Vite only substitutes the dotted form of `import.meta.env.VAR`. Reading the
  // object and indexing it keeps the substitution working — an earlier
  // `import.meta.env?.VITE_LINE_THEME` compiled to nothing and the rollback
  // build silently shipped the new design.
  assert.match(theme, /import\.meta\.env \?\? \{\}/);
  assert.match(theme, /VITE_LINE_THEME/);
  assert.doesNotMatch(theme, /import\.meta\.env\?\.VITE_LINE_THEME/);
  // Anything that is not a known design falls back to the shipped one.
  assert.doesNotMatch(theme, /isLineTheme\(undefined\)/);
  assert.match(
    theme,
    /isLineTheme\(env\.VITE_LINE_THEME\) \? env\.VITE_LINE_THEME : "line"/,
  );
});
