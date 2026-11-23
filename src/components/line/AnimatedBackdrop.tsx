import {
  Component,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  backdropField,
  backdropTheme,
  type BackdropTheme,
} from "@/lib/line/backdrops";

/**
 * Animated page backdrop.
 *
 * The launcher's chrome is frosted glass, so it needs something behind it: a
 * flat `#08090c` left every panel invisible (1.05:1 against the page) and made
 * the window read as an empty console.
 *
 * It is built in three layers on purpose.
 *
 *  1. The colour field — plain CSS generated from the theme's own palette.
 *     Always present: on a software rasteriser, on a driver Chrome refuses as a
 *     "major performance caveat", or on a machine whose GPU process dies, the
 *     page still has the colour the player picked. It drifts slowly on its own
 *     (see `[data-line-haze]` in index.css).
 *  2. The WebGL haze on top, only when the machine can actually draw it.
 *     hazeglow refuses software renderers outright, so anything that depends on
 *     the canvas would leave those users with an empty window.
 *  3. A legibility veil whose strength is a property of the theme. Bright ramps
 *     lift the top of the window enough that the
 *     title bar's caption buttons stop reading against it; dark ones need
 *     almost nothing. One global value cannot serve both.
 *
 * ## Why the shader is not in the startup bundle
 *
 * The haze is decoration, and the first seconds of the process are the ones the
 * player waits through. `hazeglow` pulls a WebGL renderer and its own config
 * normaliser in with it, and importing it eagerly put all of that in front of
 * the first paint — the greeting and the sign-in card waited for a shader to
 * arrive before they could be shown. It is now a dynamic import started *after*
 * the first frame has painted (and only when WebGL2 exists at all): the CSS
 * colour field is already on screen, so the canvas can load alongside the
 * greeting instead of holding the page back.
 *
 * ## Switching themes smoothly
 *
 * hazeglow re-renders the shader the moment its `config` prop changes — it
 * assigns the new config to a ref and renders one frame, with no tween between
 * two configs. Crossfading in the *renderer* is therefore not available, so the
 * component keeps two stacked canvases: the outgoing theme stays on the layer
 * underneath while the incoming one fades in over it. The old layer is kept
 * mounted (not unmounted) until its 600ms fade has finished, which is what makes
 * the change read as a dissolve rather than a cut.
 *
 * Rules it has to keep:
 *  - The palette is the theme's own. No hue is invented in the component.
 *  - It never animates for someone who asked for reduced motion: the shader is
 *    frozen and the CSS drift is disabled, but the colour stays.
 *  - It stops when the window is hidden, so a minimised launcher is not a lap
 *    warmer.
 *  - Without WebGL2 it renders nothing and the page keeps its CSS colour, so the
 *    app is never broken by decoration. The same holds when a driver accepts the
 *    context and then fails inside the shader: a thrown error in the canvas used
 *    to unmount the whole window, so the effect is fenced off in its own
 *    boundary.
 */

/** How long the old theme stays underneath while the new one fades in. */
const CROSSFADE_MS = 600;

type ShaderComponent = ComponentType<{
  config: BackdropTheme["config"];
  className?: string;
  onUnsupported?: () => void;
}>;

// This was previously painted only by WelcomeScreen and faded out with the
// greeting, washing the colours out when the rest of the interface appeared.
// Keep the same dark wash behind *all* screens so the intro's colour persists.
const BACKDROP_WASH =
  "radial-gradient(120% 100% at 50% 42%, rgba(8,9,12,0.28), rgba(8,9,12,0.52) 78%)";

