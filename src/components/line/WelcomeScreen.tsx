import { m, useReducedMotion } from "framer-motion";
import { useEffect } from "react";

/**
 * The greeting a player sees before anything else.
 *
 * One word, and nothing else. It is written the way a pen writes: each letter
 * is stroked into place rather than faded in, so the eye follows a hand across
 * the screen instead of watching a block of text appear. There is no product
 * name under it and no rule: those were a caption on a greeting, and a greeting
 * does not have a caption.
 *
 * It covers the launcher, so it has no chrome of its own — no title bar, no
 * rail, no panel. Only the word, over the page's own colour field, which shows
 * through a wash light enough to leave the gradient visible.
 */
export interface WelcomeScreenProps {
  /** Runs when the last letter has landed and the hold has elapsed. */
  onDone: () => void;
  /** How long the finished word stays before the sign-in screen takes over. */
  holdMs?: number;
}

/** One letter's share of the draw, in seconds. */
const LETTER_STAGGER = 0.085;
const LETTER_DURATION = 0.62;
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
  const letters = Array.from(word);

  /**
   * How long the greeting stays up.
   *
   * With motion the word takes its own time to be written. Without motion there
   * is no stroke — but the screen must still last long enough to be *read*, not
   * flashed: skipping the animation used to cut the whole greeting down to the
   * 620ms hold, which is shorter than it takes to focus on a word.
   */
  const drawMs = reduced
    ? 0
    : (letters.length * LETTER_STAGGER + LETTER_DURATION) * 1000;
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
      <span
        aria-label={word}
        data-line-welcome-word
        // `font-hand` is Caveat, the one place a handwriting face is used. The
        // size is larger than a sans wordmark of the same length: a script at
        // 104px reads like 72px of Geist, because the strokes are thin and the
        // counters are open.
        className="text-foreground font-hand flex items-baseline overflow-hidden text-[15vw] leading-[0.9] font-medium tracking-[0.005em] select-none sm:text-[132px]"
      >
        {letters.map((letter, index) => (
          <m.span
            key={`${letter}-${index}`}
            aria-hidden="true"
            // A pen does not lift a letter onto the page from below; it makes a
            // stroke. `clipPath` uncovers the glyph from left to right with a
            // hard edge — that edge is the nib — and the letter sits perfectly
            // still while it arrives. Nothing moves, which is what makes it read
            // as writing rather than as animation.
            initial={reduced ? false : { clipPath: "inset(0 100% 0 0)" }}
            animate={{ clipPath: "inset(0 0% 0 0)" }}
            transition={{
              delay: index * LETTER_STAGGER,
              duration: LETTER_DURATION,
              // Quick where the nib lands, easing as it lifts.
              ease: [0.65, 0, 0.13, 1],
            }}
            className="inline-block"
          >
            {letter}
          </m.span>
        ))}
      </span>
    </m.div>
  );
}
