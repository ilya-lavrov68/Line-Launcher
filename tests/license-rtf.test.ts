import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { licenseToRtf, rtfToPlainText } from "../scripts/lib/license-rtf.mjs";
import {
  BRAND_CONFIG,
  MSI_CONFIG,
  buildPasses,
} from "../scripts/tauri-build.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const LICENSE = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
const RTF_PATH = path.join(ROOT, "src-tauri/LICENSE.rtf");

/** RFC 7386 merge, as the Tauri CLI applies -c overlays. */
function merge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const base =
        target[key] &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
          ? (target[key] as Record<string, unknown>)
          : {};
      target[key] = merge(base, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
  return target;
}

const readJson = (rel: string) =>
  JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

test("the bilingual LICENSE really is un-encodable in the MSI code page", () => {
  // This is the condition that produced LGHT0311; if it ever stops holding,
  // the RTF indirection can be reconsidered.
  assert.ok(/[^\x00-\x7F]/.test(LICENSE), "fixture must contain non-ASCII");
  assert.match(LICENSE, /Работает на Line Launcher/);
});

test("the generated RTF is pure ASCII, so any MSI code page accepts it", () => {
  const rtf = readFileSync(RTF_PATH, "utf8");
  assert.ok(
    !/[^\x00-\x7F]/.test(rtf),
    "a non-ASCII byte in the RTF would reintroduce LGHT0311",
  );
  assert.match(rtf, /^\{\\rtf1\\ansi\\ansicpg1252/);
  assert.match(rtf, /\\uc1/, "the fallback-character count must be declared");
});

test("every Cyrillic character becomes a signed \\uN escape with a fallback", () => {
  const rtf = licenseToRtf("Работает на Line Launcher — «тест»");
  assert.ok(!/[^\x00-\x7F]/.test(rtf));
  // Р = U+0420 = 1056, em dash = U+2014 = 8212, « = U+00AB = 171
  assert.match(rtf, /\\u1056\?/);
  assert.match(rtf, /\\u8212\?/);
  assert.match(rtf, /\\u171\?/);
  assert.match(rtf, /Line Launcher/);
});

test("code points above 32767 use RTF's signed 16-bit form", () => {
  const rtf = licenseToRtf("\uFFFD"); // 65533 -> -3
  assert.match(rtf, /\\u-3\?/);
});

test("astral characters become a surrogate pair", () => {
  const rtf = licenseToRtf("\u{1F600}"); // 😀
  assert.ok(!/[^\x00-\x7F]/.test(rtf));
  assert.match(rtf, /\\u-10179\?\\u-8704\?/);
  assert.equal(rtfToPlainText(rtf), "\u{1F600}");
});

test("RTF metacharacters in the license cannot break the document", () => {
  const text = "a\\b{c}d";
  const rtf = licenseToRtf(text);
  assert.match(rtf, /a\\\\b\\\{c\\\}d/);
  assert.equal(rtfToPlainText(rtf), text);
});

test("the conversion is lossless for the whole license", () => {
  const rtf = licenseToRtf(LICENSE);
  assert.equal(rtfToPlainText(rtf), LICENSE.replace(/\r\n?/g, "\n"));
});

test("a CRLF checkout produces byte-identical RTF", () => {
  assert.equal(
    licenseToRtf(LICENSE),
    licenseToRtf(LICENSE.replace(/\n/g, "\r\n")),
  );
});

test("the committed RTF is current", () => {
  assert.equal(
    readFileSync(RTF_PATH, "utf8"),
    licenseToRtf(LICENSE),
    "run: npm run brand",
  );
});

test("NSIS keeps the plain license and MSI switches to the RTF", () => {
  const base = readJson("src-tauri/tauri.conf.json");
  const brand = readJson("src-tauri/tauri.brand.conf.json");
  const msi = readJson("src-tauri/tauri.msi.conf.json");

  const nsisCfg = merge(structuredClone(base), brand) as {
    bundle: { licenseFile: string };
  };
  const msiCfg = merge(merge(structuredClone(base), brand), msi) as {
    bundle: { licenseFile: string };
  };

  // NSIS renders licenseFile verbatim, so RTF there would show escape codes.
  assert.equal(nsisCfg.bundle.licenseFile, "../LICENSE");
  assert.equal(msiCfg.bundle.licenseFile, "LICENSE.rtf");

  for (const cfg of [nsisCfg, msiCfg]) {
    assert.ok(
      existsSync(path.join(ROOT, "src-tauri", cfg.bundle.licenseFile)),
      `licenseFile must resolve: ${cfg.bundle.licenseFile}`,
    );
  }
  const msiBytes = readFileSync(
    path.join(ROOT, "src-tauri", msiCfg.bundle.licenseFile),
  );
  assert.ok(!msiBytes.some((b) => b > 127), "the MSI license must be ASCII");
});

test("the MSI overlay only touches licenseFile, leaving the bundle intact", () => {
  const msi = readJson("src-tauri/tauri.msi.conf.json");
  assert.deepEqual(Object.keys(msi.bundle), ["licenseFile"]);
  const base = readJson("src-tauri/tauri.conf.json");
  const merged = merge(structuredClone(base), msi) as typeof base;
  // Resources and icons must survive the overlay merge.
  assert.deepEqual(merged.bundle.resources, base.bundle.resources);
  assert.deepEqual(merged.bundle.icon, base.bundle.icon);
  assert.equal(merged.bundle.publisher, base.bundle.publisher);
});

test("Windows builds NSIS first, then MSI with the RTF overlay", () => {
  const passes = buildPasses("win32");
  assert.equal(passes.length, 2);
  assert.deepEqual(passes[0].args, ["--bundles", "nsis"]);
  assert.deepEqual(passes[1].args, ["--bundles", "msi", "-c", MSI_CONFIG]);
  // The MSI overlay must come after the brand overlay so it wins the merge.
  assert.equal(BRAND_CONFIG, "src-tauri/tauri.brand.conf.json");
  assert.equal(MSI_CONFIG, "src-tauri/tauri.msi.conf.json");
});

test("other platforms keep a single unfiltered pass", () => {
  for (const platform of ["linux", "darwin"]) {
    const passes = buildPasses(platform);
    assert.equal(passes.length, 1);
    // No --bundles filter: deb/rpm/AppImage and dmg must still be produced.
    assert.deepEqual(passes[0].args, []);
  }
});

test("the build command and the release workflow both use the wrapper", () => {
  const pkg = readJson("package.json");
  assert.match(pkg.scripts["tauri:build"], /scripts\/tauri-build\.mjs/);
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/release.yml"),
    "utf8",
  );
  assert.match(workflow, /node scripts\/tauri-build\.mjs/);
  assert.ok(
    !/tauri build -- -c/.test(workflow),
    "a raw `tauri build` would reintroduce LGHT0311 on Windows",
  );
});
