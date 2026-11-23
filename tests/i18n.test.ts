import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  LANGUAGE_NAMES,
  isLanguage,
  resolveLanguage,
} from "../src/lib/line/languages.ts";
import { DICTIONARIES, ru } from "../src/lib/line/i18n-dictionaries.ts";
import { translate } from "../src/lib/line/i18n-core.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The interface speaks four languages. These tests are about the properties
 * that make that true rather than about any one sentence: the same keys in all
 * four, the order and names the brief fixed, and the fact that switching has
 * nothing to wait for.
 */

test("exactly four languages, in the order the brief fixes", () => {
  assert.deepEqual([...LANGUAGES], ["ru", "en", "de", "fr"]);
  assert.equal(DEFAULT_LANGUAGE, "ru");
  // Endonyms: a language is named in its own language in the picker.
  assert.equal(LANGUAGE_NAMES.ru, "Русский");
  assert.equal(LANGUAGE_NAMES.en, "English");
  assert.equal(LANGUAGE_NAMES.de, "Deutsch");
  assert.equal(LANGUAGE_NAMES.fr, "Français");
});

test("every language carries every key, and none is left in Russian", () => {
  const keys = Object.keys(ru).sort();
  for (const language of LANGUAGES) {
    const dictionary = DICTIONARIES[language] as Record<string, string>;
    assert.deepEqual(
      Object.keys(dictionary).sort(),
      keys,
      `${language} has a different set of keys`,
    );
    for (const key of keys) {
      assert.equal(
        typeof dictionary[key],
        "string",
        `${language}.${key} is not a string`,
      );
      assert.ok(
        dictionary[key].trim().length > 0,
        `${language}.${key} is empty`,
      );
    }
  }

  // A translation that is byte-identical to the Russian source is either a
  // proper noun or an oversight. The list is explicit so adding a Russian copy
  // under another language has to be a decision.
  const identicalOnPurpose = new Set([
    "about.title",
    "settings.java",
    "settings.runtime",
    "settings.javaPathPlaceholder",
    "install.step.apply",
    "profile.skin",
    "signin.attributionMode",
  ]);
  for (const language of ["en", "de", "fr"] as const) {
    const dictionary = DICTIONARIES[language] as Record<string, string>;
    for (const key of Object.keys(ru)) {
      if (identicalOnPurpose.has(key)) continue;
      // Latin-script languages must not contain Cyrillic at all; that is the
      // failure a half-finished translation actually produces.
      assert.doesNotMatch(
        dictionary[key],
        /[А-Яа-яЁё]/,
        `${language}.${key} is still Russian: ${dictionary[key]}`,
      );
    }
  }
});

test("placeholders survive translation", () => {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(ru)) {
    const source = placeholders(ru[key as keyof typeof ru]);
    for (const language of ["en", "de", "fr"] as const) {
      const translated = placeholders(
        (DICTIONARIES[language] as Record<string, string>)[key] ?? "",
      );
      assert.deepEqual(
        translated,
        source,
        `${language}.${key} has different placeholders`,
      );
    }
  }
});

