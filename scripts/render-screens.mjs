// Draws the README screenshots without a browser.
//
//   node scripts/render-screens.mjs            # writes .offline-shots/line-*.png
//   node scripts/render-screens.mjs --check    # fails if any image is missing
//   SHOTS_DIR=/tmp/out node scripts/render-screens.mjs
//
// Why this exists: `npm run screenshots` renders the real app through
// playwright-core and is the source of truth. It needs Chrome/Edge, which some
// build machines (and CI containers without libnss) do not have. This script is
// a deterministic approximation: colours are read from `src/index.css`,
// the same tokens the app renders with, and every screen is laid out at one fixed
// size (1280x800) so the gallery never mixes tall and short images again.
//
// It draws the *current* design (`data-theme="line"`). The old design is
// reachable in the app; the README only shows what a new user sees.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Where the vector renders go.
 *
 * Deliberately NOT `docs/images`: that folder is the README gallery, and it
 * belongs to `scripts/screenshots.mjs`, which photographs the real components in
 * a browser. The two writers used to share the path, so running the offline
 * renderer — the fallback for machines with no browser — silently replaced every
 * real screenshot with a token-drawn approximation: the settings page lost its
 * language section, labels drifted, and the gallery began showing a design the
 * app does not have. The fallback now has its own folder and overwrites nothing.
 */
const outDir = path.resolve(
  process.env.SHOTS_DIR || path.join(root, ".offline-shots"),
);
const checkOnly = process.argv.includes("--check");

/** Every screenshot has the same body size; the poster swaps per screen. */
export const SHOT_WIDTH = 1280;
export const SHOT_HEIGHT = 800;

// `let` first: a bare destructuring assignment to undeclared names is a syntax
// error in a module, not a runtime one.
let createCanvas;
let GlobalFonts;
try {
  ({ createCanvas, GlobalFonts } = await import("@napi-rs/canvas"));
} catch {
  console.error(
    "Нет @napi-rs/canvas. Он нужен только офлайн-рендеру: npm i -D @napi-rs/canvas\n" +
      "Либо снимите настоящие скриншоты браузером: npm run screenshots",
  );
  process.exit(2);
}

// ───────────────────────────── tokens ─────────────────────────────

/** Converts `oklch(L C H)` / `oklch(L C H / a)` to [r, g, b, a]. */
export function oklchToRgba(value) {
  const match =
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, rawL, rawC, rawH, rawA] = match;
  const L = rawL.endsWith("%") ? Number(rawL.slice(0, -1)) / 100 : Number(rawL);
  const C = Number(rawC);
  const H = Number(rawH);
  const a = rawA
    ? rawA.endsWith("%")
      ? Number(rawA.slice(0, -1)) / 100
      : Number(rawA)
    : 1;
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const gamma = (x) =>
    x <= 0.0031308
      ? 12.92 * x
      : 1.055 * Math.min(1, Math.max(0, x)) ** (1 / 2.4) - 0.055;
  return [
    Math.round(Math.min(1, Math.max(0, gamma(lr))) * 255),
    Math.round(Math.min(1, Math.max(0, gamma(lg))) * 255),
    Math.round(Math.min(1, Math.max(0, gamma(lb))) * 255),
    a,
  ];
}

/** `rgba(255, 255, 255, 0.06)`, `#0a0a0a`, `oklch(…)`, `color-mix(…)`. */
export function parseColor(value) {
  const text = value.trim();
  if (text.startsWith("oklch(")) return oklchToRgba(text);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    const full =
      digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const rgba =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(
      text,
    );
  if (rgba) {
    return [
      Number(rgba[1]),
      Number(rgba[2]),
      Number(rgba[3]),
      rgba[4] === undefined ? 1 : Number(rgba[4]),
    ];
  }
  return null;
}

const css = (file) => readFileSync(path.join(root, file), "utf8");

/** The palette block from index.css, resolved through `var()`. */
export function loadTokens() {
  const sheet = css("src/index.css");
  /** Declarations inside the block that opens at `selector`. */
  const readBlock = (selector, from = 0) => {
    const start = sheet.indexOf(selector, from);
    if (start < 0) throw new Error(`index.css: не найден блок ${selector}`);
    const open = sheet.indexOf("{", start);
    const close = sheet.indexOf("\n}", open);
    const found = new Map();
    for (const line of sheet.slice(open, close).split("\n")) {
      const decl = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line);
      if (decl) found.set(decl[1], decl[2].trim());
    }
    return found;
  };
  // One `:root` holds the whole palette and the additive ladder (--fill*,
  // --surface-glass, --radius-*). It used to be two blocks in two files, and
  // reading only one of them silently resolved every token to the white
  // fallback — white cards on a dark page.
  const raw = new Map([...readBlock(":root {")]);
  // The dark palette is only what the *canvas* paints. Every panel is a
  // `[data-line-glass]` sheet, and that rule re-points most of the palette
  // (`--foreground`, `--fill*`, `--border`, `--primary`…) for its own subtree.
  // Reading `:root` alone drew a design the app does not ship: white frost with
  // ink meant for black panels. Read the glass rules too and let them win, the
  // way the cascade does.
  const readRule = (selector) => {
    const start = sheet.indexOf(selector);
    if (start < 0) throw new Error(`index.css: не найден блок ${selector}`);
    const open = sheet.indexOf("{", start);
    const close = sheet.indexOf("\n  }", open);
    const found = new Map();
    for (const line of sheet.slice(open, close).split("\n")) {
      const decl = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line);
      if (decl) found.set(decl[1], decl[2].trim());
    }
    return found;
  };
  const resolveRoot = (name, depth = 0) => {
    const value = raw.get(name);
    if (!value || depth > 6) return value ?? "";
    const ref = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/.exec(value);
    if (!ref) return value;
    return resolveRoot(ref[1], depth + 1) || ref[2] || "";
  };
  const canvasInk = parseColor(resolveRoot("--foreground")) ?? [
    255, 255, 255, 1,
  ];
  const canvasInkSoft = parseColor(resolveRoot("--muted-foreground")) ?? [
    255, 255, 255, 1,
  ];
  for (const rule of ["[data-line-glass] {", '[data-line-glass="raised"] {']) {
    for (const [name, value] of readRule(rule)) raw.set(name, value);
  }
  const resolve = (name, depth = 0) => {
    const value = raw.get(name);
    if (!value || depth > 6) return value ?? "";
    const ref = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/.exec(value);
    if (!ref) return value;
    return resolve(ref[1], depth + 1) || ref[2] || "";
  };
  const color = (name) => parseColor(resolve(name)) ?? [255, 255, 255, 1];
  return {
    background: color("--background"),
    // `--line-canvas` is `#08090c`: one flat value under the backdrop.
    canvas: color("--line-canvas"),
    foreground: color("--foreground"),
    mutedForeground: color("--muted-foreground"),
    primary: color("--primary"),
    primaryForeground: color("--primary-foreground"),
    border: color("--border"),
    input: color("--input"),
    fill: color("--fill"),
    fillSubtle: color("--fill-subtle"),
    fillHover: color("--fill-hover"),
    surfaceGlass: color("--surface-glass"),
    // The two shell tiles are the pale ones; everything nested keeps the dark
    // pane above. Read as a pair so the renderer cannot drift from the CSS.
    surfaceShellGlass: color("--surface-shell-glass"),
    online: color("--line-online"),
    update: color("--line-update"),
    offline: color("--line-offline"),
    destructive: color("--destructive"),
    sidebar: color("--sidebar"),
    // Light ink for the strips that sit on the dark canvas, not on frost.
    canvasInk,
    canvasInkSoft,
    popover: color("--popover"),
  };
}

const T = loadTokens();

/** `#rrggbb` (without the hash) → the [r,g,b,a] tuple `rgba()` expects. */
const hexRgb = (value) => {
  const full =
    value.length === 3 ? [...value].map((d) => d + d).join("") : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
    1,
  ];
};

const rgba = ([r, g, b, a = 1], alpha = 1) =>
  `rgba(${r},${g},${b},${(a * alpha).toFixed(3)})`;
const mix = ([r1, g1, b1, a1 = 1], [r2, g2, b2, a2 = 1], t) => [
  Math.round(r1 + (r2 - r1) * t),
  Math.round(g1 + (g2 - g1) * t),
  Math.round(b1 + (b2 - b1) * t),
  a1 + (a2 - a1) * t,
];

// ───────────────────────────── font ─────────────────────────────

/**
 * Geist as TTF, not the woff2 the app ships.
 *
 * @napi-rs/canvas accepts a woff2 path without complaining and then quietly
 * falls back to a default face, so every measurement in the layout is wrong
 * while the registration looks successful. The TTFs in `scripts/fonts/` are the
 * same font (SIL OFL, see `LICENSES/Geist-OFL.txt`) in a format the rasteriser
 * reads.
 *
 * They are two subsets — Latin and Cyrillic — so they are registered as two
 * families and used as one stack: the canvas falls back per missing glyph, which
 * is how «Survival» and «Гардероб» both end up in Geist.
 */
