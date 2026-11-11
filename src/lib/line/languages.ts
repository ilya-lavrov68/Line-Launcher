/**
 * Interface languages.
 *
 * One catalogue per language, all of them complete. There is no per-locale
 * bundle to download and nothing loads when the player switches: every language
 * is already in the binary, because a launcher that stutters for 200ms when you
 * pick "Deutsch" is not translated, it is delivered.
 *
 * Russian is the source of truth and the primary language: it is what the
 * interface was written in, what the tests assert on, and what a missing or
 * unknown code falls back to. Until the player picks a language, the interface
 * follows the operating system — see `resolveLanguage`.
 */
export const LANGUAGES = ["ru", "en", "de", "fr"] as const;

export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "ru";

/** Shown in the picker. Endonyms: a language is named in its own language. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  ru: "Русский",
  en: "English",
  de: "Deutsch",
  fr: "Français",
};

export function isLanguage(value: unknown): value is Language {
  return (
    typeof value === "string" &&
    (LANGUAGES as readonly string[]).includes(value)
  );
}

/**
 * A settings value (and optionally the system language) → a supported language.
 *
 * The order is: what the player chose, then what the operating system says,
 * then Russian. The system is consulted *only* while there is no stored
 * choice — once "Deutsch" has been picked it wins on every later launch, even
 * on a machine whose Windows is English. That is what makes the picker a
 * setting rather than a suggestion.
 *
 * Matching is on the primary subtag, so `de-AT`, `en-GB` and `fr-CA` all land
 * on a language instead of falling back, and a region subtag written by a newer
 * build still resolves in an older one.
 */
export function resolveLanguage(
  stored: string | null | undefined,
  system?: string | null,
): Language {
  const fromStored = primarySubtag(stored);
  if (fromStored) return fromStored;
  const fromSystem = primarySubtag(system);
  if (fromSystem) return fromSystem;
  return DEFAULT_LANGUAGE;
}

function primarySubtag(value: string | null | undefined): Language | null {
  if (isLanguage(value)) return value;
  const primary = (value ?? "").toLowerCase().split(/[-_]/)[0];
  return isLanguage(primary) ? primary : null;
}
