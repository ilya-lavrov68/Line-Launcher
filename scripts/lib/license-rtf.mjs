// Convert the plain-text LICENSE into an ASCII-only RTF for the WiX MSI dialog.
//
// Why this exists: tauri-bundler wraps a non-.rtf `licenseFile` in a minimal
// `\rtf1\ansi\ansicpg1252` document and inserts the raw text, only translating
// newlines. Our LICENSE is bilingual, so its Cyrillic reaches WiX as characters
// that cannot be encoded in the MSI database code page (1252 for en-US) and
// `light.exe` fails with LGHT0311.
//
// When `licenseFile` already ends in .rtf the bundler passes it through
// untouched. Emitting every non-ASCII character as an RTF \uN escape keeps the
// file pure ASCII — so any MSI code page works — while RichEdit still renders
// the original Cyrillic. Switching the installer language to ru-RU would hide
// the build error but leave the text mis-decoded, so it is not the fix.

const HEADER =
  "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1" +
  "{\\fonttbl{\\f0\\fmodern\\fcharset0 Consolas;}}" +
  "{\\*\\generator Line Launcher license-rtf}" +
  "\\viewkind4\\pard\\f0\\fs18 ";

/** RTF \uN takes a signed 16-bit value; astral chars become a surrogate pair. */
function unicodeEscape(codePoint) {
  const signed = (n) => (n > 0x7fff ? n - 0x10000 : n);
  if (codePoint <= 0xffff) return `\\u${signed(codePoint)}?`;
  const v = codePoint - 0x10000;
  const high = 0xd800 + (v >> 10);
  const low = 0xdc00 + (v & 0x3ff);
  return `\\u${signed(high)}?\\u${signed(low)}?`;
}

/**
 * @param {string} text plain license text
 * @returns {string} ASCII-only RTF
 */
export function licenseToRtf(text) {
  let body = "";
  // Normalize first so a CRLF checkout produces byte-identical output.
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    switch (ch) {
      case "\\":
        body += "\\\\";
        break;
      case "{":
        body += "\\{";
        break;
      case "}":
        body += "\\}";
        break;
      case "\n":
        body += "\\par\n";
        break;
      case "\t":
        body += "\\tab ";
        break;
      default: {
        const cp = ch.codePointAt(0);
        body += cp < 0x80 ? ch : unicodeEscape(cp);
      }
    }
  }
  return `${HEADER}${body}}\n`;
}

/**
 * Recover the plain text from RTF produced by licenseToRtf, so a test can prove
 * the conversion is lossless. Only handles the escapes this module emits.
 */
export function rtfToPlainText(rtf) {
  const start = rtf.indexOf("\\fs18 ");
  if (start < 0) throw new Error("not a license RTF: header missing");
  let body = rtf.slice(start + "\\fs18 ".length);
  if (!body.endsWith("}\n"))
    throw new Error("not a license RTF: footer missing");
  body = body.slice(0, -2);

  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const rest = body.slice(i);
    const u = /^\\u(-?\d+)\?/.exec(rest);
    if (u) {
      const n = Number(u[1]);
      out += String.fromCharCode(n < 0 ? n + 0x10000 : n);
      i += u[0].length - 1;
      continue;
    }
    if (rest.startsWith("\\par\n")) {
      out += "\n";
      i += "\\par\n".length - 1;
      continue;
    }
    if (rest.startsWith("\\tab ")) {
      out += "\t";
      i += "\\tab ".length - 1;
      continue;
    }
    if (["\\\\", "\\{", "\\}"].some((e) => rest.startsWith(e))) {
      out += rest[1];
      i += 1;
      continue;
    }
    throw new Error(`unexpected RTF escape at ${i}: ${rest.slice(0, 12)}`);
  }
  // Surrogate pairs recombine automatically when concatenated.
  return out;
}
