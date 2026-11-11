/**
 * Reading a skin's arm width out of its pixels.
 *
 * A Minecraft skin does not declare whether it is classic (4px arms) or slim
 * (3px arms): the format has no field for it. The game guesses from the texture
 * and so does every skin editor — the left and right arm strips are 4 or 3
 * pixels wide, and the remaining column is either transparent or a duplicate of
 * the face column next to it.
 *
 * The launcher asked the player to pick the model from a dropdown, which means
 * the launcher could be told the wrong thing about a file that already knows:
 * upload a slim skin with "classic" selected and the game renders wide arms on a
 * narrow body. The dropdown is still there for the case where the detection is
 * genuinely ambiguous, but it starts out reading the file instead of asking.
 *
 * ## What is inspected
 *
 * Only the arm strips, and only their alpha:
 *
 * | region            | classic            | slim               |
 * |-------------------|--------------------|--------------------|
 * | right arm (40,20) | 4 columns, 16 rows | 3 columns, 16 rows |
 * | left arm  (32,52) | 4 columns, 16 rows | 3 columns, 16 rows |
 * | right leg (0,20)  | 4 columns, 16 rows | 4 columns (same)   |
 *
 * The arm faces at x=44..47 (right) and x=36..39 (left) are what the split
 * affects, but the *column that disappears* is the last one of the arm strip,
 * so the useful question is "is the pixel just past a 3px arm ever painted?".
 * For a slim skin the fourth column of the arm is never used; for a classic one
 * it is part of the arm, which is almost always painted — a fully transparent
 * arm is possible (a bare-skin-armed character) but then the skin looks
 * identical either way, and "classic" is the safer default.
 *
 * ## Why the alpha channel and not RGB
 *
 * Transparent pixels in a PNG usually carry black RGB. Reading colour would
 * count every unpainted pixel as "painted". Alpha is the only channel that
 * distinguishes "this column belongs to the arm" from "this column is padding".
 */

export type DetectedSkinModel = "classic" | "slim" | "unknown";

/** The arm strips, in texture coordinates, for a 64x64 skin. */
const ARMS = [
  // Right arm: the 16x16 face block starts at (40, 16); its first 16 rows of
  // pixels at x=40..43 are the side of the arm.
  { x: 40, y: 20, width: 4, height: 16 },
  // Left arm, only present since 1.8 (64x64 textures).
  { x: 32, y: 52, width: 4, height: 16 },
] as const;

export interface SkinPixels {
  width: number;
  height: number;
  /** RGBA, row-major, four bytes per pixel. */
  data: Uint8ClampedArray | Uint8Array;
}

/** Alpha of one pixel, or 0 for coordinates outside the texture. */
function alphaAt(pixels: SkinPixels, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return 0;
  return pixels.data[(y * pixels.width + x) * 4 + 3] ?? 0;
}

/**
 * Does the arm strip at `strip` use its fourth column?
 *
 * Counted over every row of the arm. One painted pixel is enough: a skin may
 * legitimately leave most of an arm transparent (sleeves, cutouts), but a slim
 * texture's fourth column is *outside the UV mapping entirely*, so it stays
 * transparent on every row.
 */
function fourthColumnUsed(
  pixels: SkinPixels,
  strip: (typeof ARMS)[number],
): boolean {
  const x = strip.x + 3;
  for (let row = 0; row < strip.height; row += 1) {
    if (alphaAt(pixels, x, strip.y + row) > 8) return true;
  }
  return false;
}

/** How much of the 3px arm itself is painted, as a 0..1 share of its pixels. */
function armCoverage(pixels: SkinPixels, strip: (typeof ARMS)[number]): number {
  let painted = 0;
  let total = 0;
  for (let row = 0; row < strip.height; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      total += 1;
      if (alphaAt(pixels, strip.x + column, strip.y + row) > 8) painted += 1;
    }
  }
  return total === 0 ? 0 : painted / total;
}

/**
 * Decide the model from decoded pixels.
 *
 * Returns `unknown` rather than guessing when the texture gives no evidence —
 * a 64x32 legacy texture has no left arm at all, and a completely unpainted pair
 * of arms is ambiguous. The caller keeps whatever the player chose in that case,
 * so a detection failure is never worse than not having detection.
 */
export function detectSkinModel(pixels: SkinPixels): DetectedSkinModel {
  const { width, height } = pixels;
  if (width !== 64 || (height !== 64 && height !== 32)) return "unknown";

  // A legacy 64x32 texture predates slim arms (they arrived with 1.8, together
  // with the 64x64 layout), so its model is settled without looking further.
  if (height === 32) return "classic";

  const right = ARMS[0];
  const left = ARMS[1];
  const rightUsesFourth = fourthColumnUsed(pixels, right);
  const leftUsesFourth = fourthColumnUsed(pixels, left);

  // Either arm using its fourth column is proof of a classic texture: a slim one
  // cannot paint there, because that column is not part of any face.
  if (rightUsesFourth || leftUsesFourth) return "classic";

  // Neither does. That is what a slim skin looks like — but it is also what an
  // entirely blank arm looks like. Require that the 3px arm itself carries
  // pixels, otherwise the texture has told us nothing.
  const evidence =
    Math.max(armCoverage(pixels, right), armCoverage(pixels, left)) > 0;
  return evidence ? "slim" : "unknown";
}
