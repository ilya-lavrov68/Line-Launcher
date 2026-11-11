import { m, useReducedMotion } from "framer-motion";
import { useEffect } from "react";

/**
 * The greeting a player sees before anything else.
 *
 * One word, and nothing else. It is written the way a pen writes: a hard-edged
 * stroke sweeps across it and leaves the finished word behind, so the eye
 * follows a hand instead of watching a block of text appear. There is no
 * product name under it and no rule: those were a caption on a greeting, and a
 * greeting does not have a caption.
 *
 * It covers the launcher, so it has no chrome of its own — no title bar, no
 * rail, no panel. Only the word, over the page's own colour field, which shows
 * through a wash light enough to leave the gradient visible.
 */
export interface WelcomeScreenProps {
  /** Runs when the word has been written and the hold has elapsed. */
  onDone: () => void;
  /** How long the finished word stays before the sign-in screen takes over. */
  holdMs?: number;
}

/** How long the nib takes to cross the word, in seconds. */
const DRAW_DURATION = 1.15;
/** Shortest time the greeting may stay on screen, motion or not. */
const REDUCED_MIN_MS = 1500;

/**
 * The wash over the backdrop.
 *
 * Light on purpose. The first version went to 94% black at the edges, which is
 * not a wash — it is a lid: the animated gradient behind the greeting, the one
 * thing that makes the first second feel like this launcher, was invisible. At
 * these stops the field still reads through the middle and only the corners
 * are pulled down far enough to keep a white word crisp.
 */
const WASH =
  "radial-gradient(120% 100% at 50% 42%, rgba(8,9,12,0.28), rgba(8,9,12,0.52) 78%)";

export default function WelcomeScreen({
  onDone,
  holdMs = 620,
}: WelcomeScreenProps) {
  const reduced = useReducedMotion();
  // Not translated, on purpose: it is a wordmark — the greeting itself, not a
  // sentence that belongs to one language.
  const word = "Welcome";

  /**
   * How long the greeting stays up.
   *
   * With motion the word takes its own time to be written. Without motion there
   * is no stroke — but the screen must still last long enough to be *read*, not
   * flashed: skipping the animation used to cut the whole greeting down to the
   * 620ms hold, which is shorter than it takes to focus on a word.
   */
  const drawMs = reduced ? 0 : DRAW_DURATION * 1000;
  const total = Math.max(drawMs + holdMs, REDUCED_MIN_MS);

  // The greeting is a fixed-length prologue, not a loading state: it ends when
  // the word has been written and held, whether or not the provider has
  // answered, so the sign-in page is never blocked behind the network.
  useEffect(() => {
    const timer = window.setTimeout(onDone, total);
    return () => window.clearTimeout(timer);
  }, [onDone, total]);

  return (
    <m.div
      key="welcome"
      data-line-welcome
      initial={{ opacity: 1 }}
      exit={{
        opacity: 0,
        transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
      }}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden"
      style={{ background: WASH }}
    >
      {/*
        One element, one mask — the word is never split into per-letter boxes.
        A script face is a single joined stroke: putting each letter in its own
        `overflow: hidden` box clipped the ascenders that rise above the cap
        height and cut the joins where one glyph overlaps the next, which is
        what "the letters are chopped into cells" was describing. The mask now
        belongs to the whole word, and `clip-path` is inset well beyond the
        glyph bounds on every side so descenders and the swash of the `W` have
        room instead of being trimmed at the box edge.

        There is no `overflow: hidden` and no collapsed line-height either: the
        face's ink box is taller than its em box, and a 0.9 line-height would
        crop it top and bottom. `leading-none` plus the generous `clip-path`
        inset leaves the whole glyph intact.
      */}
      <m.span
        aria-label={word}
        data-line-welcome-word
        // `font-hand` is Pacifico, the one place a handwriting face is used.
        // It is a sweeping, connected script, so it needs more room than a sans
        // wordmark of the same letters: 120px here reads like roughly 80px of
        // Geist, and the swashes reach further out than the advance width.
        className="text-foreground font-hand block text-[15vw] leading-none select-none sm:text-[120px]"
        initial={reduced ? false : { clipPath: "inset(-40% 100% -40% -12%)" }}
        animate={{ clipPath: "inset(-40% -12% -40% -12%)" }}
        transition={{
          duration: DRAW_DURATION,
          // Quick where the nib lands, easing as it lifts: the stroke moves
          // fastest in the middle of the word, like a hand, not like a wipe.
          ease: [0.55, 0, 0.25, 1],
        }}
      >
        {word}
      </m.span>
    </m.div>
  );
}
