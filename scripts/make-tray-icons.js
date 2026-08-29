"use strict";
/**
 * Ikony paska menu, renderowane z tego samego znaku, co reszta marki.
 *   node scripts/make-tray-icons.js
 *
 * macOS chce ikon o wysokości 18 pt, więc generujemy 18 px i 36 px (@2x).
 * Electron sam wybierze właściwą, jeśli leżą obok siebie z sufiksem @2x.
 *
 * RYSUJE ELECTRON, NIE PUPPETEER. Zrzut z puppeteera na tej maszynie nigdy
 * nie wraca — `page.screenshot()` wisi w nieskończoność i skrypt trzeba
 * ubijać ręcznie. Electron i tak jest w zależnościach, a `capturePage`
 * z ukrytego okna robi dokładnie to samo. Uruchamia się to więc inaczej
 * niż resztę skryptów:
 *
 *   npx electron scripts/make-tray-icons.js
 *
 * Stan „gotowe" jest szablonem (czarny + alfa): macOS przemaluje go na biało
 * w ciemnym pasku i na czarno w jasnym. Stany pracy są kolorowe i celowo
 * łamią tę zasadę — mają przyciągać wzrok, a nie wtapiać się w tło.
 */
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

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

const AIR = token("air");
const ON_AIR = token("air-ink");

/* Nagrywanie SPOTKANIA. Osobny stan i osobny kolor — dlaczego czerwień,
   a nie fiolet, patrz --air w design/themes/tokens.css. Kropka w środku
   to znak nagrywania, ten sam od czasów magnetofonów; przy osiemnastu
   pikselach fale z ikony w oknie zlałyby się w plamę. */
const AIR_SHAPE = `
    <circle cx="12" cy="12" r="9.4" fill="currentColor"/>
    <circle cx="12" cy="12" r="3.4" fill="${ON_AIR}"/>`;
shapes.meeting = AIR_SHAPE;

const COLOR = { idle: "#000000", listening: PURPLE, sifting: AMBER, done: MINT, meeting: AIR };

function page(name, size) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
svg{display:block;color:${COLOR[name]}}</style>
<svg width="${size}" height="${size}" viewBox="0 0 24 24">${shapes[name]}</svg>`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = path.join(__dirname, "..", "assets", "tray");
  fs.mkdirSync(out, { recursive: true });

  /* Okno rysujące. Przezroczyste i postawione poza ekranem: `show: false`
     nie wystarcza, bo okno schowane nie ma czego malować i capturePage
     oddaje pustą klatkę. */
  const win = new BrowserWindow({
    show: true,
    x: -3000,
    y: 0,
    width: 64,
    height: 64,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
  });

  for (const name of Object.keys(shapes)) {
    for (const [size, suffix] of [[18, ""], [36, "@2x"]]) {
      win.setBounds({ x: -3000, y: 0, width: size, height: size });
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page(name, size)));
      await wait(120);
      const image = await win.webContents.capturePage();
      // Szablon musi nazywać się Template, żeby macOS go przemalował.
      const file = path.join(out, `${name}${name === "idle" ? "Template" : ""}${suffix}.png`);
      fs.writeFileSync(file, image.toPNG());
    }
  }

  console.log("Ikony paska menu:", fs.readdirSync(out).sort().join(", "));
  app.exit(0);
});