export interface AnimatedBackdropProps {
  /**
   * The provider's own image, when there is one. Its colours are not sampled —
   * the mesh stays on the theme's ramp — but it fades in behind the haze so the
   * page is tinted by the server the player is looking at.
   */
  imageUrl?: string;
  /** Theme id from `BACKDROP_THEMES`; unknown ids fall back to the default. */
  themeId?: string;
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

/**
 * One shader layer. Keyed by theme id, so a switch mounts a *new* element while
 * the old one is still in the tree.
 *
 * The incoming layer starts transparent and is raised to full opacity on the
 * next frame. That one-frame gap is what makes the change visible at all: if the
 * element mounted already opaque, React would commit both layers in the same
 * paint and the switch would read as a cut, not a dissolve. Setting it in an
 * effect (not a timer inside the style) also means the browser has a real
 * starting value to interpolate from.
 *
 * `Hazeglow` arrives through a dynamic import started after the first paint,
 * so the renderer is not part of the startup bundle. This component renders
 * nothing until the chunk has landed, and the CSS field underneath is what the
 * player sees until then. A chunk that never arrives (offline dev server, a
 * broken cache) simply leaves the CSS field in place — the same fallback as a
 * driver that refuses the context.
 */
function HazeLayer({
  theme,
  enter,
  exit,
  reduced,
  Shader,
  onUnsupported,
}: {
  theme: BackdropTheme;
  /** True for the newest layer, which fades in. */
  enter: boolean;
  /** Outgoing layers fade away beneath the incoming theme. */
  exit: boolean;
  reduced: boolean;
  Shader: ShaderComponent | null;
  onUnsupported: () => void;
}) {
  const [shown, setShown] = useState(!enter);

  useEffect(() => {
    if (!enter) {
      setShown(true);
      return;
    }
    // Two frames: React commits, then the browser paints the transparent state,
    // and only after that is there something to transition away from.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [enter]);

  return (
    <div
      className="absolute inset-0 transition-opacity ease-out"
      style={{
        opacity: exit ? 0 : shown ? 1 : 0,
        transitionDuration: reduced ? "0ms" : `${CROSSFADE_MS}ms`,
      }}
      aria-hidden="true"
    >
      {Shader ? (
        <Shader
          config={reduced ? { ...theme.config, motion: "none" } : theme.config}
          className="h-full w-full mix-blend-screen"
          onUnsupported={onUnsupported}
        />
      ) : null}
    </div>
  );
}

export default function AnimatedBackdrop({
  imageUrl,
  themeId,
  className,
}: AnimatedBackdropProps) {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  const [supported, setSupported] = useState(hasWebgl2);
  // Keep the heavy shader out of the first paint, but start downloading its
  // chunk immediately after that paint. This puts WebGL work alongside the
  // welcome stroke instead of hundreds of milliseconds after it.
  const [hazeReady, setHazeReady] = useState(false);
  const [Shader, setShader] = useState<ShaderComponent | null>(null);

  const active = backdropTheme(themeId);
  // `layers` holds the theme currently painted plus, during a switch, the one
  // fading out underneath it. The newest entry is always on top.
  const [layers, setLayers] = useState<BackdropTheme[]>([active]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => setHazeReady(true));
    void import("hazeglow")
      .then((module) => {
        if (!cancelled) setShader(() => module.Hazeglow);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [supported]);

  // Follow the preference live: someone who turns it on mid-session should not
  // have to restart the launcher for the page to settle.
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Keep the newest theme on top and let the previous one fade out.
  useEffect(() => {
    setLayers((previous) => {
      if (previous[previous.length - 1]?.id === active.id) return previous;
      return [...previous.slice(-1), active];
    });
  }, [active]);

  // Drop the outgoing layer once its fade has finished. Doing it on a timer
  // rather than on `transitionend` keeps this working when the shader rejects
  // the renderer and the wrapper never actually animates.
  useEffect(() => {
    if (layers.length < 2) return;
    const timer = setTimeout(
      () =>
        setLayers((previous) =>
          previous.length > 1 ? previous.slice(-1) : previous,
        ),
      CROSSFADE_MS,
    );
    return () => clearTimeout(timer);
  }, [layers]);

  const field = backdropField(active);

  return (
    <div
      aria-hidden="true"
      data-line-backdrop
      data-line-backdrop-theme={active.id}
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
      {/* Always-on colour: plain CSS, no GPU required. Keyed by theme so the
          CSS field crossfades together with the shader instead of snapping. */}
      <div
        key={active.id}
        data-line-haze
        className="absolute -inset-[20%] transition-opacity duration-500 ease-out"
        style={{
          backgroundImage: field,
          // The theme's own veil is folded into the layer's colour budget
          // rather than applied twice.
          opacity: 0.9,
        }}
      />
      {/* The animated layers, only where they can actually be drawn — and only
          after the first paint, so the shader never delays it. */}
      {supported && hazeReady && (
        <BackdropBoundary>
          {layers.map((layer, index) => (
            <HazeLayer
              key={layer.id}
              theme={layer}
              // The incoming layer fades in while its predecessor fades out;
              // the timer below keeps both mounted for the full transition.
              enter={index === layers.length - 1 && layers.length > 1}
              exit={index < layers.length - 1}
              reduced={reduced}
              Shader={Shader}
              onUnsupported={() => setSupported(false)}
            />
          ))}
        </BackdropBoundary>
      )}
      {/* A legibility floor: the artwork never touches text directly. Without
          it, muted body copy drops under 4.5:1 over the bright part of the
          haze. Its strength comes from the theme — see `shade` in backdrops.ts. */}
      <div
        className="bg-background absolute inset-0 transition-opacity duration-500 ease-out"
        style={{ opacity: active.shade }}
      />
      <div
        data-line-backdrop-wash
        className="absolute inset-0"
        style={{ background: BACKDROP_WASH }}
      />
    </div>
  );
}
