/**
 * Decoding a PNG to RGBA, in the webview.
 *
 * The browser already has a PNG decoder: an `<img>` plus a 2D canvas. That is
 * what this uses — no new dependency, and it is the same decoder that will draw
 * the skin, so the pixels inspected here are the pixels the player will see.
 *
 * `createImageBitmap` is preferred where available because it decodes off the
 * main thread; the `<img>` path is the fallback for older WebViews. Both are
 * wrapped so a failure is a `null`, never an exception in the middle of an
 * upload.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function drawToData(
  source: CanvasImageSource,
  width: number,
  height: number,
): RgbaImage | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  // Pixel truth only: smoothing would blend a neighbouring column into the one
  // being inspected, which is exactly the boundary this decoder is used to read.
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

async function decodeWithImage(bytes: Uint8Array): Promise<RgbaImage | null> {
  const blob = new Blob([bytes as BlobPart], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => resolve(null);
      element.src = url;
    });
    if (!image) return null;
    return drawToData(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode PNG bytes into RGBA. Returns `null` when the platform cannot (no
 * canvas, a corrupt file, a WebView without `createImageBitmap` *and* without
 * blob URLs) — callers treat that as "could not inspect", never as a failure of
 * the upload itself.
 */
export async function decodePng(bytes: Uint8Array): Promise<RgbaImage | null> {
  try {
    if (typeof createImageBitmap === "function") {
      const blob = new Blob([bytes as BlobPart], { type: "image/png" });
      try {
        const bitmap = await createImageBitmap(blob);
        try {
          return drawToData(bitmap, bitmap.width, bitmap.height);
        } finally {
          bitmap.close();
        }
      } catch {
        // Fall through to the <img> path rather than failing: a WebView may
        // refuse createImageBitmap for a blob it will happily decode in an img.
      }
    }
    return await decodeWithImage(bytes);
  } catch {
    return null;
  }
}
