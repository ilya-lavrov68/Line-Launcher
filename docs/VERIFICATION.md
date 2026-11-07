# Verification status

Checked in the implementation sandbox:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm run check` (TypeScript project build)
- `npm run build` (production Vite build)
- `npm test` (113 passing, 1 skipped: contract, branding, licence/metadata, environment
  probe, Windows tool discovery, Tauri version alignment, installer licence encoding,
  TLS trust, and the player-feature suite — skin geometry/PNG validation, per-server
  artwork, wardrobe contract, custom-frame permissions, window-geometry survival
  through the branding overlay, and token-only styling of the new chrome)
- `npm run brand:check` (generated branding is current)
- License/metadata tests: custom Line license, verbatim upstream MIT hash,
  npm/Cargo license pointers, and desktop bundle legal resources
- Prettier check and `git diff --check`
- Rust syntax parse and `rustfmt --edition 2021 --check`
- `npm run test:rust`: 25 tests compiled and executed by a real `rustc --test`
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
  the selectable range).
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
  through validation → preview → upload → reset while a malformed PNG is rejected
  without any upload call. 34 IPC calls, 0 page errors. Uses a test-only injected
  Tauri IPC stub — the real window plugin and Rust commands are not exercised.
- Layout-stability regressions measured in Chromium, not assumed: the provider
  submit button holds its position within 1px across idle → error → loading
  (it used to jump 24px), the scrollbar thumb computes to a pill
  (`border-radius`, `background-clip: content-box`) and follows `--foreground`
  when the token changes, and the disabled wardrobe is hoverable, focusable and
  shows a reason naming the missing prerequisite. Playwright's default
  `--hide-scrollbars` is disabled for this suite, otherwise the scrollbar under
  test would be invisible. The three new static assertions were mutation-checked:
  restoring the unconditional `scrollbar-width` or dropping
  `focusableWhenDisabled` makes them fail.
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
installation. Real Minecraft launch, provider ticket exchange, OS-specific IPC
permissions still require a real desktop run; Rust unit tests now run in CI on
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
