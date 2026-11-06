import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BrandConfig, BrandPalette } from "../branding/brand.types.ts";
import {
  BrandError,
  renderCss,
  renderTauriOverlay,
  renderTs,
  validateBrand,
} from "../scripts/brand-config.ts";

const presets = (
  JSON.parse(
    readFileSync(new URL("../branding/presets.json", import.meta.url), "utf8"),
  ) as { presets: Record<string, BrandPalette> }
).presets;

const shipped = JSON.parse(
  readFileSync(new URL("../branding/line.brand.json", import.meta.url), "utf8"),
) as BrandConfig;

function clone(): BrandConfig {
  return JSON.parse(JSON.stringify(shipped)) as BrandConfig;
}

test("shipped default preserves the upstream Obsy palette exactly", () => {
  const result = validateBrand(shipped, presets);
  // Zero overrides means src/index.css tokens win untouched.
  assert.deepEqual(result.palette, {});
  const css = renderCss(result.palette);
  assert.ok(!css.includes(":root"), "default must not emit a :root override");
  assert.ok(!css.includes("--radius"), "geometry must never be emitted");
});

test("no preset may override radius or geometry", () => {
  for (const [name, palette] of Object.entries(presets)) {
    for (const slot of Object.keys(palette)) {
      assert.ok(
        !/radius|spacing|size|font|shadow/i.test(slot),
        `preset ${name} overrides geometry slot ${slot}`,
      );
    }
  }
  const config = clone();
  // A downstream attempt to change rounding is rejected outright.
  (config.palette as Record<string, string>).radius = "0px";
  assert.throws(() => validateBrand(config, presets), BrandError);
});

test("attribution cannot be removed or disabled", () => {
  const missing = clone();
  delete (missing as Partial<BrandConfig>).attribution;
  assert.throws(() => validateBrand(missing, presets), /mandatory|required/);

  const disabled = clone();
  (disabled.attribution as unknown as Record<string, unknown>).enabled = false;
  assert.throws(() => validateBrand(disabled, presets), /mandatory/);

  const badPlacement = clone();
  (badPlacement.attribution as unknown as Record<string, unknown>).placement =
    "none";
  assert.throws(() => validateBrand(badPlacement, presets), /placement/);

  const badLanguage = clone();
  (badLanguage.attribution as unknown as Record<string, unknown>).language =
    "de";
  assert.throws(() => validateBrand(badLanguage, presets), /language/);

  const aboutOnly = clone();
  (aboutOnly.attribution as unknown as Record<string, unknown>).placement =
    "about";
  assert.throws(
    () => validateBrand(aboutOnly, presets),
    /main interface.*About-only/,
  );

  for (const key of ["hidden", "visible", "text", "enabled"]) {
    const extra = clone();
    (extra.attribution as unknown as Record<string, unknown>)[key] =
      key === "visible" ? false : "anything";
    assert.throws(
      () => validateBrand(extra, presets),
      key === "enabled" ? /mandatory/ : /mandatory.*cannot be customized/,
      `accepted attribution.${key}`,
    );
  }
});

test("every permitted placement/language keeps both exact credit strings", () => {
  for (const placement of ["footer", "header"] as const) {
    for (const language of ["ru", "en", "both"] as const) {
      const config = clone();
      config.attribution = { placement, language };
      const ts = renderTs(validateBrand(config, presets).config, null);
      assert.ok(ts.includes("Powered by Line Launcher | Plus In Plus"));
      assert.ok(ts.includes("Работает на Line Launcher | Plus In Plus"));
      assert.ok(!ts.includes("·"), "middle dot must not separate credit names");
    }
  }
});

test("credit constants retain both names and the vertical separator", () => {
  const config = clone();
  (config.attribution as unknown as Record<string, unknown>).text =
    "My Server only";
  assert.throws(() => validateBrand(config, presets), /cannot be customized/);
  const ts = renderTs(validateBrand(clone(), presets).config, null);
  for (const phrase of [
    "Powered by Line Launcher | Plus In Plus",
    "Работает на Line Launcher | Plus In Plus",
  ]) {
    assert.ok(ts.includes(phrase));
    assert.ok(phrase.includes("Line Launcher"));
    assert.ok(phrase.includes("Plus In Plus"));
  }
});