test("a switch is synchronous and needs no re-fetch", () => {
  // The catalogue is a static import, not a dynamic one: a language that has to
  // be fetched has a moment where the screen is half-translated, which is the
  // "instant switch" the brief asked for.
  const source = read("src/lib/line/i18n-core.ts");
  assert.doesNotMatch(source, /\bimport\(/);
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.match(
    source,
    /import \{[\s\S]*DICTIONARIES[\s\S]*\} from "\.\/i18n-dictionaries\.ts"/,
  );

  // And the store is a module-level value with synchronous listeners: set and
  // read in the same task.
  const before = translate("ru", "nav.servers");
  assert.equal(translate("de", "nav.servers"), "Server");
  assert.equal(translate("fr", "nav.servers"), "Serveurs");
  assert.equal(before, "Серверы");
});

test("the player's choice wins, then the system, then Russian", () => {
  // A stored choice outranks the operating system on every later launch.
  assert.equal(resolveLanguage("de", "en-US"), "de");
  assert.equal(resolveLanguage("ru", "de-DE"), "ru");
  // A region subtag from a newer build still lands on a language.
  assert.equal(resolveLanguage("fr-CA"), "fr");
  assert.equal(resolveLanguage("en_GB"), "en");
  // Nobody has chosen yet: the launcher comes up in the machine's language, so
  // a German Windows shows a German first run instead of a Russian one.
  assert.equal(resolveLanguage(null, "de-DE"), "de");
  assert.equal(resolveLanguage(undefined, "fr-FR"), "fr");
  assert.equal(resolveLanguage(null, "en-US"), "en");
  // A language the launcher does not ship falls back to the primary one.
  assert.equal(resolveLanguage(null, "it-IT"), "ru");
  assert.equal(resolveLanguage(null, undefined), "ru");
  assert.equal(resolveLanguage("it", "it-IT"), "ru");
  assert.equal(isLanguage("fr"), true);
  assert.equal(isLanguage("it"), false);
});

test("settings are grouped into left-side categories", () => {
  const settings = read("src/components/line/SettingsScreen.tsx");
  for (const group of [
    "performance",
    "appearance",
    "java",
    "window",
    "storage",
  ]) {
    assert.match(settings, new RegExp(`data-settings-panel="${group}"`));
  }
  assert.match(settings, /data-settings-category=\{id\}/);
  assert.match(settings, /setActiveGroup\(id\)/);
  assert.match(settings, /data-settings-categories/);
  assert.match(settings, /md:grid-cols-\[168px_minmax\(0,1fr\)\]/);
  assert.match(settings, /md:flex-col/);
  assert.match(
    settings,
    /translateY\(calc\(\$\{activeGroupIndex \* 44\}px\)\)/,
  );
  assert.match(settings, /motion-reduce:transition-none/);
  assert.match(
    settings,
    /data-settings-panel="appearance"[\s\S]*?t\("settings\.lang"\)/,
  );
  assert.match(
    settings,
    /data-settings-panel="performance"[\s\S]*?t\("settings\.memory"\)/,
  );
});

test("settings use balanced spacing and a flat active category marker", () => {
  const settings = read("src/components/line/SettingsScreen.tsx");
  const launcher = read("src/components/line/LineLauncher.tsx");
  assert.match(settings, /max-w-4xl flex-col gap-4/);
  assert.match(
    settings,
    /border-border\/30 flex min-w-0 flex-col gap-3 border-b pb-6 last:border-b-0 last:pb-0/,
  );
  assert.match(settings, /flex flex-col gap-6/);
  const categoryNav = settings.match(
    /<nav[\s\S]*?data-settings-categories[\s\S]*?<\/nav>/,
  )?.[0];
  assert.ok(categoryNav);
  assert.match(categoryNav, /bg-primary\/12/);
  assert.doesNotMatch(
    categoryNav,
    /border-primary\/20|border transition-transform/,
  );
  assert.match(settings, /role="radio"[\s\S]*?rounded-lg border p-2/);
  assert.match(
    launcher,
    /rounded-\[var\(--radius-item\)\] border p-4 sm:p-5 lg:p-6/,
  );
});

test("new settings and logout confirmation labels exist in every locale", () => {
  const keys = [
    "profile.logoutConfirmTitle",
    "settings.group.nav",
    "settings.group.performance",
    "settings.group.appearance",
    "settings.group.java",
    "settings.group.window",
    "settings.group.storage",
    "window.actions",
  ];
  for (const language of LANGUAGES) {
    const dictionary = DICTIONARIES[language] as Record<string, string>;
    for (const key of keys) {
      assert.ok(dictionary[key], `${language} is missing ${key}`);
    }
  }
});

test("every backdrop theme has a name in every language", () => {
  const backdrops = read("src/lib/line/backdrops.ts");
  const ids = [...backdrops.matchAll(/^    id: "([a-z]+)",$/gm)].map(
    (match) => match[1],
  );
  assert.ok(ids.length >= 10, `expected the shipped themes, got ${ids.length}`);
  for (const language of LANGUAGES) {
    const dictionary = DICTIONARIES[language] as Record<string, string>;
    for (const id of ids) {
      assert.ok(
        dictionary[`backdrop.${id}`],
        `${language} is missing a name for the "${id}" backdrop`,
      );
    }
  }
  // The names are not the same string in all four languages; the picker would
  // be lying if they were.
  const german = DICTIONARIES.de as Record<string, string>;
  const russian = DICTIONARIES.ru as Record<string, string>;
  assert.notEqual(german[`backdrop.${ids[0]}`], russian[`backdrop.${ids[0]}`]);
});

test("the settings picker offers the four languages in order", () => {
  const settings = read("src/components/line/SettingsScreen.tsx");
  assert.match(settings, /LANGUAGES\.map\(/);
  assert.match(settings, /LANGUAGE_NAMES\[/);
  assert.match(settings, /setLanguage\(value\)/);
  // The choice is persisted with the rest of the settings, not in localStorage:
  // one write path, one schema, and it survives a reinstall of the webview.
  assert.match(settings, /language: value/);
});

test("no component keeps a frozen Russian string of its own", () => {
  // Every visible sentence comes from the catalogue. Comments are allowed to be
  // Russian — they are written for the person maintaining the launcher.
  const files = [
    "AboutDialog",
    "AuthForm",
    "BackdropPicker",
    "ConfigUrlInput",
    "ConnectingScreen",
    "LineLauncher",
    "MinecraftPanel",
    "ProfileScreen",
    "ReleaseHistoryDialog",
    "ServerActionPanel",
    "ServerCard",
    "ServerCatalogRail",
    "ServerDetail",
    "ServerList",
    "SettingsScreen",
    "SideNav",
    "SignInScreen",
    "SkinPreview",
    "SkinViewer3D",
    "TitleBar",
    "WardrobeScreen",
    "WelcomeScreen",
  ];
  for (const name of files) {
    const source = read(`src/components/line/${name}.tsx`);
    const withoutComments = source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(
      withoutComments,
      /[А-Яа-яЁё]/,
      `${name} still renders a hard-coded Russian string`,
    );
  }
});
