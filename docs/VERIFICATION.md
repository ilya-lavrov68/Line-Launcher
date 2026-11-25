# Verification status

## Current snapshot — 2026-11-17

- `npm ci --no-audit --no-fund` completed successfully.
- `npm run check` passed (`tsc -b --pretty false`).
- `npm test` passed: **431 total, 430 passed, 1 skipped, 0 failed**.
- `npm run build` passed. Vite reports the existing `skinview3d` chunk at
  525.52 kB, above its 500 kB advisory threshold.
- `npm run test:ui` passed in Chromium at **1280×900** and at the Tauri minimum
  **800×560**: 180 mocked IPC calls per run, 0 page errors. Coverage includes
  sign-in/configuration error states, all six independently selectable guide
  topics, defer/reopen/Escape, server actions, Minecraft, wardrobe, account,
  settings, and four-locale settings text overflow checks.
- `npm run test:dock` passed at 1100 and 640 px; `npm run test:drag` passed;
  `npm run test:catalog-rail` passed at 1280, 720, and 375 px.
- `npm run screenshots` passed in real Chromium **158.0.8127.0** and regenerated
  **14 screenshots, six GIFs, and six poster PNGs**, with 0 page errors. The
  capture manifest records hashes and date `2026-11-17`.
- `npm run visual-evidence:check` passed: all 14 screenshots, six GIFs, and six
  posters match the manifest.
- `git diff --check` passed.

Browser screenshots and UI smoke use the real React application with demo data
and mocked Tauri IPC. They do not prove native window behavior, Windows/WebView2,
real provider responses, production authentication, downloads, or a Minecraft
launch. This environment has no `rustc`, `cargo`, or Windows toolchain, so Rust
format/build/tests/Clippy and native desktop checks remain unverified. Follow the
open acceptance gates in [ROADMAP.md](ROADMAP.md).

The UI audit’s coverage and one non-blocking visual opportunity are recorded in
[UI-AUDIT-ACTIONS.md](UI-AUDIT-ACTIONS.md). Older verification counts have been
removed rather than carried forward.
