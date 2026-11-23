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
    't("detail.installing")',
    't("detail.play")',
  ]) {
    assert.ok(panel.includes(piece), `missing ${piece}`);
  }
  // Кнопка — единственный индикатор: её заливка растёт, подпись остаётся
  // действием. Роль прогресса живёт внутри той же кнопки, чтобы скринридер
  // получал число, а на экране не появлялось второй полосы.
  const primary = read("src/components/line/ServerDock.tsx");
  for (const piece of [
    'role="progressbar"',
    "aria-valuenow",
    "aria-valuemin",
  ]) {
    assert.ok(primary.includes(piece), `missing ${piece} in ServerDockPrimary`);
  }
  assert.match(panel, /<ServerDockPrimary[\s\S]{0,600}progress=\{/);
  assert.match(panel, /progressLabel=/);
  // The launch stage asks for the sweep, the install stage asks for the fill.
  // Both are pinned: merging them back into one "hold a third" branch is the
  // regression this pair exists to catch.
  assert.match(panel, /indeterminate=\{!installing && phase === "starting"\}/);
  const primarySource = read("src/components/line/ServerDock.tsx");
  assert.match(primarySource, /busy && !indeterminate &&/);
  assert.match(primarySource, /busy && indeterminate &&/);
  assert.match(primarySource, /className="dock-sweep /);
  // The sweep must actually travel; a static third was the rejected version.
  assert.match(read("src/index.css"), /@keyframes line-dock-sweep/);
  assert.match(
    read("src/index.css"),
    /\.dock-sweep \{[\s\S]{0,200}animation: line-dock-sweep/,
  );
  // Ни отдельного прогресса, ни имени файла: стадия — из словаря.
  assert.doesNotMatch(panel, /<ActionProgress/);
  assert.doesNotMatch(panel, /progress\.label/);
  assert.doesNotMatch(panel, /progress\.file/);
  const dock = read("src/components/line/ServerDock.tsx");
  const minecraft = read("src/components/line/MinecraftPanel.tsx");
  // Both launch modes use the same named region and primary action styling.
  for (const mode of [panel, minecraft]) {
    assert.match(mode, /<ServerDock name=\{server\.name\}>/);
    assert.match(mode, /<ServerDockPrimary/);
  }
  assert.match(dock, /role="progressbar"/);
  assert.match(dock, /aria-valuenow/);
  assert.match(dock, /data-line-glass="dock"/);
  assert.match(dock, /role="region"/);
  assert.match(dock, /aria-labelledby="server-action-title"/);
  assert.match(dock, /h-11 w-full/);
  assert.match(dock, /useReducedMotion\(\)/);
  // The fill grows from the *left edge*, the way tryliner's mini player does
  // it: a full-size layer anchored with `transform-origin: left` and scaled on
  // X (`MiniPlayer.tsx`: `origin-left` + `scaleX(progress)`). An element that
  // appears from the middle — a bar with a centred width, or a scale with the
  // default `origin-center` — is the mistake this asserts against.
  assert.match(dock, /origin-left/);
  assert.match(dock, /scaleX\(/, "the fill must be scaled from its left edge");
  assert.doesNotMatch(
    dock,
    /\{ width: `\$\{clamped\}%` \}/,
    "width-from-the-left was replaced by an origin-left scale",
  );
  assert.match(dock, /ease: \[0\.22, 1, 0\.36, 1\]/);
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
  // Minecraft and ZIP modes use mutually exclusive panels in the same dock.
  assert.doesNotMatch(detail, /theme === /);
  assert.doesNotMatch(detail, /LegacyDetail/);
  assert.match(detail, /\{isMinecraft \? \(/);
  assert.equal((detail.match(/<MinecraftPanel\b/g) ?? []).length, 1);
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
  assert.match(rail, /aria-label=\{t\("catalog\.lastSelected"\)\}/);
  assert.match(rail, /\{t\("catalog\.details"\)\}/);
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
  const account = read("src/components/line/SignInScreen.tsx");
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

  // Signing in is a page, not a panel inside the launcher: it must not paint
  // its own opaque background (the shell's backdrop shows through) and it must
  // keep the window's own frame, or a frameless window opened here could not be
  // moved or closed.
  assert.doesNotMatch(account, /className="bg-background[^"]*h-dvh/);
  // The logo is fixed in the same compact corner on the gate and launcher;
  // its position must not depend on the expanded/collapsed rail state.
  assert.match(account, /<TitleBar \/>/);
  assert.match(account, /data-line-signin/);
});

test("the greeting draws itself and ends without waiting for the network", () => {
  const welcome = read("src/components/line/WelcomeScreen.tsx");
  const launcher = read("src/components/line/LineLauncher.tsx");

  // The word is written by one stroke crossing it — not faded in as a block,
  // and not split into per-letter boxes (see the test below for why).
  assert.match(welcome, /const word = "Welcome"/);
  assert.match(welcome, /DRAW_DURATION/);
  // A fixed-length prologue: the timer is not tied to a fetch or a session.
  assert.match(welcome, /setTimeout\(onDone, total\)/);
  // With reduced motion there is no draw to watch, so the screen needs a floor
  // of its own — it used to last 620ms and flashed past unread.
  assert.match(welcome, /REDUCED_MIN_MS/);
  // `minMs` keeps the greeting readable; it is no longer an artificial wait
  // for the shader, which now starts loading alongside the stroke.
  assert.match(welcome, /Math\.max\(drawMs \+ holdMs, minMs, REDUCED_MIN_MS\)/);
  const backdrop = read("src/components/line/AnimatedBackdrop.tsx");
  assert.match(
    backdrop,
    /requestAnimationFrame\(\(\) => setHazeReady\(true\)\)/,
  );
  assert.match(backdrop, /void import\("hazeglow"\)/);
  assert.doesNotMatch(
    backdrop,
    /HAZE_DEFER_MS|setTimeout\(\(\) => setHazeReady/,
  );
  // No fetch, no session check, no promise: only the timer decides.
  assert.doesNotMatch(welcome, /\bawait\b|\bPromise\b|lineApi\./);

  // It covers everything, and the shell underneath is hidden while it runs —
  // the first frame a player saw used to be "Welcome" over a half-drawn
  // catalogue, because the greeting was transparent.
  assert.match(launcher, /<WelcomeScreen/);
  assert.match(launcher, /!introDone &&/);
  // The shell is hidden during the greeting because it is locked, and the same
  // lock now also covers a signed-out player on any screen — not just the
  // account one, which was the door a failed config fetch walked through.
  assert.match(launcher, /shellLocked && "pointer-events-none opacity-0"/);
  assert.match(launcher, /const shellLocked = signedOut \|\| !introDone/);

  // Reduced motion keeps the screen: it is content, not decoration.
  assert.match(welcome, /useReducedMotion/);

  // The greeting is the word and nothing else. The product name and the
  // hairline under it were a caption on a greeting; both are gone.
  assert.doesNotMatch(welcome, /welcome\.brand/);
  assert.doesNotMatch(welcome, /<m\.p/);
  assert.doesNotMatch(welcome, /h-px/);

  // Written, not faded: a hard-edged mask uncovers the word, which is what
  // makes it read as a pen rather than a dissolve.
  assert.match(welcome, /clipPath: "inset\(-40% 100% -40% -12%\)"/);
  assert.match(welcome, /font-hand/);
  // The handwriting face is a real dependency, not a stack of names that will
  // silently resolve to the system sans on most machines.
  assert.match(read("src/index.css"), /@import "@fontsource\/pacifico"/);
  assert.match(read("src/index.css"), /--font-hand: "Pacifico"/);

  // The same background wash stays behind every screen; the welcome fade
  // must not remove it and make the colours look washed out afterwards.
  assert.doesNotMatch(welcome, /WASH|style=\{\{ background/);
  assert.match(backdrop, /data-line-backdrop-wash/);
  assert.match(backdrop, /style=\{\{ background: BACKDROP_WASH \}\}/);
  assert.match(backdrop, /rgba\(8,9,12,0\.28\)/);
  assert.match(backdrop, /rgba\(8,9,12,0\.52\)/);
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
  const themes = backdrops.match(/^ {4}id: "/gm)?.length ?? 0;
  assert.ok(
    themes >= 10,
    `expected at least 10 backdrop themes, found ${themes}`,
  );
  assert.match(backdrops, /shade:/);

  // The configs come from hazeglow's own randomizer, not from hand-edited
  // ramps. That is the point of the rewrite: `randomConfig` varies the shape,
  // the size, the warp and the grain as well as the colours, which is why the
  // themes stopped looking like one picture in twelve tints.
  assert.match(backdrops, /randomConfig\(/);
  // And they must not all be the same shape either.
  const shapes = new Set(
    [...backdrops.matchAll(/^ {6}shape: "(\w+)"/gm)].map((m) => m[1]),
  );
  assert.ok(
    shapes.size >= 4,
    `themes should cover several shapes, found ${[...shapes].join(", ")}`,
  );

  // The compact picker: a folded list with a preview beside it, not a grid of
  // static tiles. The preview has to be animated, and it has to paint the same
  // field the page does — a static swatch was what made every theme look alike.
  const picker = read("src/components/line/BackdropPicker.tsx");
  assert.match(picker, /Popover/);
  assert.match(picker, /role="radiogroup"/);
  assert.match(picker, /data-backdrop-preview/);
  assert.match(picker, /backdropField\(theme\)/);
  assert.match(picker, /onMouseEnter/);
  // Not the old twelve-tile grid.
  assert.doesNotMatch(picker, /grid-cols-2 gap-2 sm:grid-cols-3/);

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
  // The mark itself is whatever the provider shipped — its colour is a branding
  // choice, not a contract, and pinning one here broke the moment the logo was
  // replaced. What must hold is that it is a real SVG with geometry in it.
  const logo = read("branding/assets/logo.svg");
  assert.match(logo, /^\s*<svg[\s>]/i);
  assert.match(logo, /viewBox=/);
  assert.match(logo, /<path[\s>]/i);
  assert.match(logo, /fill="/);
});

test("the launcher casts no shadows", () => {
  // Depth here is the fill ladder and the backdrop blur; a drop shadow over a
  // moving colour field read as grime along the panel edge, and an inset 1px
  // highlight drew a second border inside the real one. Both were removed on
  // purpose, so they must not creep back one component at a time.
  const css = read("src/index.css");
  const glass = css.slice(
    css.indexOf("[data-line-glass] {"),
    css.indexOf("[data-line-glass] {") + 400,
  );
  // Match the declaration, not the comment that explains why it is gone.
  assert.doesNotMatch(glass, /^\s*box-shadow\s*:/m);

  const files = [
    "src/components/line/ConfigUrlInput.tsx",
    "src/components/line/LineLauncher.tsx",
    "src/components/ui/popover.tsx",
    "src/components/ui/select.tsx",
    "src/components/ui/tooltip.tsx",
    "src/components/ui/tabs.tsx",
  ];
  for (const file of files) {
    assert.doesNotMatch(
      read(file),
      /shadow-(?:sm|md|lg|xl|2xl)\b/,
      `${file} still casts a drop shadow`,
    );
  }

  // Focus rings are not shadows-for-look: they are the keyboard affordance and
  // they stay.
  assert.match(css, /box-shadow: 0 0 0 3px color-mix/);
});

test("the greeting word is never split into per-letter boxes", () => {
  const welcome = read("src/components/line/WelcomeScreen.tsx");

  // The first version mapped the letters to spans and put `overflow: hidden`
  // on each one. A connected script is a single stroke: boxing every glyph
  // clipped the ascenders that rise above the line box and cut the joins where
  // one letter overlaps the next, so the word arrived chopped into cells. The
  // mask belongs to the whole word, and there is no per-letter element at all.
  assert.doesNotMatch(welcome, /letters\.map\(/);
  assert.doesNotMatch(welcome, /Array\.from\(word\)/);
  assert.doesNotMatch(welcome, /LETTER_STAGGER/);
  assert.doesNotMatch(
    welcome,
    /overflow-hidden[\s\S]{0,80}data-line-welcome-word/,
  );

  // The glyph box is larger than the em box, so it must not be cropped: no
  // `overflow: hidden` on the word, and the mask reaches well past the glyphs
  // on every side so descenders and the `W`'s swash survive.
  assert.match(welcome, /clipPath: "inset\(-40% 100% -40% -12%\)"/);
  assert.match(welcome, /clipPath: "inset\(-40% -12% -40% -12%\)"/);
  assert.doesNotMatch(welcome, /leading-\[0\.9\]/);
});

test("the account lives in the navigation list, not at the bottom of the rail", () => {
  const nav = read("src/components/line/SideNav.tsx");
  // One place for the account: the nav item that opens its page. The footer
  // carried a second copy of the name and a logout button beside it, which made
  // two ways to the same place and one destructive control always on screen.
  assert.doesNotMatch(
    nav,
    /onLogout/,
    "the rail must not own a logout control",
  );
  assert.doesNotMatch(nav, /LogOut/, "the rail must not draw a logout icon");
  assert.match(nav, /id: "account"/);

  // The shell must not pass them either, or the props come back with the block.
  const shell = read("src/components/line/LineLauncher.tsx");
  const navUse = shell.slice(
    shell.indexOf("<SideNav"),
    shell.indexOf("<SideNav") + 700,
  );
  assert.doesNotMatch(navUse, /onLogout/);
  assert.doesNotMatch(navUse, /username=/);

  // Logging out still has to be possible: it is the profile page's job.
  assert.match(read("src/components/line/ProfileScreen.tsx"), /onLogout/);
});

test("the backdrop picker shows names, and only the live preview shows the art", () => {
  const picker = read("src/components/line/BackdropPicker.tsx");
  // Twelve 32x18 gradient thumbnails were twelve smears. The preview beside the
  // list is an actual rendering at 208px, so it is the only picture needed.
  assert.doesNotMatch(
    picker,
    /function Swatch/,
    "the chip-size swatch must be gone",
  );
  assert.doesNotMatch(picker, /radial-gradient\(120% 120% at 12% 18%/);
  // The live preview stays — this is what replaced them.
  assert.match(picker, /data-backdrop-preview/);
  assert.match(picker, /backdropField\(theme\)/);
  // The options are still a full radiogroup, so removing the thumbnail did not
  // remove the semantics.
  assert.match(picker, /role="radiogroup"/);
  assert.match(picker, /role="radio"/);
});

test("the 3D skin is centred, and its turn does not depend on the frame rate", () => {
  const viewer = read("src/components/line/SkinViewer3D.tsx");
  // The canvas was appended into an absolutely-positioned host with no layout:
  // a 216px surface in a 288px field, hard against the left edge.
  assert.match(viewer, /absolute inset-0 flex items-center justify-center/);
  assert.match(viewer, /mx-auto|items-center justify-center/);
  assert.match(viewer, /setSize\(width, height\)/);

  // `autoRotate` advances a fixed angle per frame, so the model span 2.4x
  // faster on a 144 Hz display than on a 60 Hz one.
  assert.match(viewer, /viewer\.autoRotate = false/);
  assert.match(viewer, /function startSpin/);
  assert.match(viewer, /performance\.now\(\)/);
  assert.match(viewer, /maxDeltaMs/);
  // Reduced motion must still mean no rotation at all.
  assert.match(viewer, /reduced \? null : startSpin/);
});

test("signing out does not flash a connection error before the gate", () => {
  const launcher = read("src/components/line/LineLauncher.tsx");

  // Measured defect: for five frames at full opacity, the panel behind the
  // gate read "Нет соединения" with a retry button. Two independent causes,
  // both fixed here.
  //
  // One: the account branch of the shell was wired to the same screens as a
  // failed fetch, so a launcher with no session drew a connection error. It
  // survives only for a template that has no provider to connect to — the one
  // state the gate cannot cover.
  // The account branch used to render the connecting screen unconditionally,
  // so a signed-out launcher drew "Нет соединения" with a retry button. Only a
  // template with no provider may render it now. Asserted against the source
  // between two stable markers rather than by column, so Prettier's wrapping
  // cannot break the test.
  // The branch spans two lines in the source (Prettier wraps the condition), so
  // the slice is anchored on its comment and on the next branch's start.
  const branchStart = launcher.indexOf(
    "// Not unreachable, and it used to be wrong",
  );
  const branch = launcher.slice(
    branchStart,
    launcher.indexOf("!snapshot &&", branchStart),
  );
  assert.match(
    branch,
    /mode === "unconfigured" \?/,
    "the signed-out shell must not draw a connection error",
  );
  assert.doesNotMatch(
    branch,
    /loading=\{loading\}/,
    "a signed-out shell must not render a live loading state",
  );
  assert.match(
    branch,
    /loading=\{false\}/,
    "and it must not claim to be connecting while it waits for nothing",
  );

  // Two: `account` is what raises the gate, so a signed-out launcher keeps that
  // name — the flash came from what the branch *drew*, not from the name.
  assert.match(launcher, /setScreen\(current \? "servers" : "account"\)/);

  // And the failure banner is not shown to a shell with no session: the player
  // is already signed out, and the gate is covering it.
  assert.match(
    launcher,
    /!\(section === "servers" && screen === "config"\) &&\n\s+session &&/,
  );
});

test("panes are a darkening tint over the moving backdrop", () => {
  // The brief, in the user's words: «должна быть чуть затемняющая панель как
  // было в одном фиксе старом» — a pane that *darkens* what is behind it, not a
  // white sheet and not an opaque panel. That state is in this repo's history
  // (`rgba(10, 12, 16, 0.45)` over `#08090c`), and both rejected readings are
  // recorded so they cannot come back:
  //
  //   - a white 0.55–0.82 sheet turned the panels into white boards that hid
  //     the animated backdrop the window is built around;
  //   - lightening `--background` too flattened the whole window to one colour.
  //
  // What the pane must do: keep the dark ground, be translucent enough for the
  // backdrop's colour to read through it, and stay dark.
  assert.match(
    indexCss,
    /--background:\s*#08090c/,
    "the ground stays dark; the backdrop paints over it",
  );

  const pane = /--glass-surface:\s*rgba\((\d+), (\d+), (\d+), 0\.(\d+)\)/.exec(
    indexCss,
  );
  assert.ok(pane, "--glass-surface must be an rgba quadruple");
  const [r, g, b] = [Number(pane[1]), Number(pane[2]), Number(pane[3])];
  const alpha = Number(`0.${pane[4]}`);
  assert.ok(
    r < 60 && g < 60 && b < 60,
    `a pane must darken, not whiten — got rgb(${r}, ${g}, ${b})`,
  );
  assert.ok(
    alpha > 0.3 && alpha < 0.65,
    `the pane must be translucent enough to show the backdrop, got ${alpha}`,
  );

  // The panes no longer re-point the palette per subtree, so no pane carries a
  // second, inverted ink.
  const glassRule = /\[data-line-glass\]\s*\{([\s\S]*?)\n  \}/.exec(indexCss);
  assert.ok(glassRule, "the [data-line-glass] rule must exist");
  assert.match(
    glassRule[1],
    /background:\s*var\(--glass-surface\)/,
    "the pane paints the shared tint",
  );
  assert.doesNotMatch(
    glassRule[1],
    /--foreground:\s*var\(--glass-ink\)/,
    "the pane must not flip the ink per subtree",
  );

  // Light text: the pane is dark, so the ink is near-white.
  assert.match(
    indexCss,
    /--foreground:\s*oklch\(0\.9[0-9]/,
    "the ink is light, because the ground is dark",
  );

  assert.match(
    read("src/components/line/LineLauncher.tsx"),
    /<main\s+data-line-glass="main"/,
  );
  assert.match(
    read("src/components/line/SideNav.tsx"),
    /data-line-glass="sidebar"/,
  );
});

test("the page cannot shift sideways when a screen starts overflowing", () => {
  // Measured defect: the page pane scrolled its own content, so a screen taller
  // than the pane (settings) and one shorter than it (server catalogue) had
  // different content widths — the whole column stepped 6px sideways every time
  // the player moved between them, because the scrollbar gutter only existed
  // while a scrollbar did.
  //
  // The fix has two halves and both are needed: the gutter is reserved on every
  // scrolling shell pane, and the thumb is not drawn at rest, so reserving it
  // costs nothing visually.
  const css = read("src/index.css");
  assert.match(
    css,
    /\[data-line-glass="main"\]\s*\{[\s\S]*?scrollbar-gutter:\s*stable;/,
    "the main page must reserve its scrollbar gutter",
  );
  assert.match(
    css,
    /\[data-line-glass="sidebar"\]\s*\{[\s\S]*?scrollbar-gutter:\s*stable;/,
    "the sidebar must reserve its scrollbar gutter",
  );

  // Rest state: the pill is invisible. Without this the reserved gutter would
  // paint a thumb on every screen, including the ones that do not scroll.
  const thumbRule = /::-webkit-scrollbar-thumb\s*\{([\s\S]*?)\n  \}/.exec(css);
  assert.ok(thumbRule, "the thumb rule must exist");
  assert.match(
    thumbRule[1],
    /background-color:\s*transparent;/,
    "the thumb must be invisible at rest",
  );
  // ...and it comes back on interaction, or a long page has no visible affordance.
  assert.match(css, /:hover::-webkit-scrollbar-thumb\s*\{/);
  assert.match(css, /:focus-within::-webkit-scrollbar-thumb\s*\{/);

  // The sign-in gate is a screen of its own and needs the same reservation.
  assert.match(
    read("src/components/line/SignInScreen.tsx"),
    /scrollbarGutter:\s*"stable"/,
  );
});

test("the featured catalogue server reads as an immersive panel", () => {
  const rail = read("src/components/line/ServerCatalogRail.tsx");
  const section = rail.slice(
    rail.indexOf("data-line-server-featured"),
    rail.indexOf("</section>"),
  );
  assert.match(
    section,
    /rounded-\[var\(--radius-panel\)\]/,
    "the featured server should use the larger panel radius",
  );
  assert.match(section, /min-h-56/);
  assert.match(section, /bg-gradient-to-r/);
});

test("the sign-in plate is half the density of the shared pane", () => {
  // The brief: «главная плитка должна быть такая же» on the sign-in screen — the
  // gate card is a page-level plate, not a card inside a pane, so it is the
  // shared tint at half the density rather than a second surface.
  //
  // A later round painted it light grey and twice as transparent; that round was
  // reverted in full, and this test pins the shape it was reverted to. The dark
  // veil is the point: the plate darkens what is behind it, so the root ink
  // reads on it without any per-subtree palette.
  const css = read("src/index.css");
  assert.match(
    css,
    /--glass-surface:\s*rgba\(10,\s*12,\s*16,\s*0\.45\)/,
    "--glass-surface must stay the shared pane value",
  );
  assert.match(
    css,
    /--glass-surface-gate:\s*rgba\(10,\s*12,\s*16,\s*0\.225\)/,
    "the gate plate must be half the shared pane: 0.45 → 0.225",
  );
  assert.doesNotMatch(
    css,
    /--glass-surface-gate:\s*rgba\(230,\s*233,\s*238/,
    "the gate plate is a dark veil, not a light sheet — that version was reverted",
  );
  assert.match(
    css,
    /\[data-line-glass="gate"\]\s*\{[\s\S]*?background:\s*var\(--glass-surface-gate\)/,
    "the gate attribute must paint the gate plate",
  );
  assert.match(
    read("src/components/line/SignInScreen.tsx"),
    /data-line-glass="gate"/,
    "the sign-in card must opt into the gate plate",
  );
});

test("the skin placeholder cannot stretch the card around it", () => {
  // The bug: a paragraph saying «Не удалось показать текстуру» lived inside a
  // 32×64 box on the wardrobe page. Text does not shrink to fit, so it pushed
  // the grid row wide, clipped the skin name and shoved the row below onto it.
  // The placeholder is now a positioned marker with no intrinsic text width.
  const preview = read("src/components/line/SkinPreview.tsx");
  assert.doesNotMatch(
    preview,
    /<p[^>]*>\s*\{[^}]*previewFailed/,
    "the placeholder must not be a <p> — that is what broke the card layout",
  );
  assert.match(
    preview,
    /absolute inset-0/,
    "the placeholder must be positioned so it cannot size the box",
  );
  assert.match(
    preview,
    /role="img"/,
    "the placeholder is a picture, so it must expose that to screen readers",
  );
  // The mark covers two cases — a texture that failed to decode and a slot
  // with no texture at all — so the label is a ternary over both keys.
  assert.match(
    preview,
    /aria-label=\{failed \? t\("skin\.previewFailed"\) : t\("skin\.none"\)\}/,
    "the placeholder must keep its accessible label for both states",
  );
});

test("the sidebar blends into the backdrop while the main page stays distinct", () => {
  const css = read("src/index.css");
  const shell =
    /--glass-surface-shell:\s*rgba\(10,\s*12,\s*16,\s*0\.225\)/.exec(css);
  const gate = /--glass-surface-gate:\s*rgba\(10,\s*12,\s*16,\s*0\.225\)/.exec(
    css,
  );
  assert.ok(shell, "the main page must keep its dark translucent plate");
  assert.ok(gate, "the sign-in plate must be the same dark veil at 0.225");
  assert.match(
    css,
    /\[data-line-glass="sidebar"\]\s*\{\s*background:\s*transparent/,
    "the sidebar blends into the animated backdrop",
  );
  assert.match(
    css,
    /\[data-line-glass="main"\]\s*\{\s*background:\s*var\(--glass-surface-shell\)/,
    "the content page remains a distinct panel",
  );
  const launcher = read("src/components/line/LineLauncher.tsx");
  assert.doesNotMatch(launcher, /data-line-glass="workspace"/);
  assert.match(
    launcher,
    /<SideNav[\s\S]*?<main\s+data-line-glass="main"/,
    "navigation and page remain separate surfaces",
  );
  const mainStart = launcher.lastIndexOf(
    "<main",
    launcher.indexOf('data-line-glass="main"'),
  );
  const main = launcher.slice(mainStart, launcher.indexOf(">", mainStart));
  assert.match(main, /border-border\/50/);
  assert.match(main, /rounded-\[var\(--radius-item\)\].*border/);
  const serverCard = read("src/components/line/ServerCard.tsx");
  assert.match(serverCard, /border-border\/50 bg-fill/);
  assert.match(serverCard, /hover:bg-fill-strong\/85/);
  assert.match(
    launcher,
    /className="flex min-h-0 w-full flex-1 gap-1\.5 overflow-hidden"/,
    "a small gap preserves the separation between rail and page",
  );
  assert.match(css, /--line-solid-panel:\s*#222326/);
  assert.doesNotMatch(
    css,
    /--glass-surface-shell:\s*rgba\(230,/,
    "the page panel must not go back to the light sheet",
  );
  const shellValue = /--glass-surface-shell:\s*([^;]+);/.exec(css)?.[1];
  const gateValue = /--glass-surface-gate:\s*([^;]+);/.exec(css)?.[1];
  assert.ok(shellValue && gateValue, "both plate tokens must be declared");
  assert.equal(
    shellValue,
    gateValue,
    "the main page and sign-in plates must share one value",
  );
});

test("the rail does not repeat the provider name", () => {
  // «Вот эту надпись ещё надо убрать, она там только мешает» — the small
  // provider label under the logo in the sidebar. It is not hidden by CSS: the
  // label is gone from the component and the prop with it, so no page can bring
  // it back without failing here. The name still has its proper homes — the
  // page title on the catalogue and the window title — so nothing is lost.
  const nav = read("src/components/line/SideNav.tsx");
  assert.doesNotMatch(
    nav,
    /providerName/,
    "the rail must not take a provider name at all — it only had it for the label",
  );
  assert.doesNotMatch(
    nav,
    /title=\{providerName\}/,
    "the rail must not render the provider name as a tooltip either",
  );
  // The label sat between the logo and the first nav item; assert the rail now
  // starts with the list by checking no element is rendered before `items.map`.
  const body = nav.slice(nav.indexOf("overflow-y-auto p-2"));
  const firstChild = body.slice(0, body.indexOf("items.map"));
  assert.doesNotMatch(
    firstChild,
    /<p |<span /,
    "nothing may be rendered above the nav items — that slot held the label",
  );
});
