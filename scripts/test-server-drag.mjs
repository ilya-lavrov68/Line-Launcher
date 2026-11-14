// Browser-level drag test with a lightweight settings stub, not the Tauri backend.
// Start `npm run dev` in another terminal, then run `npm run test:drag`.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserHelp, findBrowser } from "./lib/find-browser.mjs";

const base = process.env.BASE_URL || "http://127.0.0.1:5173";
const browserPath = findBrowser();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(browserPath ? { executablePath: browserPath.path } : {}),
  });
} catch (error) {
  console.error(`${error.message}\n${browserHelp()}`);
  process.exit(2);
}
try {
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/tests/ui/server-drag/`);
  const card = page.locator('[data-server-drag="one"] [data-line-card]');
  const section = (id) => page.locator(`[data-section-id="${id}"]`);
  await card.waitFor();
  async function startDrag() {
    const from = await card.boundingBox();
    assert.ok(from);
    await page.mouse.move(from.x + 50, from.y + 30);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + 45, { steps: 4 });
    await page.locator("[data-drag-preview]").waitFor();
  }
  async function dropOn(id) {
    const target = section(id);
    await target.waitFor();
    const box = await target.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 25, box.y + 10, { steps: 12 });
    assert.match(await target.getAttribute("class"), /ring-2/);
    await page.mouse.up();
    await page.locator("[data-drag-preview]").waitFor({ state: "detached" });
  }

  // An empty collapsed section accepts a card without opening it.
  await startDrag();
  await dropOn("b");
  assert.equal(await page.locator("[data-opened]").textContent(), "");
  assert.equal(
    JSON.parse(await page.evaluate(() => localStorage.getItem("drag-layout")))
      .assignments.one,
    "b",
  );
  await section("b").locator("button").first().click();

  // With all cards assigned, the otherwise hidden unassigned group appears during drag.
  await startDrag();
  await dropOn("");
  assert.equal(
    await section("").locator('[data-server-drag="one"]').count(),
    1,
  );
  await page.reload();
  assert.equal(
    await section("").locator('[data-server-drag="one"]').count(),
    1,
  );

  // Escape cancels without saving or opening, while an ordinary click still opens.
  const before = await page.evaluate(() => localStorage.getItem("drag-layout"));
  await startDrag();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("drag-layout")),
    before,
  );
  assert.equal(await page.locator("[data-opened]").textContent(), "");
  await card.click();
  assert.equal(await page.locator("[data-opened]").textContent(), "one");
  assert.deepEqual(errors, []);
  console.log(
    "Server drag: collapsed target, unassigned target, reload, cancel and click passed.",
  );
} finally {
  await browser.close();
}
