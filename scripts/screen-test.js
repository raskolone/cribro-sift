"use strict";

/**
 * Kartki na pulpicie po zmianie rozdzielczości ekranu.
 *
 * Zmiana rozdzielczości nie przesuwa okien — przesuwa KRAWĘDZIE, spod
 * których okna nie uciekają same. Kartka stojąca przy prawej krawędzi
 * pulpitu zostaje po zejściu z 1470 na 1280 punktów dokładnie tam, gdzie
 * była, czyli dwieście pikseli za ekranem. Widać z niej wtedy tyle, ile
 * się zmieściło.
 *
 * Reflow po `display-metrics-changed` miał to naprawiać i naprawiał tylko
 * połowę: pytał, czy ŚRODEK kartki jest jeszcze na pulpicie. Kartka
 * wystająca krawędzią miała środek na miejscu, więc nic jej nie ruszało —
 * a przy niezmienionej skali (podłoga w deckScale) nie ruszał jej też
 * retuneCard, bo ten wychodzi od razu, gdy skala jest ta sama.
 *
 * Rozdzielczości nie da się zmienić z kodu, więc test PODSTAWIA ekran:
 * moduł `screen` oddaje udawany monitor, a zdarzenie o zmianie idzie
 * ręcznie. Reszta — reflowDeck, deckScale, retuneCard — jest prawdziwa.
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/screen-test.js
 */

const { app, BrowserWindow, screen } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sandbox = path.join(os.tmpdir(), "cribro-screen");
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
app.setPath("userData", sandbox);

/* Cztery notatki na pulpicie. Dwie ostatnie stoją PRZY PRAWEJ I DOLNEJ
   KRAWĘDZI — to one wypadają z ekranu po jego zmniejszeniu, więc to
   o nie w tym teście chodzi. */
const notes = ["n1", "n2", "n3", "n4"].map((id, i) => ({
  id,
  at: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  text: `Notatka ${i + 1}\nTreść, żeby kartka miała co pokazać.`,
  widget: true,
  pinned: false,
}));
fs.writeFileSync(path.join(sandbox, "notes.json"), JSON.stringify(notes));
fs.writeFileSync(
  path.join(sandbox, "settings.json"),
  JSON.stringify({
    tutorial: { seen: true },
    widget: {
      enabled: true,
      cards: {
        n1: { x: 60, y: 80, width: 300, height: 328 },
        n2: { x: 400, y: 80, width: 300, height: 328 },
        n3: { x: 1140, y: 120, width: 300, height: 328 }, // prawa krawędź 1440
        n4: { x: 700, y: 570, width: 300, height: 328 }, // dolna krawędź 898
      },
    },
  }),
);

const display = (width, height) => ({
  id: 1,
  label: "test",
  bounds: { x: 0, y: 0, width, height },
  workArea: { x: 0, y: 25, width, height: height - 25 },
  size: { width, height },
  workAreaSize: { width, height: height - 25 },
  scaleFactor: 2,
  rotation: 0,
  internal: true,
  touchSupport: "unknown",
  accelerometerSupport: "unknown",
  monochrome: false,
  colorDepth: 24,
  colorSpace: "srgb",
  depthPerComponent: 8,
});

let fake = display(1470, 956);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const problems = [];
const ok = (message) => console.log("✓", message);
const bad = (message) => {
  problems.push(message);
  console.log("✗", message);
};

require(path.join(__dirname, "..", "src", "main", "main.js"));

const cards = () => BrowserWindow.getAllWindows().filter((w) => (w.webContents.getURL() || "").includes("sticky.html"));

/** Kartki, które nie mieszczą się CAŁE w obszarze roboczym. */
function sticking(workArea) {
  return cards()
    .map((win) => win.getBounds())
    .filter(
      (b) =>
        b.x < workArea.x ||
        b.y < workArea.y ||
        b.x + b.width > workArea.x + workArea.width ||
        b.y + b.height > workArea.y + workArea.height,
    );
}

/** Skala, którą kartka NAPRAWDĘ rysuje — prosto z jej arkusza. */
async function scaleOf(win) {
  return win.webContents
    .executeJavaScript(`getComputedStyle(document.getElementById('stage')).getPropertyValue('--k').trim()`)
    .catch(() => null);
}

async function change(width, height) {
  fake = display(width, height);
  screen.emit("display-metrics-changed", {}, fake, ["bounds", "workArea"]);
  // Reflow chodzi dwa razy: od razu i po SCREENS_SETTLE_MS.
  await wait(1500);
}

