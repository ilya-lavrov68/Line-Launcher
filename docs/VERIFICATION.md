# Verification status

## Current snapshot — 2026-11-25

For the current PR workspace:

- `npm run check` passed (`tsc -b --pretty false`).
- `npm test` passed: **430 total, 429 passed, 1 skipped, 0 failed**.
- `npm run build` passed. Vite reports the existing `skinview3d` chunk over
  500 kB (about 526 kB).
- `npm run test:ui` passed in Chromium: **179 IPC calls, 0 page errors**. The
  smoke now completes the first-run guidebook and explicitly selects the
  settings categories before exercising their controls.
- `npm run screenshots` passed after the final UI changes and regenerated all
  **14 real-browser screenshots**, all **six GIFs**, and all **six poster PNGs**.
  The run used
  Chromium `158.0.8127.0` and reported **0 page errors**.
- `docs/visual-evidence.json` records SHA-256 hashes for all 14 screenshots and
  all 12 GIF/poster files. `npm run visual-evidence:check` passed against the
  generated files.
- `git diff --check` passed.

The screenshot harness renders the real React components with demo config and
mocked Tauri IPC. It documents the UI but does **not** prove live provider
status, authentication, telemetry delivery, ZIP downloads, native Tauri
behavior, or an actual Minecraft launch. These screenshots are not production
data.

This sandbox has no `rustc`, `cargo`, or Windows build tools. The Windows
`npm run demo:build` failure report was fixed at its source, but a native
Rust/Tauri build, Cargo tests/Clippy, Windows/WebView2 validation, provider
integration, and real Minecraft launch could not be run here. The Rust errors
must still be confirmed by CI or a Windows build environment.

The screenshot capture is an unconditional pre-PR requirement: every PR
refreshes the full screenshot set, all six guidebook GIF/poster pairs, the
README generated-on note, relevant player documentation, and this verification
record. The PR evidence checklist and CI gate enforce the manifest and doc
refresh.

Accepted open work and acceptance gates are in [ROADMAP.md](ROADMAP.md);
detailed installation risks are in [INSTALLATION-AUDIT.md](INSTALLATION-AUDIT.md).

## Earlier records

Older verification counts, platform availability and implementation details
were removed from this rolling status page to avoid presenting stale snapshots
as current. Historical audit observations remain in
[AUDIT-2026-11.md](AUDIT-2026-11.md). Update this page whenever a new verification
pass is performed; keep dated historical results only when they add evidence not
already covered by that audit.
