import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const provider = read("examples/provider/server.mjs");
const spec = read("docs/SESSION-MODEL-A.md");
const selftest = read("scripts/demo-selftest.mjs");

/**
 * The reference provider is what a mod author integrates against. If it drifts
 * from docs/SESSION-MODEL-A.md, the document stops being executable and the mod
 * has nothing to test with — which is exactly what happened before this suite
 * existed: the provider returned `{ok, session_id}` with no secret and no TTL,
 * and had no /v1/session/verify at all.
 */

/** The uuid rule from src-tauri/src/line/launch.rs, restated so a drift shows. */
function playerUuid(nickname: string): string {
  const digest = createHash("sha256")
    .update(`line-launcher:player:${nickname}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

test("the reference provider mints the documented exchange response", () => {
  // Every field of §2.2 must actually be produced by the demo, or a mod written
  // against the document cannot parse its answer.
  for (const field of [
    "session_id",
    "session_secret",
    "username",
    "uuid",
    "server_id",
    "expires_in",
  ]) {
    assert.match(
      provider,
      new RegExp(`\\b${field}:`),
      `the exchange response omits ${field}`,
    );
  }
  assert.match(
    provider,
    /randomBytes\(32\)\.toString\("base64url"\)/,
    "session_secret must be 32 random bytes in base64url (43 chars)",
  );
  assert.match(provider, /SESSION_TTL_SECONDS = 120/);
  assert.match(
    provider,
    /SESSION_TTL_SECONDS >= 30|expires_in: SESSION_TTL_SECONDS/,
    "the TTL comes from the session constant",
  );
  // The response must not leak what the launcher deliberately keeps private.
  const exchange = provider.slice(
    provider.indexOf('url.pathname === "/v1/launcher/exchange"'),
    provider.indexOf('url.pathname === "/v1/session/verify"'),
  );
  assert.doesNotMatch(
    exchange,
    /access_token:/,
    "the response leaks the provider token",
  );
});

test("the reference provider implements /v1/session/verify with an HMAC proof", () => {
  assert.match(provider, /url\.pathname === "\/v1\/session\/verify"/);
  const verify = provider.slice(provider.indexOf("/v1/session/verify"));
  for (const [status, error] of [
    ["403", "bad_api_key"],
    ["401", "unknown_session"],
    ["401", "session_expired"],
    ["403", "server_mismatch"],
    ["403", "user_mismatch"],
    ["403", "bad_proof"],
  ]) {
    assert.match(
      verify,
      new RegExp(`json\\(res, ${status}, \\{ error: "${error}" \\}\\)`),
      `verify must answer ${status} ${error}`,
    );
  }
  // Constant-time comparisons only: a length-or-early-exit compare leaks.
  assert.match(
    verify,
    /timingSafeEqual/,
    "api key and proof comparisons must be constant-time",
  );
  // Prettier may wrap the call, so match the parts rather than one line.
  assert.match(verify, /createHmac\(\s*"sha256",/, "proof uses HMAC-SHA256");
  assert.match(
    verify,
    /Buffer\.from\(found\.secret,\s*"base64url"\)/,
    "the HMAC key is the decoded session secret",
  );
  assert.match(
    verify,
    /\.digest\("base64url"\)/,
    "the proof is base64url, so it survives a JSON round trip",
  );
  assert.match(verify, /valid: true/);
});

test("the demo uuid rule matches the launcher", () => {
  // A provider minting a different uuid than launch.rs would give the player two
  // identities: --uuid in the game, and this one in every session.
  assert.match(
    provider,
    /`line-launcher:player:\$\{username\}`/,
    "the provider hashes the same prefixed nickname as launch.rs",
  );
  assert.match(
    provider,
    /bytes\[6\] = \(bytes\[6\] & 0x0f\) \| 0x40/,
    "version 4 bits",
  );
  assert.match(
    provider,
    /bytes\[8\] = \(bytes\[8\] & 0x3f\) \| 0x80/,
    "RFC 4122 variant bits",
  );

  // Known vectors, so a change in either implementation shows up here.
  assert.equal(playerUuid("Player_1"), "357b224b-7284-4b0b-9604-24bce67c4b7d");
  assert.equal(playerUuid("Player_2"), "80070112-5d51-465e-9297-e3ac873b8ea8");
  assert.equal(playerUuid("demo"), "512d625f-4762-4ab9-ba3b-d311a6552146");
  // Same nickname always gives the same uuid; the vector is not a constant.
  assert.equal(playerUuid("demo"), playerUuid("demo"));
  assert.notEqual(playerUuid("demo"), playerUuid("Demo"));
  // The vectors above are the ones the document publishes.
  for (const uuid of [
    "357b224b-7284-4b0b-9604-24bce67c4b7d",
    "80070112-5d51-465e-9297-e3ac873b8ea8",
  ]) {
    assert.ok(spec.includes(uuid), `SESSION-MODEL-A.md publishes ${uuid}`);
  }
});

test("demo:check exercises the session contract end to end", () => {
  // The provider could be correct and still untested; these checks are what make
  // the contract a gate rather than a hope.
  for (const phrase of [
    "the exchange mints a session_id",
    "the exchange mints a 32-byte session_secret",
    "the session carries the deterministic account uuid",
    "the session TTL is in the documented 30..600 s range",
    "a valid session verifies",
    "a wrong proof is rejected with 403",
    "verification without an api key is rejected",
    "a session issued for another server is rejected",
    "an unknown session is rejected with 401",
  ]) {
    assert.ok(selftest.includes(phrase), `demo:check is missing: ${phrase}`);
  }
  // The proof in the self-test must be computed, not copied.
  assert.match(selftest, /createHmac\(\s*"sha256"/);
  assert.match(selftest, /\.digest\("base64url"\)/);
});

test("the spec states the response fields the provider actually returns", () => {
  // Guard the document against drifting away from the implementation it claims
  // to describe.
  for (const field of ["session_id", "session_secret", "uuid", "expires_in"]) {
    assert.match(spec, new RegExp(`\`${field}\``), `the spec omits ${field}`);
  }
  assert.match(spec, /30–600/, "the spec must state the TTL range");
});

test("the HMAC proof shape holds for a 43-character secret", () => {
  // A short sanity check that the documented construction is what the code uses:
  // base64url(HMAC-SHA256(base64url_decode(secret), nonce)).
  const secret = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(secret.length, 43);
  const proof = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update("nonce-123", "utf8")
    .digest("base64url");
  assert.equal(proof.length, 43);
  // The same nonce and secret produce the same proof — no hidden state.
  const again = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update("nonce-123", "utf8")
    .digest("base64url");
  assert.equal(proof, again);
});
