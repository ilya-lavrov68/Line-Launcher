import { Component, useEffect, useState, type ReactNode } from "react";
import { Hazeglow, type GradientConfig } from "hazeglow";

/**
 * Animated page backdrop.
 *
 * The launcher's chrome is glass, so it needs something behind it: a flat
 * `#08090c` left every panel invisible (1.05:1 against the page) and made the
 * window read as an empty console.
 *
 * It is built in two layers on purpose. The colour field below is plain CSS and
 * always present — on a software rasteriser, on a driver Chrome refuses as a
 * "major performance caveat", or on a machine whose GPU process dies, the page
 * still has colour. The WebGL haze is added on top and only when the machine
 * can actually draw it; hazeglow refuses software renderers outright (it checks
 * for swiftshader/llvmpipe), so anything that depends on the canvas would leave
 * those users with an empty window.
 *
 * Rules it has to keep:
 *  - The palette is the project's own. The mesh points are the canvas, the
 *    accent, and the two haze steps between them; no new hues.
 *  - It never animates for someone who asked for reduced motion: the config is
 *    frozen at `motion: "none"` and the shader stops at the frame it has.
 *  - It stops when the window is hidden, so a minimised launcher is not a
 *    lap warmer.
 *  - Without WebGL2 it renders nothing and the page keeps its flat colour, so
 *    the app is never broken by decoration. The same holds when a driver
 *    accepts the context and then fails inside the shader: a thrown error in
 *    the canvas used to unmount the whole window and leave a black screen, so
 *    the effect is fenced off in its own error boundary.
 */

/** The haze, expressed as a named ramp. */
const CANVAS = "#08090c";

/**
 * The colour ramp behind the window.
 *
 * A palette is a *ramp*, not two hues. The page has a warm corner, a cool
 * corner and a green that means "the brand", and they meet in the middle
 * rather than sitting in separate circles: that is what makes the backdrop
 * read as light falling across a surface instead of three stains on black.
 *
 * `pool` is the always-on CSS layer — it has to survive without WebGL, so it is
 * written as plain radial gradients in the same order (warm, cool, deep). The
 * shader mesh gets the same three points, so adding colour to one adds it to
 * both and the transition between them is not a visible seam.
 *
 * Chosen by rendering all four over the real UI rather than by picking hex
 * values in isolation — see the notes in `docs/` if the palette is ever
 * revisited: a ramp that looks rich on its own turns to mud under 45%-opaque
 * glass, and one that looks tasteful there tends to be a single hue.
 */
export interface HazeRamp {
  id: string;
  /** Warm pool, upper left. */
  warm: string;
  /** Cool pool, lower right. */
  cool: string;
  /** Deep green pooling under the warm one — the brand's own dark step. */
  deep: string;
  /** Mid-tone that keeps the two pools from meeting as a hard line. */
  mid: string;
  /** Haze opacity budget for the CSS layer; 1 = as written. */
  strength: number;
}

export const HAZE_RAMPS: HazeRamp[] = [
  {
    id: "aurora",
    warm: "#1ad6a0",
    cool: "#2a5df0",
    deep: "#07303a",
    mid: "#3ba8d8",
    strength: 1,
  },
  {
    id: "ember",
    warm: "#f0883e",
    cool: "#3b2fa8",
    deep: "#3a1230",
    mid: "#e0507a",
    strength: 1,
  },
  {
    id: "lagoon",
    warm: "#2fe0c0",
    cool: "#2a3fd4",
    deep: "#082435",
    mid: "#5f7cf5",
    strength: 1,
  },
  {
    id: "moss",
    warm: "#8fd14f",
    cool: "#1f6f8b",
    deep: "#102b22",
    mid: "#4f8f6a",
    strength: 1,
  },
];

/**
 * The ramp the app ships, overridable for experiments without a code edit:
 *
 *     VITE_LINE_HAZE=ember npm run dev
 *
 * The build-time default is deliberately a constant rather than a preference:
 * like the design theme, the palette is part of the look, not a setting, and
 * the shipped window exposes no control that changes it under the player.
 */
const RAMP_ID: string =
  (import.meta.env as { VITE_LINE_HAZE?: string } | undefined)
    ?.VITE_LINE_HAZE ?? "aurora";

