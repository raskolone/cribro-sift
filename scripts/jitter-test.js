"use strict";

/**
 * Czy nieruchomy ekran naprawdę stoi.
 *
 * Aplikacja NIC nie robi — nikt nie klika, nic się nie przewija — a mimo to
 * górne krawędzie notatek, panelu i listy drgają. Oko to widzi, a zrzut nie,
 * bo pojedynczy zrzut łapie jedną klatkę i każda z osobna wygląda dobrze.
 * Ten skrypt łapie ich kilkanaście po kolei i PORÓWNUJE. Piksel, który
 * zmienia się bez powodu, jest właśnie tym drżeniem.
 *
 * Raport idzie WIERSZAMI, bo drżenie jest krawędziowe: interesuje nas nie
 * „ile pikseli", tylko „na jakiej wysokości".
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/jitter-test.js
 *   … --view notes --frames 14
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const renderer = path.join(root, "src", "renderer");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const FILE = arg("file", "index.html");
const VIEW = arg("view", "notes");
const FRAMES = Number(arg("frames", 14));
const WIDTH = Number(arg("width", 1120));
const HEIGHT = Number(arg("height", 720));
/* Odstęp mniejszy niż klatka (16 ms) łapałby tę samą klatkę dwa razy
   i pokazywał ciszę tam, gdzie jej nie ma. */
const GAP = Number(arg("gap", 90));
/* Próg na kanał. Kompresja i wygładzanie kroju potrafią przesunąć wartość
   o jeden — to nie jest drżenie, tylko zaokrąglenie. */
const NOISE = 6;

const sandbox = path.join(os.tmpdir(), "cribro-jitter");
fs.rmSync(sandbox, { recursive: true, force: true });
app.setPath("userData", sandbox);

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    backgroundColor: "#0a0f14",
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadFile(path.join(renderer, FILE), { search: `view=${VIEW}` });
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  /* Cztery sekundy: tyle trwa najdłuższa animacja wejścia widoku plus zapas.
     Mierzymy SPOCZYNEK, więc wszystko, co miało dojechać, ma już stać. */
  await wait(4000);

  const shots = [];
  for (let i = 0; i < FRAMES; i += 1) {
    const image = await win.webContents.capturePage();
    shots.push({ bitmap: image.toBitmap(), size: image.getSize() });
    await wait(GAP);
  }

  const { width, height } = shots[0].size;
  const rows = new Array(height).fill(0);
  let moving = 0;

  /* Porównujemy KAŻDĄ klatkę z pierwszą, a nie z poprzednią: drżenie bywa
     wahadłem między dwoma stanami i sąsiednie klatki potrafią być wtedy
     identyczne co drugą. */
  for (let f = 1; f < shots.length; f += 1) {
    const a = shots[0].bitmap;
    const b = shots[f].bitmap;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        if (
          Math.abs(a[at] - b[at]) > NOISE ||
          Math.abs(a[at + 1] - b[at + 1]) > NOISE ||
          Math.abs(a[at + 2] - b[at + 2]) > NOISE
        ) {
          rows[y] += 1;
          moving += 1;
        }
      }
    }
  }

  const perFrame = Math.round(moving / (shots.length - 1));
  console.log(`\nWidok „${VIEW}", ${shots.length} klatek w spoczynku, ${width}×${height}`);
  console.log(`Ruchomych pikseli na klatkę: ${perFrame}`);

  const loud = rows
    .map((count, y) => ({ y, count: Math.round(count / (shots.length - 1)) }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);

  if (!loud.length) {
    console.log("Ekran stoi. Żaden piksel nie drgnął.\n");
  } else {
    console.log(`Niespokojnych wierszy: ${loud.length} z ${height}`);
    console.log("Najgorsze wysokości (y — ile pikseli w wierszu drga):");
    for (const row of loud.slice(0, 14)) {
      const bar = "█".repeat(Math.min(40, Math.ceil(row.count / 8)));
      console.log(`  y=${String(row.y).padStart(4)}  ${String(row.count).padStart(5)}  ${bar}`);
    }
    console.log("");
  }

  app.exit(loud.length ? 1 : 0);
});
