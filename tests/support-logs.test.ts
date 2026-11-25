import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  renderOwnerTs,
  validateSupportEmail,
} from "../scripts/brand-config.ts";
import { validateProvider } from "../scripts/provider-config.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The publisher's address has to survive a provider re-branding the build.
 *
 * A provider owns `branding/line.brand.json` (palette, product name) and
 * `branding/provider.json` (their config URL). Neither may decide where a
 * player's diagnostics are mailed: that address belongs to the publisher, and a
 * re-branded build redirecting support mail to the re-brander is exactly the
 * failure this file exists to prevent.
 */
test("the brand config cannot carry a support address", () => {
  const brand = read("scripts/brand-config.ts");
  // Rejected by name, with the reason in the message.
  assert.match(brand, /if \("owner" in config \|\| "support" in config\)/);
  assert.match(brand, /branding\/owner\.ts/);
});

test("the support address lives in its own file, outside the brand schema", () => {
  const owner = read("branding/owner.ts");
  assert.match(owner, /export const OWNER/);
  assert.match(owner, /support_email/);
  // It is build input, like the brand config: the app imports the generated
  // module, never this file.
  assert.match(
    read("src/components/line/SupportSection.tsx"),
    /owner\.generated/,
  );
  assert.doesNotMatch(
    read("src/components/line/SupportSection.tsx"),
    /from "@\/brand\/owner"/,
  );
  // The generated module is what ships.
  const generated = read("src/brand/owner.generated.ts");
  assert.match(generated, /export const OWNER: BrandOwner/);
  assert.match(generated, /do not edit by hand/);
});

test("a provider's own config may name a support address, and nothing else", () => {
  const provider = read("src-tauri/src/line/config.rs");
  // The field exists on the provider, not on the brand.
  assert.match(provider, /pub support_email: Option<String>/);
  // It is validated: the value is turned into a `mailto:` by the launcher.
  assert.match(provider, /pub fn valid_support_email/);
  assert.match(provider, /if !valid_support_email\(address\)/);
  // And it is plain mail, not a URL the config could point elsewhere.
  assert.match(provider, /должен быть адресом электронной почты/);
  // The TypeScript mirror agrees about the shape.
  assert.match(read("src/types/line.ts"), /support_email\?: string;/);
});

test("the provider file still cannot smuggle anything else", () => {
  // Guard the neighbouring rule: `provider.json` accepts exactly one key.
  assert.throws(
    () => validateProvider({ config_url: "", support_email: "x@y.com" }),
    /unknown key "support_email"/,
  );
});

test("only a plain address is accepted, never a scheme or a query", () => {
  for (const good of ["help@example.com", "a.b+tag@sub.example.co.uk"]) {
    assert.equal(validateSupportEmail("owner.support_email", good), good);
  }
  for (const bad of [
    "help@example",
    "@example.com",
    "help@@example.com",
    "help@exam ple.com",
    " help@example.com",
    "help@example.com ",
    "user@.com",
    "user@example..com",
    "help@example.com?subject=x",
    "help@example.com&bcc=evil@x.com",
    "javascript:alert(1)@x.com",
    "help@example.com#frag",
  ]) {
    assert.throws(
      () => validateSupportEmail("owner.support_email", bad),
      `should reject: ${bad}`,
    );
  }
  // Absent is allowed: a build with no support desk has no mail button, rather
  // than one that opens an empty draft.
  assert.equal(validateSupportEmail("owner.support_email", null), null);
  assert.equal(validateSupportEmail("owner.support_email", "   "), null);
});

test("the generated owner module is valid TypeScript with a null address", () => {
  const text = renderOwnerTs(null, "Line Launcher");
  assert.match(text, /support_email: null/);
  assert.match(text, /support_name: "Line Launcher"/);
  const withMail = renderOwnerTs("help@example.com", "Plus In Plus");
  assert.match(withMail, /support_email: "help@example\.com"/);
});