const FONT_FILES = [
  ["geist-cyrillic-wght-normal.ttf", "Line UI Cyrillic"],
  ["geist-latin-wght-normal.ttf", "Line UI Latin"],
  // The greeting's handwriting face, converted from the woff2 the app ships
  // (SIL OFL, see `LICENSES/Pacifico-OFL.txt`) for the same reason as Geist.
  ["pacifico-latin-400-normal.ttf", "Line Hand"],
];
const FONT_NAMES = FONT_FILES.map(([, family]) => `"${family}"`);
const FONT = FONT_NAMES.join(", ");
function loadFont() {
  let loaded = 0;
  for (const [file, family] of FONT_FILES) {
    try {
      GlobalFonts.registerFromPath(
        path.join(root, "scripts/fonts", file),
        family,
      );
      loaded += 1;
    } catch {
      // Missing files are not fatal: DejaVu is the last-resort fallback.
    }
  }
  return loaded > 0;
}
loadFont();
const font = (size, weight = 400) =>
  `${weight} ${size}px ${FONT}, "DejaVu Sans", sans-serif`;

// ───────────────────────────── drawing ─────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function fillRound(ctx, x, y, w, h, r, fill) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokeRound(ctx, x, y, w, h, r, stroke, width = 1) {
  roundRect(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Wraps at word boundaries; returns the drawn line count. */
function text(ctx, value, x, y, options = {}) {
  const {
    size = 13,
    weight = 400,
    color = rgba(T.foreground),
    align = "left",
    maxWidth = 0,
    lineHeight = size * 1.45,
    mono = false,
    letterSpacing = 0,
    maxLines = 0,
  } = options;
  ctx.font = mono
    ? `${size}px "DejaVu Sans Mono", monospace`
    : font(size, weight);
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  const words = String(value).split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (maxWidth && ctx.measureText(next).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  // A description that would overflow the card is clipped by CSS; the render
  // has to clip it too, or the shot shows text the app never draws.
  const shown = maxLines ? lines.slice(0, maxLines) : lines;
  shown.forEach((line, index) => {
    const drawX =
      align === "center"
        ? x - ctx.measureText(line).width / 2
        : align === "right"
          ? x - ctx.measureText(line).width
          : x;
    ctx.fillText(
      line,
      drawX + letterSpacing * index * 0,
      y + index * lineHeight,
    );
  });
  return shown.length;
}

function measure(ctx, value, size, weight = 400, mono = false) {
  // The mono stack is narrower than the proportional one; measuring a mono run
  // with the sans font overestimates it and the following text collides.
  ctx.font = mono
    ? `${size}px "DejaVu Sans Mono", monospace`
    : font(size, weight);
  return ctx.measureText(value).width;
}

/** Lucide-shaped stroke icons (24x24 grid), enough for the documented screens. */
const ICONS = {
  server: "M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01",
  shirt:
    "M20.4 6.3 16 4a4 4 0 0 1-8 0L3.6 6.3a2 2 0 0 0-.9 2.7l1.5 3.1 2.3-1.1V20h11v-9l2.3 1.1 1.5-3.1a2 2 0 0 0-.9-2.7Z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01",
  chevron: "M15 18l-6-6 6-6",
  chevronDown: "M6 9l6 6 6-6",
  play: "M6 3l14 9-14 9z",
  history: "M3 3v5h5M3.05 13a9 9 0 1 0 2.1-6.4L3 8M12 7v5l4 2",
  check: "M20 6 9 17l-5-5",
  wifi: "M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 9.5a15 15 0 0 1 20 0M12 20h.01",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  sparkles:
    "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  minus: "M5 12h14",
  square: "M5 5h14v14H5z",
  x: "M6 6l12 12M18 6 6 18",
  arrow: "M5 12h14M13 6l6 6-6 6",
  memory: "M6 4h12v16H6zM10 4v16M14 4v16",
  monitor: "M4 4h16v12H4zM8 20h8M12 16v4",
  trash: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13",
  palette:
    "M12 21a9 9 0 1 1 0-18c4.5 0 8 3 8 6.5 0 2.5-2 4.5-4.5 4.5H14a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 21Z",
  cpu: "M6 6h12v12H6zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3",
  folder: "M3 7h6l2 2h10v10H3z",
  image:
    "M3 5h18v14H3zM8 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM21 15l-5-5L5 19",
};

/**
 * The brand mark, read from `branding/assets/logo.svg`.
 *
 * The screenshots used to carry a hand-drawn "L" bracket instead, which is not
 * the artwork the window renders — the guide showed a logo the launcher does not
 * have. The path and its viewBox are read from the same file the app imports, so
 * replacing the logo replaces it in the guide too.
 */
const BRAND_LOGO = (() => {
  const file = readFileSync(
    path.resolve(root, "branding/assets/logo.svg"),
    "utf8",
  );
  const viewBox = /viewBox="([^"]+)"/.exec(file)?.[1]?.split(/\s+/).map(Number);
  const d = /<path\b[^>]*\bd="([^"]+)"/.exec(file)?.[1];
  const fill = /<path\b[^>]*\bfill="([^"]+)"/.exec(file)?.[1];
  if (!viewBox || !d || !fill) {
    throw new Error(
      "branding/assets/logo.svg must be a single path with a viewBox and a fill",
    );
  }
  return {
    x: viewBox[0],
    y: viewBox[1],
    w: viewBox[2],
    h: viewBox[3],
    d,
    fill,
  };
})();

/** Draws the brand mark into a box, preserving its aspect ratio. */
function brandMark(ctx, x, y, size) {
  const { x: vx, y: vy, w, h, d, fill } = BRAND_LOGO;
  const scale = size / Math.max(w, h);
  ctx.save();
  // Centre the mark in the requested box; the logo is taller than it is wide.
  ctx.translate(x + (size - w * scale) / 2, y + (size - h * scale) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-vx, -vy);
  ctx.beginPath();
  tracePath(ctx, d);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}

/**
 * Minimal SVG path interpreter (M/L/H/V/C/Q/A/Z in absolute and relative
 * form). @napi-rs/canvas has no Path2D, and pulling a library in for eleven
 * 24x24 icons would be more code than this.
 */
export function tracePath(ctx, d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let i = 0;
  let x = 0;
  let y = 0;
  let command = "";
  const next = () => Number(tokens[i++]);
  const moveTo = (nx, ny) => {
    x = nx;
    y = ny;
    ctx.moveTo(x, y);
  };
  const lineTo = (nx, ny) => {
    x = nx;
    y = ny;
    ctx.lineTo(x, y);
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    const baseX = relative ? x : 0;
    const baseY = relative ? y : 0;
    switch (command.toUpperCase()) {
      case "M":
        moveTo(baseX + next(), baseY + next());
        command = relative ? "l" : "L";
        break;
      case "L":
        lineTo(baseX + next(), baseY + next());
        break;
      case "H":
        lineTo(baseX + next(), y);
        break;
      case "V":
        lineTo(x, baseY + next());
        break;
      case "C": {
        const x1 = baseX + next();
        const y1 = baseY + next();
        const x2 = baseX + next();
        const y2 = baseY + next();
        lineTo(baseX + next(), baseY + next());
        ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
        break;
      }
      case "Q": {
        const x1 = baseX + next();
        const y1 = baseY + next();
        lineTo(baseX + next(), baseY + next());
        ctx.quadraticCurveTo(x1, y1, x, y);
        break;
      }
      case "A": {
        // Arcs in these icons only ever draw near-quarter circles; a cubic with
        // the same endpoints and tangents is indistinguishable at 16px.
        const rx = next();
        const ry = next();
        next(); // rotation
        next(); // large-arc flag
        next(); // sweep flag
        const ex = baseX + next();
        const ey = baseY + next();
        ctx.ellipse(
          (x + ex) / 2,
          (y + ey) / 2,
          Math.abs(rx) / 2,
          Math.abs(ry) / 2,
          0,
          0,
          Math.PI * 2,
        );
        x = ex;
        y = ey;
        ctx.moveTo(x, y);
        break;
      }
      case "Z":
        ctx.closePath();
        break;
      default:
        i += 1;
    }
  }
}

function icon(ctx, name, x, y, size, color, width = 1.75) {
  const path = ICONS[name];
  if (!path) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = (width * 24) / size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  tracePath(ctx, path);
  if (name === "play") {
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.stroke();
  }
  ctx.restore();
}

// ───────────────────────────── shell ─────────────────────────────

function background(ctx) {
  // One flat colour, exactly like `--line-canvas`. The two accent glows that
  // used to be painted here are what made the window look hazy.
  ctx.fillStyle = rgba(T.canvas);
  ctx.fillRect(0, 0, SHOT_WIDTH, SHOT_HEIGHT);
}

