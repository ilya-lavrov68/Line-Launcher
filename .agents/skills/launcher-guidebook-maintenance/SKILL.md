---
name: launcher-guidebook-maintenance
description: Mandatory before every Line Launcher pull request. Refresh the full real-browser screenshot set, all six GIF/poster pairs, README, player documentation, and verification/hash manifests even when a change appears unrelated to the UI.
---

# Mandatory visual evidence refresh before every PR

This is an unconditional repository rule, not an impact-based suggestion. Before opening any PR, refresh and review the complete screenshot gallery and guidebook, update documentation, and record the run. Do this for backend-only, internal, and documentation-only PRs too. Do not open a PR with stale evidence or skip a category because output appears unchanged.

## Required sequence

1. Finish code changes and run the project checks first: `npm run check`, `npm test`, `npm run build`, relevant Rust checks, and `git diff --check`.
2. Install the capture dependency with `python3 -m pip install -r scripts/requirements-guidebook.txt`, run the real app in Chromium, and execute `npm run screenshots`. This must regenerate all 14 native 1920×1080 screenshots in `docs/images/`, all six native Full HD GIFs and posters in `public/guidebook/`, `docs/visual-evidence.json` with hashes for every generated file, and the generated-on note in `README.md`. The GIF encoder may reduce frame rate, never resolution.
3. Inspect the complete screenshot set and each guidebook chapter. Confirm the controls, labels, state, loop boundary, and navigation still match the real app. Never present mock, fixture-only, hand-drawn, or reconstructed images as real screenshots.
4. Update the relevant player-facing documentation and `docs/VERIFICATION.md` for this PR. The README gallery and verification record are refreshed on every PR; update any other pages describing changed behavior.
5. Run `npm run visual-evidence:check`. Complete every item in `.github/pull_request_template.md`. Only then open the PR. CI validates the hashes, required documentation changes, and checked PR assertions.

If a browser, image tool, Rust toolchain, or other required validator is unavailable, resolve the environment before opening the PR. Do not bypass the gate or claim a check passed when it did not. If capture outputs are byte-identical, the capture still must be rerun; the refreshed dated manifest records the complete verified set.

## Guidebook constraints

- Keep six independent, directly selectable chapters, organized around first-time player tasks: find a server, install and launch a game, move between sections, choose a character skin, check the account, and set up the launcher. The order is a suggested starting point, not a forced sequence.
- Keep each GIF tied to real React UI interactions captured by Playwright; `scripts/generate-guidebook-gifs.py` encodes the browser-frame manifest and creates matching posters.
- Keep localized visible copy in `ru`, `en`, `de`, and `fr`; do not autoplay animations, respect reduced motion, keep replay/pause controls, and preserve loop continuity.
- For new or removed chapters, update the reference UI, capture scenario, README gallery, documentation tests, and manifest expectations together. Do not silently drop an existing topic.
