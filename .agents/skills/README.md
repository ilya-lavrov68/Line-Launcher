# Installed Agent Skills

These are project-local Agent Skills in the standard `.agents/skills/<skill-name>/SKILL.md` layout. They are source material for agents, not application dependencies; no bundled scripts were executed during installation.

## Before using skills

Follow the skill-first and Grill Me process in [`AGENTS.md`](../../AGENTS.md). Read the complete skill relevant to the task and any references it explicitly requires. For project changes, always read `grill-me` and `grilling`, interview in rounds, and wait for confirmation before implementation.

## Sources and pinned snapshots

- [`mattpocock/skills`](https://github.com/mattpocock/skills) at `abeeaf95660ba9e8b7c753eb38f441ca707a8823` — 39 skills.
  - `ask-matt`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-with-docs`, `implement`, `implement-spec`, `improve-codebase-architecture`, `pr`, `prototype`, `research`, `retro`, `setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, `wizard`, `chief-of-staff`, `claude-handoff`, `loop-me`, `setup-ts-deep-modules`, `software-factory`, `writing-beats`, `writing-fragments`, `writing-shape`, `git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`, `grill-me`, `grilling`, `handoff`, `teach`, `to-questionnaire`, `wait-what`, `writing-for-agents`
- [`vercel-labs/agent-skills`](https://github.com/vercel-labs/agent-skills) at `5a37a6329fbad3666c3207392a6a7c0110e92efb` — 9 skills.
  - `vercel-composition-patterns`, `deploy-to-vercel`, `vercel-react-best-practices`, `vercel-react-native-skills`, `vercel-react-view-transitions`, `vercel-cli-with-tokens`, `vercel-optimize`, `web-design-guidelines`, `writing-guidelines`
- [`anthropics/skills`](https://github.com/anthropics/skills) at `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` — 19 skills.
  - `academy-guide`, `algorithmic-art`, `brand-guidelines`, `canvas-design`, `claude-api`, `discernment-nudge`, `doc-coauthoring`, `docx`, `frontend-design`, `internal-comms`, `mcp-builder`, `pdf`, `pptx`, `skill-creator`, `slack-gif-creator`, `theme-factory`, `web-artifacts-builder`, `webapp-testing`, `xlsx`

## Existing collection and duplicate check

The pre-existing curated collection remains in `.agent-skills/jakubkrehel-skills/`. Its 15 skill names were compared with the 67 names above; no exact-name duplicates were found, so no requested skill was skipped. There are also no duplicate names among the three newly installed sources.

## Licensing and provenance

Skill folders and their bundled references/assets were copied without modifying their contents. Matt Pocock’s repository MIT license is preserved at [`_licenses/mattpocock-skills-MIT.txt`](_licenses/mattpocock-skills-MIT.txt). Vercel and Anthropic do not declare a repository-wide license in GitHub metadata; any per-skill license files/frontmatter have been preserved. Check the relevant upstream skill terms before redistributing skill text or assets outside this repository.

The folders are pinned to the commits above for reproducibility. To update them, review the upstream diff, re-check duplicate names and licensing, then update this index and the hashes.
