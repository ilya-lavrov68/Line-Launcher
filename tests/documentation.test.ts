import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("README and every documentation page have valid local markdown links", () => {
  const markdownFiles = (directory: string): string[] =>
    readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(
      (entry) => {
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) return markdownFiles(relative);
        return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
      },
    );
  const files = ["README.md", ...markdownFiles("docs")];
  for (const file of files) {
    const body = readFileSync(path.join(root, file), "utf8");
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0].split("?")[0];
      if (!target || /^(https?:|mailto:|<|\/)/.test(target)) continue;
      assert.ok(
        existsSync(path.resolve(root, path.dirname(file), target)),
        `${file}: ${target}`,
      );
    }
  }
});

test("the in-app guidebook has six GIF pages with real navigation controls", () => {
  const component = readFileSync(
    path.join(root, "src/components/line/LauncherTour.tsx"),
    "utf8",
  );
  const pageGifs = [
    "navigation",
    "servers",
    "server-actions",
    "wardrobe",
    "account",
    "settings",
  ];
  for (const name of pageGifs) {
    const file = path.join(root, "public/guidebook", `${name}.gif`);
    const poster = path.join(root, "public/guidebook", `${name}.png`);
    assert.ok(existsSync(file), `missing ${name} guidebook animation`);
    assert.ok(existsSync(poster), `missing ${name} reduced-motion poster`);
    const signature = readFileSync(file).subarray(0, 6).toString("ascii");
    assert.ok(["GIF87a", "GIF89a"].includes(signature), `${name} is not a GIF`);
    assert.ok(component.includes(`/guidebook/${name}.gif`));
    assert.ok(component.includes(`/guidebook/${name}.png`));
  }
  assert.match(component, /tour\.back/);
  assert.match(component, /tour\.next/);
  assert.match(component, /<img/);
  assert.match(component, /current\.body/);
  assert.match(component, /useReducedMotion/);
  assert.match(component, /tour\.pauseAnimation/);
  assert.match(component, /tour\.playAnimation/);
  assert.match(
    readFileSync(path.join(root, "README.md"), "utf8"),
    /GIF-прохождениями/,
  );
});

test("the project skill keeps screenshots, docs, and GIF guidebook changes linked", () => {
  const skill = readFileSync(
    path.join(root, ".agents/skills/launcher-guidebook-maintenance/SKILL.md"),
    "utf8",
  );
  const index = readFileSync(
    path.join(root, ".agents/skills/README.md"),
    "utf8",
  );
  assert.match(index, /launcher-guidebook-maintenance/);
  assert.match(skill, /npm run screenshots/);
  assert.match(skill, /generate-guidebook-gifs\.py/);
  assert.match(skill, /docs\/VERIFICATION\.md/);
  assert.match(skill, /Never present mock, fixture-only, hand-drawn/);
});

test("every PR is gated on full screenshots, guidebook refresh, docs, and hash evidence", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const instructions = read("AGENTS.md");
  const template = read(".github/pull_request_template.md");
  const workflow = read(".github/workflows/ci.yml");
  assert.match(
    instructions,
    /Mandatory pre-PR visual-evidence refresh — no exceptions/,
  );
  assert.match(
    instructions,
    /full real-browser `npm run screenshots` capture/i,
  );
  assert.match(template, /all six GIFs and all six posters/);
  assert.match(template, /\*\*Integrity:\*\* `npm run visual-evidence:check`/);
  assert.match(template, /docs\/visual-evidence\.json/);
  assert.match(workflow, /pr-visual-evidence:/);
  assert.match(workflow, /check-pr-visual-evidence\.mjs/);
  assert.match(workflow, /visual-evidence:check/);
});

test("documentation has one active roadmap and labels current integration limits", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const roadmap = read("docs/ROADMAP.md");
  const verification = read("docs/VERIFICATION.md");
  assert.match(roadmap, /Единственное место для активных планов проекта/);
  assert.match(roadmap, /не передавать UUID из\s+интерфейса лаунчера/i);
  assert.match(roadmap, /не добавлять endpoint, поля ответа, mock-метрики/i);
  assert.match(verification, /430 total, 429 passed, 1 skipped, 0 failed/);
  assert.match(
    verification,
    /npm run screenshots` passed after the final UI changes/,
  );
  assert.match(verification, /14 real-browser screenshots/);
  assert.match(verification, /mocked Tauri IPC/);
  assert.match(
    read("CONTRIBUTING.md"),
    /Обновляйте документацию в том же изменении/,
  );
  assert.equal(
    existsSync(path.join(root, "docs/INSTALLATION-ROADMAP.md")),
    false,
  );
  assert.equal(existsSync(path.join(root, "docs/PLAN-0.12-0.15.md")), false);
  assert.doesNotMatch(
    read("docs/PROVIDER.md"),
    /автоматический выбор JRE из сети и загрузка Java лаунчером не реализованы/,
  );
});
