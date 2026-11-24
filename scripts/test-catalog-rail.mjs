// Browser geometry regression for the image-less featured server fallback.
//
//   npm run dev
//   CHROMIUM_PATH=/path/to/chrome npm run test:catalog-rail
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { browserHelp, findBrowser } from "./lib/find-browser.mjs";

const base = process.env.BASE_URL || "http://127.0.0.1:5173";
const outDir = path.resolve(".smoke/catalog-rail");
mkdirSync(outDir, { recursive: true });

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core не установлен. Выполните: npm ci");
  process.exit(2);
}

let browser;
try {
  const found = findBrowser();
  browser = await chromium.launch({
    headless: true,
    ...(found ? { executablePath: found.path } : {}),
  });
} catch (error) {
  console.error(`${error.message}\n${browserHelp()}`);
  process.exit(2);
}

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
    locale: "ru-RU",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/tests/ui/catalog-rail/`, {
    waitUntil: "domcontentloaded",
  });

  const card = page.locator("[data-line-server-featured]");
  await card.locator("svg.absolute").waitFor();
  for (const width of [1280, 720, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await card.evaluate((element) => {
      const rect = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { left: x, top: y, right: x + width, bottom: y + height };
      };
      const cardBox = rect(element);
      const frameBox = rect(element.parentElement);
      const art = element.querySelector("svg.absolute");
      const action = element.querySelector("button");
      if (!art || !action) return null;
      const fits = (box, bounds) =>
        box.left >= bounds.left - 1 &&
        box.top >= bounds.top - 1 &&
        box.right <= bounds.right + 1 &&
        box.bottom <= bounds.bottom + 1;
      return {
        cardInside: fits(cardBox, frameBox),
        artInside: fits(rect(art), cardBox),
        actionInside: fits(rect(action), cardBox),
        art: rect(art),
        card: cardBox,
        frame: frameBox,
      };
    });
    await page.screenshot({
      path: path.join(outDir, `catalog-rail-${width}.png`),
      animations: "disabled",
    });
    assert.ok(
      bounds?.cardInside,
      `featured card escapes its layout frame at ${width}px: ${JSON.stringify(bounds)}`,
    );
    assert.ok(
      bounds?.artInside,
      `fallback art escapes the card at ${width}px: ${JSON.stringify(bounds)}`,
    );
    assert.ok(
      bounds?.actionInside,
      `catalog action escapes the card at ${width}px: ${JSON.stringify(bounds)}`,
    );
  }
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    "Catalog rail fallback: art and action stay inside the hero at 1280px, 720px, and 375px.",
  );
} finally {
  await browser.close();
}
