---
name: launcher-guidebook-maintenance
description: Use this skill whenever a change can alter what a Line Launcher player sees, where they find an action, how a flow works, or what the current README, screenshots, or in-app GIF guidebook teaches. Check and update the affected documentation, real-browser screenshots, and guidebook GIF pages together; do not skip the guidebook impact check just because the request only mentions code or screenshots.
---

# Keep the launcher guidebook in sync

A visible launcher change has three possible records: written documentation, the committed screenshot gallery, and the post-login page-by-page GIF guidebook. They do different jobs. Check all three for every player-facing change, then update only the ones whose information or visuals are now stale. For an internal-only change, record why none need revision rather than adding noise.

## 1. Read the current truth first

Before editing explanatory material, inspect the changed component and the actual flow it participates in. Then compare it with:

- `README.md` and the relevant page under `docs/` (including `docs/guidebook/` when gameplay or setup is involved);
- the related real-browser screenshot(s) under `docs/images/` and the screenshot script;
- `src/components/line/LauncherTour.tsx`, the matching GIF(s) in `public/guidebook/`, and `scripts/generate-guidebook-gifs.py`.

Treat code as the behavioral source of truth; do not preserve outdated prose merely because it already exists.

## 2. Decide what is affected

Use the user's task to choose a scope, not a blanket documentation rewrite:

- Update documentation when a player-facing behavior, control, setting, limitation, or recovery path changed.
- Update committed screenshots when the visible screen changed or a screenshot would otherwise teach the wrong location or state. Capture from the real app/browser with `npm run screenshots`; wait until code checks pass before replacing committed images.
- Update a GIF guidebook page when its screen, controls, flow, or explanation changed. If a new feature merits teaching, add a page rather than forcing it into an unrelated animation.
- If an artifact remains accurate, leave it untouched and state that judgment briefly in the change summary.

Never present a hand-drawn, fixture-rendered, or reconstructed image as a real app screenshot. If the real browser/screenshot flow cannot run, do not fabricate a replacement: record the unavailable check and affected stale evidence in `docs/VERIFICATION.md`.

## 3. Keep GIF pages tied to the app

The in-app guidebook is a sequence of separate pages with one looping GIF above a short explanation and Back/Next navigation. Keep every page factual and concise, match its GIF to a real launcher screen, and translate all visible copy in the four shipped locales (`ru`, `en`, `de`, `fr`). Preserve the distinction between first-run setup and the completed/replayable product guide.

The six GIFs are captured by `scripts/screenshots.mjs` while Playwright drives the real React interface with the test-only Tauri IPC stub. The visible cursor is a restrained overlay synchronized with actual pointer movement and clicks; the GIFs are then encoded from captured browser frames by `scripts/generate-guidebook-gifs.py` (ImageMagick `convert`) along with static poster PNGs. After checks pass, run `npm run screenshots` against the live app. Do not run the encoder without a browser-capture manifest or replace these recordings with coordinate drawings or offline mockups.

For a new page, add a real interaction recording to `scripts/screenshots.mjs`, add the GIF/poster paths and localized title/body to `LauncherTour.tsx`, and include the chapter in the README gallery and documentation tests. Do not silently drop an existing chapter.

## 4. Verify the complete change

After code and docs are ready:

1. Run `npm run check`, `npm test`, `npm run build`, and `git diff --check`.
2. Run the real browser screenshot flow (`npm run screenshots`) after those checks pass; review the changed captures and confirm the README gallery still references the current files.
3. Regenerate changed GIFs from the refreshed real screenshot sources, inspect at least one rendered frame and confirm all GIFs open and loop.
4. Re-run relevant checks after generated assets are updated. Mention browser, Rust, or image-tool checks that could not run; do not imply they passed.

Use `docs/VERIFICATION.md` when a required validation is unavailable, following its existing format. The final summary should name the affected docs/screenshots/GIF chapters, or say why each category stayed unchanged.
