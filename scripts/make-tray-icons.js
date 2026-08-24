"use strict";
/**
 * Ikony paska menu, renderowane z tego samego znaku, co reszta marki.
 *   node scripts/make-tray-icons.js
 *
 * macOS chce ikon o wysokości 18 pt, więc generujemy 18 px i 36 px (@2x).
 * Electron sam wybierze właściwą, jeśli leżą obok siebie z sufiksem @2x.
 *
 * Stan „gotowe" jest szablonem (czarny + alfa): macOS przemaluje go na biało
 * w ciemnym pasku i na czarno w jasnym. Stany pracy są kolorowe i celowo
 * łamią tę zasadę — mają przyciągać wzrok, a nie wtapiać się w tło.
 */
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME =
  "/Users/maciej/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

/* Kolory bierzemy z motywu, nie z pamięci — tokeny są jedynym miejscem,
   w którym wolno trzymać surowy kolor. */
const tokens = fs.readFileSync(path.join(__dirname, "..", "design", "themes", "tokens.css"), "utf8");
const token = (name) => tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1];

const MINT = token("accent");
const AMBER = token("warn");
const PURPLE = token("rec");
const ON_MINT = token("accent-ink");
const ON_PURPLE = token("rec-ink");

/* Znak Cribro sprowadzony do tego, co czytelne przy 18 px: krąg i sito.
   Delikatna siateczka z dużej ikony zlewałaby się w plamę. */
const shapes = {
  idle: `
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.1"/>
    <path d="M4.6 9.6h14.8M4.6 14.4h14.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,

  /* Nasłuch: pełne koło z falą w środku — widać je kątem oka. Fiolet,
     nie zieleń: zieleń w pasku menu znaczy „gotowe", a to jest dokładnie
     przeciwieństwo gotowego. */
  listening: `
    <circle cx="12" cy="12" r="9.4" fill="currentColor"/>
    <path d="M8 10v4M12 7.4v9.2M16 10v4" stroke="${ON_PURPLE}" stroke-width="2.1" stroke-linecap="round"/>`,

  /* Przesiewanie: sito z ziarnami, które przez nie przechodzą. */
  sifting: `
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.1"/>
    <path d="M4.6 12h14.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="9" cy="8" r="1.5" fill="currentColor"/>
    <circle cx="14.5" cy="16" r="1.5" fill="currentColor"/>`,

  /* Gotowe: znacznik w kole. */
  done: `
    <circle cx="12" cy="12" r="9.4" fill="currentColor"/>
    <path d="M7.6 12.2l3 3 5.8-6" fill="none" stroke="${ON_MINT}" stroke-width="2.3"
          stroke-linecap="round" stroke-linejoin="round"/>`,
};

const COLOR = { idle: "#000000", listening: PURPLE, sifting: AMBER, done: MINT };

function page(name, size) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
svg{display:block;color:${COLOR[name]}}</style>
<svg width="${size}" height="${size}" viewBox="0 0 24 24">${shapes[name]}</svg>`;
}

(async () => {
  const out = path.join(__dirname, "..", "assets", "tray");
  fs.mkdirSync(out, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "shell",
    args: ["--no-sandbox"],
  });

  for (const name of Object.keys(shapes)) {
    for (const [size, suffix] of [[18, ""], [36, "@2x"]]) {
      const tab = await browser.newPage();
      await tab.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      // Szablon musi nazywać się Template, żeby macOS go przemalował.
      const file = path.join(out, `${name}${name === "idle" ? "Template" : ""}${suffix}.png`);
      await tab.setContent(page(name, size), { waitUntil: "networkidle0" });
      await tab.screenshot({ path: file, omitBackground: true });
      await tab.close();
    }
  }

  await browser.close();
  console.log("Ikony paska menu:", fs.readdirSync(out).join(", "));
})();
