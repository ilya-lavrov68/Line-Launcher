# Verification status

## Current snapshot — 2026-11-17

- `npm run check` passed (`tsc -b --pretty false`).
- `npm test` passed: **432 total, 431 passed, 1 skipped, 0 failed**.
- `npm run build` passed. Vite reports the existing `skinview3d` chunk above its
  500 kB advisory threshold.
- `npm run test:ui` passed in real Chromium **158.0.8127.0**: 180 mocked IPC
  calls, 0 page errors. The run covered guidebook direct chapter selection,
  defer/reopen, manual GIF playback and pause, keyboard focus, and the 800×560
  minimum-window layout, plus server actions, Minecraft, wardrobe, account, and
  settings checks.
- `npm run screenshots` passed in real Chromium and regenerated **14 real-browser
  screenshots, six GIFs, and six poster PNGs**, with 0 page errors. Every
  screenshot, GIF logical canvas, and poster is 1920×1080. The GIFs use 256
  colours and a reduced frame rate; total gallery and guidebook media is about
  82 MiB. The capture manifest records Chromium `158.0.8127.0` and date
  `2026-11-17`.
- `npm run visual-evidence:check` passed for all 14 screenshot hashes and six
  GIF/poster pairs; `git diff --check` passed.

The UI smoke and screenshots use the real React application with demo data and
mocked Tauri IPC. They do not prove native window behavior, Windows/WebView2,
real provider responses, production authentication, downloads, or a Minecraft
launch. This environment has no `rustc`, `cargo`, or Windows toolchain, so Rust
and native desktop checks remain unverified. Follow the open acceptance gates
in [ROADMAP.md](ROADMAP.md).

The broader audit scope and implementation history are recorded in
[UI-AUDIT-ACTIONS.md](UI-AUDIT-ACTIONS.md).