test("preset colours apply and explicit overrides win", () => {
  const config = clone();
  config.preset = "emerald";
  const presetOnly = validateBrand(config, presets);
  assert.equal(presetOnly.palette.primary, presets.emerald.primary);

  config.palette = { primary: "#ff0000" };
  const overridden = validateBrand(config, presets);
  assert.equal(overridden.palette.primary, "#ff0000");
  const css = renderCss(overridden.palette);
  assert.ok(css.includes("--primary: #ff0000;"));
  assert.ok(!css.includes("--radius"));
});

test("unknown preset and unknown palette slot are rejected", () => {
  const unknownPreset = clone();
  unknownPreset.preset = "does-not-exist";
  assert.throws(() => validateBrand(unknownPreset, presets), /unknown preset/);

  const unknownSlot = clone();
  (unknownSlot.palette as Record<string, string>).chart_1 = "#fff";
  assert.throws(
    () => validateBrand(unknownSlot, presets),
    /unknown palette slot/,
  );
});

test("colour slots reject CSS injection and references", () => {
  for (const value of [
    "red; } body { display: none",
    "var(--something)",
    "url(https://evil.example/x.png)",
    "#fff/*x*/",
    "expression(alert(1))",
    " ",
  ]) {
    const config = clone();
    config.palette = { primary: value };
    assert.throws(
      () => validateBrand(config, presets),
      BrandError,
      `accepted unsafe colour: ${value}`,
    );
  }
});

test("asset paths cannot escape branding/ and must be svg or png", () => {
  for (const path of [
    "../secrets.svg",
    "/etc/passwd.svg",
    "assets/../../evil.png",
    "assets/logo.gif",
    "assets\\logo.svg",
  ]) {
    const config = clone();
    config.assets = { logo: path };
    assert.throws(
      () => validateBrand(config, presets),
      BrandError,
      `accepted unsafe asset path: ${path}`,
    );
  }
});

test("app_id must be reverse-DNS and product text rejects markup", () => {
  for (const appId of ["notanid", ".leading.dot", "a..b", "com.example/x"]) {
    const config = clone();
    config.product.app_id = appId;
    assert.throws(() => validateBrand(config, presets), /app_id/);
  }
  const markup = clone();
  markup.product.name = "<script>alert(1)</script>";
  assert.throws(() => validateBrand(markup, presets), /markup/);
});

test("tauri overlay carries product identity and icon set", () => {
  const config = clone();
  config.product.name = "My Server Launcher";
  config.product.app_id = "com.example.launcher";
  const overlay = JSON.parse(
    renderTauriOverlay(validateBrand(config, presets).config, true),
  ) as {
    productName: string;
    identifier: string;
    app: { windows: { title: string }[] };
    bundle: { icon: string[]; publisher: string };
  };
  assert.equal(overlay.productName, "My Server Launcher");
  assert.equal(overlay.identifier, "com.example.launcher");
  assert.equal(overlay.app.windows[0].title, config.product.window_title);
  assert.ok(overlay.bundle.icon.includes("icons/icon.ico"));
  assert.ok(overlay.bundle.icon.includes("icons/icon.icns"));
  // The overlay must never touch geometry either.
  assert.equal(overlay.app.windows[0].title, config.product.window_title);
});

test("rendered output is deterministic", () => {
  const a = validateBrand(shipped, presets);
  const b = validateBrand(clone(), presets);
  assert.equal(renderCss(a.palette), renderCss(b.palette));
  assert.equal(renderTs(a.config, null), renderTs(b.config, null));
  assert.equal(
    renderTauriOverlay(a.config, true),
    renderTauriOverlay(b.config, true),
  );
});
