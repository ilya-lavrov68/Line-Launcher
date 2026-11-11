import { m, useReducedMotion } from "framer-motion";
import { useEffect } from "react";
import { brand } from "@/brand/generated";

/**
 * The greeting a player sees before anything else.
 *
 * A word that draws itself, the way the Apple `hello` draws: the letters arrive
 * one after another, each rising a few pixels and settling, and the whole word
 * is written rather than faded in as a block — a block fade reads as a loading
 * state, and this screen is not loading anything.
 *
 * It covers the launcher, so it has no chrome of its own: no title bar, no rail,
 * no panel. Only the word, the product name under it, and the page's own
 * backdrop showing through. Everything above it is `position: fixed`, so the
 * greeting cannot be scrolled past.
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
/** The bar under the word, drawn left to right once the letters are down. */
const RULE_DELAY = 0.1;
const RULE_DURATION = 0.7;

export default function WelcomeScreen({
  onDone,
  holdMs = 620,
}: WelcomeScreenProps) {
  const reduced = useReducedMotion();
  // "Welcome" is the word on screen; the brand name is what it welcomes you to.
  const word = "Welcome";
  const letters = Array.from(word);

  // With reduced motion the word is simply there, and the screen leaves after a
  // readable pause instead of animating. The timer is the same either way, so
  // the sequence stays predictable.
  /**
   * How long the greeting stays up.
   *
   * With motion the word takes its own time to draw. Without motion there is
   * no draw — but the screen must still last long enough to be *read*, not
   * flashed: skipping the animation used to cut the whole greeting down to the
   * 620ms hold, which is shorter than it takes to focus on a word. The floor
   * is what a static greeting needs to register.
   */
  const drawMs = reduced
    ? 0
    : (letters.length * LETTER_STAGGER + LETTER_DURATION) * 1000;
  const total = Math.max(drawMs + holdMs, REDUCED_MIN_MS);

  // The greeting is a fixed-length prologue, not a loading state: it ends when
  // the word has been drawn and held, whether or not the provider has answered,
  // so the sign-in page is never blocked behind the network.
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
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden"
      // The shell paints the backdrop behind this layer, so the greeting is
      // read over the same gradient the launcher keeps. An opaque sheet here
      // was the alternative; it made the first frame of the product the only
      // frame without its colour field.
      style={{
        background:
          "radial-gradient(120% 100% at 50% 42%, rgba(8,9,12,0.72), rgba(8,9,12,0.94) 70%)",
      }}
    >
      {/* The word, in the display face at a size that owns the screen. The
          letters are clipped individually so the rise does not require a
          different mask per glyph. */}
      <span
        aria-label={word}
        className="text-foreground flex items-baseline overflow-hidden font-sans text-[13vw] leading-[0.95] font-semibold tracking-[-0.055em] select-none sm:text-[104px]"
      >
        {letters.map((letter, index) => (
          <m.span
            key={`${letter}-${index}`}
            aria-hidden="true"
            initial={reduced ? false : { y: "110%", opacity: 0 }}
            animate={{ y: "0%", opacity: 1 }}
            transition={{
              delay: index * LETTER_STAGGER,
              duration: LETTER_DURATION,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="inline-block will-change-transform"
          >
            {letter}
          </m.span>
        ))}
      </span>

      {/* A hairline that draws itself under the word, then the product name
          fading up under it. Two lines of motion instead of a spinner: the
          screen says "starting" without a control that looks clickable. */}
      <m.span
        aria-hidden="true"
        initial={reduced ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{
          delay: RULE_DELAY + letters.length * LETTER_STAGGER * 0.55,
          duration: RULE_DURATION,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="bg-foreground/25 mt-5 h-px w-40 origin-left"
      />
      <m.p
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          delay: RULE_DELAY + letters.length * LETTER_STAGGER * 0.7 + 0.15,
          duration: 0.5,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="text-muted-foreground mt-4 text-xs font-medium tracking-[0.24em] uppercase"
      >
        {brand.name}
      </m.p>
    </m.div>
  );
}
