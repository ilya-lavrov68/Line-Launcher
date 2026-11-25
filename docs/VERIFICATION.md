# Verification status

## Current snapshot — 2026-11-17

For the current workspace state:

- `npm run check` passed (`tsc -b --pretty false`).
- `npm test` passed: **426 total, 425 passed, 1 skipped, 0 failed**.
- `npm run build` passed. Vite warned about a chunk over 500 kB; the
  `skinview3d` chunk is approximately 526 kB.
- `npm run screenshots` passed and regenerated **14 real browser captures** in
  `docs/images/`, including the new in-app guidebook page. The script now waits
  through its timed welcome screen and closes the post-login guidebook after
  capturing it. A temporary Chromium package and its Linux runtime libraries
  were supplied outside the repository; no browser dependency was added.
- `python3 scripts/generate-guidebook-gifs.py` passed and regenerated all six
  looping GIFs from the refreshed real app screenshots. The navigation sequence
  now also points out the replay-guidebook icon in the window header.
- `git diff --check` passed at the last verification.

The screenshot harness renders the real React components with demo config and
mocked Tauri IPC. It is suitable for documenting the UI, but it does **not** prove
live provider status, authentication, telemetry delivery, ZIP downloads, native
Tauri behavior or an actual Minecraft launch. Those screenshots are not
production data.

This environment has no `rustc`, `cargo` or `javac`. `npm run test:rust` was
attempted but stopped with `spawnSync rustc ENOENT`; no full Rust/Tauri build,
Cargo tests/Clippy, Java-client run, Windows/WebView2 validation, real provider
integration or real Minecraft launch was performed. The server-profile endpoint
is not connected; the profile UI intentionally shows no sample statistics.

Accepted open work and acceptance gates are in [ROADMAP.md](ROADMAP.md);
detailed installation risks are in [INSTALLATION-AUDIT.md](INSTALLATION-AUDIT.md).

## Earlier records

Older verification counts, platform availability and implementation details
were removed from this rolling status page to avoid presenting stale snapshots
as current. Historical audit observations remain in
[AUDIT-2026-11.md](AUDIT-2026-11.md). Update this page whenever a new verification
pass is performed; keep dated historical results only when they add evidence not
already covered by that audit.
