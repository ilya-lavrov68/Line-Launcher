// Geometry regression with a mocked backend; run alongside `npm run dev`.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserHelp, findBrowser } from "./lib/find-browser.mjs";

const base = process.env.BASE_URL || "http://127.0.0.1:5173";
const executablePath = findBrowser()?.path;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-gpu"],
  });
} catch (error) {
  console.error(`${error.message}\n${browserHelp()}`);
  process.exit(2);
}
try {
  for (const width of [1100, 640]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/tests/ui/server-dock/`);
    const region = page.getByRole("region", { name: "BattleArmory" });
    const play = region.getByRole("button", { name: "Играть", exact: true });
    const testMode = region.getByRole("button", { name: "Тестовый режим" });
    await play.waitFor();
    await page.waitForTimeout(350);
    const beforePlay = await play.boundingBox();
    const beforeTest = await testMode.boundingBox();
    assert.ok(beforePlay && beforeTest);
    await play.click();
    await page.waitForFunction(() => window.requestCount() === 1);
    await page.evaluate(() => window.pushProgress());
    await region.getByRole("progressbar").waitFor();
    const afterPlay = await play.boundingBox();
    const afterTest = await testMode.boundingBox();
    for (const [before, after] of [
      [beforePlay, afterPlay],
      [beforeTest, afterTest],
    ]) {
      assert.ok(after);
      assert.ok(
        Math.abs(before.x - after.x) < 1 &&
          Math.abs(before.y - after.y) < 1 &&
          Math.abs(before.width - after.width) < 1,
        `action moved at width ${width}`,
      );
    }
    assert.equal(
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Настройки" })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "Все серверы" }).isDisabled(),
      true,
    );
    await page.evaluate(() => window.finishPlay());
    await page.waitForFunction(
      () => !document.querySelector('[role="progressbar"]'),
    );
    assert.equal(
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Настройки" })
        .isDisabled(),
      false,
    );
    await testMode.click();
    await page.waitForFunction(() => window.requestCount() === 2);
    assert.equal(
      await page.evaluate(() => window.lastRequest().testMode),
      true,
    );
    await page.evaluate(() => window.failPlay());
    await region.getByRole("alert").waitFor();
    const afterError = await play.boundingBox();
    assert.ok(
      afterError && Math.abs(beforePlay.y - afterError.y) < 1,
      "error moved the primary action",
    );
    await region.getByRole("button", { name: "Подготовить заранее" }).click();
    await page.waitForFunction(() => window.requestCount() === 3);
    assert.equal(
      await page.evaluate(() => window.lastRequest().prepareOnly),
      true,
    );
    await page.evaluate(() => window.finishPlay());
    await page.waitForFunction(
      () => !document.querySelector('[role="progressbar"]'),
    );
    await page.locator("[data-test-mode-switch]").click();
    const archive = page.getByRole("region", { name: "Other" });
    const install = archive.getByRole("button", { name: "Установить сборку" });
    await install.waitFor();
    await page.waitForTimeout(350);
    const before = await install.boundingBox();
    await install.click();
    const cancel = archive.getByRole("button", { name: "Отменить загрузку" });
    await cancel.waitFor();
    const after = await cancel.boundingBox();
    assert.ok(
      before &&
        after &&
        Math.abs(before.y - after.y) < 1 &&
        Math.abs(before.width - after.width) < 1,
      `archive action moved at width ${width}`,
    );
    await page.goto(`${base}/tests/ui/server-dock/?catalogue`);
    const refresh = page.getByRole("button", { name: "Обновить", exact: true });
    const addSection = page.getByRole("button", { name: "Добавить секцию" });
    await refresh.waitFor();
    await page.waitForTimeout(350);
    const refreshBefore = await refresh.boundingBox();
    const sectionBefore = await addSection.boundingBox();
    await refresh.click();
    const refreshingButton = page.getByRole("button", { name: "Обновляем…" });
    await refreshingButton.waitFor();
    const refreshAfter = await refreshingButton.boundingBox();
    const sectionAfter = await addSection.boundingBox();
    assert.ok(
      refreshBefore &&
        refreshAfter &&
        Math.abs(refreshBefore.width - refreshAfter.width) < 1,
      "refresh button resized",
    );
    assert.ok(
      sectionBefore &&
        sectionAfter &&
        Math.abs(sectionBefore.y - sectionAfter.y) < 1,
      "add-section button moved or disappeared",
    );
    assert.equal(await addSection.isDisabled(), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "Server dock: action positions, progress, navigation lock and archive mode passed at both widths (mock backend).",
  );
} finally {
  await browser.close();
}
