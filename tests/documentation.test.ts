import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DICTIONARIES } from "../src/lib/line/i18n-dictionaries.ts";

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

test("the in-app player guide has six authentic illustrations and direct chapter navigation", () => {
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
  assert.match(component, /PAGES\.map/);
  assert.match(component, /setPage\(index\)/);
  assert.match(component, /aria-current/);
  assert.match(component, /<DialogContent/);
  assert.match(component, /<img/);
  assert.match(component, /current\.body/);
  assert.match(component, /tour\.pauseAnimation/);
  assert.match(component, /tour\.playAnimation/);
  const dictionaries = readFileSync(
    path.join(root, "src/lib/line/i18n-dictionaries.ts"),
    "utf8",
  );
  for (const phrase of [
    "Choose a topic",
    "Thema auswählen",
    "Choisir un sujet",
    "Выберите тему",
    "Close for now",
    "Vorläufig schließen",
    "Fermer pour le moment",
    "Позже — закрыть справочник",
  ]) {
    assert.ok(
      dictionaries.includes(phrase),
      `missing guidebook translation: ${phrase}`,
    );
  }
  assert.match(
    readFileSync(path.join(root, "README.md"), "utf8"),
    /Встроенный справочник игрока/,
  );
});

test("all guidebook chapters and defer controls are complete in every supported locale", () => {
  const keys = [
    "tour.title",
    "tour.intro",
    "tour.choose",
    "tour.navTitle",
    "tour.navBody",
    "tour.navAlt",
    "tour.catalogTitle",
    "tour.catalogBody",
    "tour.catalogAlt",
    "tour.serverTitle",
    "tour.serverBody",
    "tour.serverAlt",
    "tour.wardrobeTitle",
    "tour.wardrobeBody",
    "tour.wardrobeAlt",
    "tour.accountTitle",
    "tour.accountBody",
    "tour.accountAlt",
    "tour.settingsTitle",
    "tour.settingsBody",
    "tour.settingsAlt",
    "tour.skip",
    "tour.playAnimation",
    "tour.pauseAnimation",
  ] as const;
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    for (const key of keys) {
      assert.ok(
        dictionary[key].trim().length > 0,
        `${locale} is missing ${key}`,
      );
      assert.notEqual(
        dictionary[key],
        key,
        `${locale}.${key} contains an untranslated key`,
      );
    }
  }
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
  assert.match(verification, /431 total, 430 passed, 1 skipped, 0 failed/);
  assert.match(verification, /14 screenshots, six GIFs, and six poster PNGs/);
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
