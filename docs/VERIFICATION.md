# Verification status

## Current desktop-fix pass

**Screenshots in `docs/images/line-*.png` were produced by
`npm run screenshots:offline`** on a machine with no browser (only
`registry.npmjs.org` was reachable; Chromium needed libnspr4/libnss3 that no
mirror could supply). The renderer parses the palette out of
`src/styles/themes.css` and uses the bundled Geist TTFs, and the layout follows
the components' own structure, but it is a token-driven vector drawing, not a
capture of the live WebView. Re-running `npm run screenshots` on a desktop with
Chrome replaces them with real captures at the same 1280x800 size.

Design system: two themes on one attribute (`data-theme="line"|"old"`). The new
palette re-declares the legacy slots so existing components restyle themselves,
while `"old"` inherits `index.css` unchanged instead of a copy that would drift.
The server dock, its phases and its degradation rules are covered by
`tests/design-theme.test.ts` (12 tests, including the catalogue rail's single
action and the game subscription that must outlive the detail screen);
`/preview.html` renders the rail, a card and six dock states in both designs.

Minecraft mode (`mc-launcher-core` 0.1.2): server-only, offline identity, no
Microsoft path. The pack is a provider ZIP of a whole `.minecraft`, described by
`pack.json`; download/verify reuses the existing verified installer, and the live
game directory is separate so player data and mod-config edits survive updates.
Layout, loader detection and overlay rules are pure Rust with unit tests;
`scripts/pack-manifest.mjs` is covered by tests that build real ZIP archives and
cross-check the limits against `config.rs`. Auto-join is built here rather than through the crate's
`LaunchOptions::server`, because Mojang removed `--server`/`--port` in 23w14a;
the Quick Play path is chosen by exact-token detection in the merged version
metadata and covered by pure Rust tests. the crate-facing code (install,
load_version, LaunchOptions/LaunchCommand, Java runtime helpers, the exhaustive
`LauncherError` mapping) was typechecked with `rustc` against a stand-in built
from the crate's real 0.1.2 signatures. The dependency-free rules run in the pure
Rust suite (4 new tests) and `tests/minecraft-mode.test.ts` guards the wiring
(pinned version, prelude import, spawn_blocking, stable UUID, heap/argument
hardening, Java fallback order, additive boundary). **The full cargo graph is
still not built here** — `cargo check --all-targets` on a real machine remains
required, and the Minecraft UI screen is not implemented yet.

Follow-up to the first Windows `cargo run`: the stop branch now aborts the IPC
handle only inside `if let Some(task) = &ipc_task`, and the unused `Path` import
was removed. The new regression fails if the out-of-scope `task.abort()` returns.
The demo generator also no longer attaches ticket/exchange URLs to offline
Creative or install-only Showcase; the launchable config wiring was checked with
a compiler stub (Survival=ticket, Creative=offline/no auth, Showcase=install-only).
The next Windows error (`E0382`, moved `task`) is fixed by reborrowing the handle
in the select arm and grace timeout (`&mut *task`), matching the previously
compiling non-optional monitor; a regression catches a moved `result = task`.

Checked in the implementation sandbox after the Java/UI/demo/offline changes:

- `npm run check`, `npm run build`, `npm run brand:check`, Prettier, `rustfmt`
  and `git diff --check`: clean; `npm audit --omit=dev`: 0 vulnerabilities.
- `npm test`: **202 tests, 201 passing, 1 skipped** (the JDK-dependent contract
  case). Includes the new unframed-icon/manual-Java/proxy/offline/release-guard
  regressions. **10/10 targeted mutations were caught** (fake plus, framed icon,
  doubled PATH `bin`, unverified manual Java, release-wide proxy bypass, inferred
  offline mode, accepted dev release flags, the Windows `task` scope error, and
  ticket endpoints leaking into offline/install-only demo servers).
- `npm run test:rust`: **66/66** compiled pure-logic tests, including PATH entries
  that already end in `bin`, verbatim Windows path normalisation, stdout/stderr
  version parsing and the offline Java command without a session-channel property.
  This is still not a full `cargo check` of the async/Tauri crate graph.
- `npm run test:ui`: passed in real Chromium (99 IPC calls, 0 page errors),
  including the manual Adoptium-style path, unframed icons, the removed upload
  plus, per-server install receipts and an explicit offline server launch.
  `npm run test:boot`: passed; `npm run screenshots` regenerated the guide images.