function titleBar(ctx, context, trailing) {
  const h = 44;
  // Transparent, like `TitleBar`: it floats over the page's colour field and
  // nothing separates it from the content but space. The inks below are the
  // canvas palette — near-white — because this strip sits on the dark backdrop,
  // not on a glass sheet. Filling it and using the glass ink drew a black band
  // with black text on it.
  const canvasInk = rgba(T.canvasInk, 1);
  const canvasInkSoft = rgba(T.canvasInkSoft, 1);

  // The real mark from branding/assets/logo.svg — the same file the window
  // renders. It used to be a hand-drawn "L" bracket, which put a glyph in the
  // screenshots that the application never drew.
  brandMark(ctx, 16, 11, 22);

  text(ctx, "Line Launcher", 38, 27, {
    size: 12,
    weight: 600,
    color: canvasInk,
  });
  if (context) {
    text(ctx, "/", 38 + measure(ctx, "Line Launcher", 12, 600) + 8, 27, {
      size: 12,
      color: canvasInkSoft,
    });
    text(ctx, context, 38 + measure(ctx, "Line Launcher", 12, 600) + 20, 27, {
      size: 12,
      color: canvasInk,
    });
  }
  if (trailing) {
    // A ghost button: text and icon, no frame.
    const w = measure(ctx, trailing, 11, 500) + 34;
    const x = SHOT_WIDTH - w - 100;
    icon(ctx, "sparkles", x + 9, 17, 12, canvasInkSoft);
    text(ctx, trailing, x + 25, 27, {
      size: 11,
      color: canvasInkSoft,
    });
  }
  // Caption buttons.
  const cap = ["minus", "square", "x"];
  cap.forEach((name, index) => {
    const cx = SHOT_WIDTH - 128 + index * 40;
    icon(ctx, name, cx + 12, 14, 14, canvasInkSoft, 1.5);
  });
  return h;
}

const NAV = [
  { icon: "server", label: "Серверы", id: "servers" },
  { icon: "shirt", label: "Гардероб", id: "wardrobe" },
  { icon: "user", label: "Аккаунт", id: "account" },
  { icon: "settings", label: "Настройки", id: "settings" },
];

function sideNav(ctx, top, height, active, { providerName, username } = {}) {
  const w = 208;
  ctx.save();
  // No panel fill: in the app the rail *is* a `[data-line-glass]` element
  // (`SideNav`), so its background is the frost painted by `shellGlass` and the
  // ink is the glass palette. `--sidebar` is a near-black canvas value that
  // nothing in `src/` reads; painting it here put dark ink on a black strip.
  ctx.strokeStyle = rgba(T.border, 0.6);
  ctx.beginPath();
  ctx.moveTo(w - 0.5, top);
  ctx.lineTo(w - 0.5, top + height);
  ctx.stroke();

  if (providerName) {
    text(ctx, providerName, 12, top + 30, {
      size: 10,
      color: rgba(T.mutedForeground, 0.85),
    });
  }

  NAV.forEach((item, index) => {
    const y = top + 52 + index * 36;
    const isActive = active === item.id;
    if (isActive) fillRound(ctx, 8, y, w - 16, 32, 8, rgba(T.fill, 1));
    icon(
      ctx,
      item.icon,
      18,
      y + 8,
      16,
      isActive ? rgba(T.foreground) : rgba(T.mutedForeground),
    );
    text(ctx, item.label, 42, y + 21, {
      size: 12,
      weight: 500,
      color: isActive ? rgba(T.foreground) : rgba(T.mutedForeground),
    });
  });

  // Footer block, pinned to the bottom exactly as SideNav lays it out: account
  // row, three ghost buttons, the required credit, then the collapse control.
  const base = top + height;
  const pad = 10;
  const collapseTop = base - pad - 32;
  const creditTop = collapseTop - 8 - 26;
  const aboutTop = creditTop - 8 - 36;
  const reconnectTop = aboutTop - 36;
  const footLine = reconnectTop - 8;
  const accountTop = footLine - 8 - 32;

  ctx.strokeStyle = rgba(T.border, 0.5);
  ctx.beginPath();
  ctx.moveTo(0, footLine);
  ctx.lineTo(w, footLine);
  ctx.stroke();

  if (username) {
    icon(ctx, "user", 16, accountTop + 8, 16, rgba(T.mutedForeground));
    text(ctx, username, 40, accountTop + 20, { size: 11, weight: 500 });
    icon(
      ctx,
      "logout",
      w - 30,
      accountTop + 9,
      13,
      rgba(T.mutedForeground, 0.8),
      1.6,
    );
  }
  [
    ["refresh", "Переподключиться", reconnectTop],
    ["info", "О программе", aboutTop],
  ].forEach(([name, label, rowTop]) => {
    icon(ctx, name, 17, rowTop + 10, 15, rgba(T.mutedForeground));
    text(ctx, label, 42, rowTop + 22, {
      size: 11,
      color: rgba(T.mutedForeground),
    });
  });
  // The credit is a licence condition and wraps to two lines at this width, so
  // it is drawn with a max width rather than clipped to one line.
  text(ctx, "Powered by Line Launcher | Plus In Plus", 12, creditTop + 9, {
    size: 9,
    color: rgba(T.mutedForeground, 0.7),
    maxWidth: w - 24,
    lineHeight: 13,
  });
  icon(ctx, "chevron", 17, collapseTop + 10, 15, rgba(T.mutedForeground), 1.8);
  text(ctx, "Свернуть", 42, collapseTop + 22, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  ctx.restore();
  return w;
}

function appFooter(ctx, top, height) {
  // Also on the dark canvas, below the sheets: light ink and a faint light rule,
  // not the glass hairlines (which are dark and vanish on black).
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.lineTo(SHOT_WIDTH, top);
  ctx.stroke();
  text(ctx, "Line | 0.1.0", 16, top + 15, {
    size: 9,
    color: rgba(T.canvasInkSoft, 0.8),
  });
  icon(
    ctx,
    "shield",
    SHOT_WIDTH - 176,
    top + 5,
    11,
    rgba(T.canvasInkSoft, 0.8),
    1.6,
  );
  text(ctx, "Только авторизация провайдера", SHOT_WIDTH - 160, top + 15, {
    size: 9,
    color: rgba(T.canvasInkSoft, 0.8),
  });
}

/**
 * A panel: a translucent sheet, nothing else.
 *
 * There is no shadow and no inner highlight, because the CSS has none — the
 * launcher draws depth with the fill ladder and the backdrop blur, and a
 * gallery that invented a shadow would be documenting a design the app does
 * not ship.
 */
function glass(ctx, x, y, w, h, radius = 18) {
  fillRound(ctx, x, y, w, h, radius, rgba(T.surfaceGlass));
}

/**
 * The two structural sheets of the shell — the navigation rail and the main
 * pane. Both are `[data-line-glass]` elements in the app, so they paint the
 * white frost over the canvas. The renderer used to leave the canvas bare, and
 * every card floated on black. Painted before the rail, so the rail's ink lands
 * on the frost rather than under it.
 */
function shellGlass(ctx, top, footerH, navW) {
  const height = SHOT_HEIGHT - top - footerH - 6;
  // `--surface-shell-glass`, not `--surface-glass`: only the rail and the main
  // pane are white tiles. Cards, dialogs and controls inside them keep the
  // dark pane, and so does everything the renderer paints with `glass()`.
  fillRound(ctx, 6, top + 6, navW - 6, height, 12, rgba(T.surfaceShellGlass));
  fillRound(
    ctx,
    navW + 2,
    top + 6,
    SHOT_WIDTH - navW - 8,
    height,
    12,
    rgba(T.surfaceShellGlass),
  );
}

function button(
  ctx,
  x,
  y,
  w,
  h,
  label,
  { variant = "primary", iconName, size = 12 } = {},
) {
  if (variant === "primary") {
    fillRound(ctx, x, y, w, h, 10, rgba(T.primary));
    const fg = rgba(T.primaryForeground);
    const textWidth = measure(ctx, label, size, 600);
    const total = iconName ? textWidth + 20 : textWidth;
    let cursor = x + (w - total) / 2;
    if (iconName) {
      icon(ctx, iconName, cursor, y + h / 2 - 7, 14, fg, 2);
      cursor += 20;
    }
    text(ctx, label, cursor, y + h / 2 + 4.5, { size, weight: 600, color: fg });
    return;
  }
  fillRound(ctx, x, y, w, h, 10, rgba(T.fill, 0.7));
  strokeRound(ctx, x, y, w, h, 10, rgba(T.border), 1);
  const fg = rgba(T.foreground, 0.92);
  const textWidth = measure(ctx, label, size, 500);
  const total = iconName ? textWidth + 20 : textWidth;
  let cursor = x + (w - total) / 2;
  if (iconName) {
    icon(ctx, iconName, cursor, y + h / 2 - 7, 14, fg, 1.8);
    cursor += 20;
  }
  text(ctx, label, cursor, y + h / 2 + 4.5, { size, weight: 500, color: fg });
}

function chip(ctx, x, y, label, tone = "neutral") {
  const color =
    tone === "ok"
      ? T.online
      : tone === "warn"
        ? T.update
        : tone === "error"
          ? T.destructive
          : T.mutedForeground;
  const width = measure(ctx, label, 9, 600) + 24;
  fillRound(ctx, x, y, width, 18, 5, rgba(color, 0.12));
  strokeRound(ctx, x, y, width, 18, 5, rgba(color, 0.32), 1);
  icon(ctx, "check", x + 6, y + 4, 10, rgba(color), 2.4);
  text(ctx, label, x + 17, y + 12.5, {
    size: 9,
    weight: 600,
    color: rgba(color),
  });
  return width;
}

function progressBar(ctx, x, y, w, percent) {
  fillRound(ctx, x, y, w, 8, 4, rgba(T.fill, 1));
  const width = Math.max(8, (w * percent) / 100);
  fillRound(ctx, x, y, width, 8, 4, rgba(T.primary));
  fillRound(ctx, x, y, w, 8, 4, rgba(T.fill, 0.9));
}

// ───────────────────────────── screens ─────────────────────────────

const STATUS_OK = "Сборка не изменилась · готов к запуску";

/** Width of the left rail; the content column is centred in what remains. */
const NAV_WIDTH = 208;
const FOOTER_H = 28;

/**
 * The app shell every screen shares: background, title bar, rail, footer.
 * Returns the content area so each screen only lays out its own body.
 */

/** Caption buttons alone, for the frameless pages that carry no title text. */
function captionButtons(ctx) {
  ["minus", "square", "x"].forEach((name, index) => {
    const cx = SHOT_WIDTH - 128 + index * 40;
    icon(ctx, name, cx + 12, 14, 14, rgba(T.mutedForeground, 0.9), 1.5);
  });
}

function shell(ctx, context, { active = "servers", signedIn = false } = {}) {
  background(ctx);
  const top = titleBar(ctx, context);
  // The sheets go under the rail, not over it.
  shellGlass(ctx, top, FOOTER_H, NAV_WIDTH);
  const nav = sideNav(ctx, top, SHOT_HEIGHT - top - FOOTER_H, active, {
    providerName: signedIn ? "Plus In Plus Demo" : undefined,
    username: signedIn ? "Player_1" : undefined,
  });
  appFooter(ctx, SHOT_HEIGHT - FOOTER_H, FOOTER_H);
  return {
    top,
    nav,
    contentX: nav + 32,
    contentW: SHOT_WIDTH - nav - 64,
    centerX: nav + (SHOT_WIDTH - nav) / 2,
    centerY: top + (SHOT_HEIGHT - FOOTER_H - top) / 2,
  };
}

/**
 * «Подключение к проекту» — the startup state of a configured build.
 *
 * There is no card here: ConnectingScreen centres a spinner, a heading and one
 * sentence in the content area, and the design switch sits in the title bar
 * because the rail has no account block yet.
 */
function screenConnecting(ctx) {
  const { centerX, centerY } = shell(ctx, "Подключение");

  // Loading spinner: a quarter-arc on a faint track, like Loader2 mid-rotate.
  const ringY = centerY - 78;
  ctx.beginPath();
  ctx.arc(centerX, ringY, 14, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(T.primary, 0.22);
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(centerX, ringY, 14, -Math.PI / 2, Math.PI / 3);
  ctx.strokeStyle = rgba(T.primary);
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";

  text(ctx, "Подключение к проекту", centerX, centerY - 26, {
    size: 18,
    weight: 700,
    align: "center",
  });
  text(
    ctx,
    "Загружаем список серверов. Адрес уже настроен в этой сборке — вводить ничего не нужно.",
    centerX,
    centerY + 2,
    {
      size: 12,
      color: rgba(T.mutedForeground),
      align: "center",
      maxWidth: 448,
      lineHeight: 19,
    },
  );
}

/**
 * «Welcome» — the greeting that runs before anything else.
 *
 * The word is written at display size on the page's own colour field, and
 * nothing else: the product name that used to sit under a hairline was a
 * caption, and the greeting does not have one. No chrome either — this screen
 * covers the window, so a title bar or a rail here would show a frame the app
 * does not have at this point.
 */
/**
 * The default backdrop («Полярное сияние») as a soft radial field.
 *
 * Both screens without chrome stand on it: the same three pools the theme's
 * palette produces, so the gallery shows the colour the app actually opens with
 * rather than a black page.
 */
function paintField(ctx, strength = 1) {
  const glow = (x, y, w, h, colour) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) / 2);
    g.addColorStop(0, colour);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
  };
  glow(
    SHOT_WIDTH * 0.45,
    SHOT_HEIGHT * 0.36,
    1100,
    900,
    rgba(hexRgb("6a3df5"), 0.5 * strength),
  );
  glow(
    SHOT_WIDTH * 0.78,
    SHOT_HEIGHT * 0.72,
    800,
    700,
    rgba(hexRgb("35aef2"), 0.34 * strength),
  );
  glow(
    SHOT_WIDTH * 0.2,
    SHOT_HEIGHT * 0.8,
    700,
    600,
    rgba(hexRgb("f59a22"), 0.16 * strength),
  );
}

