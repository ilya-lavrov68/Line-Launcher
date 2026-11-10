// Draws the README screenshots without a browser.
//
//   node scripts/render-screens.mjs            # writes docs/images/line-*.png
//   node scripts/render-screens.mjs --check    # fails if any image is missing
//   SHOTS_DIR=/tmp/out node scripts/render-screens.mjs
//
// Why this exists: `npm run screenshots` renders the real app through
// playwright-core and is the source of truth. It needs Chrome/Edge, which some
// build machines (and CI containers without libnss) do not have. This script is
// the deterministic fallback: every colour is read from `src/styles/themes.css`,
// the same tokens the app renders with, and every screen is laid out at one fixed
// size (1280x800) so the gallery never mixes tall and short images again.
//
// It draws the *current* design (`data-theme="line"`). The old design is
// reachable in the app; the README only shows what a new user sees.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(
  process.env.SHOTS_DIR || path.join(root, "docs/images"),
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

/** The `"line"` palette block from themes.css, resolved through `var()`. */
export function loadTokens() {
  const sheet = css("src/styles/themes.css");
  /** Declarations inside the block that opens at `selector`. */
  const readBlock = (selector, from = 0) => {
    const start = sheet.indexOf(selector, from);
    if (start < 0) throw new Error(`themes.css: не найден блок ${selector}`);
    const open = sheet.indexOf("{", start);
    const close = sheet.indexOf("\n}", open);
    const found = new Map();
    for (const line of sheet.slice(open, close).split("\n")) {
      const decl = /^\s*(--[\w-]+):\s*([^;]+);/.exec(line);
      if (decl) found.set(decl[1], decl[2].trim());
    }
    return found;
  };
  // `:root` holds the additive ladder (--fill*, --surface-glass, --radius-*)
  // that both themes share; `[data-theme="line"]` re-declares the legacy slots.
  // Reading only the second block silently resolved every additive token to the
  // white fallback — white cards on a dark page.
  const raw = new Map([
    ...readBlock(":root {"),
    ...readBlock('[data-theme="line"] {'),
  ]);
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
    online: color("--line-online"),
    update: color("--line-update"),
    offline: color("--line-offline"),
    destructive: color("--destructive"),
    sidebar: color("--sidebar"),
    popover: color("--popover"),
  };
}

