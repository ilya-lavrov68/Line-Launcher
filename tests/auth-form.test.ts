import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const form = read("src/components/line/AuthForm.tsx");
const dict = read("src/lib/line/i18n-dictionaries.ts");

const LOCALES = ["ru", "en", "de", "fr"] as const;

function block(locale: string): string {
  // Each locale is one object in the dictionary file; slice from its marker to
  // the next locale marker so a key can be checked where it actually lives.
  const order = ["ru", "en", "de", "fr"];
  const marker = (l: string) => `const ${l}${l === "ru" ? " =" : ":"}`;
  const rest = order.slice(order.indexOf(locale) + 1);
  const start = dict.indexOf(marker(locale));
  assert.ok(start >= 0, `${locale} dictionary exists`);
  const end = rest.length
    ? Math.min(
        ...rest.map((l) => {
          const at = dict.indexOf(marker(l));
          return at > start ? at : dict.length;
        }),
      )
    : dict.length;
  return dict.slice(start, end);
}

/**
 * The submit button used to lay the icon and the label out as siblings, and the
 * label carried an invisible copy of the longest string ("Create account") so
 * the button would not resize between tabs. The reserve was in the wrong place:
 * the label box was as wide as "Create account" even when it read "Sign in", so
 * the centred text sat 48px away from an icon pinned to the left edge — a hole
 * wide enough to read as a clipped glyph in the screenshot.
 *
 * The fix reserves the *whole group* (icon + widest label) as a stacked grid
 * cell and centres the live group inside it. These tests pin that shape: a
 * reserve, one group, one gap, and a reserve for every state.
 */
const submitButton = () => {
  const formAt = form.indexOf("      </form>");
  const end = form.lastIndexOf("</Button>", formAt);
  const start = form.lastIndexOf("<Button", end);
  return form.slice(start, end);
};

test("submit button reserves every state as a stacked grid cell", () => {
  const body = submitButton();
  assert.match(body, /<span className="grid place-items-center">/);

  // Every direct child of the grid must be pinned to the same cell, or the
  // reserves would stack as rows and make the button taller.
  const cells = body.match(
    /className="(?:invisible )?col-start-1 row-start-1 inline-flex items-center gap-2"/g,
  );
  assert.equal(
    cells?.length,
    3,
    "login/register reserve, loading reserve, live group",
  );

  // The reserves carry the widest strings; the live group does not.
  const reserves = body.slice(
    0,
    body.indexOf('className="col-start-1 row-start-1 inline-flex'),
  );
  assert.match(reserves, /auth\.submitRegister/, "register reserve");
  assert.match(reserves, /auth\.submitting/, "loading reserve");
  assert.doesNotMatch(
    reserves,
    /auth\.submitLogin/,
    "login does not need a reserve",
  );
});

test("the icon and its label keep one 8px gap in every state", () => {
  const body = submitButton();
  const liveStart = body.indexOf(
    'className="col-start-1 row-start-1 inline-flex items-center gap-2"',
  );
  const live = body.slice(liveStart);

  // One spacing token, on the group that holds the icon and the label. Any
  // gap on the children themselves would add to it.
  const groupTags = body.match(/inline-flex items-center gap-2/g) ?? [];
  assert.equal(groupTags.length, 3, "all three groups share the spacing");
  assert.doesNotMatch(
    body,
    /\b(?:ml|mr|pl|pr)-\d/,
    "no side margins/padding faking a second gap",
  );

  for (const icon of ["RefreshCw", "LogIn", "UserPlus"]) {
    const at = live.indexOf(`<${icon}`);
    assert.ok(at > -1, `${icon} is in the live group`);
    assert.match(
      live.slice(at, live.indexOf("/>", at)),
      /shrink-0/,
      `${icon} cannot be squeezed by the flex row`,
    );
  }

  // The label wrapper must follow the icon and must not carry a spacer.
  const labelAt = live.indexOf("relative grid place-items-center");
  assert.ok(labelAt > live.indexOf("<LogIn"), "label follows the icon");
  assert.doesNotMatch(
    live.slice(labelAt),
    /invisible col-start-1 row-start-1 whitespace-nowrap/,
    "no width spacer inside the label: that was the bug",
  );
});

