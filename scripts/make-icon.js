"use strict";
/* Ikona aplikacji renderowana z tego samego znaku, co reszta marki.
   node scripts/make-icon.js → build/icon.png (potem iconutil robi .icns) */
const path = require("path");
const puppeteer = require("puppeteer-core");
const CHROME =
  "/Users/maciej/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "shell", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
  await page.goto(`file://${process.argv[2]}`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: path.join(__dirname, "..", "build", "icon.png"), omitBackground: true });
  await browser.close();
  console.log("build/icon.png");
})();