const T = loadTokens();

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
  lines.forEach((line, index) => {
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
  return lines.length;
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
  ctx.fillStyle = rgba(T.background);
  ctx.fillRect(0, 0, SHOT_WIDTH, SHOT_HEIGHT);
  const glow = ctx.createRadialGradient(1000, -80, 40, 1000, -80, 900);
  glow.addColorStop(0, rgba(T.primary, 0.14));
  glow.addColorStop(1, rgba(T.primary, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SHOT_WIDTH, SHOT_HEIGHT);
  const glow2 = ctx.createRadialGradient(60, 780, 20, 60, 780, 700);
  glow2.addColorStop(0, rgba(T.primary, 0.09));
  glow2.addColorStop(1, rgba(T.primary, 0));
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, SHOT_WIDTH, SHOT_HEIGHT);
}

function titleBar(ctx, context, trailing) {
  const h = 44;
  ctx.fillStyle = rgba(T.fillSubtle, 1);
  ctx.fillRect(0, 0, SHOT_WIDTH, h);
  ctx.strokeStyle = rgba(T.border, 0.6);
  ctx.beginPath();
  ctx.moveTo(0, h - 0.5);
  ctx.lineTo(SHOT_WIDTH, h - 0.5);
  ctx.stroke();

  // Brand mark: a tilted "L" bracket, the same silhouette as branding/logo.svg.
  ctx.save();
  ctx.translate(18, 13);
  ctx.strokeStyle = rgba(T.primary);
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(1, 3);
  ctx.lineTo(10, 3);
  ctx.moveTo(6, 3);
  ctx.lineTo(12, 15);
  ctx.moveTo(6, 15);
  ctx.lineTo(17, 15);
  ctx.stroke();
  ctx.restore();

  text(ctx, "Line Launcher", 38, 27, { size: 12, weight: 600 });
  if (context) {
    text(ctx, "/", 38 + measure(ctx, "Line Launcher", 12, 600) + 8, 27, {
      size: 12,
      color: rgba(T.mutedForeground, 0.6),
    });
    text(ctx, context, 38 + measure(ctx, "Line Launcher", 12, 600) + 20, 27, {
      size: 12,
      color: rgba(T.mutedForeground),
    });
  }
  if (trailing) {
    const w = measure(ctx, trailing, 11, 500) + 34;
    const x = SHOT_WIDTH - w - 100;
    fillRound(ctx, x, 12, w, 22, 8, rgba(T.fill, 1));
    strokeRound(ctx, x, 12, w, 22, 8, rgba(T.border), 1);
    icon(ctx, "sparkles", x + 9, 17, 12, rgba(T.mutedForeground));
    text(ctx, trailing, x + 25, 27, {
      size: 11,
      color: rgba(T.mutedForeground),
    });
  }
  // Caption buttons.
  const cap = ["minus", "square", "x"];
  cap.forEach((name, index) => {
    const cx = SHOT_WIDTH - 128 + index * 40;
    icon(ctx, name, cx + 12, 14, 14, rgba(T.mutedForeground, 0.9), 1.5);
  });
  return h;
}

const NAV = [
  { icon: "server", label: "Серверы", id: "servers" },
  { icon: "shirt", label: "Гардероб", id: "wardrobe" },
  { icon: "settings", label: "Настройки", id: "settings" },
];

function sideNav(ctx, top, height, active, { providerName, username } = {}) {
  const w = 208;
  ctx.save();
  ctx.fillStyle = rgba(T.sidebar, 0.92);
  ctx.fillRect(0, top, w, height);
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
  const themeTop = aboutTop - 36;
  const reconnectTop = themeTop - 36;
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
    ["moon", "Старый дизайн", themeTop],
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
  ctx.strokeStyle = rgba(T.border, 0.5);
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.lineTo(SHOT_WIDTH, top);
  ctx.stroke();
  text(ctx, "Line | 0.1.0", 16, top + 15, {
    size: 9,
    color: rgba(T.mutedForeground, 0.8),
  });
  icon(
    ctx,
    "shield",
    SHOT_WIDTH - 176,
    top + 5,
    11,
    rgba(T.mutedForeground, 0.8),
    1.6,
  );
  text(ctx, "Только авторизация провайдера", SHOT_WIDTH - 160, top + 15, {
    size: 9,
    color: rgba(T.mutedForeground, 0.8),
  });
}

function glass(ctx, x, y, w, h, radius = 18) {
  fillRound(ctx, x, y, w, h, radius, rgba(T.surfaceGlass));
  strokeRound(ctx, x, y, w, h, radius, rgba(T.border), 1);
  // Top inner highlight: the same 1px inset the CSS adds.
  ctx.save();
  roundRect(ctx, x + 1, y + 1, w - 2, h - 2, radius - 1);
  ctx.clip();
  const sheen = ctx.createLinearGradient(x, y, x, y + h);
  sheen.addColorStop(0, "rgba(255,255,255,0.06)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.01)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
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
  const gradient = ctx.createLinearGradient(x, y, x + width, y);
  gradient.addColorStop(0, rgba(T.primary));
  gradient.addColorStop(1, rgba(T.primary, 0.7));
  fillRound(ctx, x, y, width, 8, 4, gradient);
  strokeRound(ctx, x, y, w, 8, 4, "rgba(255,255,255,0.10)", 1);
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
function shell(
  ctx,
  context,
  { active = "servers", signedIn = false, pill = false } = {},
) {
  background(ctx);
  const top = titleBar(ctx, context, pill ? "Старый дизайн" : undefined);
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
  const { centerX, centerY } = shell(ctx, "Подключение", { pill: true });

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
 * Sign-in. Real structure: brand mark, provider name, one sentence, then the
 * glass card that holds AuthForm — the card the browser screenshot shows.
 */
function screenAccount(ctx) {
  const { centerX, top } = shell(ctx, "Plus In Plus Demo", { pill: true });
  const cardW = 448;
  const x = centerX - cardW / 2;
  let y = top + 40;

  // BrandMark, 36px tall, centred above the provider name.
  ctx.save();
  ctx.translate(centerX - 13, y);
  ctx.strokeStyle = rgba(T.primary);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 2);
  ctx.lineTo(11, 2);
  ctx.moveTo(7, 2);
  ctx.lineTo(13, 17);
  ctx.moveTo(7, 17);
  ctx.lineTo(20, 17);
  ctx.stroke();
  ctx.restore();
  y += 52;
  text(ctx, "Plus In Plus Demo", centerX, y, {
    size: 24,
    weight: 600,
    align: "center",
  });
  y += 16;
  text(
    ctx,
    // AccountScreen builds this from `servers.length`; the demo config has two.
    "Войдите один раз — и все серверы проекта будут доступны. Сейчас в проекте 2 сервера.",
    centerX,
    y,
    {
      size: 12,
      color: rgba(T.mutedForeground),
      align: "center",
      maxWidth: 448,
      lineHeight: 18,
    },
  );
  y += 40;

  // Card height is derived from its own contents (24px padding, two 88px
  // fields, the tab row and a 40px button), not guessed: an oversized card
  // leaves a dead strip under «Войти».
  const cardH = 24 + 66 + 44 + 2 * 88 + 2 + 4 + 40 + 24;
  glass(ctx, x, y, cardW, cardH, 16);
  const ix = x + 24;
  const innerW = cardW - 48;
  let iy = y + 24;

  text(ctx, "Аккаунт проекта", ix, iy + 12, { size: 14, weight: 600 });
  iy += 20;
  text(
    ctx,
    "Один аккаунт Plus In Plus Demo на все серверы проекта. Аккаунт Microsoft не нужен.",
    ix,
    iy + 12,
    {
      size: 11,
      color: rgba(T.mutedForeground),
      maxWidth: innerW,
      lineHeight: 15,
    },
  );
  iy += 46;

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

  const field = (label, value, placeholder, withLock) => {
    fillRound(ctx, ix, iy, innerW, 74, 10, rgba(T.fill, 0.35));
    strokeRound(ctx, ix, iy, innerW, 74, 10, rgba(T.border, 0.7), 1);
    text(ctx, label, ix + 12, iy + 21, { size: 12, weight: 600 });
    fillRound(
      ctx,
      ix + 12,
      iy + 30,
      innerW - 24,
      34,
      8,
      rgba(T.background, 0.55),
    );
    strokeRound(
      ctx,
      ix + 12,
      iy + 30,
      innerW - 24,
      34,
      8,
      rgba(T.input, 0.7),
      1,
    );
    if (withLock)
      icon(ctx, "lock", ix + 22, iy + 40, 14, rgba(T.mutedForeground));
    text(ctx, value || placeholder, ix + (withLock ? 46 : 24), iy + 52, {
      size: 12,
      color: value ? rgba(T.foreground) : rgba(T.mutedForeground, 0.7),
    });
    iy += 88;
  };
  // «Player_1» typed but not submitted: the password field stays empty so the
  // shot does not imply a stored secret.
  field("Логин", "Player_1", "Player_name", false);
  field("Пароль", "", "", true);

  // The reserved slot the form keeps for a validation message, then the button.
  iy += 2;
  button(ctx, ix, iy + 4, innerW, 40, "Войти", { size: 12 });
}

function serverCard(ctx, x, y, w, h, server) {
  fillRound(ctx, x, y, w, h, 12, rgba(T.fill, 0.24));
  strokeRound(ctx, x, y, w, h, 12, rgba(T.border, 0.9), 1);

  // Banner: gradient with the provider glyph, drawn the way the art helper does.
  const bh = 96;
  ctx.save();
  roundRect(ctx, x + 14, y + 14, w - 28, bh, 8);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + bh);
  g.addColorStop(0, server.from);
  g.addColorStop(1, server.to);
  ctx.fillStyle = g;
  ctx.fillRect(x + 14, y + 14, w - 28, bh);
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.beginPath();
  ctx.arc(x + w - 60, y + 20, 66, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.13)";
  [0, 1, 2].forEach((i) => {
    const barH = [26, 52, 38][i];
    ctx.fillRect(x + 54 + i * 34, y + 14 + 96 - 18 - barH, 26, barH);
  });
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = font(15, 700);
  ctx.textAlign = "center";
  ctx.fillText(server.glyph, x + (w - 28) / 2 + 14, y + 14 + 56);
  ctx.textAlign = "left";
  ctx.restore();

  // Icon + status chip.
  const iconTop = y + 124;
  fillRound(ctx, x + 20, iconTop, 44, 44, 10, server.from);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = font(19, 700);
  ctx.textAlign = "center";
  ctx.fillText(server.letter, x + 42, iconTop + 29);
  ctx.textAlign = "left";
  if (server.installed) chip(ctx, x + w - 118, iconTop + 2, "Установлен", "ok");

  text(ctx, server.name, x + 20, iconTop + 74, { size: 14, weight: 600 });
  const nameWidth = measure(ctx, server.name, 14, 600);
  fillRound(
    ctx,
    x + 28 + nameWidth,
    iconTop + 60,
    58,
    18,
    5,
    rgba(T.fill, 0.7),
  );
  text(ctx, server.version, x + 36 + nameWidth, iconTop + 73, {
    size: 10,
    color: rgba(T.mutedForeground),
    mono: true,
  });
  text(ctx, server.description, x + 20, iconTop + 96, {
    size: 11,
    color: rgba(T.mutedForeground),
    maxWidth: w - 40,
    lineHeight: 16,
  });
  fillRound(ctx, x + 20, y + h - 34, 92, 20, 5, rgba(T.fill, 0.7));
  text(ctx, `Minecraft ${server.minecraftVersion}`, x + 28, y + h - 20, {
    size: 9,
    color: rgba(T.mutedForeground),
    mono: true,
  });
  if (server.pack) {
    fillRound(ctx, x + 118, y + h - 34, 96, 20, 5, rgba(T.fill, 0.55));
    text(ctx, "ZIP + pack.json", x + 126, y + h - 20, {
      size: 9,
      color: rgba(T.mutedForeground),
      mono: true,
    });
  }
}

function catalogRail(ctx, x, y, w) {
  const h = 62;
  glass(ctx, x, y, w, h, 14);
  fillRound(ctx, x + 14, y + 13, 36, 36, 8, "#0f766e");
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = font(16, 700);
  ctx.textAlign = "center";
  ctx.fillText("S", x + 32, y + 37);
  ctx.textAlign = "left";
  text(ctx, "ТЕКУЩИЙ СЕРВЕР", x + 62, y + 24, {
    size: 8,
    weight: 500,
    color: rgba(T.mutedForeground),
  });
  text(ctx, "Survival", x + 62, y + 42, { size: 13, weight: 500 });
  text(ctx, STATUS_OK, x + 134, y + 42, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  fillRound(ctx, x + w - 102, y + 19, 88, 24, 8, rgba(T.fill, 0.8));
  strokeRound(ctx, x + w - 102, y + 19, 88, 24, 8, rgba(T.border), 1);
  icon(ctx, "play", x + w - 92, y + 25, 11, rgba(T.foreground, 0.9), 1.6);
  text(ctx, "Открыть", x + w - 76, y + 35, { size: 11, weight: 500 });
}

function screenServers(ctx) {
  background(ctx);
  const top = titleBar(ctx, "Plus In Plus Demo", undefined);
  const nav = 208;
  const footerH = 28;
  sideNav(ctx, top, SHOT_HEIGHT - top - footerH, "servers", {
    providerName: "Plus In Plus Demo",
    username: "Player_1",
  });
  appFooter(ctx, SHOT_HEIGHT - footerH, footerH);

  const contentX = nav + 32;
  const contentW = SHOT_WIDTH - contentX - 32;

  let y = top + 34;
  text(ctx, "Провайдер", contentX, y, {
    size: 10,
    weight: 500,
    color: rgba(T.mutedForeground),
  });
  y += 24;
  text(ctx, "Plus In Plus Demo", contentX, y, { size: 20, weight: 700 });
  button(ctx, SHOT_WIDTH - 32 - 118, top + 30, 118, 30, "Обновить", {
    variant: "outline",
    iconName: "refresh",
    size: 11,
  });

  y += 22;
  catalogRail(ctx, contentX, y, contentW);
  y += 62 + 22;

  const cardW = (contentW - 2 * 16) / 3;
  const cardH = 300;
  // Exactly the servers `examples/config.json` publishes — no invented third
  // card. The grid stays three columns wide, so two servers leave one empty
  // slot, which is what the real screen does.
  const servers = [
    {
      name: "Survival",
      glyph: "SURVIVAL",
      letter: "S",
      from: "#0f766e",
      to: "#052e2b",
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
      to: "#0b1a3a",
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

  // The action dock.
  const dockH = 214;
  glass(ctx, x, y, contentW, dockH, 18);
  fillRound(ctx, x + 16, y + 16, 44, 44, 12, rgba(T.fill, 1));
  icon(ctx, "wifi", x + 28, y + 28, 20, rgba(T.primary));
  text(ctx, "Survival", x + 74, y + 34, { size: 15, weight: 600 });
  icon(ctx, "check", x + 74, y + 46, 11, rgba(T.online), 2.2);
  const statusW = measure(ctx, STATUS_OK, 11, 400);
  text(ctx, STATUS_OK, x + 90, y + 55, {
    size: 11,
    color: rgba(T.mutedForeground),
  });
  // Version and loader sit after the status text, not under it: the status line
  // is localised and changes width, so a fixed offset overlapped on long ones.
  let metaX = x + 106 + statusW;
  for (const meta of ["2026.11.1", "MC 1.21.1"]) {
    text(ctx, meta, metaX, y + 55, {
      size: 10,
      color: rgba(T.mutedForeground, 0.8),
      mono: true,
    });
    metaX += measure(ctx, meta, 10, 400, true) + 16;
  }
  icon(ctx, "history", x + contentW - 44, y + 22, 16, rgba(T.mutedForeground));

  button(ctx, x + 16, y + 76, contentW - 32, 44, "Играть", {
    iconName: "play",
    size: 13,
  });

  // A second state in the same shot would be dishonest; instead show what the
  // dock looks like mid-download as a separate, clearly labelled block.
  const progressTop = y + 136;
  text(ctx, "Загрузка сборки · 45%", x + 16, progressTop, {
    size: 10,
    color: rgba(T.mutedForeground),
  });
  progressBar(ctx, x + 16, progressTop + 8, contentW - 32, 45);
  text(ctx, "Скачивание", x + 16, progressTop + 34, {
    size: 9,
    color: rgba(T.mutedForeground, 0.9),
  });
  text(
    ctx,
    "45%",
    x + contentW - 16 - measure(ctx, "45%", 9),
    progressTop + 34,
    {
      size: 9,
      color: rgba(T.mutedForeground, 0.9),
    },
  );

  icon(
    ctx,
    "shield",
    x + 16,
    y + dockH - 30,
    11,
    rgba(T.mutedForeground, 0.9),
    1.8,
  );
  text(
    ctx,
    "Офлайн-сборка провайдера: ник аккаунта проекта, Microsoft-вход не нужен.",
    x + 32,
    y + dockH - 21,
    { size: 9, color: rgba(T.mutedForeground, 0.9) },
  );

  y += dockH + 18;
  text(
    ctx,
    "Сборка скачается целиком: архив провайдера, проверка sha256 и распаковка. Прогресс виден здесь же, меню не блокируется.",
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
  text(
    ctx,
    "История скинов хранится на этом компьютере. Активный скин один на весь проект и отправляется на сервер сам — ничего нажимать не нужно.",
    x,
    y + 12,
    { size: 11, color: rgba(T.mutedForeground), maxWidth: w, lineHeight: 16 },
  );
  y += 40;

  // ── Card 1: add a texture. Idle form: picker, name, model select.
  // 18 padding + title/description + two stacked field rows + 18 padding.
  const addH = 18 + 44 + 58 + 8 + 50 + 18;
  glass(ctx, x, y, w, addH, 16);
  let iy = y + 18;
  text(ctx, "Добавить скин в историю", x + 20, iy + 10, {
    size: 12,
    weight: 600,
  });
  text(
    ctx,
    "PNG 64×64 или 64×32, до 256 КБ. Работает без входа и без интернета.",
    x + 20,
    iy + 30,
    {
      size: 10,
      color: rgba(T.mutedForeground),
    },
  );
  iy += 44;

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
  field(x + 20, "Файл текстуры", "Choose File · No file chosen");
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
  const tileH = 116;
  const historyH = 18 + 34 + 12 + rowH + 12 + tileH + 16;
  glass(ctx, x, y, w, historyH, 16);
  iy = y + 18;
  fillRound(ctx, x + 20, iy, 32, 32, 9, rgba(T.primary, 0.12));
  icon(ctx, "history", x + 28, iy + 8, 16, rgba(T.primary));
  text(ctx, "Локальная история", x + 60, iy + 13, { size: 12, weight: 600 });
  text(
    ctx,
    "3 из 64. Прежние скины остаются здесь и никуда не отправляются.",
    x + 60,
    iy + 29,
    {
      size: 10,
      color: rgba(T.mutedForeground),
    },
  );
  iy += 46;

  fillRound(ctx, x + 20, iy, w - 40, rowH, 10, rgba(T.fill, 0.3));
  strokeRound(ctx, x + 20, iy, w - 40, rowH, 10, rgba(T.border, 0.7), 1);
  icon(ctx, "user", x + 32, iy + 14, 16, rgba(T.mutedForeground));
  text(ctx, "Стандартный скин", x + 60, iy + 20, { size: 11, weight: 500 });
  text(ctx, "вернуть обычный вид", x + 60, iy + 35, {
    size: 9,
    color: rgba(T.mutedForeground),
  });
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
      active ? rgba(T.primary, 0.06) : rgba(T.fill, 0.3),
    );
    strokeRound(
      ctx,
      tx,
      iy,
      tileW,
      tileH,
      10,
      active ? rgba(T.primary, 0.4) : rgba(T.border, 0.7),
      1,
    );
    // SkinThumb renders the silhouette at 8x16 CSS px per skin pixel (h-16 w-8),
    // so 14 here keeps the same 2:4 proportions inside a 116px tile.
    drawSkin(ctx, tx + 14, iy + 10, 14, model);
    text(ctx, name, tx + 56, iy + 26, { size: 11, weight: 500 });
    text(ctx, `64×64 · ${model}`, tx + 56, iy + 42, {
      size: 9,
      color: rgba(T.mutedForeground),
      mono: true,
    });
    if (active) {
      text(ctx, "✓ активный", tx + 56, iy + 58, {
        size: 9,
        color: rgba(T.primary),
      });
    }
    fillRound(
      ctx,
      tx + 10,
      iy + tileH - 32,
      tileW - 44,
      22,
      6,
      rgba(T.fill, 0.5),
    );
    strokeRound(
      ctx,
      tx + 10,
      iy + tileH - 32,
      tileW - 44,
      22,
      6,
      rgba(T.border, 0.8),
      1,
    );
    text(
      ctx,
      active ? "Выбран" : "Выбрать",
      tx + 10 + (tileW - 44) / 2,
      iy + tileH - 17,
      {
        size: 9,
        align: "center",
        color: rgba(T.foreground, 0.9),
      },
    );
    icon(
      ctx,
      "trash",
      tx + tileW - 26,
      iy + tileH - 28,
      12,
      rgba(T.mutedForeground),
      1.6,
    );
  });
  y += historyH + 14;

  // ── Card 3: what the servers see. The upload already happened on its own.
  const syncH = 74;
  glass(ctx, x, y, w, syncH, 16);
  fillRound(ctx, x + 20, y + 18, 32, 32, 9, rgba(T.primary, 0.12));
  icon(ctx, "shirt", x + 28, y + 26, 16, rgba(T.primary));
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
  text(ctx, "Player_1 · на сервере: classic", x + 60, y + 64, {
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
    glass(ctx, x, y, w, height, 14);
    fillRound(ctx, x + 16, y + 16, 32, 32, 9, rgba(T.primary, 0.12));
    icon(ctx, iconName, x + 24, y + 24, 16, rgba(T.primary));
    text(ctx, title, x + 60, y + 32, { size: 12, weight: 600 });
    text(ctx, description, x + 60, y + 50, {
      size: 10,
      color: rgba(T.mutedForeground),
      maxWidth: w - 90,
      lineHeight: 15,
    });
    body(x + 16, y + 76, w - 32);
    y += height + 12;
  };

  section(
    "Память игры",
    "Автоматически подбирается 4096 МБ. Всего на компьютере 32768 МБ, доступно до 24576 МБ.",
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
    "Найдена встроенная среда: Eclipse Adoptium 25.0.3. Используется для всех сборок.",
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
  section(
    "Поведение и окно",
    "Что делает окно лаунчера после старта игры и какой размер использовать.",
    "monitor",
    190,
    (bx, by, bw) => {
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
    },
  );

  section(
    "Оформление",
    "Новый дизайн — стеклянные поверхности и один акцент на действие. Старый дизайн сохранён целиком и переключается мгновенно.",
    "palette",
    96,
    (bx, by, bw) => {
      button(ctx, bx, by, 196, 30, "Оформление: новый дизайн", {
        variant: "outline",
        size: 10,
        iconName: "moon",
      });
      text(
        ctx,
        "Выбор запоминается на этом компьютере и не влияет на сборки, аккаунт или настройки запуска.",
        bx + 212,
        by + 19,
        {
          size: 9,
          color: rgba(T.mutedForeground, 0.85),
          maxWidth: bw - 220,
          lineHeight: 13,
        },
      );
    },
  );
}

// ───────────────────────────── main ─────────────────────────────

export const SCREENS = [
  ["connecting", screenConnecting],
  ["account", screenAccount],
  ["servers", screenServers],
  ["server", screenServer],
  ["wardrobe", screenWardrobe],
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