/** A ramp → shader config. Same three points as the CSS layer, same order. */
function backdropConfig(ramp: HazeRamp): GradientConfig {
  return {
    version: 1,
    seed: 7,
    shape: "mesh",
    center: [0.5, 0.45],
    size: [0.95, 0.9],
    roundness: 0.7,
    softness: 0.7,
    rotation: 0,
    rampDirection: 0.9,
    angle: 90,
    warp: 0.12,
    warpScale: 1,
    palette: [CANVAS, ramp.deep, ramp.warm, ramp.cool, ramp.mid],
    background: CANVAS,
    mesh: [
      [0.22, 0.3, ramp.warm],
      [0.72, 0.24, ramp.cool],
      [0.5, 0.78, ramp.deep],
      [0.86, 0.62, ramp.mid],
    ],
    grain: 0.35,
    motion: "drift",
    speed: 0.6,
    loop: 0,
    hover: 0,
    hoverMode: "pull",
    effect: "none",
    effectSize: 8,
    effectAmount: 0.5,
  };
}

/**
 * The always-on colour field. Same stops as the mesh, arranged as broad
 * off-centre pools so the page has a light and a dark corner — that is what
 * gives the glass panels an edge to sit against.
 *
 * This used to be a static image. It is now generated per ramp from three
 * radial gradients, and the *movement* comes from a sibling layer in the
 * stylesheet (`[data-line-haze]`): a 90s background-position drift, two of
 * them, out of phase. Two layers of plain CSS animation cost nothing on the
 * GPU, survive without WebGL, keep working under a software rasteriser, and
 * honour `prefers-reduced-motion` — which the previous static field could not
 * do at all. That is the difference between "a dark page with a hint of green"
 * and a backdrop that is alive.
 */
function hazeField(ramp: HazeRamp): string {
  const a = (alpha: number) =>
    Math.round(Math.min(1, alpha * ramp.strength) * 255)
      .toString(16)
      .padStart(2, "0");
  const pool = (colour: string, alpha: number) => `${colour}${a(alpha)}`;
  return (
    `radial-gradient(120% 95% at 10% 2%, ${pool(ramp.warm, 0.5)}, transparent 58%),` +
    `radial-gradient(105% 90% at 92% 96%, ${pool(ramp.cool, 0.55)}, transparent 58%),` +
    `radial-gradient(95% 80% at 82% 10%, ${pool(ramp.deep, 0.8)}, transparent 62%),` +
    `radial-gradient(70% 65% at 45% 60%, ${pool(ramp.mid, 0.32)}, transparent 70%)`
  );
}

export interface AnimatedBackdropProps {
  /**
   * The provider's own image, when there is one. Its colours are not sampled —
   * the mesh stays on the brand ramp — but it fades in behind the haze so the
   * page is tinted by the server the player is looking at.
   */
  imageUrl?: string;
  className?: string;
}

/**
 * One-shot capability probe. A browser that cannot create a WebGL2 context
 * gets the flat canvas and never pays for the shader.
 */
function hasWebgl2(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decoration fails closed. If the shader throws after the context was handed
 * out — old drivers, a lost GPU process, a headless browser without a real
 * rasteriser — the window keeps its flat background instead of turning black.
 */
class BackdropBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Visible in devtools, never in the player's face.
    console.warn("[backdrop] falling back to the flat canvas:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function AnimatedBackdrop({
  imageUrl,
  className,
}: AnimatedBackdropProps) {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const [supported, setSupported] = useState(hasWebgl2);
  const ramp =
    HAZE_RAMPS.find((entry) => entry.id === RAMP_ID) ?? HAZE_RAMPS[0];

  // Follow the preference live: someone who turns it on mid-session should not
  // have to restart the launcher for the page to settle.
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const config = reduced
    ? { ...backdropConfig(ramp), motion: "none" as const }
    : backdropConfig(ramp);

  return (
    <div
      aria-hidden="true"
      data-line-backdrop
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ""}`}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-3xl"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : null}
      {/* Always-on colour: plain CSS, no GPU required. `data-line-haze`
          picks up the slow drift from themes.css; the second layer is the same
          field rotated, so the two never line up and the page breathes. */}
      <div
        data-line-haze
        className="absolute -inset-[20%]"
        style={{ backgroundImage: hazeField(ramp) }}
      />
      {/* The animated layer, only where it can actually be drawn. It is
          composited over the field above, so removing it never changes the
          page's overall colour — only whether it moves. */}
      {supported && (
        <BackdropBoundary>
          <Hazeglow
            config={config}
            className="absolute inset-0 h-full w-full mix-blend-screen"
            onUnsupported={() => setSupported(false)}
          />
        </BackdropBoundary>
      )}
      {/* A legibility floor: the artwork never touches text directly. Without
          it, muted body copy drops under 4.5:1 over the bright part of the
          haze. */}
      <div className="bg-background/30 absolute inset-0" />
    </div>
  );
}
