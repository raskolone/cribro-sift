"use strict";

/**
 * Zrzuty do README — te, które ktoś obcy zobaczy pierwsze.
 *
 *   npm run screens            wszystko
 *   npm run screens start      jeden zrzut po nazwie
 *
 * DLACZEGO ELECTRON, A NIE PUPPETEER. Puppeteerowe `page.screenshot()` na
 * tej maszynie nie wraca nigdy — strona wczytuje się poprawnie, `evaluate`
 * działa, a samo wywołanie zrzutu wisi do końca świata. Ukryte okno
 * Electrona i `capturePage()` działają od pierwszego razu, a przy okazji
 * rysują tym samym silnikiem, na którym chodzi aplikacja. Puppeteer zostaje
 * do pomiarów i wyłapywania błędów (`scripts/shoot*.js`).
 *
 * DLACZEGO TO NIE POKAZUJE NICZYJEGO ŻYCIA. Okno startuje BEZ mostu do
 * procesu głównego, więc `js/mock-bridge.js` podstawia atrapę z własnymi
 * danymi. Na zrzutach nie ma ani jednego prawdziwego zdania — a interfejs
 * jest ten sam, bo plik jest ten sam.
 *
 * Uruchamiać przez `env -u ELECTRON_RUN_AS_NODE`: z tą zmienną w powłoce
 * Electron startuje jako goły Node i gaśnie po cichu z kodem 0.
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const renderer = path.join(root, "src", "renderer");
const out = path.join(root, "docs", "screens");

/* WŁASNY KATALOG DANYCH, kasowany przy każdym uruchomieniu. Electron
   ZAPAMIĘTUJE POWIĘKSZENIE strony per adres — i zapisuje je na dysk, więc
   `zoomFactor: 2` ustawione tu przeżywa koniec procesu i wita następne okno,
   które o żadnym powiększeniu nie wie. Bez tej izolacji zrzuty zostawiałyby
   po sobie ślad w ustawieniach, a przy zbiegu nazw — w ustawieniach samej
   aplikacji. */
const sandbox = path.join(os.tmpdir(), "cribro-screens");
fs.rmSync(sandbox, { recursive: true, force: true });
app.setPath("userData", sandbox);

/* Kroje jadą z sieci (fonts.googleapis.com), a widoki wchodzą animacją.
   Zrzut zrobiony za wcześnie łapie zastępczy krój i pół ruchu. */
const SETTLE = 1600;
const AFTER_CLICK = 900;

/* UKRYTE OKNO RYSUJE W ×1, nawet na ekranie Retina — a zrzut w ×1 na
   siatkówce wygląda jak rozmyty. Okno jest więc DWA RAZY WIĘKSZE, a strona
   dostaje `zoomFactor: 2`: układ liczy się w tych samych 1120 punktach,
   tylko każdy piksel jest rysowany czterokrotnie. Gotowy zrzut zjeżdża
   potem do ×1.5 — ×2 to półtora megabajta na obrazek, za dużo jak na
   repozytorium, a różnicy przy szerokości, jaką nadaje README, nie widać. */
const DENSITY = 2;
const SCALE = 1.5;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Jedno okno na jeden plik HTML. Nie pokazujemy go — zrzut i tak wychodzi. */
async function open({ file, width, height, search = "" }) {
  const win = new BrowserWindow({
    width: width * DENSITY,
    height: height * DENSITY,
    show: false,
    frame: false,
    backgroundColor: "#0a0f14",
    webPreferences: { backgroundThrottling: false, zoomFactor: DENSITY },
  });

  await win.loadFile(path.join(renderer, file), search ? { search } : undefined);
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  await wait(SETTLE);
  return win;
}

