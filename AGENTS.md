# Agent workflow

## Skill-first rule — required before every task

1. Before planning, editing, running task-specific commands, or reviewing this repository, read `.agents/skills/README.md` and `.agent-skills/README.md`.
2. Select the skills relevant to the request. Read each selected `SKILL.md` completely, plus any local references it explicitly requires. Do not load unrelated skills; the index records the complete installed set.
3. For **every change to product behavior, code, UI/design, documentation, or project configuration**, first read `.agents/skills/grill-me/SKILL.md` and `.agents/skills/grilling/SKILL.md`. Run Grill Me as a decision-tree interview: ask the current frontier of questions with a recommendation for each, wait for answers, continue through newly unblocked questions, then summarize the agreed scope and get the user's confirmation. **Do not implement until the Grill Me tree is closed and the user confirms the summary.**
4. If the runtime does not expose a skill-invocation tool, follow the installed skill files manually and conduct the Grill Me rounds in the conversation (use the structured question UI when available).
5. For review, deployment, PR, testing, or other operational tasks, read the corresponding skill(s) first; use Grill Me as well whenever the request introduces a product/project decision. Never run scripts bundled with a skill unless the user-approved task actually requires them and their contents have been inspected.

`CONTRIBUTING.md` and the project's safety, security, documentation, and branch rules remain in force alongside this workflow.
