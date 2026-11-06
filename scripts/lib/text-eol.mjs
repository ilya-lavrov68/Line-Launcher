// Line-ending tolerant text comparison.
//
// Git for Windows defaults to core.autocrlf=true, so a committed LF file is
// checked out as CRLF. Comparing generated output byte-for-byte then reports
// "out of date" on every run: the icon stamp never matched, which made
// `npm run dev` regenerate all OS icons on each launch.

/** Normalize CRLF/CR to LF so comparisons are checkout-independent. */
export function normalizeEol(text) {
  return text.replace(/\r\n?/g, "\n");
}

/** True when two texts differ only by line endings (or not at all). */
export function sameText(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return normalizeEol(a) === normalizeEol(b);
}