/**
 * The greeting's face.
 *
 * Pacifico is registered from the TTF above like the UI font, because a canvas
 * has no @font-face to load: naming the family without registering it silently
 * falls back to a system script face and the gallery stops matching the app.
 */
const HAND_FONT = '400 120px "Line Hand", "Segoe Script", cursive';

function screenWelcome(ctx) {
  const cx = SHOT_WIDTH / 2;
  const cy = SHOT_HEIGHT / 2;

  // The field the greeting stands on.
  //
  // Not near-black with two bright pools on it: at the moment the greeting runs,
  // the aurora shader has spread its colour over the whole window and the page
  // reads as a fairly even indigo, brightest at the top left. Painting a black
  // page and dropping glows on it is what made the offline render of this screen
  // look nothing like the app — a bright word over a black void.
  ctx.fillStyle = rgba(T.canvas);
  ctx.fillRect(0, 0, SHOT_WIDTH, SHOT_HEIGHT);
  ctx.fillStyle = rgba(hexRgb("46409b"));
  ctx.fillRect(0, 0, SHOT_WIDTH, SHOT_HEIGHT);
  const glow = (x, y, w, h, colour) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) / 2);
    g.addColorStop(0, colour);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
  };
  // The shader's own pools, kept as modulation rather than as the only source
  // of colour.
  glow(
    SHOT_WIDTH * 0.45,
    SHOT_HEIGHT * 0.36,
    1300,
    1000,
    rgba(hexRgb("6a3df5"), 0.2),
  );
  glow(
    SHOT_WIDTH * 0.78,
    SHOT_HEIGHT * 0.72,
    1000,
    900,
    rgba(hexRgb("35aef2"), 0.16),
  );
  glow(
    SHOT_WIDTH * 0.12,
    SHOT_HEIGHT * 0.85,
    900,
    700,
    rgba(hexRgb("f59a22"), 0.1),
  );

  // The wash the real screen puts over the field so a white word stays crisp.
  // It is light — 28% in the middle, 52% at the edges — and a radial gradient,
  // not a flat sheet: painting a flat sheet here is what made the offline
  // render of this screen look nothing like the app.
  const wash = ctx.createRadialGradient(
    SHOT_WIDTH / 2,
    SHOT_HEIGHT * 0.42,
    0,
    SHOT_WIDTH / 2,
    SHOT_HEIGHT * 0.42,
    SHOT_WIDTH * 0.62,
  );
  wash.addColorStop(0, "rgba(8,9,12,0.28)");
  wash.addColorStop(1, "rgba(8,9,12,0.52)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, SHOT_WIDTH, SHOT_HEIGHT);

  // The word, and only the word: a handwriting face at display size, centred on
  // the optical middle. The real screen writes it stroke by stroke; a still
  // image can only show where it ends up, so the size and the face carry it.
  //
  // `--canvas` ink, not `--foreground`: the greeting is `fixed inset-0` over the
  // backdrop, outside every glass panel, so `text-foreground` resolves to the
  // light canvas value. The glass override is dark ink for sheets, and using it
  // here drew a black word on a dark purple field.
  ctx.save();
  ctx.fillStyle = rgba(T.canvasInk);
  ctx.font = HAND_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = "0px";
  ctx.fillText("Welcome", cx, cy + 44);
  ctx.restore();
}

/**
 * Sign-in — a full-window page, not a panel inside the launcher.
 *
 * Real structure: the window's own frame (caption buttons only), then a centred
 * column of mark, provider name, one sentence and the glass card that holds
 * AuthForm. There is no rail and no catalogue behind it: signing in happens
 * before the launcher exists, and the drawing has to say so.
 */