test("settings offers the folder, the bundle and both mails", () => {
  const section = read("src/components/line/SupportSection.tsx");
  // The three the request asked for, by their i18n keys.
  for (const key of [
    "support.openFolder",
    "support.copy",
    "support.mailOwner",
    "support.mailProvider",
  ]) {
    assert.ok(section.includes(key), `SupportSection is missing ${key}`);
  }
  // Provider mail appears only when the provider named an address.
  assert.match(section, /providerEmail && \(/);
  // A failed copy is reported, not shown as success.
  assert.match(section, /support\.copyFailed/);

  // The section is part of Settings, titled and described like the others.
  const settings = read("src/components/line/SettingsScreen.tsx");
  assert.match(settings, /<SupportSection/);
  assert.match(settings, /t\("settings\.logs"\)/);
  // Last on the page, after the cache.
  assert.ok(
    settings.indexOf('t("settings.cache")') <
      settings.indexOf('t("settings.logs")'),
    "support must come after the cache section",
  );
});

test("every language carries the support strings", () => {
  const dictionaries = read("src/lib/line/i18n-dictionaries.ts");
  for (const key of [
    "settings.logs",
    "settings.logsHint",
    "support.openFolder",
    "support.copy",
    "support.copied",
    "support.copyFailed",
    "support.mailOwner",
    "support.mailProvider",
    "support.mailOpened",
    "support.hint",
  ]) {
    const occurrences = dictionaries.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 4, `${key} must exist in all four languages`);
  }
});

/**
 * A sign-in that fails must leave a record.
 *
 * This is the defect behind the first demo support round: the window showed a
 * sentence, the console showed nothing, and "sign-in does not work" could not be
 * narrowed to a request, a response or a store. The rule is now structural —
 * every call goes through one wrapper that records either the outcome or the
 * stage that stopped it — and this test keeps it that way.
 */