- `npm run demo:check`: **59 checks passed, 1 skipped** (no JDK here, so the
  launchable/offline pack variant is not built in this run). `npm run
test:wardrobe`: **21/21**. The real-JVM `test:java`/`test:provider` suites were
  verified in earlier passes but could not be rerun in this sandbox because no
  JDK/keytool is installed now; their historical results below are not a claim
  about this run.

Still required on the Windows machine: `cargo check --manifest-path
src-tauri/Cargo.toml --all-targets`, `cargo test --locked --manifest-path
src-tauri/Cargo.toml`, `npm run demo` with the installed Adoptium JDK, and a real
provider-pack install/launch. No pirate Minecraft downloader or license bypass
was added; offline mode launches only the provider's own published ZIP.

## Earlier verification history

Checked in the implementation sandbox:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm run check` (TypeScript project build)
- `npm run build` (production Vite build)
- `npm test` (then 152 passing, 1 skipped: contract, branding, licence/metadata, environment
  probe, Windows tool discovery, Tauri version alignment, installer licence encoding,
  TLS trust, and the player-feature suite — skin geometry/PNG validation, per-server
  artwork, account-wide wardrobe contract, custom-frame permissions, window-geometry
  survival through the branding overlay, and token-only styling of the new chrome),
  the local-first wardrobe contract (reachable signed out, only the active skin
  syncs, history is never silently pruned), the single-account contract (login and
  logout carry no server id, one `Option<ProviderSession>`, opening a server keeps
  the session, no per-server auth form) and the automatic-sync contract (no manual
  send button or upload/reset commands, every local change re-syncs, the uploaded
  marker follows the awaited provider response, an `unchanged` result never erases
  the known skin), and the build-time provider address (exactly one provider, the
  old multi-provider list rejected, HTTPS-only baked URL, an unconfigured installer
  refused, a configured build ignoring a foreign cache)
- `npm run brand:check` (generated branding is current)
- License/metadata tests: custom Line license, verbatim upstream MIT hash,
  npm/Cargo license pointers, and desktop bundle legal resources
- Prettier check and `git diff --check`
- Rust syntax parse and `rustfmt --edition 2021 --check`
- `npm run test:rust`: then 46 tests compiled and executed by a real `rustc --test`
  build (rustc 1.99.0). Covers the dependency-free logic: ZIP path safety,
  server-slug validation, Java version parsing, JVM argument construction and
  agent/secret rejection, classpath-separator injection, manifest component
  walking, install-lock exclusivity/recovery, main-class and SHA validation, and
  order-independent ZIP file/directory conflict detection, and classification of
  network failure chains (untrusted/expired/mismatched certificate, localized OS
  errors under an English rustls wrapper, refused connection, timeout precedence),
  skin PNG validation (both accepted sizes, rejected dimensions/depth/colour type/
  interlace, non-PNG and oversize input), and the player heap policy (RAM-share
  ceiling, hard cap, rejection instead of clamping, automatic value always inside
  the selectable range), and the local skin library (SHA-256-only ids reject
  traversal/absolute/uppercase paths, name normalisation, capacity refused while
  re-adding an existing texture still succeeds), and the automatic sync decision
  (`active == synced` sends nothing, the standard look resets once, an unconfirmed
  or forgotten upload is retried rather than skipped), and the launch/integrity
  guard: the published index versus the tree (clean, foreign, missing, edited with
  an identical size), index validation (traversal, duplicate and reserved paths),
  bookkeeping names exempt only at the release root, real deletion of foreign
  files without escaping the release, pruning only the emptied directories, a
  separate writable `game/` per server, the real-client identity arguments with a
  placeholder token, `-Xss1M`, UUID version/variant bits, and the game-argument
  allow-list (no JVM flags, no duplicates, no overriding launcher-owned flags).
  This is a subset — it does not compile the crate graph.
- `cargo generate-lockfile` against a local clone of the official crates.io index
- `npm run test:java`: 11/11 real-JVM integration cases on Linux (Temurin 25.0.2
  runtime, ECJ 3.46.100 compiler): strict JSON, HTTPS exchange, one-shot replay,
  expiry, server/release/channel/username bindings, redirect rejection, oversize
  HTTP/IPC, malformed IPC, trailing IPC bytes and IPC timeout. Node supplied the
  local HTTPS provider stub and Unix-socket launcher peer; this is not a
  production provider or a Minecraft/mod-loader test.
- `npm run test:provider`: 12 checks against the reference provider on real
  HTTPS — pack hash/size publication, config and archive download, demo login,
  bearer ticket issuance, a real JVM demo game completing the private-IPC
  handshake and exchange, ticket never printed, replay rejected (409), binding
  mismatch rejected (403). Node plays the launcher IPC peer; Rust is not involved.
- `npm run demo:check`: 59 checks over real HTTPS against the demo project the
  user clicks through — config schema and ETag/304, every published sha256/size
  and unpacked size verified against the served bytes, a valid launch manifest in
  each pack, archive paths that cannot escape `.provider/`, SVG artwork with CORS,
  registration/duplicate/wrong-password, **one account issuing tickets for two
  different servers**, the wardrobe the launcher syncs automatically (upload,
  read-back, byte-identical texture, repeat upload, reset), one-shot tickets
  (exchange, replay 409, cross-server binding 403, anonymous 401), publishing a
  second release while the provider keeps running with the previous one still
  downloadable for rollback, and neither token nor ticket in the log. Needs only
  Node and openssl; the launchable variant is checked additionally where a JDK
  exists (skipped here).
- `npm run demo -- --provider-only` exercised end to end in the sandbox: it built
  the packs, baked the address, started the provider, verified `config.json` over
  HTTPS, and on SIGTERM restored `branding/provider.json` **byte for byte** and
  freed the port. `npm run demo:update` republished Demo Survival 1.0.0 → 1.1.0
  while it ran and the provider served the new version without a restart. The
  failure paths were checked too: no Rust → actionable message and untouched
  branding; port already taken → exit 1 with a port hint and branding restored.
  The desktop window itself cannot be opened here (no crates.io), so
  `tauri dev --features dev-provider-ca` is the part that still needs a real
  machine.
- Launch integrity and per-server instances: the wiring is asserted by
  `tests/game-integrity.test.ts` (index published before the completion marker,
  every extracted file hashed, archive cannot ship the bookkeeping names, scan
  runs under the install lease before Java is spawned, the lease is dropped before
  repairing, a second mismatch after repair aborts the launch, `--gameDir` and the
  process cwd point at `instances/<id>/game`, every launcher-owned argument is
  shielded from pack overrides, progress notes are actually rendered while the
  files are checked). **20/20 targeted mutations were caught** by `npm test` or
  `npm run test:rust`: ignoring foreign files, size-only comparison, deletion
  without path validation, reserved names accepted in the index, marker written
  before the index, extraction not hashing content, repair short-circuiting to
  "already installed", archive forging `.line-files.json`, repairing while holding
  the lease, launch bypassing the scan, an unreadable index passing silently, the
  game writing into the immutable release again, a real value instead of the token
  placeholder, missing `-Xss1M`, `--uuid` overridable, odd-length/duplicate/JVM
  game arguments accepted, and hidden progress notes.
- Demo mode hardened after "it does not work" reports. Two real defects fixed:
  the provider reused `.provider/tls.crt` forever, so a demo left for a month
  failed with an expired certificate (now `scripts/lib/demo-cert.mjs` checks
  expiry, clock skew and SAN with `X509Certificate` and reissues the pair), and
  macOS was refused outright because reqwest cannot merge an extra root into
  Apple's verifier (now the dev build uses `tls_certs_only` there — verification
  stays on, the keychain is untouched; Windows/Linux keep `tls_certs_merge`,
  confirmed against the reqwest 0.13.4/0.13.5 and rustls-platform-verifier
  sources). `npm run demo:app` attaches the desktop app to a running
  `--provider-only` session through `.provider/demo-state.json`, replacing the
  POSIX-only `LINE_DEV_CA_CERT=...` hint that could not work in PowerShell.
  `npm run demo:doctor` checks Node, dependencies, openssl, Rust, MSVC, WebView2,
  JDK, the cargo feature, the port, the certificate and free space without
  writing anything. Verified live here: provider-only run → state published →
  `demo:app` found it and stopped at the missing-Rust doctor with an actionable
  message → SIGTERM restored `branding/provider.json` byte for byte and removed
  the state file. Certificate reissue was exercised on a real one-day cert.
  **15/15 targeted mutations were caught**, including a disabled expiry branch
  (caught behaviourally against PEM fixtures, not by grep), a surviving stale
  key, a provider that reuses any existing file, an attach path that skips the
  probe or the doctor, an unpinned probe, a doctor that writes files or exits 0,
  and a dev build that disables verification.
- `npm run test:wardrobe`: 21 checks against the reference provider's skin contract
  over real HTTPS (self-signed cert pinned): missing/unknown bearer rejected, 404
  for a player without a skin, missing and unknown model rejected, wrong
  Content-Type, missing PNG signature, wrong dimensions, oversized body answered
  with 413 rather than a dropped socket, valid 64×64 slim and legacy 64×32
  accepted, state read-back, texture download, reset, and the session token never
  appearing in the provider log. Needs no JDK; Rust is not involved.
- `npm run test:ui`: Chromium smoke of config → login → install → history →
  launch → stop, including a deliberately reordered game event that must not
  resurrect a finished game, and mandatory credit visibility at 375/800/1280 px.
  Extended for the player shell: the tinted brand mask must actually apply (an
  unquoted CSS `url()` silently degraded it to a solid block), the custom caption
  buttons must reach the window plugin, sidebar collapse must persist through
  `save_settings` and keep accessible names, the settings screen must show human
  labels rather than raw `keep`/`auto` values and expose no JVM-argument field,
  loaded server banner/icon must render, and the wardrobe runs a real 64×64 PNG
  through validation → preview → automatic upload → standard look while a
  malformed PNG is rejected without any upload call. Extended for the single
  account: the sign-in screen appears before any server, `line_login` carries only
  username/password, `line_session` is consulted, opening a server does not ask
  for credentials again, and signing out closes the whole list. Extended for the
  automatic wardrobe: the section is reachable before login, a texture is saved to
  local history with no provider call at all, history survives login and is then
  uploaded by itself, re-opening the screen uploads nothing, re-adding identical
  bytes performs no second upload and keeps the correct remote status, choosing
  another texture and the standard look both sync without a button, deleting
  reaches the backend, and a new account re-uploads instead of inheriting the
  previous player's marker. An expired account (`AUTH_REQUIRED` from launch)
  returns the player to the sign-in screen with an explanation instead of a dead
  «Играть» button. 87 IPC calls, 0 page errors. Uses a test-only injected
  Tauri IPC stub — the real window plugin and Rust commands are not exercised.
- Layout-stability regressions measured in Chromium, not assumed: the provider
  submit button holds its position within 1px across idle → error → loading
  (it used to jump 24px), the scrollbar thumb computes to a pill
  (`border-radius`, `background-clip: content-box`) and follows `--foreground`
  when the token changes, and the wardrobe nav entry is no longer disabled while
  signed out — the reason a skin is not syncing is a status line, not a disabled
  button. Playwright's default
  `--hide-scrollbars` is disabled for this suite, otherwise the scrollbar under
  test would be invisible. The three new static assertions were mutation-checked:
  restoring the unconditional `scrollbar-width` or dropping
  `focusableWhenDisabled` makes them fail.
- `npm run test:boot`: Chromium assertion that startup connects exactly once.
  Found and fixed a real StrictMode race — a shared `mounted` ref is set back to
  true by the second mount, so the first run's pending promise also connected and
  the config was fetched twice. Covered for a slow cache read, an instant cache
  read and a cold start. Mutation-checked: restoring the shared-ref guard makes
  two of the checks fail.
- Build-time provider flow verified in Chromium with a temporarily baked address
  (then restored): the launcher shows «Подключение к проекту» and connects to
  that address exactly once, with no URL input, no provider picker and no
  provider-switching affordance. An unconfigured **production** bundle was
  checked separately via `vite preview`: it shows «Сборка не настроена», offers
  no address field and never guesses a URL. The installer guard exits 1 on an
  empty `config_url` and passes on a filled one. 0 page errors in every case.
- `npm run screenshots`: the README images are regenerated from the real
  components against the demo provider, so documentation cannot silently drift
  from the interface. Captured after this change: the single account screen, the
  server list unlocked by it, and the wardrobe with a sync status instead of a
  send button. 0 page errors.
- Screenshot geometry is now an invariant, not a habit. All six README images
  were captured at whatever height the screen needed (480, 860, 1000, 1060), so
  the gallery mixed tall and short pictures. `scripts/screenshots.mjs` takes one
  fixed viewport for every shot and throws if the viewport drifts,
  `scripts/render-screens.mjs` draws the same six screens at the same size, and
  `tests/screenshots.test.ts` reads each PNG's IHDR and fails unless it is exactly
  1280x800. Mutation-checked, 5 of 5 caught: a 1280x860 PNG over one screen, a
  per-screen `shot("wardrobe", 1000)` height, changing the shared height constant,
  reading only the `[data-theme="line"]` block instead of `:root` + the palette
  (which resolved every additive token to white cards), and dropping a screenshot
  from the README.
- Demo-mode guarantees mutation-checked (7 of 7 caught): skipping the branding
  restore, not passing `LINE_DEV_CA_CERT` to the app, serving arbitrary file names
  from `.provider/`, caching the config at startup again (which breaks the live
  update), advertising a launch on the install-only server, discarding the game
  log, and inverting the demo game's run guard so the stop button is untestable.
- Mutation-checked the account/sync guarantees (12 mutations, all caught): clearing the
  session in `selectServer`, putting `server_id` back into the login request or
  the Rust `AuthRequest`, turning the session back into a per-server map, making
  `logout` take a server id, restoring a manual send button, dropping the
  automatic sync after activation, letting an `unchanged` result wipe the known
  skin, ignoring the `synced` marker, and deriving the uploaded marker from the
  plan instead of the awaited upload result, putting the auth callback back into
  `autoSync`'s dependencies (which re-runs the mount effect on every render), and
  swallowing an expired session instead of returning to the sign-in screen.
- Chromium smoke test of the browser fallback screen
- Chromium screenshots of the config, server list, auth, installed, server detail
  (banner + icon), settings and wardrobe states, reviewed visually
- Branding switch verified in the browser: a non-default preset changed the
  accent, product name and attribution placement while `--radius` stayed 14px
- Mandatory credit visibility smoke: footer and header placements checked at
  375, 800 and 1280 px; the main-interface credit and the additional About copy
  remained visible with both names and `|`, with no page errors
- `src-tauri/tauri.conf.json` validated against the bundled Tauri CLI JSON
  schema; `cargo metadata --locked --offline --no-deps` reports the custom
  `license_file` instead of MIT
- Installer licence encoding: `src-tauri/LICENSE.rtf` is ASCII-only and decodes
  back to the bilingual `LICENSE` byte-for-byte (checked both by the in-repo
  reader and independently by Python `striprtf`, Cyrillic intact). The merged
  NSIS/MSI configs were resolved the way the CLI merges `-c` overlays: NSIS keeps
  the plain UTF-8 `LICENSE`, MSI gets the RTF. Mutation checks confirmed the tests
  fail if the `\uN` escaping or the MSI overlay is removed.
  **The installers themselves were never built here** — WiX and NSIS are
  Windows-only. The rendered licence dialog still needs a human check on Windows.

- TLS trust diagnosis reproduced against the real reference provider: without
  trust the request fails with `self-signed certificate` (Node:
  `DEPTH_ZERO_SELF_SIGNED_CERT`), and `curl --cacert .provider/tls.crt` returns the
  config JSON. The server was never the problem.
- `src-tauri/src/line/dev_ca.rs` type-checked and executed against a stub reqwest
  with `CARGO_MANIFEST_DIR` set to the real crate directory: a repo-relative
  `.provider/…` path resolves while cwd is `src-tauri` (the reported failure),
  absolute paths pass through, missing/garbage files are rejected, an unset
  variable is a no-op, and the resolved local path stays out of the error DTO
  (5 end-to-end cases). The real reqwest/rustls pairing is not compiled here.
- WebView2 detection corrected against Microsoft's documented rule: the registry
  `pv` value under the EdgeUpdate client GUID, with `0.0.0.0` treated as absent,
  and an on-disk fallback that understands the Evergreen `Application/<version>/`
  layout. Covered by tests for the versioned layout, newest-version selection
  (numeric, not lexical), the flat layout, per-user hives and the `0.0.0.0` state.
  The registry itself cannot be queried from this Linux sandbox.

Verified by CI (not reproducible in this sandbox):

**First real `cargo run` (Windows 11, rustc 1.99.1, MSVC VS18, JDK 25).** The demo
orchestrator itself worked end to end — packs built, provider served HTTPS,
branding applied, Vite started, `cargo run --features dev-provider-ca` launched —
and then the crate failed to compile. Five errors and one warning, all in code
that no local check could see:

- `Option::retain` does not exist (`skin_library.rs`, four call sites). The rule
  now lives in `keep_slot`/`prune_library`/`forget_skin`, which the pure harness
  compiles and unit-tests, so this cannot regress silently again.
- `staging.join(relative)` moved the `PathBuf` that the new integrity index still
  needed (`install.rs`); it now borrows.
- `unused_mut` on the first `response` binding in `wardrobe.rs`.

Two test-only defects were found by review while fixing those: the reserved-name
test asserted the staging directory did not exist (the extractor creates it up
front — it now asserts no file landed inside), and the symlink test called
`symlink_file` unconditionally, which needs Developer Mode on Windows (it now
skips with a message instead of failing).

Crate archives cannot be downloaded from crates.io here, so the full graph was
first compiled on GitHub Actions. As of PR #1 all ten jobs are green, including
the `rust` matrix (`cargo fmt --check`, `check --all-targets`, `test`,
`clippy --all-targets -- -D warnings`) and the `java-client` matrix on
ubuntu-22.04, windows-latest and macos-latest. That run exercised the IPC,
lifecycle-lease, symlink, ticket-parser, status-revision and crash-recovery
tests, plus Windows named-pipe ACL/PID and Unix peer-credential paths.

CI found and this branch fixed defects the local subset could not see: nine
compile errors (temporary lifetimes in `try_join!`/`select!`, a missing
`tauri::Manager` import, `&AtomicBool` misuse, a moved `PathBuf`), an
order-dependent ZIP file/directory conflict check, a POSIX-only test fixture
that was not absolute on Windows, `ExecutionException` masking `IOException` in
the Windows IPC client, and a Windows timeout path that blocked while closing a
pipe with a pending read.

Not checked here or by CI:

- The full extract → index → scan → repair cycle on a real filesystem: the
  decision and the deletion are executed by `npm run test:rust`, but hashing,
  index serialisation and the extraction changes need `cargo test`
  (`integrity::filesystem_tests`, `install_tests`). Those tests are written and
  formatted, not executed here (no crates.io access).
- Tauri desktop shell, real ZIP installation through Rust commands, and
  Java/Minecraft launch. The reference provider and generated pack exist
  (`examples/provider/`), but the desktop app itself was never run: CI compiles
  and unit-tests the backend, it does not open a window. The Java/provider tests
  use Node as the launcher's IPC peer, not Rust commands.
  Step-by-step instructions: `docs/RUNBOOK.md`.
- Actual desktop installer contents: legal resources are configured and their
  source paths tested, but no platform installer was built in this sandbox.

The browser fallback is intentionally read-only and explains that desktop
operations require Tauri. It does not simulate successful authentication or
installation. Real Minecraft launch (the launcher now emits the identity arguments,
`-Xss1M`, the macOS first-thread flag, LWJGL/log4j properties and allow-listed game
arguments, but no actual Minecraft client was run here), provider ticket exchange,
OS-specific IPC permissions still require a real desktop run; Rust unit tests now run in CI on
all three platforms.

Additional Chromium smoke coverage used a test-only injected Tauri IPC stub
(no stub code ships in the app): config URL → server cards → login/registration
switch → login → install progress events → completed state. No page errors were
observed. Captures use `reducedMotion: reduce` because Obsy's animated background
gradient otherwise never settles for a screenshot. This validates React orchestration and event filtering only, not Rust
commands, network security, filesystem safety, or real extraction. The smoke
also exercises the launch/stop/history UI against the same test-only IPC stub;
it does not launch Java or validate the private ticket channel.

## Как закрыть оставшиеся пробелы

Полная пошаговая инструкция — в [RUNBOOK.md](RUNBOOK.md): подготовка окружения,
полный прогон Rust, локальный провайдер и тестовая сборка, ручной сценарий
настольного приложения, интеграция с реальным Minecraft, проверки устойчивости,
подпись кода, updater и финальный чек-лист релиза.
