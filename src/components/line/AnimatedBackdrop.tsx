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

/** The haze, expressed in the theme's own tokens. */
const CANVAS = "#08090c";
const ACCENT = "#2fbf71";
const HAZE_DEEP = "#0f3d2a";
const HAZE_COOL = "#0d2a3d";

const BASE_CONFIG: GradientConfig = {
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
  palette: [CANVAS, HAZE_DEEP, ACCENT, HAZE_COOL],
  background: CANVAS,
  mesh: [
    [0.22, 0.3, ACCENT],
    [0.72, 0.24, HAZE_COOL],
    [0.5, 0.78, HAZE_DEEP],
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

const STILL: GradientConfig = { ...BASE_CONFIG, motion: "none" };

/**
 * The always-on colour field. Same four palette stops as the mesh, arranged as
 * broad off-centre pools so the page has a light and a dark corner: that is
 * what gives the glass panels an edge to sit against. Static on purpose — the
 * motion is the shader's job, and this layer has to work on every machine.
 */
const HAZE_FIELD =
  "radial-gradient(120% 95% at 10% 2%, rgba(47,191,113,0.46), transparent 58%)," +
  "radial-gradient(105% 90% at 92% 96%, rgba(24,84,120,0.5), transparent 58%)," +
  "radial-gradient(95% 80% at 82% 10%, rgba(15,61,42,0.75), transparent 62%)";

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

  // Follow the preference live: someone who turns it on mid-session should not
  // have to restart the launcher for the page to settle.
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const config = reduced ? STILL : BASE_CONFIG;

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
      {/* Always-on colour: plain CSS, no GPU required. */}
      <div
        className="absolute inset-0"
        style={{ backgroundImage: HAZE_FIELD }}
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
      <div className="bg-background/35 absolute inset-0" />
    </div>
  );
}
