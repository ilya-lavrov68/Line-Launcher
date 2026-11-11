import { useSyncExternalStore } from "react";
import {
  currentLanguage,
  subscribeLanguage,
  translatorFor,
  type Translator,
} from "./i18n-core.ts";

/**
 * The React binding for the translation store.
 *
 * The store itself is in `i18n-core.ts` and does not touch React; this file
 * adds one hook. Components import `useT` (or, for a language picker, `t`),
 * and a switch re-renders exactly the components that read a string — there is
 * no provider, so nothing above them has to re-render and no context boundary
 * can be stale.
 */

/**
 * A translator subscribed to language changes.
 *
 * The returned value is stable per language: `useSyncExternalStore` only
 * re-runs the component when the language really changed, so passing `t` into
 * a `useMemo`/`useCallback` dependency list is correct and cheap.
 */
export function useT(): Translator {
  const language = useSyncExternalStore(
    subscribeLanguage,
    currentLanguage,
    currentLanguage,
  );
  return translatorFor(language);
}

export {
  currentLanguage,
  format,
  initialLanguage,
  setLanguage,
  subscribeLanguage,
  t,
  translate,
  translatorFor,
} from "./i18n-core.ts";
export type { MessageKey, MessageValues, Translator } from "./i18n-core.ts";
export type { Language } from "./languages.ts";