async function grab(win, name) {
  const image = await win.webContents.capturePage();
  const { width } = image.getSize();
  const small = image.resize({ width: Math.round((width / DENSITY) * SCALE), quality: "best" });
  const file = path.join(out, `${name}.png`);
  fs.writeFileSync(file, small.toPNG());
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  → docs/screens/${name}.png  ${small.getSize().width}px, ${kb} kB`);
}

/* ── Co dokładnie stoi na zrzucie ───────────────────────────────── */

/**
 * Pasek „Cribro potrzebuje zgody »Dostępność«" stoi na każdej zakładce, bo
 * makieta startuje bez zgód. Na zrzucie do README zabierałby pół ekranu
 * i pokazywał obcym ludziom stan awaryjny zamiast aplikacji. Atrapa
 * przyznaje zgodę od ręki — jedno kliknięcie i pasek znika.
 */
const grantAccess = `
  (() => {
    const btn = document.querySelector('#banner [data-act="perm-accessibility"]');
    if (btn) btn.click();
    return Boolean(btn);
  })()
`;

/**
 * Spotkanie wybrane z listy i otwarte na TRANSKRYPCJI — inaczej prawa
 * kolumna jest pustym prostokątem z zaproszeniem do napisania podsumowania,
 * a to akurat najmniej mówi o tym, co ta zakładka robi. Na transkrypcji
 * widać dwa tory i to, kto co powiedział.
 */
const pickFirstMeeting = `
  (async () => {
    const row = document.querySelector("#view-meetings .meet__row[data-meet-id]");
    if (!row) return false;
    row.click();
    await new Promise((done) => setTimeout(done, 400));
    document.querySelector('#view-meetings [data-meet-tab="transcript"]')?.click();
    return true;
  })()
`;

/**
 * Zakładki głównego okna. Jedno okno, siedem widoków, jedno wczytanie.
 * `height` przycina okno tam, gdzie widok jest krótki — pół zrzutu pustego
 * tła nie mówi o aplikacji nic.
 *
 * „start" jest pierwsza i celowo: to dawne „Start" i dawne „Przesiane"
 * w jednym — statystyki, cztery kroki i cała historia pod kreską, z różnicą
 * surowe→przesiane widoczną od razu przy pierwszym wpisie, bez klikania.
 */
const VIEWS = [
  { name: "start", view: "start" },
  { name: "notes", view: "notes" },
  { name: "meetings", view: "meetings", prepare: pickFirstMeeting },
  { name: "sieve", view: "sieve" },
  { name: "grains", view: "grains", height: 560 },
  { name: "commands", view: "commands" },
  { name: "settings", view: "settings" },
];

/**
 * HUD w spoczynku to przezroczyste okno i nic więcej — chowa się, kiedy nikt
 * nie mówi. Na zrzucie ma być w trakcie: `setState` i `level` to zwykłe
 * globalne z js/hud.js (klasyczny skrypt, nie moduł), więc da się je ruszyć
 * z zewnątrz bez podstawiania czegokolwiek. Pigułka zwija się do samego
 * znaczka po trzech sekundach, więc zrzut musi być szybszy.
 */
const hudListening = `
  (() => {
    startedAt = Date.now() - 7000;
    setState("listening");
    level = 0.62;
    return true;
  })()
`;

/**
 * Osobne okna: każde ma swój plik i swój rozmiar z main.js.
 *
 * ŻADNE Z NICH NIE JEST TU PRZEZROCZYSTE, choć w aplikacji są. Zrzut
 * z kanałem alfa wygląda dobrze tylko na ciemnej stronie, a README ogląda
 * się w obu motywach GitHuba — na białym tle półprzezroczysta ciemna karta
 * robi się szarą plamą. Ciemne tło pod spodem jest tym samym kolorem, co
 * okno aplikacji, więc widać dokładnie to, co widać na ekranie.
 */
/**
 * Panel admina — jedyna zakładka, której zwykły użytkownik nie widzi.
 *
 * Dlatego osobne okno i osobne wczytanie z „?owner": makieta domyślnie
 * pokazuje aplikację taką, jaką widzi subskrybent (patrz js/mock-bridge.js),
 * a puszczenie całej reszty zrzutów w trybie właściciela dołożyłoby do nich
 * krok „Silniki", którego nikt poza mną nie ma na ekranie.
 */
const OWNER_VIEWS = [{ name: "admin", view: "admin", height: 720 }];

const WINDOWS = [
  { name: "hud", file: "hud.html", width: 380, height: 132, prepare: hudListening, after: 700 },
  { name: "quick", file: "quick.html", width: 460, height: 300 },
  { name: "briefing", file: "briefing.html", width: 860, height: 700 },
  /* Notatnik i kartka: dwa okna, w których stoi ten sam pasek czynności co
     w zakładce Notatki. Na zrzutach widać, czy naprawdę jest ten sam —
     i czy mieści się w kartce, która bywa wąska. */
  { name: "notepad", file: "notes.html", width: 900, height: 620 },
  { name: "sticky", file: "sticky.html", width: 380, height: 320 },
];

async function main() {
  fs.mkdirSync(out, { recursive: true });

  const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const wanted = (name) => only.length === 0 || only.includes(name);

  if (VIEWS.some((v) => wanted(v.name))) {
    console.log("Główne okno:");
    const win = await open({ file: "index.html", width: 1120, height: 760 });
    await win.webContents.executeJavaScript(grantAccess);
    await wait(AFTER_CLICK);

    for (const spec of VIEWS) {
      const { name, view, prepare } = spec;
      if (!wanted(name)) continue;
      win.setContentSize(1120 * DENSITY, (spec.height ?? 760) * DENSITY);
      await win.webContents.executeJavaScript(
        `document.querySelector('.nav__item[data-view="${view}"]').click(); true`,
      );
      await wait(AFTER_CLICK);
      if (prepare) {
        await win.webContents.executeJavaScript(prepare);
        await wait(AFTER_CLICK);
      }
      await grab(win, name);
    }
    win.destroy();
  }

  /* Zakładki właściciela — drugie okno, bo różni je nie widok, tylko to,
     kim jest patrzący. */
  if (OWNER_VIEWS.some((v) => wanted(v.name))) {
    console.log("Okno właściciela:");
    const win = await open({ file: "index.html", width: 1120, height: 760, search: "owner" });
    await win.webContents.executeJavaScript(grantAccess);
    await wait(AFTER_CLICK);

    for (const spec of OWNER_VIEWS) {
      if (!wanted(spec.name)) continue;
      win.setContentSize(1120 * DENSITY, (spec.height ?? 760) * DENSITY);
      await win.webContents.executeJavaScript(
        `document.querySelector('.nav__item[data-view="${spec.view}"]').click(); true`,
      );
      await wait(AFTER_CLICK);
      await grab(win, spec.name);
    }
    win.destroy();
  }

  for (const spec of WINDOWS) {
    if (!wanted(spec.name)) continue;
    console.log(`${spec.file}:`);
    const win = await open(spec);
    if (spec.prepare) {
      await win.webContents.executeJavaScript(spec.prepare);
      await wait(spec.after ?? AFTER_CLICK);
    }
    await grab(win, spec.name);
    win.destroy();
  }
}

/* KAŻDE OKNO JEST TU ZAMYKANE, A ZRZUTÓW JEST WIĘCEJ NIŻ JEDEN. Bez tego
   nasłuchu Electron kończy aplikację, gdy zniknie ostatnie okno — kolejne
   okno powstaje już w trakcie zamykania i dostaje ERR_FAILED na wczytaniu
   pliku albo proces gaśnie bez słowa w połowie listy. */
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    await main();
  } catch (problem) {
    console.error("Zrzuty nie wyszły:", problem);
    app.exit(1);
    return;
  }
  app.exit(0);
});
