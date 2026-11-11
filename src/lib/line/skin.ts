import type { SkinModel } from "@/types/line";
import { t } from "./i18n-core.ts";

/** Minecraft accepts exactly these texture sizes. */
export const SKIN_SIZES = [
  [64, 64],
  [64, 32],
] as const;
export const MAX_SKIN_BYTES = 256 * 1024;

export interface SkinRect {
  /** Source rectangle inside the texture. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination inside the 16x32 front silhouette. */
  dx: number;
  dy: number;
  /** Mirror horizontally (legacy 64x32 reuses the right limbs). */
  flip?: boolean;
}

/**
 * Front-view rectangles for a Minecraft skin, in paint order.
 *
 * `classic` has 4px arms, `slim` has 3px. A 64x32 texture has no left limbs or
 * overlay layer, so the right limbs are mirrored — the same rule the game uses.
 * Kept pure so the geometry can be unit-tested without a canvas.
 */
export function skinLayout(model: SkinModel, legacy = false): SkinRect[] {
  const arm = model === "slim" ? 3 : 4;
  const rects: SkinRect[] = [
    // Head
    { sx: 8, sy: 8, sw: 8, sh: 8, dx: 4, dy: 0 },
    // Torso
    { sx: 20, sy: 20, sw: 8, sh: 12, dx: 4, dy: 8 },
    // Right arm sits left of the torso in a front view.
    { sx: 44, sy: 20, sw: arm, sh: 12, dx: 4 - arm, dy: 8 },
    // Right leg
    { sx: 4, sy: 20, sw: 4, sh: 12, dx: 4, dy: 20 },
  ];
  if (legacy) {
    rects.push(
      { sx: 44, sy: 20, sw: arm, sh: 12, dx: 12, dy: 8, flip: true },
      { sx: 4, sy: 20, sw: 4, sh: 12, dx: 8, dy: 20, flip: true },
    );
    return rects;
  }
  rects.push(
    // Left arm / left leg have their own region since 1.8.
    { sx: 36, sy: 52, sw: arm, sh: 12, dx: 12, dy: 8 },
    { sx: 20, sy: 52, sw: 4, sh: 12, dx: 8, dy: 20 },
    // Overlay ("hat"/jacket) layer, painted last so it sits on top.
    { sx: 40, sy: 8, sw: 8, sh: 8, dx: 4, dy: 0 },
    { sx: 20, sy: 36, sw: 8, sh: 12, dx: 4, dy: 8 },
    { sx: 44, sy: 36, sw: arm, sh: 12, dx: 4 - arm, dy: 8 },
    { sx: 4, sy: 36, sw: 4, sh: 12, dx: 4, dy: 20 },
    { sx: 52, sy: 52, sw: arm, sh: 12, dx: 12, dy: 8 },
    { sx: 4, sy: 52, sw: 4, sh: 12, dx: 8, dy: 20 },
  );
  return rects;
}

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read the IHDR fields. Returns null when this is not a PNG at all. */
export function readPngHeader(bytes: Uint8Array): PngHeader | null {
  if (bytes.length < 33) return null;
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return null;
  const tag = String.fromCharCode(...bytes.subarray(12, 16));
  if (tag !== "IHDR") return null;
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
    interlace: bytes[28],
  };
}

/**
 * Same rules as the Rust validator, applied before upload so the player gets an
 * immediate message instead of a round trip. Rust revalidates regardless.
 */
export function validateSkinFile(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return t("skin.errEmpty");
  if (bytes.length > MAX_SKIN_BYTES) {
    return t("wardrobe.fileTooBig");
  }
  const header = readPngHeader(bytes);
  if (!header) return t("skin.errNotPng");
  if (!SKIN_SIZES.some(([w, h]) => w === header.width && h === header.height)) {
    return t("skin.errSize", { width: header.width, height: header.height });
  }
  // Palette PNGs are valid skins (see the Rust validator): only greyscale,
  // greyscale+alpha and 16-bit channels are refused. Depth 8 is still checked
  // first because a 16-bit PNG of any colour type is a different texture.
  if (header.bitDepth !== 8 || ![2, 3, 6].includes(header.colourType)) {
    return t("skin.errDepth");
  }
  if (header.interlace !== 0) return t("skin.errInterlaced");
  return null;
}

/** A 64x32 texture predates the dual-limb layout. */
export function isLegacySkin(header: PngHeader): boolean {
  return header.height === 32;
}
