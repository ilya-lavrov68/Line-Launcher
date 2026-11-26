# Agent workflow

## Skill-first rule — required before every task

1. Before planning, editing, running task-specific commands, or reviewing this repository, read `.agents/skills/README.md` and `.agent-skills/README.md`.
2. Select the skills relevant to the request. Read each selected `SKILL.md` completely, plus any local references it explicitly requires. Do not load unrelated skills; the index records the complete installed set.
3. For **every change to product behavior, code, UI/design, documentation, or project configuration**, first read `.agents/skills/grill-me/SKILL.md` and `.agents/skills/grilling/SKILL.md`. Run Grill Me as a decision-tree interview: ask the current frontier of questions with a recommendation for each, wait for answers, continue through newly unblocked questions, then summarize the agreed scope and get the user's confirmation. **Do not implement until the Grill Me tree is closed and the user confirms the summary.**
4. If the runtime does not expose a skill-invocation tool, follow the installed skill files manually and conduct the Grill Me rounds in the conversation (use the structured question UI when available).
5. For review, deployment, PR, testing, or other operational tasks, read the corresponding skill(s) first; use Grill Me as well whenever the request introduces a product/project decision. Never run scripts bundled with a skill unless the user-approved task actually requires them and their contents have been inspected.

## Canonical product-design authority

For any UI or product-design work, read `.agents/skills/product-design/SKILL.md` and treat it as the primary source for design direction, information architecture, and visual hierarchy. It supersedes conflicting generic aesthetic recipes in imported skills, including `frontend-design` and `better-ui`; do not edit vendored skill sources to resolve a conflict. Keep specialist requirements for accessibility, measured contrast, localization, platform semantics, and functional verification in force. For Line-specific decisions, read `docs/DESIGN.md` as the current product profile and update it when the approved design changes.

## Documentation and visual evidence

Before changing behavior, identify the user-facing contracts and the documentation that describes them; check each document against the current code rather than treating old text as truth. Update the relevant `docs/` and README sections in the same change. For UI changes, run the real app in a live browser, inspect the actual affected states and controls, and regenerate affected committed UI screenshots from that browser only after the checks pass. Never replace a missing browser run with hand-drawn/offline renderings or fixtures presented as real screenshots. Record unavailable checks and stale screenshots explicitly in `docs/VERIFICATION.md`; do not claim verification that did not happen.

### Required Chromium restoration before every screenshot/GIF capture

Before taking screenshots or recording any GIFs, run `npm run browser:restore`. It validates the selected executable, reuses an installed browser or Playwright's pinned cache, restores Playwright Chromium if absent, and on Linux x64 has a version-matched npm-registry fallback for restricted browser-CDN environments. `npm run screenshots` also runs this restoration automatically before capture; do not invoke the raw capture script directly. If restoration fails, diagnose the error and stop—never reuse stale assets or substitute offline drawings for real captures.

## Mandatory pre-PR visual-evidence refresh — no exceptions

Before opening **any** pull request, even for a backend-only, internal, or documentation-only change:

1. After the final code edits, run the full real-browser `npm run screenshots` capture. This refreshes all 14 images in `docs/images/`, all six GIFs and six poster PNGs in `public/guidebook/`, and the SHA-256 capture manifest `docs/visual-evidence.json`.
2. Review the complete gallery and guidebook, refresh the README's generated-on record, update the relevant player documentation, and update the current verification record in `docs/VERIFICATION.md`.
3. Run `npm run visual-evidence:check`, check the PR template boxes, and do not open the PR until the screenshot run succeeded and every box is true. CI independently validates the hashes and rejects PRs without the refresh record and documentation changes.
4. If a browser or image tool is unavailable, stop: do not open the PR with stale assets. Resolve the environment and rerun the required capture; never substitute mock or hand-drawn screenshots.

This rule is unconditional. Identical image pixels are acceptable only when the full capture was rerun and the new manifest verifies the complete committed set.

`CONTRIBUTING.md` and the project's safety, security, documentation, and branch rules remain in force alongside this workflow.
