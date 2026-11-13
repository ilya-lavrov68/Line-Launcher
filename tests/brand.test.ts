import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { BrandConfig } from "../branding/brand.types.ts";
import {
  BrandError,
  renderCss,
  renderTauriOverlay,
  renderTs,
  validateBrand,
} from "../scripts/brand-config.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

const shipped = JSON.parse(
  readFileSync(new URL("../branding/line.brand.json", import.meta.url), "utf8"),
) as BrandConfig;

function clone(): BrandConfig {
  return JSON.parse(JSON.stringify(shipped)) as BrandConfig;
}

test("the shipped config carries no colour settings at all", () => {
  // The palette is fixed. What must hold is not "the override is empty" — an
  // empty override can become a full one in the next release — but that the
  // schema has nowhere to put a colour.
  assert.ok(!("preset" in shipped));
  assert.ok(!("palette" in shipped));
  const result = validateBrand(shipped);
  assert.ok(!("palette" in result));
});

test("the generated stylesheet cannot recolour anything", () => {
  const css = renderCss();
  // No custom properties, no :root block: nothing here can beat src/index.css.
  assert.ok(!css.includes(":root"), "must not emit a :root block");
  assert.ok(!css.includes("--primary"), "must not emit colour tokens");
  assert.ok(!css.includes("--radius"), "must not emit geometry");
  // It is still a valid CSS file, because src/index.tsx imports it.
  assert.ok(css.includes("GENERATED"));
});

test("a config that still sets colours fails with a reason, not an unknown key", () => {
  // The point is the message: "unknown key" would suggest the setting moved.
  for (const key of ["preset", "palette"] as const) {
    for (const value of ["obsy", {}, { primary: "#ff0000" }]) {
      const config = clone() as BrandConfig & Record<string, unknown>;
      config[key] = value;
      assert.throws(
        () => validateBrand(config),
        /palette is fixed/,
        `accepted ${key}=${JSON.stringify(value)}`,
      );
    }
  }
});

test("presets.json is gone, so there is nothing to select from", () => {
  // A leftover file means a half-migrated checkout; the generator refuses it
  // (checked in brand-generator.test.ts) and the shipped tree must not ship it.
  assert.throws(
    () => readFileSync(new URL("../branding/presets.json", import.meta.url)),
    /ENOENT/,
  );
});

test("attribution cannot be removed or disabled", () => {
  const missing = clone();
  delete (missing as Partial<BrandConfig>).attribution;
  assert.throws(() => validateBrand(missing), /mandatory|required/);

  const disabled = clone();
  (disabled.attribution as unknown as Record<string, unknown>).enabled = false;
  assert.throws(() => validateBrand(disabled), /mandatory/);

  const badPlacement = clone();
  (badPlacement.attribution as unknown as Record<string, unknown>).placement =
    "none";
  assert.throws(() => validateBrand(badPlacement), /placement/);

  const badLanguage = clone();
  (badLanguage.attribution as unknown as Record<string, unknown>).language =
    "de";
  assert.throws(() => validateBrand(badLanguage), /language/);

  const aboutOnly = clone();
  (aboutOnly.attribution as unknown as Record<string, unknown>).placement =
    "about";
  assert.throws(() => validateBrand(aboutOnly), /main interface.*About-only/);

  for (const key of ["hidden", "visible", "text", "enabled"]) {
    const extra = clone();
    (extra.attribution as unknown as Record<string, unknown>)[key] =
      key === "visible" ? false : "anything";
    assert.throws(
      () => validateBrand(extra),
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
      const ts = renderTs(validateBrand(config).config, null);
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
  assert.throws(() => validateBrand(config), /cannot be customized/);
  const ts = renderTs(validateBrand(clone()).config, null);
  for (const phrase of [
    "Powered by Line Launcher | Plus In Plus",
    "Работает на Line Launcher | Plus In Plus",
  ]) {
    assert.ok(ts.includes(phrase));
    assert.ok(phrase.includes("Line Launcher"));
    assert.ok(phrase.includes("Plus In Plus"));
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
      () => validateBrand(config),
      BrandError,
      `accepted unsafe asset path: ${path}`,
    );
  }
});

test("app_id must be reverse-DNS and product text rejects markup", () => {
  for (const appId of ["notanid", ".leading.dot", "a..b", "com.example/x"]) {
    const config = clone();
    config.product.app_id = appId;
    assert.throws(() => validateBrand(config), /app_id/);
  }
  const markup = clone();
  markup.product.name = "<script>alert(1)</script>";
  assert.throws(() => validateBrand(markup), /markup/);
});

test("tauri overlay carries product identity and icon set", () => {
  const config = clone();
  config.product.name = "My Server Launcher";
  config.product.app_id = "com.example.launcher";
  const overlay = JSON.parse(
    renderTauriOverlay(validateBrand(config).config, true),
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
  const a = validateBrand(shipped);
  const b = validateBrand(clone());
  assert.equal(renderCss(), renderCss());
  assert.equal(renderTs(a.config, null), renderTs(b.config, null));
  assert.equal(
    renderTauriOverlay(a.config, true),
    renderTauriOverlay(b.config, true),
  );
});

test("a leftover presets.json is refused by the generator, not ignored", () => {
  // The config check above catches the keys; this catches the other half of an
  // unfinished migration. It runs the real generator, because the check lives
  // there — brand-config.ts is pure and must not touch the filesystem.
  const presetsPath = path.join(ROOT, "branding/presets.json");
  assert.ok(!existsSync(presetsPath), "the shipped tree must not carry it");
  writeFileSync(presetsPath, '{"presets":{}}');
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["--experimental-strip-types", "scripts/apply-brand.ts", "--check"],
          { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
        ),
      (error: { stderr?: string }) => {
        assert.match(String(error.stderr), /palette is fixed/);
        return true;
      },
    );
  } finally {
    rmSync(presetsPath, { force: true });
  }
});
