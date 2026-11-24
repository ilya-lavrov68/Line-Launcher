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

test("documentation has one active roadmap and labels current integration limits", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const roadmap = read("docs/ROADMAP.md");
  const verification = read("docs/VERIFICATION.md");
  assert.match(roadmap, /Единственное место для активных планов проекта/);
  assert.match(roadmap, /не передавать UUID из\s+интерфейса лаунчера/i);
  assert.match(roadmap, /не добавлять endpoint, поля ответа, mock-метрики/i);
  assert.match(verification, /423 total, 422 passed, 1 skipped, 0 failed/);
  assert.match(verification, /npm run screenshots` passed and regenerated/);
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