test("confirmation field exists only in register mode", () => {
  assert.match(
    form,
    /\{mode === "register" && \(/,
    "the confirmation row is gated on register",
  );
  assert.match(form, /id=\{`\$\{id\}-confirm`\}/);
  assert.match(form, /autoComplete="new-password"/);
  assert.match(form, /maxLength=\{1024\}/);
  assert.match(form, /disabled=\{loading\}/);
});

test("confirmation is validated on submit, before the length check", () => {
  const submit = form.slice(form.indexOf("function submit"));
  const body = submit.slice(0, submit.indexOf("onSubmit(mode"));

  const mismatchAt = body.indexOf("confirm !== password");
  const shortAt = body.indexOf("Array.from(password).length < 8");
  assert.ok(mismatchAt > -1, "mismatch is checked");
  assert.ok(shortAt > -1, "short password is still checked");
  assert.ok(
    mismatchAt < shortAt,
    "wrong confirmation is reported before password length",
  );
  assert.match(body, /t\("auth\.passwordMismatch"\)/);
});

test("confirmation is cleared on tab switch and after submit", () => {
  const changeMode = form.slice(form.indexOf("function changeMode"));
  assert.match(
    changeMode.slice(0, changeMode.indexOf("setValidation")),
    /setConfirm\(""\)/,
    "switching tabs drops the typed confirmation",
  );
  const submit = form.slice(form.indexOf("function submit"));
  assert.match(
    submit.slice(0, submit.indexOf("\n  }\n")),
    /setConfirm\(""\)/,
    "a successful submit drops the confirmation",
  );
  assert.match(
    form.slice(form.indexOf("function changeMode")),
    /setShowConfirm\(false\)/,
    "the reveal toggle resets with the field",
  );
});

test("confirmation feedback uses a reserved slot and always resolves", () => {
  const row = form.slice(form.indexOf("auth.confirmPassword"));
  const body = row.slice(0, row.indexOf("</div>\n          )}") + 1);

  assert.match(body, /min-h-4/, "the note slot reserves its height");
  assert.match(
    body,
    /id=\{`\$\{id\}-confirm-note`\}/,
    "the slot carries the id aria-describedby points at",
  );
  assert.match(
    body,
    /aria-describedby=\{`\$\{id\}-confirm-note`\}/,
    "the field points at that slot",
  );
  assert.match(body, /aria-invalid=\{confirmMismatch \|\| undefined\}/);
  // Both messages live in the same slot, so only one is ever mounted.
  assert.match(body, /t\("auth\.passwordMismatch"\)/);
  assert.match(body, /t\("auth\.passwordMatch"\)/);
  assert.equal(
    (body.match(/<FieldMessage/g) ?? []).length,
    2,
    "one message component per branch, never both at once",
  );
});

test("the confirmation has its own reveal toggle", () => {
  const row = form.slice(form.indexOf("auth.confirmPassword"));
  const body = row.slice(0, row.indexOf("auth.passwordMatch") + 400);

  assert.match(body, /type=\{showConfirm \? "text" : "password"\}/);
  assert.match(body, /aria-pressed=\{showConfirm\}/);
  assert.match(body, /setShowConfirm\(\(value\) => !value\)/);
  // The password field must not have been rewired to the new state.
  assert.match(form, /type=\{showPassword \? "text" : "password"\}/);
});

test("confirmation strings exist in every locale", () => {
  const keys = [
    "auth.confirmPassword",
    "auth.passwordMismatch",
    "auth.passwordMatch",
  ];
  for (const locale of LOCALES) {
    const section = block(locale);
    for (const key of keys) {
      assert.match(
        section,
        new RegExp(`"${key.replace(".", "\\.")}":\\s*"`),
        `${locale} translates ${key}`,
      );
    }
  }
});

test("no leftover shared-toggle label for the confirmation field", () => {
  assert.doesNotMatch(
    form,
    /t\("auth\.showBoth"\)\s*,?\s*\n?\s*\)\}/,
    "the unused combined label is not wired to a control",
  );
});
