import {
  DEFAULT_LANGUAGE,
  isLanguage,
  resolveLanguage,
  type Language,
} from "./languages.ts";
import {
  DICTIONARIES,
  ru,
  type MessageKey,
  type MessageValues,
} from "./i18n-dictionaries.ts";

/**
 * Translation core: the store, `t`, and `format`.
 *
 * This module deliberately does not import React. Everything that has to put a
 * sentence in front of the player goes through it — validators in `skin.ts`,
 * errors raised in `api.ts`, helpers that never render — and a launcher that
 * can only translate inside a component tree is a launcher with half a
 * translated interface. The hook lives in `i18n.ts` and is a thin subscription
 * over the same store.
 *
 * Two rules decide the rest of the shape:
 *
 *  1. **Every language is already in memory.** No lazy import per locale, no
 *     fetch, no spinner between choosing "Deutsch" and the screen becoming
 *     German. The whole catalogue is a few kilobytes and ships in the binary; a
 *     language switch with a loading state is a language switch that failed.
 *  2. **The current language is a module-level store.** That is what makes
 *     `t()` usable outside React and what makes a switch reach every string in
 *     the same task, with no provider to thread through the tree.
 */
type Listener = () => void;

let current: Language = DEFAULT_LANGUAGE;
const listeners = new Set<Listener>();

/** Read the current language outside React. */
export function currentLanguage(): Language {
  return current;
}

/**
 * Set the language. Returns the value now in force, which is the input only
 * when it is a language the launcher actually ships.
 *
 * Synchronous on purpose: the store notifies, React re-renders in the same
 * task, and the new strings are on screen before the click handler returns.
 */
export function setLanguage(next: string | null | undefined): Language {
  const language = isLanguage(next) ? next : current;
  if (language === current) return current;
  current = language;
  for (const listener of listeners) listener();
  return current;
}

/** Subscribe, for `useSyncExternalStore`. Exported for tests. */
export function subscribeLanguage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `{name}` interpolation in one pass: a value containing braces is inserted
 * verbatim and never re-scanned, so no translation can expand another's
 * placeholder.
 */
export function format(template: string, values?: MessageValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** Translate one key in a given language. */
export function translate(
  language: Language,
  key: MessageKey | (string & {}),
  values?: MessageValues,
): string {
  const dictionary = DICTIONARIES[language] ?? ru;
  const template =
    (dictionary as Record<string, string>)[key] ??
    (ru as Record<string, string>)[key];
  // A key that exists in no language is a programming mistake, not a runtime
  // state; showing the key makes it obvious in a screenshot instead of blank.
  return format(template ?? key, values);
}

export interface Translator {
  /**
   * `key` is a `MessageKey` for every literal call, which is what makes a typo
   * a compile error. The union is widened with `(string & {})` so a
   * data-driven key (`backdrop.${id}`) is accepted; those are covered by
   * `tests/i18n.test.ts`, which checks every theme id has a name in every
   * language.
   */
  (key: MessageKey | (string & {}), values?: MessageValues): string;
  /** The language the caller is reading, for `lang` attributes and pickers. */
  readonly language: Language;
}

/** A translator bound to one language, cached so a render allocates nothing. */
const cache = new Map<Language, Translator>();

export function translatorFor(language: Language): Translator {
  const cached = cache.get(language);
  if (cached) return cached;
  const translator = Object.assign(
    (key: MessageKey | (string & {}), values?: MessageValues) =>
      translate(language, key, values),
    {
      get language() {
        return language;
      },
    },
  );
  cache.set(language, translator);
  return translator;
}

/**
 * The translator bound to the current language.
 *
 * Use this outside React (event handlers that build a message, validators,
 * helpers) and `useT()` inside components, which subscribes to changes.
 */
export const t: Translator = Object.assign(
  (key: MessageKey | (string & {}), values?: MessageValues) =>
    translate(current, key, values),
  {
    get language() {
      return current;
    },
  },
);

/**
 * The language to start with: the stored choice, else the system language, else
 * Russian.
 *
 * A player who has never touched the picker gets the launcher in the language
 * their machine is already in — German Windows, German launcher, first run. The
 * moment they choose something in Settings, that choice is stored and it
 * outranks the system on every later launch; the picker is a setting, not a
 * suggestion. `navigator.language` is the WebView's view of the same setting
 * the Rust side would read, so nothing has to be passed in.
 */
export function initialLanguage(stored: string | null | undefined): Language {
  const system =
    typeof navigator !== "undefined" ? navigator.language : undefined;
  return resolveLanguage(stored, system);
}

export type { MessageKey, MessageValues, Language };