app.whenReady().then(async () => {
  screen.getPrimaryDisplay = () => fake;
  screen.getAllDisplays = () => [fake];
  screen.getDisplayNearestPoint = () => fake;
  screen.getDisplayMatching = () => fake;
  screen.getCursorScreenPoint = () => ({ x: 700, y: 400 });

  let win = null;
  const until = Date.now() + 20000;
  while (!win && Date.now() < until) {
    await wait(200);
    win = BrowserWindow.getAllWindows().find((w) => (w.webContents.getURL() || "").includes("index.html"));
  }
  if (!win) {
    bad("główne okno się nie otworzyło");
    return finish();
  }
  await wait(2500);
  await win.webContents.executeJavaScript("window.cribro.deck.show(true)").catch(() => {});
  await wait(2500);

  if (cards().length !== notes.length) {
    bad(`na pulpicie jest ${cards().length} kartek zamiast ${notes.length}`);
    return finish();
  }
  ok(`Talia wyszła na pulpit — ${cards().length} kartki`);

  const before = new Map(cards().map((w) => [w.noteId, w.getBounds()]));

  /* ══ EKRAN MNIEJSZY ══
     Tu usterka była widoczna: kartki przy krawędziach zostawały za nią. */
  await change(1280, 832);
  const out = sticking(fake.workArea);
  if (out.length === 0) ok("Po zmniejszeniu ekranu każda kartka mieści się cała na pulpicie");
  else bad(`po zmniejszeniu ekranu ${out.length} kartek wystaje poza pulpit: ${JSON.stringify(out)}`);

  /* Kartka, która mieściła się JUŻ W MNIEJSZYM obszarze, ma zostać tam,
     gdzie leżała — przekładanie jej „na to samo miejsce" byłoby drgnięciem
     bez powodu. Sprawdzamy więc tę, której zmiana nie miała prawa dotknąć,
     a nie po prostu pierwszą z brzegu: pierwsza z brzegu bywa właśnie tą,
     która wystawała i musiała wrócić. */
  const settled = new Map(cards().map((w) => [w.noteId, w.getBounds()]));
  const fits = (b, area) =>
    b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;
  const untouched = [...before].filter(([, b]) => fits(b, fake.workArea));
  if (!untouched.length) {
    bad("zasiew jest do poprawy: żadna kartka nie mieściła się w obu rozdzielczościach");
  } else {
    const moved = untouched.filter(([id, b]) => settled.get(id).x !== b.x || settled.get(id).y !== b.y);
    if (!moved.length) ok(`Kartki, które i tak się mieściły (${untouched.length}), nie drgnęły`);
    else bad(`kartka mieszcząca się w obu rozdzielczościach została przesunięta: ${moved[0][0]}`);
  }

  /* ══ EKRAN WIĘKSZY ══
     Tu kartka ma UROSNĄĆ — i to samo powiększenie ma dojść do arkusza,
     bo okno bez pasującego `--k` rysuje kartkę w złych proporcjach. */
  await change(1710, 1112);
  const sample = cards()[0];
  const was = settled.get(sample.noteId);
  const grown = sample.getBounds();
  if (grown.width > was.width) ok(`Po powiększeniu ekranu kartka urosła (${was.width} → ${grown.width})`);
  else bad(`kartka nie urosła po powiększeniu ekranu (${was.width} → ${grown.width})`);

  const drawn = await scaleOf(sample);
  const expected = (grown.width - 32) / 268; // aureola z obu stron, patrz STICKY_HALO
  if (drawn && Math.abs(Number(drawn) - expected) < 0.02) {
    ok(`Arkusz kartki rysuje tę samą skalę, którą dostało okno (--k=${drawn})`);
  } else {
    bad(`kartka rysuje --k=${drawn}, a jej okno ma rozmiar na ${expected.toFixed(2)}`);
  }

  if (sticking(fake.workArea).length === 0) ok("Po powiększeniu ekranu kartki nadal mieszczą się całe");
  else bad("po powiększeniu ekranu kartka wyszła poza pulpit");

  finish();
});

/* Wyjście przez app.quit(), a NIE app.exit(): tylko quit puszcza „will-quit",
   a na nim main.js zatrzymuje silnik skrótu (uiohook). Ubity bez tego wątek
   natywny dostawał zdarzenie w trakcie sprzątania i cały proces kończył się
   SIGABRT-em — czyli test przechodził, a mimo to wyglądał na przegrany. */
function finish() {
  console.log(
    problems.length
      ? `\nEkran: ${problems.length} ${problems.length === 1 ? "usterka" : "usterek"}.`
      : "\nEkran: kartki nadążają za zmianą rozdzielczości.",
  );
  const code = problems.length ? 1 : 0;
  /* Kod wyjścia trzeba dopisać na samym końcu: app.quit() kończy pętlę,
     ale kodu ustawionego wcześniej nie przenosi — a to on decyduje, czy
     `npm test` pojedzie dalej, czy stanie. */
  app.once("quit", () => process.exit(code));
  app.quit();
}
