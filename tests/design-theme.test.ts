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
  assert.equal(readTheme(store("old")), "old");
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
  // Bootstrap never persists: it only applies what is already stored, so a
  // first-run default is not silently written over someone's choice.
  const written: string[] = [];
  assert.equal(
    bootstrapTheme({
      read: () => "line",
      write: (value) => written.push(value),
      root: root as unknown as HTMLElement,
    }),
    "line",
  );
  assert.equal(root.dataset.theme, "line");
  assert.deepEqual(written, ["line"]);
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

test("glass surfaces degrade to a plain panel in the old design", () => {
  assert.match(themes, /\[data-theme="line"\] \[data-line-glass\]/);
  assert.match(themes, /backdrop-filter: blur\(20px\) saturate\(140%\)/);
  // The old design must get a real panel back, not an unstyled transparent box.
  const legacyAt = themes.lastIndexOf('[data-theme="old"] [data-line-glass]');
  const legacyGlass = themes.slice(legacyAt, themes.indexOf("}", legacyAt));
  assert.match(legacyGlass, /background: var\(--card\)/);
  assert.match(legacyGlass, /box-shadow: none/);
  assert.match(themes, /\[data-theme="line"\] \[data-line-canvas\]/);
  // The gradient animation belongs to the old design only, so the new one does
  // not repaint a full-screen gradient every frame.
  assert.match(
    indexCss,
    /\[data-theme="old"\] body \{\s*animation: gradientBg/,
  );
  assert.doesNotMatch(
    indexCss.slice(0, indexCss.indexOf('[data-theme="old"] body')),
    /animation: gradientBg 20s ease infinite;\s*\}\s*html/,
  );
  // Reduced motion turns glass into a solid surface rather than wobbling.
  assert.match(themes, /prefers-reduced-motion: reduce/);
});

test("the theme is reachable and remembered", () => {
  const launcher = read("src/components/line/LineLauncher.tsx");
  const provider = read("src/components/line/ThemeProvider.tsx");
  const nav = read("src/components/line/SideNav.tsx");
  const settings = read("src/components/line/SettingsScreen.tsx");
  const entry = read("src/index.tsx");
  assert.match(read("src/App.tsx"), /<ThemeProvider>/);
  assert.match(provider, /applyTheme\(next\)/);
  assert.match(provider, /writeTheme\(theme\)/);
  assert.match(entry, /bootstrapTheme\(\)/);
  assert.match(launcher, /useTheme\(\)/);
  assert.match(launcher, /onToggleTheme=\{toggleTheme\}/);
  assert.match(nav, /aria-label="Сменить оформление"/);
  assert.match(settings, /title="Оформление"/);
  assert.match(settings, /<ThemeToggle \/>/);
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
  assert.match(card, /statusLabel \?/);
  assert.match(card, /hasPack\?: boolean/);
  assert.match(card, /ZIP \+ pack\.json/);
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

test("the design switch exists before the sidebar does", () => {
  const pill = read("src/components/line/ThemeSwitchPill.tsx");
  const bar = read("src/components/line/TitleBar.tsx");
  const launcher = read("src/components/line/LineLauncher.tsx");
  const account = read("src/components/line/AccountScreen.tsx");

  // The first screens are the address form and sign-in; the sidebar is not
  // mounted there, so a switch that only lives in the sidebar is unreachable
  // and the app looks unchanged to anyone who never signs in.
  assert.match(bar, /trailing\?: React\.ReactNode/);
  assert.match(bar, /\{trailing && \(/);
  assert.match(launcher, /screen === "config" \|\| screen === "account"/);
  assert.match(pill, /useTheme\(\)/);
  assert.match(
    pill,
    /aria-label=\{`Включить \$\{toOld \? "старый" : "новый"\} дизайн`\}/,
  );

  // The login card must use the same surface as the dock, not the old bg-card
  // (which is transparent in the new theme and looked like nothing changed).
  // The attribute itself, not the comment that names it.
  assert.match(account, /^\s+data-line-glass$/m);
  assert.doesNotMatch(account, /bg-card(?!\/)/);
});