function screenAccount(ctx) {
  background(ctx);
  paintField(ctx);
  const cx = SHOT_WIDTH / 2;
  const cardW = 380;
  const x = cx - cardW / 2;

  // Caption buttons in the top right, on the window's 6px inset.
  captionButtons(ctx);

  // Vertically centred as a block: the same maths the page uses (flex centring
  // inside the space under the frame).
  const cardH = 24 + 44 + 2 * 60 + 22 + 48 + 40 + 24;
  const columnH = 44 + 16 + 30 + 12 + 18 + 24 + cardH + 20 + 34;
  let y = Math.round((SHOT_HEIGHT - columnH) / 2) + 18;

  brandMark(ctx, cx - 22, y, 44);
  y += 44 + 18;
  // Above the card, on the dark backdrop: canvas ink. `SignInScreen` paints the
  // wordmark and the sub-line outside the `[data-line-glass]` panel, so they
  // resolve to `--foreground` from `:root`, not the glass override.
  text(ctx, "Plus In Plus Demo", cx, y + 18, {
    size: 24,
    weight: 600,
    align: "center",
    color: rgba(T.canvasInk),
  });
  y += 30;
  text(
    ctx,
    // The page builds this from `servers.length`; the demo config has two.
    "Один вход — все серверы проекта. Серверов: 2.",
    cx,
    y + 2,
    {
      size: 12,
      color: rgba(T.canvasInkSoft),
      align: "center",
      maxWidth: 420,
      lineHeight: 18,
    },
  );
  y += 24;

  glass(ctx, x, y, cardW, cardH, 18);
  const ix = x + 24;
  const innerW = cardW - 48;
  let iy = y + 24;

  // Tabs: a quiet trough with the active segment raised.
  fillRound(ctx, ix, iy, innerW, 28, 8, rgba(T.fill, 0.5));
  const tabW = innerW / 2 - 2;
  fillRound(ctx, ix + 2, iy + 2, tabW, 24, 6, rgba(T.fill, 0.9));
  text(ctx, "Вход", ix + 2 + tabW / 2, iy + 18, {
    size: 12,
    weight: 500,
    align: "center",
  });
  text(ctx, "Регистрация", ix + innerW / 2 + tabW / 2 + 2, iy + 18, {
    size: 12,
    color: rgba(T.mutedForeground),
    align: "center",
  });
  iy += 44;

  const field = (label, value, withEye) => {
    text(ctx, label, ix, iy + 10, {
      size: 11,
      weight: 500,
      color: rgba(T.mutedForeground),
    });
    // Transparent with a hairline, like `Input`: it has no fill of its own, and
    // painting `--background` here filled the fields with a grey plate.
    strokeRound(ctx, ix, iy + 16, innerW, 38, 8, rgba(T.input, 1), 1);
    text(ctx, value || "Player_name", ix + 14, iy + 40, {
      size: 12,
      color: value ? rgba(T.foreground) : rgba(T.mutedForeground, 0.7),
    });
    if (withEye)
      icon(ctx, "eye", ix + innerW - 26, iy + 24, 14, rgba(T.mutedForeground));
    iy += 60;
  };
  // «Player_1» typed but not submitted: the password field stays empty so the
  // shot does not imply a stored secret.
  field("Логин", "Player_1", false);
  field("Пароль", "", true);

  text(ctx, "Тот же вход открывает все серверы проекта.", ix, iy + 4, {
    size: 11,
    color: rgba(T.mutedForeground, 0.8),
  });
  iy += 22;

  button(ctx, ix, iy + 6, innerW, 42, "Войти", { size: 13 });
  iy += 42 + 6;

  // The promise under the button, then the footer line under the card.
  text(ctx, "Пароль передаётся только API проекта по HTTPS.", ix, iy + 20, {
    size: 11,
    color: rgba(T.mutedForeground, 0.75),
    maxWidth: innerW,
    lineHeight: 16,
  });
  // Below the card, back on the backdrop.
  text(ctx, "Вход только через аккаунт проекта.", cx, y + cardH + 28, {
    size: 10,
    color: rgba(T.canvasInkSoft, 0.7),
    align: "center",
  });
}

/**
 * One server tile.
 *
 * Flat artwork, name, version, one description line, one quiet meta line. The
 * previous version drew a gradient banner with abstract bars, a boxed
 * «Установлен» chip and two more chips on a footer row — the "dashboard of
 * labels" the cards were replaced for. A missing state now draws nothing.
 */
function serverCard(ctx, x, y, w, h, server) {
  fillRound(ctx, x, y, w, h, 12, rgba(T.fillSubtle));

  // Banner: the provider's colour, blended down into the card. At full strength
  // a saturated block fought the mint accent for the eye; held back it reads as
  // artwork behind the name, which is what a banner is.
  const bh = 96;
  ctx.save();
  roundRect(ctx, x, y, w, bh, 12);
  ctx.clip();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = server.from;
  ctx.fillRect(x, y, w, bh);
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = font(15, 700);
  ctx.textAlign = "center";
  ctx.fillText(server.glyph, x + w / 2, y + 56);
  ctx.textAlign = "left";

  if (server.installed) {
    // Floats on the artwork: the one place a readable label beats another row.
    const label = "Установлен";
    const cw = measure(ctx, label, 10, 500) + 30;
    fillRound(ctx, x + w - cw - 8, y + 8, cw, 20, 10, "rgba(0,0,0,0.55)");
    icon(ctx, "check", x + w - cw, y + 13, 11, "rgba(255,255,255,0.95)", 2.2);
    text(ctx, label, x + w - cw + 15, y + 22, {
      size: 10,
      weight: 500,
      color: "rgba(255,255,255,0.95)",
    });
  }

  let cy = y + bh + 14;
  // Icon and name on one row; the icon is 32px and unframed.
  fillRound(ctx, x + 14, cy, 32, 32, 8, server.from);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = font(14, 700);
  ctx.textAlign = "center";
  ctx.fillText(server.letter, x + 30, cy + 22);
  ctx.textAlign = "left";
  text(ctx, server.name, x + 56, cy + 14, { size: 14, weight: 600 });
  // The fixture already carries the `v` prefix.
  text(ctx, server.version, x + 56, cy + 29, {
    size: 10,
    color: rgba(T.mutedForeground),
    mono: true,
  });
  cy += 44;

  text(ctx, server.description, x + 14, cy + 6, {
    size: 11,
    color: rgba(T.mutedForeground),
    maxWidth: w - 28,
    lineHeight: 16,
    maxLines: 2,
  });
  cy += 52;

  // One meta line, no chips.
  const meta = [`Minecraft ${server.minecraftVersion}`];
  if (server.pack) meta.push("pack.json");
  text(ctx, meta.join(" · "), x + 14, cy - 4, {
    size: 10,
    color: rgba(T.mutedForeground, 0.8),
    mono: true,
  });
}

