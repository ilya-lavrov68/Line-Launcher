# Verification status

Checked in the implementation sandbox:

- `npm ci --ignore-scripts --no-audit --no-fund`
- `npm run check` (TypeScript project build)
- `npm run build` (production Vite build)
- `npm test` (22 tests: 6 contract + 12 branding validator + 4 license/metadata)
- `npm run brand:check` (generated branding is current)
- License/metadata tests: custom Line license, verbatim upstream MIT hash,
  npm/Cargo license pointers, and desktop bundle legal resources
- Prettier check and `git diff --check`
- Rust syntax parse and `rustfmt --edition 2021 --check`
- `npm run test:rust`: 9 tests compiled and executed by a real `rustc --test`
  build (rustc 1.99.0). Covers the dependency-free logic: ZIP path safety,
  server-slug validation, Java version parsing, JVM argument construction and
  agent/secret rejection, classpath-separator injection, manifest component
  walking, install-lock exclusivity/recovery, main-class and SHA validation.
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
- `npm run test:ui`: Chromium smoke of config → login → install → history →
  launch → stop, including a deliberately reordered game event that must not
  resurrect a finished game, and mandatory credit visibility at 375/800/1280 px.
  0 page errors. Uses a test-only injected Tauri IPC stub.
- Chromium smoke test of the browser fallback screen
- Chromium screenshots of the config, server list, auth and installed states
- Branding switch verified in the browser: a non-default preset changed the
  accent, product name and attribution placement while `--radius` stayed 14px
- Mandatory credit visibility smoke: footer and header placements checked at
  375, 800 and 1280 px; the main-interface credit and the additional About copy
  remained visible with both names and `|`, with no page errors
- `src-tauri/tauri.conf.json` validated against the bundled Tauri CLI JSON
  schema; `cargo metadata --locked --offline --no-deps` reports the custom
  `license_file` instead of MIT

Not checked here:

- Full Rust compilation/unit tests/clippy: crate archives cannot be downloaded
  from crates.io in this sandbox, so the Tauri/serde/reqwest/zip/tokio graph was
  never compiled here. CI must run these on Linux, Windows, and macOS, including
  the IPC, lifecycle-lease, symlink, ticket-parser, status-revision and
  crash-recovery tests. Windows named-pipe ACL/PID and macOS peer-credential
  behaviour remain OS-dependent until that CI/desktop run.
  Step-by-step instructions: `docs/RUNBOOK.md`.
- Tauri desktop shell, real ZIP installation through Rust commands, and
  Java/Minecraft launch. The reference provider and generated pack now exist
  (`examples/provider/`), but the desktop app itself was never run here: the
  Rust backend cannot be compiled in this sandbox. The Java/provider tests use
  Node as the launcher's IPC peer, not Rust commands.
- Actual desktop installer contents: legal resources are configured and their
  source paths tested, but no platform installer was built in this sandbox.

The browser fallback is intentionally read-only and explains that desktop
operations require Tauri. It does not simulate successful authentication or
installation. Real Minecraft launch, provider ticket exchange, OS-specific IPC
permissions and Rust unit tests still require CI/desktop verification.

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
