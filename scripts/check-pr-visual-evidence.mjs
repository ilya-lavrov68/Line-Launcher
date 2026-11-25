import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const eventPath = process.argv[2] ?? process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error(
    "Usage: node scripts/check-pr-visual-evidence.mjs <GitHub event JSON>",
  );
  process.exit(2);
}

let event;
try {
  event = JSON.parse(readFileSync(eventPath, "utf8"));
} catch (error) {
  console.error(`[pr-evidence] Cannot read GitHub event: ${error.message}`);
  process.exit(2);
}

const pullRequest = event.pull_request;
if (!pullRequest) {
  console.error("[pr-evidence] This check only runs for pull_request events.");
  process.exit(2);
}

const body = pullRequest.body ?? "";
const requiredStatements = [
  {
    label: "full screenshot run",
    pattern:
      /^- \[x\] \*\*Screenshots:\*\* Ran `npm run screenshots`; reviewed the complete set of 14 current browser captures\.$/im,
  },
  {
    label: "all GIF and poster outputs regenerated",
    pattern:
      /^- \[x\] \*\*Guidebook:\*\* Regenerated and reviewed all six GIFs and all six posters from those browser captures\.$/im,
  },
  {
    label: "documentation and verification updated",
    pattern:
      /^- \[x\] \*\*Docs:\*\* Updated README\.md and relevant docs; refreshed `docs\/VERIFICATION\.md` and `docs\/visual-evidence\.json`\.$/im,
  },
  {
    label: "visual evidence hashes verified",
    pattern:
      /^- \[x\] \*\*Integrity:\*\* `npm run visual-evidence:check` passes against the committed images and GIFs\.$/im,
  },
];

const missing = requiredStatements
  .filter(({ pattern }) => !pattern.test(body))
  .map(({ label }) => label);
if (missing.length) {
  console.error(
    `[pr-evidence] Complete the required PR checklist before review: ${missing.join(", ")}.`,
  );
  process.exitCode = 1;
}

let changed;
try {
  changed = new Set(
    execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        `${pullRequest.base.sha}...${pullRequest.head.sha}`,
      ],
      { encoding: "utf8" },
    )
      .split(/\r?\n/)
      .filter(Boolean),
  );
} catch (error) {
  console.error(`[pr-evidence] Cannot inspect PR diff: ${error.message}`);
  process.exit(2);
}

for (const requiredPath of [
  "README.md",
  "docs/VERIFICATION.md",
  "docs/visual-evidence.json",
]) {
  if (!changed.has(requiredPath)) {
    console.error(`[pr-evidence] Every PR must refresh ${requiredPath}.`);
    process.exitCode = 1;
  }
}
if (
  ![...changed].some(
    (file) =>
      file.startsWith("docs/") &&
      file.endsWith(".md") &&
      file !== "docs/VERIFICATION.md",
  )
) {
  console.error(
    "[pr-evidence] Every PR must update at least one relevant docs/*.md page.",
  );
  process.exitCode = 1;
}

if (process.exitCode) process.exit(process.exitCode);
console.log(
  "[pr-evidence] Required screenshots, guidebook, and documentation audit passed.",
);