test("a failed sign-in writes a record with a stage and a code", () => {
  const auth = read("src-tauri/src/line/auth.rs");

  // The wrapper exists and both commands go through it.
  assert.match(auth, /async fn authenticate\(/);
  assert.match(auth, /async fn authenticate_inner\(/);
  assert.match(
    auth,
    /let result = authenticate_inner\(state, request, register\)\.await;/,
  );
  assert.match(auth, /authenticate\(&state, request, false\)\.await/);
  assert.match(auth, /authenticate\(&state, request, true\)\.await/);

  // A failure is an ERROR, not an informational note: support greps for level.
  const failure = auth.slice(
    auth.indexOf("Err(error) => logger::error("),
    auth.indexOf("fn stage_of("),
  );
  assert.ok(failure.length > 0, "a failure must be written at level ERROR");
  assert.match(failure, /"login failed"/);
  assert.match(failure, /"register failed"/);
  // A success is an INFO line.
  assert.match(auth, /Ok\(info\) => logger::info\(/);
  assert.match(auth, /"login ok"/);
  assert.match(auth, /Field::text\("stage", stage_of\(error\)\)/);
  assert.ok(
    auth.includes('Field::text("code", format!("{:?}", error.code))'),
    "the failure record must carry the error code",
  );
  // The password is not in scope in the wrapper: it was zeroized inside.
  const wrapper = auth.slice(
    auth.indexOf("async fn authenticate("),
    auth.indexOf("fn stage_of("),
  );
  assert.doesNotMatch(
    wrapper,
    /password/,
    "the wrapper must not see a password",
  );
  // The token is never logged either.
  assert.doesNotMatch(wrapper, /access_token|token/);
});

test("the logger is initialised before anything can fail", () => {
  const lib = read("src-tauri/src/lib.rs");
  const setup = lib.indexOf("line::logger::init(root)");
  assert.ok(setup > -1, "run() must initialise the logger");
  // Before the first command can be invoked, and before the tray is touched.
  assert.ok(setup < lib.indexOf("line::tray::install"), "init must come first");
  assert.match(lib, /line::support::open_logs_folder/);
  assert.match(lib, /line::support::copy_diagnostics/);
  assert.match(lib, /line::support::open_mail_draft/);
});

test("diagnostics gather all launcher lines and each instance game launch log", () => {
  const support = read("src-tauri/src/line/support.rs");
  assert.match(support, /fn read_logs\(root: &Path\)/);
  assert.match(support, /logger::log_files\(&root\.join\(logger::DIR\)\)/);
  assert.match(support, /instance_dir\.join\("game"\)\.join\("logs"\)/);
  assert.match(support, /logs_dir\.join\("launch\.log"\)/);
  assert.match(support, /reader\.read_until\(b'\\n'/);
  assert.doesNotMatch(support, /const BUDGET|MAX_LINES/);
  assert.match(support, /reads_every_launcher_file_and_game_launch_log/);
});

test("daily launcher logs are retained by age, not capped by file count", () => {
  const logger = read("src-tauri/src/line/logger.rs");
  assert.match(logger, /pub const DIR: &str = "launcher_logs";/);
  assert.match(logger, /pub const RETENTION_DAYS: u64 = 30;/);
  assert.match(logger, /launcher-\{day\}\.log/);
  assert.match(logger, /prune_before\(dir, cutoff\)/);
  assert.match(logger, /modified < cutoff/);
  assert.match(logger, /pruning_uses_age_and_never_limits_the_number_of_recent_daily_files/);
});

test("secrets cannot reach a log line", () => {
  const logger = read("src-tauri/src/line/logger.rs");
  // Redaction is a property of the field type, not a discipline.
  assert.match(logger, /pub fn scrub\(value: &str\) -> String/);
  assert.match(logger, /pub fn secret\(key: &'static str\) -> Self/);
  for (const marker of ["Bearer ", "token=", "password=", "ticket="]) {
    assert.ok(
      logger.includes(marker),
      `scrub must know about ${marker.trim()}`,
    );
  }
  // Newlines are stripped so a value cannot forge a whole record.
  assert.match(logger, /value\.replace\(\['\\n', '\\r'\], " "\)/);
});

test("the diagnostic bundle carries paths, not secrets", () => {
  const diagnostics = read("src-tauri/src/line/diagnostics.rs");
  for (const part of [
    "launcher_logs=",
    "provider_id=",
    "config_url=",
    "session=",
    "data_dir=",
  ]) {
    assert.ok(diagnostics.includes(part), `bundle is missing ${part}`);
  }
  // A signed-in bundle names the player and still does not carry the token.
  // Comments are stripped first: the module explains the rule and therefore
  // names the words it forbids.
  // Production half only: the module's own unit test asserts this same rule
  // and therefore contains the words it forbids.
  const code = diagnostics
    .slice(0, diagnostics.indexOf("#[cfg(test)]"))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(code, /signed_in as /);
  // Raw logs must flow through the conservative secret filter before output.
  assert.match(code, /sanitize_line\(line\)/);
  assert.match(code, /"access_token"/);
  assert.match(code, /"session_secret"/);
  // No line cap: all retained log entries are included.
  assert.doesNotMatch(diagnostics, /MAX_LINES/);
  assert.match(diagnostics, /pub fn sanitize_line\(/);
  assert.match(diagnostics, /SENSITIVE_MARKERS/);
  // The mailto is built here, percent-encoded, never string-concatenated raw.
  assert.match(diagnostics, /pub fn mailto\(/);
  assert.match(diagnostics, /percent_encode\(body\)/);
  assert.match(diagnostics, /b' ' => out\.push_str\("%20"\)/);
});

test("the log scheme is documented where a provider will look", () => {
  const doc = read("docs/LOGGING.md");
  // The layout has to be in the doc, not only in the code: a provider reading
  // PROVIDER.md is who asks "where are the logs".
  for (const part of [
    "launcher_logs/",
    "launcher-YYYY-MM-DD.log",
    "instances/<id>/",
    "Ротация",
    "Field::text",
    "provider.support_email",
    "branding/owner.ts",
  ]) {
    assert.ok(doc.includes(part), `LOGGING.md is missing ${part}`);
  }
  assert.match(doc, /30 дней/);
  assert.match(doc, /launch\.log/);
  // Indexed from the README, and cross-linked from the provider contract.
  assert.match(read("README.md"), /\[LOGGING\.md\]\(docs\/LOGGING\.md\)/);
  assert.match(read("docs/PROVIDER.md"), /\[LOGGING\.md\]\(LOGGING\.md\)/);
  assert.match(read("docs/BRANDING.md"), /owner\.ts/);
  assert.match(read("docs/RUNBOOK.md"), /LOGGING\.md/);
});

test("the demo provider advertises a support address", () => {
  // The demo is what a provider copies from; a field that exists only in the
  // spec and not in the reference implementation will be missed.
  const build = read("examples/provider/build-pack.mjs");
  assert.match(build, /support_email:/);
  // And it is a plain address, not a URL.
  assert.doesNotMatch(build, /support_email: `\$\{base\}/);
});