function catalogRail(ctx, x, y, w) {
  const h = 56;
  glass(ctx, x, y, w, h, 14);
  fillRound(ctx, x + 14, y + 13, 36, 36, 8, "#0f766e");
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = font(16, 700);
  ctx.textAlign = "center";
  ctx.fillText("S", x + 32, y + 37);
  ctx.textAlign = "left";
  // One line: name, then its state. The uppercase kicker that used to sit
  // above the name repeated the section heading directly above the strip.
  const railName = measure(ctx, "Survival", 13, 500);
  text(ctx, "Survival", x + 62, y + 34, { size: 13, weight: 500 });
  text(ctx, STATUS_OK, x + 62 + railName + 10, y + 34, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  fillRound(ctx, x + w - 102, y + 16, 88, 24, 8, rgba(T.fillHover, 0.7));
  icon(ctx, "play", x + w - 92, y + 22, 11, rgba(T.foreground, 0.9), 1.6);
  text(ctx, "Открыть", x + w - 76, y + 32, { size: 11, weight: 500 });
}

function screenServers(ctx) {
  background(ctx);
  const top = titleBar(ctx, "Plus In Plus Demo", undefined);
  const nav = 208;
  const footerH = 28;
  shellGlass(ctx, top, footerH, nav);
  sideNav(ctx, top, SHOT_HEIGHT - top - footerH, "servers", {
    providerName: "Plus In Plus Demo",
    username: "Player_1",
  });
  appFooter(ctx, SHOT_HEIGHT - footerH, footerH);

  const contentX = nav + 32;
  const contentW = SHOT_WIDTH - contentX - 32;

  // Provider name is the section title; no kicker above it.
  let y = top + 34;
  text(ctx, "Plus In Plus Demo", contentX, y + 20, { size: 20, weight: 700 });
  y += 42;
  button(ctx, SHOT_WIDTH - 32 - 118, top + 34, 118, 30, "Обновить", {
    variant: "outline",
    iconName: "refresh",
    size: 11,
  });

  y += 8;
  catalogRail(ctx, contentX, y, contentW);
  y += 56 + 22;

  const cardW = (contentW - 2 * 16) / 3;
  const cardH = 96 + 14 + 44 + 52 + 18;
  // Exactly the servers `examples/config.json` publishes — no invented third
  // card. The grid stays three columns wide, so two servers leave one empty
  // slot, which is what the real screen does.
  const servers = [
    {
      name: "Survival",
      glyph: "SURVIVAL",
      letter: "S",
      from: "#0f766e",
      version: "v2026.11.1",
      description:
        "Классическое выживание с бережным отношением к игровому процессу.",
      minecraftVersion: "1.21.1",
      installed: true,
      pack: true,
    },
    {
      name: "SkyBlock",
      glyph: "SKYBLOCK",
      letter: "K",
      from: "#1d4ed8",
      version: "v2026.11.1",
      description:
        "Острова в пустоте: кооператив, экономика и сезонные задания.",
      minecraftVersion: "1.21.1",
      installed: false,
      pack: true,
    },
  ];
  servers.forEach((server, index) => {
    serverCard(ctx, contentX + index * (cardW + 16), y, cardW, cardH, server);
  });
}

function screenServer(ctx) {
  background(ctx);
  const top = titleBar(ctx, "Plus In Plus Demo / Survival", undefined);
  const nav = 208;
  const footerH = 28;
  shellGlass(ctx, top, footerH, nav);
  sideNav(ctx, top, SHOT_HEIGHT - top - footerH, "servers", {
    providerName: "Plus In Plus Demo",
    username: "Player_1",
  });
  appFooter(ctx, SHOT_HEIGHT - footerH, footerH);

  const contentW = 560;
  const x = nav + (SHOT_WIDTH - nav - contentW) / 2;
  let y = top + 26;

  icon(ctx, "chevron", x, y, 14, rgba(T.mutedForeground), 2);
  text(ctx, "Все серверы", x + 20, y + 11, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  y += 32;

  // Header: 56px icon, provider line, name, description.
  fillRound(ctx, x, y, 56, 56, 12, "#0f766e");
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = font(24, 700);
  ctx.textAlign = "center";
  ctx.fillText("S", x + 28, y + 37);
  ctx.textAlign = "left";
  text(ctx, "Plus In Plus Demo · v2026.11.1", x + 70, y + 16, {
    size: 10,
    color: rgba(T.mutedForeground),
    mono: true,
  });
  text(ctx, "Survival", x + 70, y + 40, { size: 24, weight: 600 });
  text(
    ctx,
    "Классическое выживание с бережным отношением к игровому процессу.",
    x + 70,
    y + 58,
    { size: 11, color: rgba(T.mutedForeground), maxWidth: contentW - 70 },
  );
  y += 84;

  // The action dock. Same order as `ServerActionPanel`: one status row, the
  // single filled action, then the sign-in footnote. No icon and no repeated
  // name — the header directly above already carries both.
  //
  // Ни строки прогресса под кнопкой: полоса — это сама кнопка.
  const dockH = 132;
  glass(ctx, x, y, contentW, dockH, 18);
  const pad = 16;
  let rowY = y + pad;
  icon(ctx, "check", x + pad, rowY - 1, 12, rgba(T.online), 2.2);
  const statusW = measure(ctx, STATUS_OK, 12, 400);
  text(ctx, STATUS_OK, x + pad + 18, rowY + 9, {
    size: 12,
    color: rgba(T.mutedForeground),
  });
  let metaX = x + pad + 18 + statusW + 12;
  for (const meta of ["v2026.11.1", "MC 1.21.1"]) {
    text(ctx, meta, metaX, rowY + 9, {
      size: 10,
      color: rgba(T.mutedForeground, 0.8),
      mono: true,
    });
    metaX += measure(ctx, meta, 10, 400, true) + 14;
  }
  icon(
    ctx,
    "history",
    x + contentW - pad - 16,
    rowY - 3,
    16,
    rgba(T.mutedForeground),
  );
  rowY += 26;

  // Середина загрузки: кнопка И ЕСТЬ прогресс. Её заливка выросла на 45 %,
  // подпись осталась действием («Отменить скачивание»). Ни процента текстом,
  // ни второй полосы, ни имени файла — как play/pause у Liner.
  const barW = contentW - pad * 2;
  const btnH = 44;
  fillRound(ctx, x + pad, rowY, barW, btnH, 10, rgba(T.primary));
  ctx.save();
  roundRect(ctx, x + pad, rowY, barW, btnH, 10);
  ctx.clip();
  ctx.fillStyle = rgba(T.primaryForeground, 0.25);
  ctx.fillRect(x + pad, rowY, Math.round((barW * 45) / 100), btnH);
  ctx.restore();
  const busyLabel = "Отменить скачивание";
  const labelX = x + pad + barW / 2 - measure(ctx, busyLabel, 13, 600) / 2;
  icon(
    ctx,
    "download",
    labelX - 18,
    rowY + 15,
    13,
    rgba(T.primaryForeground),
    1.8,
  );
  text(ctx, busyLabel, labelX, rowY + 27, {
    size: 13,
    weight: 600,
    color: rgba(T.primaryForeground),
  });
  rowY += btnH + 10;

  icon(ctx, "shield", x + pad, rowY + 1, 11, rgba(T.mutedForeground, 0.9), 1.8);
  text(ctx, "Офлайн-сборка: ник аккаунта проекта.", x + pad + 16, rowY + 9, {
    size: 9,
    color: rgba(T.mutedForeground, 0.9),
  });

  y += dockH + 18;
  text(
    ctx,
    "Сборка скачается целиком: архив провайдера, проверка sha256 и распаковка. Ход виден по самой кнопке, меню не блокируется.",
    x + 8,
    y,
    {
      size: 10,
      color: rgba(T.mutedForeground, 0.85),
      maxWidth: contentW - 16,
      lineHeight: 15,
    },
  );
}

/**
 * Гардероб. Matches WardrobeScreen's actual stack inside a max-w-3xl column:
 * title, «Добавить скин в историю», «Локальная история» with a 3-up grid, and
 * the card that reports the automatic upload.
 *
 * Heights are computed from the rows they contain so the last card cannot run
 * under the footer — the previous version hard-coded 400px cards and the skin
 * preview spilled over the status line.
 */
function screenWardrobe(ctx) {
  const { top, centerX } = shell(ctx, "Plus In Plus Demo / Гардероб", {
    active: "wardrobe",
    signedIn: true,
  });
  const w = 768; // the component's max-w-3xl
  const x = centerX - w / 2;
  let y = top + 24;

  text(ctx, "Гардероб", x, y + 12, { size: 20, weight: 700 });
  y += 32;
  text(ctx, "Активный скин отправляется на сервер сам.", x, y + 12, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  y += 40;

  // ── Card 1: add a texture. Idle form: picker, name, model select.
  // 18 padding + title/description + two stacked field rows + 18 padding.
  const addH = 18 + 40 + 58 + 8 + 50 + 16;
  glass(ctx, x, y, w, addH, 16);
  let iy = y + 18;
  // Title on the left, the accepted format on the right — one row instead of
  // a heading plus a sentence under it.
  text(ctx, "Добавить скин", x + 20, iy + 12, { size: 12, weight: 600 });
  const hint = "PNG 64×64 · до 256 КБ";
  text(ctx, hint, x + w - 20 - measure(ctx, hint, 10, 400, true), iy + 12, {
    size: 10,
    color: rgba(T.mutedForeground),
    mono: true,
  });
  iy += 40;

  const fieldW = (w - 40 - 24) / 2;
  const field = (fx, label, placeholder) => {
    text(ctx, label, fx, iy + 10, { size: 10, color: rgba(T.mutedForeground) });
    fillRound(ctx, fx, iy + 18, fieldW, 32, 8, rgba(T.background, 0.5));
    strokeRound(ctx, fx, iy + 18, fieldW, 32, 8, rgba(T.border), 1);
    text(ctx, placeholder, fx + 10, iy + 39, {
      size: 11,
      color: rgba(T.mutedForeground, 0.7),
    });
  };
  // The file row is NOT a native input: the real screen hides the <input> and
  // forwards its click from a label that reads «Выбрать файл» + «PNG не выбран».
  // A rendered "Choose File · No file chosen" showed a control the player never
  // sees, which is exactly the kind of drift this renderer exists to avoid.
  text(ctx, "Файл текстуры", x + 20, iy + 10, {
    size: 10,
    color: rgba(T.mutedForeground),
  });
  fillRound(ctx, x + 20, iy + 18, fieldW, 32, 8, "rgba(0,0,0,0)");
  strokeRound(ctx, x + 20, iy + 18, fieldW, 32, 8, rgba(T.input), 1);
  fillRound(
    ctx,
    x + 23,
    iy + 21,
    measure(ctx, "Выбрать файл", 11, 500) + 20,
    26,
    6,
    rgba(T.fill, 1),
  );
  text(ctx, "Выбрать файл", x + 33, iy + 38, { size: 11, weight: 500 });
  text(
    ctx,
    "PNG не выбран",
    x + 33 + measure(ctx, "Выбрать файл", 11, 500) + 20,
    iy + 38,
    {
      size: 11,
      color: rgba(T.mutedForeground, 0.7),
    },
  );
  field(x + 20 + fieldW + 24, "Название", "Например, зимний");
  iy += 58;

  text(ctx, "Модель", x + 20, iy + 10, {
    size: 10,
    color: rgba(T.mutedForeground),
  });
  fillRound(ctx, x + 20, iy + 18, w - 40, 32, 8, rgba(T.background, 0.5));
  strokeRound(ctx, x + 20, iy + 18, w - 40, 32, 8, rgba(T.border), 1);
  text(ctx, "Classic — широкие руки (4 px)", x + 30, iy + 39, { size: 11 });
  icon(
    ctx,
    "chevronDown",
    x + w - 42,
    iy + 27,
    14,
    rgba(T.mutedForeground),
    1.8,
  );
  y += addH + 14;

  // ── Card 2: the local library. Header, the standard-skin row, three skins.
  const rowH = 44;
  const tileH = 92;
  const historyH = 18 + 34 + 12 + rowH + 12 + tileH + 16;
  glass(ctx, x, y, w, historyH, 16);
  iy = y + 18;
  icon(ctx, "history", x + 20, iy + 6, 20, rgba(T.primary), 1.7);
  text(ctx, "Локальная история", x + 50, iy + 13, { size: 12, weight: 600 });
  const count = "3 из 64";
  text(
    ctx,
    count,
    x + 50 + measure(ctx, "Локальная история", 12, 600) + 10,
    iy + 13,
    {
      size: 10,
      color: rgba(T.mutedForeground),
    },
  );
  iy += 46;

  fillRound(ctx, x + 20, iy, w - 40, rowH, 10, rgba(T.fill, 0.3));
  icon(ctx, "user", x + 32, iy + 14, 16, rgba(T.mutedForeground));
  const stdName = "Стандартный скин";
  text(ctx, stdName, x + 60, iy + 26, { size: 11, weight: 500 });
  text(
    ctx,
    "вернуть обычный вид",
    x + 60 + measure(ctx, stdName, 11, 500) + 10,
    iy + 26,
    { size: 9, color: rgba(T.mutedForeground) },
  );
  iy += rowH + 12;

  const skins = [
    ["Зимний", "classic", true],
    ["Рабочий", "slim", false],
    ["Праздничный", "classic", false],
  ];
  const tileW = (w - 40 - 2 * 8) / 3;
  skins.forEach(([name, model, active], index) => {
    const tx = x + 20 + index * (tileW + 8);
    fillRound(
      ctx,
      tx,
      iy,
      tileW,
      tileH,
      10,
      active ? rgba(T.primary, 0.1) : rgba(T.fill, 0.3),
    );
    // SkinThumb renders the silhouette at 8x16 CSS px per skin pixel (h-16 w-8),
    // so 14 here keeps the same 2:4 proportions inside the tile.
    drawSkin(ctx, tx + 14, iy + 10, 13, model);
    text(ctx, name, tx + 56, iy + 26, { size: 11, weight: 500 });
    text(ctx, `64×64 · ${model}`, tx + 56, iy + 42, {
      size: 9,
      color: rgba(T.mutedForeground),
      mono: true,
    });
    // The state is the tint plus one word; the tile itself is the choice.
    text(ctx, active ? "Активен" : "Выбрать", tx + 12, iy + tileH - 12, {
      size: 9,
      color: active ? rgba(T.primary) : rgba(T.mutedForeground),
    });
    icon(
      ctx,
      "trash",
      tx + tileW - 26,
      iy + tileH - 21,
      12,
      rgba(T.mutedForeground),
      1.6,
    );
  });
  y += historyH + 14;

  // ── Card 3: what the servers see. The upload already happened on its own.
  const syncH = 74;
  glass(ctx, x, y, w, syncH, 16);
  icon(ctx, "shirt", x + 20, y + 18, 20, rgba(T.primary), 1.7);
  text(ctx, "Скин на серверах проекта", x + 60, y + 30, {
    size: 12,
    weight: 600,
  });
  text(
    ctx,
    "✓ «Зимний» активен и отправлен на сервер автоматически.",
    x + 60,
    y + 48,
    {
      size: 10,
      color: rgba(T.online),
    },
  );
  text(ctx, "Player_1 · Модель: classic", x + 60, y + 64, {
    size: 9,
    color: rgba(T.mutedForeground),
    mono: true,
  });
}

function drawSkin(ctx, x, y, scale, model) {
  // Classic Minecraft proportions: head 8x8, body 8x12, arms 4x12, legs 4x12.
  const unit = scale / 8;
  const palette = ["#8f6b4c", "#5f8f7a", "#3f5f9f", "#2c3550", "#cdd6e0"];
  const part = (color, px, py, pw, ph) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + px * unit, y + py * unit, pw * unit, ph * unit);
  };
  part(palette[0], 0, 0, 8, 8); // head
  part(palette[4], 1, 1, 6, 2); // face highlight
  part(palette[2], 0, 8, 8, 12); // body
  const armW = model === "slim" ? 3 : 4;
  part(palette[3], -armW, 8, armW, 12); // left arm
  part(palette[3], 8, 8, armW, 12); // right arm
  part(palette[1], 0, 20, 4, 12); // left leg
  part(palette[1], 4, 20, 4, 12); // right leg
  // Eyes.
  ctx.fillStyle = "#1b2430";
  ctx.fillRect(x + 2.2 * unit, y + 3.4 * unit, 1.2 * unit, 1.4 * unit);
  ctx.fillRect(x + 4.6 * unit, y + 3.4 * unit, 1.2 * unit, 1.4 * unit);
}

function screenSettings(ctx) {
  background(ctx);
  const top = titleBar(ctx, "Plus In Plus Demo / Настройки", undefined);
  const nav = 208;
  const footerH = 28;
  shellGlass(ctx, top, footerH, nav);
  sideNav(ctx, top, SHOT_HEIGHT - top - footerH, "settings", {
    providerName: "Plus In Plus Demo",
    username: "Player_1",
  });
  appFooter(ctx, SHOT_HEIGHT - footerH, footerH);

  const x = nav + 32;
  const w = SHOT_WIDTH - x - 32;
  let y = top + 26;
  text(ctx, "Настройки", x, y, { size: 20, weight: 700 });
  y += 14;
  text(
    ctx,
    "Параметры применяются к следующему запуску игры. Сборки и история релизов не меняются.",
    x,
    y + 8,
    {
      size: 11,
      color: rgba(T.mutedForeground),
    },
  );
  y += 40;

  const footerTop = SHOT_HEIGHT - FOOTER_H;
  const section = (title, description, iconName, height, body) => {
    if (y + height > footerTop) {
      throw new Error(
        `настройки: секция «${title}» заканчивается на ${Math.round(y + height)}px, ` +
          `а футер начинается на ${footerTop}px — уменьшите высоту`,
      );
    }
    // Not a filled card. A settings section is a heading and a control,
    // separated from the next by space and a hairline — `SettingsScreen` draws
    // `border-b` and nothing else. Stacking four frost panels on the pane made
    // the page read as a grid of boxes the app does not have.
    ctx.strokeStyle = rgba(T.border, 0.55);
    ctx.beginPath();
    ctx.moveTo(x, y + height - 0.5);
    ctx.lineTo(x + w, y + height - 0.5);
    ctx.stroke();
    // Unframed icon at 20px, exactly what `SectionIcon` renders: no tile, no
    // border, no background.
    icon(ctx, iconName, x + 18, y + 16, 20, rgba(T.primary), 1.7);
    text(ctx, title, x + 50, y + 31, { size: 12, weight: 600 });
    if (description)
      text(ctx, description, x + 50, y + 48, {
        size: 10,
        color: rgba(T.mutedForeground),
        maxWidth: w - 70,
        lineHeight: 15,
      });
    // A section without a sentence closes the gap instead of leaving a hole
    // where the description would have been.
    body(x + 16, y + (description ? 72 : 54), w - 32);
    y += height + 12;
  };

  section(
    "Память игры",
    "Компьютер: 32768 МБ, доступно до 24576 МБ.",
    "memory",
    172,
    (bx, by, bw) => {
      // «Выделено Java» + the value on the right, then the slider, then the
      // automated-pick button — the same three rows SettingsScreen renders.
      text(ctx, "Выделено Java", bx, by + 10, {
        size: 10,
        color: rgba(T.mutedForeground),
      });
      text(ctx, "4096 МБ · авто", bx + bw, by + 10, {
        size: 10,
        align: "right",
      });
      const trackY = by + 30;
      fillRound(ctx, bx, trackY, bw - 96, 6, 3, rgba(T.fill, 1));
      fillRound(ctx, bx, trackY, (bw - 96) * 0.66, 6, 3, rgba(T.primary));
      ctx.beginPath();
      ctx.arc(bx + (bw - 96) * 0.66, trackY + 3, 9, 0, Math.PI * 2);
      ctx.fillStyle = rgba(T.primary);
      ctx.fill();
      ctx.strokeStyle = rgba(T.background);
      ctx.lineWidth = 2;
      ctx.stroke();
      text(ctx, "1024", bx, by + 56, {
        size: 9,
        color: rgba(T.mutedForeground),
        mono: true,
      });
      text(ctx, "24576", bx + bw - 96, by + 56, {
        size: 9,
        color: rgba(T.mutedForeground),
        mono: true,
        align: "right",
      });
      button(ctx, bx, by + 66, 218, 26, "Вернуть автоматический подбор", {
        variant: "outline",
        size: 9,
      });
    },
  );

  section(
    "Java",
    "Только проверенные рантаймы, версия под требование сборки.",
    "cpu",
    116,
    (bx, by) => {
      fillRound(ctx, bx, by, 300, 30, 8, rgba(T.online, 0.1));
      icon(ctx, "check", bx + 12, by + 8, 13, rgba(T.online), 2.4);
      text(ctx, "Java 25.0.3 проверена и выбрана", bx + 32, by + 20, {
        size: 10,
        color: rgba(T.online),
      });
      button(ctx, bx + 316, by, 150, 30, "Проверить и выбрать", {
        variant: "outline",
        size: 10,
      });
    },
  );

  // The real screen also has «Поведение и окно» and «Кэш конфигурации»; the shot
  // shows the first four sections, which is what fits without a scrollbar.
  section("Поведение и окно", null, "monitor", 176, (bx, by, bw) => {
    text(ctx, "После запуска игры", bx, by + 8, {
      size: 10,
      color: rgba(T.mutedForeground),
    });
    fillRound(ctx, bx, by + 14, bw, 30, 8, rgba(T.fill, 0.55));
    strokeRound(ctx, bx, by + 14, bw, 30, 8, rgba(T.border), 1);
    text(ctx, "Оставить окно открытым", bx + 10, by + 34, { size: 11 });
    icon(
      ctx,
      "chevronDown",
      bx + bw - 22,
      by + 24,
      12,
      rgba(T.mutedForeground),
      1.8,
    );

    const rowY = by + 62;
    text(ctx, "Ширина", bx, rowY + 8, {
      size: 10,
      color: rgba(T.mutedForeground),
    });
    fillRound(ctx, bx, rowY + 14, 96, 28, 8, rgba(T.background, 0.6));
    strokeRound(ctx, bx, rowY + 14, 96, 28, 8, rgba(T.border), 1);
    text(ctx, "1280", bx + 10, rowY + 33, { size: 11, mono: true });
    text(ctx, "Высота", bx + 112, rowY + 8, {
      size: 10,
      color: rgba(T.mutedForeground),
    });
    fillRound(ctx, bx + 112, rowY + 14, 96, 28, 8, rgba(T.background, 0.6));
    strokeRound(ctx, bx + 112, rowY + 14, 96, 28, 8, rgba(T.border), 1);
    text(ctx, "800", bx + 122, rowY + 33, { size: 11, mono: true });
    button(ctx, bx + 224, rowY + 12, 130, 30, "Применить размер", {
      variant: "outline",
      size: 10,
    });
  });

  // No appearance section: there is one design (see docs/DESIGN.md), and the
  // settings screen has no theme switch. This renderer used to draw one, which
  // put a control in the gallery that no player could find in the app.
}

/**
 * Аккаунт. The same two-column grid as `ProfileScreen`: identity + session on
 * the left, the skin viewer on the right.
 *
 * The 3D model is drawn as a flat silhouette on purpose. This renderer is the
 * fallback for machines without a browser (see README), and pretending to draw
 * a perspective body here would be a lie about what the offline gallery shows.
 * The silhouette is the *fallback* the app really uses when WebGL is missing, so
 * the picture is still truthful.
 */
function screenProfile(ctx) {
  const { top, centerX } = shell(ctx, "Plus In Plus Demo / Аккаунт", {
    active: "account",
    signedIn: true,
  });
  const w = 768; // ProfileScreen's max-w-3xl
  const x = centerX - w / 2;
  let y = top + 16;

  text(ctx, "Аккаунт", x, y + 14, { size: 20, weight: 700 });
  y += 32;
  text(ctx, "Один аккаунт на весь проект Plus In Plus Demo.", x, y + 10, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  y += 28;

  const gap = 16;
  const right = 288; // the viewer column
  const leftW = w - right - gap;

  // ── Left card: who you are.
  const cardH = 196;
  glass(ctx, x, y, leftW, cardH, 16);
  let iy = y + 16;
  icon(ctx, "user", x + 20, iy + 2, 26, rgba(T.mutedForeground));
  text(ctx, "Player_1", x + 56, iy + 14, { size: 13, weight: 600 });
  text(ctx, "Plus In Plus Demo", x + 56, iy + 31, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  iy += 52;

  // Session rows, two columns of label/value like the real <dl>.
  const rows = [
    ["Сессия истекает", "11 ноября в 22:40"],
    ["Скин", "Зимний"],
  ];
  for (const [label, value] of rows) {
    text(ctx, label, x + 20, iy + 10, {
      size: 11,
      color: rgba(T.mutedForeground),
    });
    text(ctx, value, x + 140, iy + 10, { size: 11 });
    iy += 22;
  }
  iy += 8;

  let bx = x + 20;
  for (const [label, glyph] of [
    ["Обновить", "arrow"],
    ["Гардероб", "shirt"],
    ["Выйти", "logout"],
  ]) {
    const bw = measure(ctx, label, 11, 500) + 44;
    fillRound(ctx, bx, iy, bw, 28, 8, rgba(T.fill, 0.9));
    strokeRound(ctx, bx + 0.5, iy + 0.5, bw - 1, 27, 8, rgba(T.border, 0.8));
    // 14px, not 12: the outlined glyphs lose their stroke below that and turn
    // into smudges in a 1280px-wide render.
    icon(ctx, glyph, bx + 9, iy + 7, 14, rgba(T.foreground, 0.85));
    text(ctx, label, bx + 29, iy + 18, { size: 11, weight: 500 });
    bx += bw + 8;
  }

  // ── Right column: the skin viewer (fallback silhouette) + one sentence.
  const vx = x + leftW + gap;
  glass(ctx, vx, y, right, 288, 16);
  const cx = vx + right / 2;
  // The flat `SkinPreview` proportions: 16x32 skin pixels, head 8x8, torso 8x12,
  // arms 4 wide hanging at the sides, legs 4 each. Drawn at 7px per pixel so the
  // body fills the viewer instead of floating in it as a cross.
  const u = 7;
  const bodyW = 8 * u;
  const headH = 8 * u;
  const torsoH = 12 * u;
  const legH = 12 * u;
  const armW = 4 * u;
  const px = cx - bodyW / 2;
  const headY = y + 26;
  const torsoY = headY + headH;
  // Legs first, so the torso overlaps their top edge the way the model does.
  fillRound(ctx, px, torsoY + torsoH, 4 * u, legH, 1, "#5a7aa8");
  fillRound(ctx, px + 4 * u, torsoY + torsoH, 4 * u, legH, 1, "#63839f");
  // Arms.
  fillRound(ctx, px - armW, torsoY, armW, torsoH, 1, "#6d92c4");
  fillRound(ctx, px + bodyW, torsoY, armW, torsoH, 1, "#7498c8");
  // Torso and head.
  fillRound(ctx, px, torsoY, bodyW, torsoH, 1, "#7fa8dd");
  fillRound(ctx, px, headY, bodyW, headH, 1, "#8cb4e4");
  // A face: two eyes and a mouth, so it reads as a character rather than a slab.
  ctx.fillStyle = "rgba(20,26,38,0.75)";
  for (const ex of [px + 2 * u, px + 5 * u]) {
    ctx.fillRect(ex, headY + 3 * u, u, u);
  }
  ctx.fillRect(px + 3 * u, headY + 5.5 * u, 2 * u, Math.max(2, u / 2));

  text(
    ctx,
    "Этот скин отправлен на сервер — вы выглядите так в игре.",
    vx,
    y + 288 + 22,
    {
      size: 10,
      color: rgba(T.mutedForeground),
      maxWidth: right,
      lineHeight: 14,
    },
  );
}

// ───────────────────────────── main ─────────────────────────────

export const SCREENS = [
  ["welcome", screenWelcome],
  ["connecting", screenConnecting],
  ["account", screenAccount],
  ["servers", screenServers],
  ["server", screenServer],
  ["wardrobe", screenWardrobe],
  ["profile", screenProfile],
  ["settings", screenSettings],
];

function render(screen) {
  const canvas = createCanvas(SHOT_WIDTH, SHOT_HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.textAlign = "left";
  screen(ctx);
  return canvas.encodeSync("png");
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  mkdirSync(outDir, { recursive: true });
  let failures = 0;
  for (const [name, screen] of SCREENS) {
    const file = path.join(outDir, `line-${name}.png`);
    if (checkOnly) {
      try {
        readFileSync(file);
      } catch {
        console.error(`нет ${path.relative(root, file)}`);
        failures += 1;
      }
      continue;
    }
    writeFileSync(file, render(screen));
    console.log(`${path.relative(root, file)}  ${SHOT_WIDTH}x${SHOT_HEIGHT}`);
  }
  if (failures) {
    console.error(
      `Отсутствует ${failures} изображений. Запустите: node scripts/render-screens.mjs`,
    );
    process.exit(1);
  }
  if (!checkOnly)
    console.log(
      `Все ${SCREENS.length} экранов одного размера: ${SHOT_WIDTH}x${SHOT_HEIGHT}`,
    );
}
