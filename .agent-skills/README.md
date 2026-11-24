# Vendored interface skills

`jakubkrehel-skills/` is a verbatim copy of
[jakubkrehel/skills](https://github.com/jakubkrehel/skills) at commit
`8b254eb75dadf3615a6abce87aed28e1b6e4d77c` (2026-11-10), MIT, © Jakub Krehel.

It is kept in the repository so the design rules this project is held to travel
with it: `better-interface` (the orchestrator), `better-accessibility`,
`better-layout`, `better-writing`, `better-typography`, `better-colors`,
`better-ui`, plus `interface-review` for change-scoped reviews.

Nothing in this directory is imported by the application or by any script. It is
documentation for whoever touches `src/components/line/` next.

`skills/teardown/assets/` (viewer JS, ~600 KB) was dropped: it is a 3D teardown
viewer that this project never uses. Every `SKILL.md` and reference page is
intact.

The rules that changed this codebase are summarised in
[`docs/DESIGN.md`](../docs/DESIGN.md) under «Правила, которые действуют сейчас»,
so nobody has to read 500 KB of skill files to make a card.

Additional upstream collections are installed in the standard
[`../.agents/skills/`](../.agents/skills/) directory. The root
[`AGENTS.md`](../AGENTS.md) now requires a skill-first workflow and Grill Me
alignment before project changes. Skill names were checked against this
collection; none of the 67 added skills duplicates one of these 15.
