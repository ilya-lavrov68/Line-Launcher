import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/**
 * The platform's own form validation draws an unthemed speech bubble — a black
 * border, an orange system icon, OS wording, a different shape on every
 * platform — positioned over the app's design. The fields keep `required` for
 * assistive technology but the forms opt out of the bubble and show the app's
 * message instead.
 */
test("forms never fall back to the platform's validation bubbles", () => {
  for (const file of [
    "src/components/line/AuthForm.tsx",
    "src/components/line/ConfigUrlInput.tsx",
  ]) {
    const source = read(file);
    assert.match(
      source,
      /<form[\s\S]{0,200}noValidate/,
      `${file} lacks noValidate`,
    );
    // The constraint attributes stay: screen readers announce "required".
    assert.match(source, /required/);
  }
});

test("field feedback is one component, in the theme's colours", () => {
  const message = read("src/components/line/FieldMessage.tsx");
  // Three tones, one icon each: nothing invents a colour.
  assert.match(message, /"error" \| "hint" \| "success"/);
  assert.match(message, /text-destructive/);
  assert.match(message, /text-muted-foreground/);
  assert.match(message, /text-line-online/);
  // Errors are announced, hints are not: a hint is always there and would be
  // re-read on every keystroke.
  assert.match(message, /role=\{tone === "error" \? "alert" : undefined\}/);
  // Reduced motion is respected like everywhere else.
  assert.match(message, /useReducedMotion/);

  // Both forms use it rather than their own <p>.
  for (const file of [
    "src/components/line/AuthForm.tsx",
    "src/components/line/ConfigUrlInput.tsx",
  ]) {
    assert.match(read(file), /<FieldMessage/);
    assert.doesNotMatch(
      read(file),
      /className="text-destructive text-xs leading-relaxed"/,
    );
  }
});

test("the reserved height still holds the submit button still", () => {
  // The message slot is fixed-height on purpose: the button used to jump when
  // an error appeared. Toning the message down must not reintroduce that.
  const form = read("src/components/line/AuthForm.tsx");
  assert.match(form, /min-h-4/);
  const config = read("src/components/line/ConfigUrlInput.tsx");
  assert.match(config, /min-h-12/);
});
