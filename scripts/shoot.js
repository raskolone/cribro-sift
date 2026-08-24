"use strict";

/**
 * Podgląd wizualny. Renderuje stronę w prawdziwym Chromium, czeka na fonty
 * i animacje, zbiera błędy konsoli i zapisuje zrzuty.
 *
 *   node scripts/shoot.js landing            pełna strona
 *   node scripts/shoot.js landing hero 1200  wycinek od danego przewinięcia
 *   node scripts/shoot.js app
 */

const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const root = path.join(__dirname, "..");
const out = path.join(root, ".shots");
const CHROME =
  "/Users/maciej/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const TARGETS = {
  landing: { file: "landing/index.html", width: 1440, height: 900 },
  app: { file: "src/renderer/index.html", width: 1280, height: 860 },
  hud: { file: "src/renderer/hud.html", width: 340, height: 150 },
};

(async () => {
  const [name = "landing", label = "full", scrollTo = "0", waitMs = "4200"] = process.argv.slice(2);
  const target = TARGETS[name];
  if (!target) throw new Error(`Nieznany cel: ${name}`);

  fs.mkdirSync(out, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    args: ["--no-sandbox", "--force-color-profile=srgb", "--font-render-hinting=none"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: target.width, height: target.height, deviceScaleFactor: 2 });

  const problems = [];
  page.on("pageerror", (error) => problems.push(`BŁĄD JS: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`KONSOLA: ${message.text()}`);
  });
  page.on("requestfailed", (request) =>
    problems.push(`ŻĄDANIE: ${request.url().slice(0, 90)} — ${request.failure()?.errorText}`),
  );

  await page.goto(`file://${path.join(root, target.file)}`, {
    waitUntil: "networkidle0",
    timeout: 30000,
  });
  await page.evaluate(() => document.fonts.ready);

  if (Number(scrollTo) > 0) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), Number(scrollTo));
  }
  await new Promise((resolve) => setTimeout(resolve, Number(waitMs)));

  const file = path.join(out, `${name}-${label}.png`);
  await page.screenshot({ path: file, fullPage: label === "full" && name !== "landing" });

  // Diagnostyka: czy coś ważnego zostało niewidoczne?
  const invisible = await page.evaluate(() => {
    const hidden = [];
    for (const el of document.querySelectorAll("h1, h2, p, section, .reveal, .btn")) {
      const style = getComputedStyle(el);
      if (parseFloat(style.opacity) < 0.05 && el.offsetParent !== null) {
        hidden.push(`${el.tagName}.${el.className}`.slice(0, 60));
      }
    }
    return hidden.slice(0, 12);
  });

  await browser.close();

  console.log(`→ ${path.relative(root, file)}`);
  if (problems.length) console.log("PROBLEMY:\n  " + problems.join("\n  "));
  if (invisible.length) console.log("NIEWIDOCZNE (opacity 0):\n  " + invisible.join("\n  "));
  if (!problems.length && !invisible.length) console.log("czysto");
})();
