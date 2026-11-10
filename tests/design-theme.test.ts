import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const indexCss = read("src/index.css");

test("there is one design and no way to ask for another", () => {
  // A previous version shipped two looks: a legacy sheet plus an override sheet,
  // and a `VITE_LINE_THEME=old` build that produced the old one. That second
  // look was maintained, screenshot, documented and tested for a rollback nobody
  // performed — pure weight. This test is the guard against it coming back in
  // pieces: no attribute, no module, no build flag, no sandbox.
  const sources = [
    "src/index.css",
    "index.html",
    "src/App.tsx",
    "src/index.tsx",
    "src/components/line/ServerDetail.tsx",
    "src/components/line/LineLauncher.tsx",
  ];
  for (const file of sources) {
    assert.doesNotMatch(
      read(file),
      /data-theme/,
      `${file} still scopes a theme`,
    );
  }
  assert.equal(
    (indexCss.match(/^:root \{/gm) ?? []).length,
    1,
    "one palette block; a second one is a second design",
  );
  for (const gone of [
    "src/styles/themes.css",
    "src/lib/line/theme.ts",
    "src/components/line/ThemeProvider.tsx",
    "src/preview.tsx",
    "preview.html",
    "scripts/serve-design.mjs",
  ]) {
    assert.equal(
      existsSync(new URL(`../${gone}`, import.meta.url)),
      false,
      gone,
    );
  }
  // The design sandbox existed to compare the two looks side by side.
  assert.equal(
    (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts.design,
    undefined,
    "npm run design has nothing left to show",
  );
  assert.doesNotMatch(read("vite.config.ts"), /preview\.html|appType: "mpa"/);
});

test("the palette keeps the slots the components already use", () => {
  // Same names as the shadcn primitives expect, plus the ones this design
  // introduced. One block, so a preset only has to override values.
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
      indexCss,
      new RegExp(`\\n\\s{2}${slot}:`),
      `${slot} must be declared`,
    );
  }
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
    assert.match(indexCss, new RegExp(`\\n\\s{2}${token}:`), token);
  }
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

test("a minecraft-mode server swaps the dock, never renders two of them", () => {
  const detail = read("src/components/line/ServerDetail.tsx");
  // The two looks used to be two branches here. With one design there is one
  // page and one dock; the Minecraft panel is a separate branch *below* it, not
  // a second copy of the page, so «Играть» exists exactly once for assistive
  // tech and for the smoke test.
  assert.doesNotMatch(detail, /theme === /);
  assert.doesNotMatch(detail, /LegacyDetail/);
  assert.match(detail, /\{isMinecraft && \(/);
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

  // The catalogue mounts it above the grid, always — there is one design now,
  // so there is no branch that could leave it out.
  assert.match(list, /\{rail\}/);
  assert.doesNotMatch(launcher, /theme === /);
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
  //     The field is built from the theme's own palette in `backdrops.ts`, so the
  //     gradient generator and the shader config cannot drift apart.
  assert.match(backdrop, /backgroundImage: field/);
  const backdrops = read("src/lib/line/backdrops.ts");
  assert.match(backdrops, /export function backdropField\(/);
  assert.match(backdrops, /radial-gradient/);
  assert.match(backdrop, /backdropField\(active\)/);

  // Reduced motion freezes the shader instead of leaving the page grey.
  assert.match(backdrop, /prefers-reduced-motion: reduce/);
  assert.match(backdrop, /motion: "none"/);

  // Switching backdrops has to dissolve, not cut: hazeglow re-renders a new
  // config in one frame, so the only way to fade between two themes is to keep
  // both mounted for the length of a crossfade and animate opacity.
  assert.match(backdrop, /CROSSFADE_MS/);
  assert.match(backdrop, /transition-opacity/);
  assert.match(backdrops, /BACKDROP_THEMES/);

  // At least ten selectable themes, each with its own legibility veil — one
  // global `shade` cannot serve both a navy and a white ramp.
  const themes = backdrops.match(/^ {2}theme\(/gm)?.length ?? 0;
  assert.ok(
    themes >= 10,
    `expected at least 10 backdrop themes, found ${themes}`,
  );
  assert.match(backdrops, /shade:/);

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
