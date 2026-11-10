import type { GradientConfig } from "hazeglow";

/**
 * Backdrop themes.
 *
 * A theme is a complete shader config plus the two things the CSS layer needs
 * to stay in step with it: the same palette (so the always-on fallback is the
 * same picture, not a different one) and a legibility floor.
 *
 * ## Why `shade`
 *
 * The haze is decoration behind glass, but the title bar sits *on* it. A bright
 * ramp — mint, sand, daylight — lifts the top of the window enough that the
 * caption buttons and the brand mark lose contrast against it, which is exactly
 * what a pale gradient did in the first pass of this design. `shade` is the
 * opacity of the `bg-background` veil painted over everything: darker themes
 * need almost none, bright ones need a third of the screen. It is a property of
 * the theme, not a global constant, because a single value that keeps a white
 * gradient readable turns a navy one into black.
 *
 * ## Why the gradients move faster than they used to
 *
 * The first implementation used `speed: 0.6` over a 90s CSS drift. On a large
 * window that is below the threshold where the eye reads motion at all — it
 * looked like a still image with a slow leak. `speed` here is 1.1–1.6, which is
 * still far from distracting but is unmistakably alive when you look at it.
 */

export interface BackdropTheme {
  id: string;
  name: string;
  /** Which end of the palette dominates; drives the swatch in settings. */
  swatch: [string, string, string];
  /** Opacity of the legibility veil over the haze. 0 = none, 1 = opaque. */
  shade: number;
  config: GradientConfig;
}

const CANVAS = "#08090c";

/** Only the parts that differ between themes; the rest is shared. */
function theme(
  id: string,
  name: string,
  palette: [string, string, string, string, string],
  settings: Partial<GradientConfig> & { shade?: number } = {},
): BackdropTheme {
  const { shade = 0.3, ...overrides } = settings;
  const [deep, warm, cool, mid, accent] = palette;
  return {
    id,
    name,
    swatch: [warm, cool, mid],
    shade,
    config: {
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
      palette: [CANVAS, deep, warm, cool, mid],
      background: CANVAS,
      mesh: [
        [0.22, 0.28, warm],
        [0.74, 0.2, cool],
        [0.5, 0.8, deep],
        [0.86, 0.62, mid],
        [0.12, 0.72, accent],
      ],
      grain: 0.35,
      motion: "drift",
      speed: 1.2,
      loop: 0,
      hover: 0,
      hoverMode: "pull",
      effect: "none",
      effectSize: 8,
      effectAmount: 0.5,
      ...overrides,
    },
  };
}

/**
 * Twelve themes, each a different ramp rather than a hue rotation of one: the
 * shapes, the motion and the number of mesh points differ too, so switching
 * reads as a different backdrop and not as a filter.
 */
export const BACKDROP_THEMES: BackdropTheme[] = [
  theme(
    "aurora",
    "Полярное сияние",
    ["#07303a", "#1ad6a0", "#2a5df0", "#3ba8d8", "#0f4d55"],
    // The default: teal and electric blue, dark enough for a light veil.
    { shade: 0.3 },
  ),
  theme(
    "lagoon",
    "Лагуна",
    ["#082435", "#2fe0c0", "#2a3fd4", "#5f7cf5", "#0d3b4a"],
    { speed: 1.1, size: [1.05, 1.0], shade: 0.32 },
  ),
  theme(
    "ember",
    "Тлеющие угли",
    ["#3a1230", "#f0883e", "#3b2fa8", "#e0507a", "#5c1f14"],
    { speed: 1.3, warp: 0.2, shade: 0.34 },
  ),
  theme(
    "moss",
    "Мшистый камень",
    ["#102b22", "#8fd14f", "#1f6f8b", "#4f8f6a", "#22402f"],
    { speed: 1.1, softness: 0.8, shade: 0.3 },
  ),
  theme(
    "dusk",
    "Сумерки",
    ["#1b1330", "#8a5cf6", "#2b3f8f", "#c05bd6", "#3a1f45"],
    { speed: 1.2, shape: "blob", shade: 0.34 },
  ),
  theme(
    "abyss",
    "Глубина",
    ["#04121f", "#1463a8", "#0a2c52", "#2b8fb5", "#061a2b"],
    // Darkest theme: almost no veil is needed, so the colour stays saturated.
    { speed: 1.0, shade: 0.16, grain: 0.28 },
  ),
  theme(
    "sunset",
    "Закат",
    ["#3d1526", "#ff7a59", "#7a3bb8", "#ffb15c", "#5c2140"],
    { speed: 1.4, shade: 0.36 },
  ),
  theme(
    "ice",
    "Ледник",
    ["#0d2233", "#9fd8f2", "#3f6fb5", "#cfeeff", "#1b3c52"],
    // Pale ramp: the veil has to do real work here, see the note above.
    { speed: 1.1, shade: 0.44, grain: 0.25 },
  ),
  theme(
    "neon",
    "Неон",
    ["#120726", "#ff2fb3", "#2f6bff", "#25e8d0", "#2a0b45"],
    { speed: 1.6, warp: 0.24, grain: 0.42, shade: 0.38 },
  ),
  theme(
    "sand",
    "Тёплый песок",
    ["#2a1f14", "#e8c07a", "#a86b3c", "#f5e3c0", "#3d2c1b"],
    { speed: 1.0, shade: 0.46, softness: 0.85 },
  ),
  theme(
    "cobalt",
    "Кобальт",
    ["#0a1230", "#3d7bff", "#12245c", "#7aa8ff", "#131c3d"],
    { speed: 1.25, shape: "band", angle: 45, shade: 0.28 },
  ),
  theme(
    "forest",
    "Ночной лес",
    ["#0b1a12", "#3fa86b", "#154034", "#8fd6a0", "#12271b"],
    { speed: 1.15, shade: 0.26 },
  ),
];

export const DEFAULT_BACKDROP_ID = "aurora";

export function backdropTheme(id: string | null | undefined): BackdropTheme {
  return BACKDROP_THEMES.find((entry) => entry.id === id) ?? BACKDROP_THEMES[0];
}

/**
 * The CSS stand-in, generated from a theme's own palette.
 *
 * It is not a second design: same five stops, same positions, painted with
 * radial gradients instead of a shader. On a machine without WebGL2 — or with
 * reduced motion, where the shader still paints one frame but the CSS drift
 * stops — this is what the player sees, and it has to be the theme they chose.
 */
export function backdropField(theme: BackdropTheme): string {
  const { palette, mesh } = theme.config;
  const [, deep, warm, cool, mid] = palette;
  const alpha = (colour: string, a: number) => `${colour}${hexAlpha(a)}`;
  return (
    `radial-gradient(120% 95% at ${mesh[0][0] * 100}% ${mesh[0][1] * 100}%, ${alpha(warm, 0.5)}, transparent 58%),` +
    `radial-gradient(105% 90% at ${mesh[1][0] * 100}% ${mesh[1][1] * 100}%, ${alpha(cool, 0.55)}, transparent 58%),` +
    `radial-gradient(95% 80% at ${mesh[2][0] * 100}% ${mesh[2][1] * 100}%, ${alpha(deep, 0.8)}, transparent 62%),` +
    `radial-gradient(70% 65% at 45% 60%, ${alpha(mid, 0.3)}, transparent 70%)`
  );
}

function hexAlpha(alpha: number): string {
  return Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
}
