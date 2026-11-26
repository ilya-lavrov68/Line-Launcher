# Verification status

## Current snapshot — 2026-11-17

- `npm run check` passed (`tsc -b --pretty false`).
- `npm test` passed: **441 total, 440 passed, 1 skipped, 0 failed**.
- `npm run build` passed. Vite reports the existing `skinview3d` chunk above its
  500 kB advisory threshold.
- `npm run browser:restore` succeeded. The Playwright browser CDN was blocked in
  this sandbox; the restore script then installed a matching Chromium 158 build
  from npm and verified the executable. On this Linux x64 host it used
  Chromium `158.0.8127.0`.
- `npm run test:ui` passed against the restored real browser: **180 mocked IPC
  calls, 0 page errors**. The run covered the existing 800×560 minimum-window
  and main-navigation flows.
- `npm run screenshots` passed through its automatic Chromium restore and
  regenerated **14 real-browser screenshots, six GIFs, and six poster PNGs**;
  there were 0 page errors. Screenshots, GIF canvases and posters remain native
  1920×1080. Cursor-motion samples are now requested at 15 fps; deliberate
  action/reading pauses retain longer frame delays. The complete media set is
  approximately 121 MiB. The capture manifest records Chromium `158.0.8127.0`
  and `2026-11-17`.
- `npm run visual-evidence:check` passed: 14 screenshots and all six GIF/poster
  pairs match their hashes. `git diff --check` passed.

### Not verified in this environment

- The Fresh & Smooth Modrinth API metadata identifies release `1.4.0` for Fabric
  / Minecraft 1.20.1, but `npm run source:check-modrinth -- ICQPO4fX lsXm4sUN`
  could not download the release archive (`fetch failed`). This container also
  has no Java, `rustc`, or `cargo`, so an isolated pack install and game launch
  could not be performed. Do not treat that modpack as launch-tested.
- A user-provided Prism log for Minecraft 1.21.1 / NeoForge 21.1.267 identifies
  the main game JVM as Microsoft OpenJDK 21.0.7, an appropriate Java major for
  this Minecraft version. It also shows Quantified API launching separate
  `javaw.exe` Vulkan/OpenCL probes; these are auxiliary child processes, not
  per-mod JVM selection. The log does not expose Prism's configured executable
  path and contains no fatal JVM crash; Java selection remains unchanged.
  Missing registry entries and invalid compatibility recipes do appear in the
  log, but the game reaches a world and shuts down cleanly, so they do not
  establish the cause of any other reported crash.
- Full Rust and native desktop checks remain unverified because the Rust toolchain
  is absent.

The UI smoke and screenshots use the real React application with demo data and
mocked Tauri IPC. They do not prove native window behavior, Windows/WebView2,
real provider responses, production authentication, downloads, or a Minecraft
launch. Follow the open acceptance gates in [ROADMAP.md](ROADMAP.md).

The broader audit scope and implementation history are recorded in
[UI-AUDIT-ACTIONS.md](UI-AUDIT-ACTIONS.md).
