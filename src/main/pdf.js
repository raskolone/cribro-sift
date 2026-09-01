"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { BrowserWindow } = require("electron");
const { markdownToHtml, escapeHtml } = require("../shared/richtext");

/**
 * Notatka jako PDF.
 *
 * Jedno założenie rządzi całym plikiem: **PDF jest do wydrukowania albo do
 * wysłania komuś**, a nie zrzutem ekranu aplikacji. Cribro jest ciemne, bo
 * stoi obok pracy, w której się siedzi; kartka wyjęta z niego jest jasna,
 * bo trafia do skrzynki, na papier albo do cudzego czytnika. Ciemny PDF
 * wydrukowany wychodzi czarnym prostokątem i zużywa pół kartridża.
 *
 * Wygląd tekstu bierzemy jednak z tego samego pliku, co ekran
 * (renderer/css/prose.css) — nagłówek, lista zadań i cytat mają wyglądać
 * tak samo w obu miejscach. Zmienia się WYŁĄCZNIE paleta, i to przez
 * podmianę tokenów, nie przez drugą kopię reguł. Jedna zmiana wyglądu
 * notatki wchodzi wtedy do PDF-u sama.
 *
 * Renderowaniem zajmuje się osobne, niewidoczne okno. Nie da się inaczej:
 * `printToPDF` należy do `webContents`, a okno aplikacji ma na ekranie
 * swoją treść i nie ma jak podstawić mu innej na czas eksportu.
 */

const RENDERER = path.join(__dirname, "..", "renderer");

/* Kartka. Wartości w milimetrach, bo tak mierzy się papier — Electron
   chce cali, więc przeliczamy w jednym miejscu na dole pliku. */
const PAGE = { marginMm: 18 };

/**
 * Paleta kartki. Te same NAZWY tokenów, co w motywie — podmieniamy
 * wyłącznie wartości, więc reguły z prose.css działają bez zmian.
 */
const PAPER = `
  :root {
    --bg: #ffffff;
    --ink: #f4f5f7;
    --text: #1c2230;
    --text-hi: #0b0f18;
    --text-2: #414b5e;
    --text-3: #414b5e;
    --text-mute: #5b6779;
    --text-faint: #97a1b1;
    --line: rgba(20, 28, 44, 0.12);
    --line-strong: rgba(20, 28, 44, 0.22);
    --line-soft: rgba(20, 28, 44, 0.07);
    --accent: #0f7a52;
    --accent-soft: #0b5f40;
    --accent-ink: #ffffff;
    --accent-04: rgba(15, 122, 82, 0.05);
    --accent-25: rgba(15, 122, 82, 0.25);
    --accent-30: rgba(15, 122, 82, 0.30);
    --accent-55: rgba(15, 122, 82, 0.55);
  }
  html, body { background: #fff; }
  body {
    margin: 0;
    color: var(--text);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet { padding: 0; }

  /* Metryczka: tytuł, kiedy, w której szufladzie i czego dotyczy.
     Nad kreską, bo to jest nagłówek dokumentu, a nie jego pierwszy akapit. */
  .head { margin-bottom: 22px; }
  .head h1 {
    font-family: var(--font-display);
    font-size: 30px;
    line-height: 1.15;
    margin: 0 0 6px;
    color: var(--text-hi);
  }
  .head .meta {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-mute);
  }
  .head .tags { margin-top: 8px; font-family: var(--font-mono); font-size: 11px; color: var(--accent-soft); }
  .head .tags span { margin-right: 8px; }
  .rule { height: 1px; background: var(--line-strong); margin-bottom: 22px; }

  /* Zwinięty nagłówek w pliku, który się wydrukuje, byłby treścią, której
     nikt nie rozwinie. W PDF-ie widać wszystko — strzałka i wielokropek
     schodzą, bo nie ma tu czego klikać. */
  .prose [data-folded="true"] { display: revert; }
  .prose [data-toggle]::before,
  .prose [data-toggle="closed"]::after { content: none; }
  .prose h1[data-toggle],
  .prose h2[data-toggle],
  .prose h3[data-toggle] { padding-left: 0; }

  /* Nagłówek ma zostać przy swoim akapitem, a punkt listy nie ma prawa
     pęknąć w pół między stronami. */
  .prose h1, .prose h2, .prose h3 { break-after: avoid-page; }
  .prose li, .prose blockquote, .prose pre { break-inside: avoid; }

  /* CAŁA SZUFLADA W JEDNYM PLIKU: każda następna notatka zaczyna nową
     stronę. Bez tego druga notatka doklejałaby się pod pierwszą w połowie
     kartki i cały plik czytałby się jak jedna, bardzo długa notatka —
     a szuflada to zbiór osobnych rzeczy, nie jeden dokument. */
  .sheet + .sheet { break-before: page; }
`;

/**
 * Arkusz z rendererów WKLEJONY w dokument, a nie podlinkowany.
 *
 * Kuszące byłoby `<link href="file://…">`, ale w zapakowanej aplikacji ta
 * ścieżka prowadzi w środek `app.asar` i zawiera spację („Cribro Sift.app").
 * Wklejenie omija oba problemy naraz i jest o jedno pytanie mniej: dokument
 * jest wtedy samowystarczalny i nie ma czego nie znaleźć.
 */
const sheet = (name) => fs.readFileSync(path.join(RENDERER, "css", name), "utf8");

/**
 * Treść notatki bez linii, która jest jej tytułem.
 *
 * Tytuł notatki nie jest osobnym polem — jest jej pierwszą linią. Na kartce
 * stoi już u góry, w metryczce, więc zostawiony też w treści wyglądałby jak
 * pomyłka: ten sam napis dwa razy, jeden pod drugim.
 *
 * Zdejmujemy go WYŁĄCZNIE wtedy, gdy jest nagłówkiem albo zwykłym zdaniem.
 * Notatka zaczynająca się od punktu listy („- [ ] zadzwonić") ma tytuł
 * wzięty z tego punktu — a punkt jest treścią i musi zostać, inaczej
 * z kartki zniknęłoby zadanie.
 */
function bodyOf(text, title) {
  const lines = String(text ?? "").split("\n");
  const index = lines.findIndex((line) => line.trim());
  if (index === -1) return "";

  const line = lines[index];
  const heading = /^\s*#{1,6}[ \t]+(.*)$/.exec(line);
  const plain = (heading ? heading[1] : line)
    .replace(/^[\u25B8\u25BE]\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();

  const listOrQuote = /^\s*(?:[-*][ \t]|\d+\.[ \t]|>)/.test(line);
  if (listOrQuote || plain.slice(0, 60) !== title) return String(text ?? "");

  lines.splice(index, 1);
  return lines.join("\n");
}

/**
 * Kartka jako kompletny dokument HTML.
 *
 * @param {object} note   notatka ze store
 * @param {string} title  tytuł (pierwsza linia — patrz notes-core.js)
 * @param {string} locale język, w którym wypisujemy datę
 */
function sheetOf(note, { title, locale = "pl-PL" } = {}) {
  const when = new Date(note.updatedAt ?? note.at ?? Date.now()).toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const tags = Array.isArray(note.tags) ? note.tags.filter(Boolean) : [];
  const folder = String(note.folder ?? "").trim();
  const meta = [when, folder].filter(Boolean).map(escapeHtml).join(" · ");

  return `    <div class="sheet">
      <header class="head">
        <h1>${escapeHtml(title)}</h1>
        <div class="meta">${meta}</div>
        ${tags.length ? `<div class="tags">${tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      </header>
      <div class="rule"></div>
      <div class="prose" data-align="${escapeHtml(note.align ?? "left")}">${markdownToHtml(bodyOf(note.text, title))}</div>
    </div>`;
}

/**
 * Kartki w kopercie: gotowy dokument z arkuszami wklejonymi w środek.
 *
 * Arkusze jadą wklejone, nie podlinkowane — patrz `sheet` wyżej. Tytuł
 * dokumentu to tytuł pierwszej kartki, bo tak nazwie plik czytnik i tak
 * pokaże go podgląd.
 */
function wrap(sheets, documentTitle) {
  return `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(documentTitle)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
    <style>${sheet("tokens.css")}</style>
    <style>${sheet("prose.css")}</style>
    <style>${PAPER}</style>
  </head>
  <body>
${sheets.join("\n")}
  </body>
</html>`;
}

function toDocument(note, { title, locale = "pl-PL" } = {}) {
  return wrap([sheetOf(note, { title, locale })], title);
}

/**
 * Cała szuflada w jednym dokumencie — kartka po kartce, każda od nowej strony.
 *
 * JEDEN PLIK, NIE KATALOG PLIKÓW. Szuflada eksportowana w całości jedzie
 * zwykle dalej: do skrzynki, na papier, do czyjegoś czytnika — a tam jeden
 * załącznik jest jedną rzeczą do otwarcia, podczas gdy katalog z dwudziestoma
 * PDF-ami jest dwudziestoma. Notatki zostają przy tym osobnymi kartkami,
 * każda z własną metryczką: szuflada to zbiór osobnych rzeczy, nie jeden
 * długi dokument.
 *
 * @param {Array<{note: object, title: string}>} items notatki w kolejności,
 *        w jakiej mają leżeć — kolejność ustala wołający, nie ten plik
 */
function toBook(items, { locale = "pl-PL", documentTitle } = {}) {
  if (!items.length) throw new Error("Nie ma czego wyeksportować — szuflada jest pusta.");
  return wrap(
    items.map(({ note, title }) => sheetOf(note, { title, locale })),
    documentTitle ?? items[0].title,
  );
}

/**
 * Notatka → plik PDF pod wskazaną ścieżką.
 *
 * Dokument jedzie przez plik w katalogu tymczasowym, a nie przez `data:`.
 * Adres `data:` ma ograniczenie długości zależne od platformy, a kartka
 * z wklejonymi arkuszami ma kilkadziesiąt kilobajtów — plik nie ma z tym
 * żadnego kłopotu i przy okazji daje się podejrzeć, gdy coś wyjdzie krzywo.
 *
 * @returns {Promise<{ filePath: string, bytes: number }>}
 */
/**
 * Gotowy dokument → plik PDF. Wspólny druk dla jednej kartki i dla szuflady.
 *
 * Dokument jedzie przez plik w katalogu tymczasowym, a nie przez `data:`.
 * Adres `data:` ma ograniczenie długości zależne od platformy, a kartka
 * z wklejonymi arkuszami ma kilkadziesiąt kilobajtów — plik nie ma z tym
 * żadnego kłopotu i przy okazji daje się podejrzeć, gdy coś wyjdzie krzywo.
 *
 * @returns {Promise<{ filePath: string, bytes: number }>}
 */
async function renderPdf(html, filePath) {
  const scratch = path.join(
    os.tmpdir(),
    `cribro-pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.html`,
  );
  fs.writeFileSync(scratch, html, "utf8");

  /* Zwykłe okno, tylko nigdy niepokazane. Renderowania „offscreen" tu nie
     ma celowo: `printToPDF` i tak rysuje własny przebieg dla papieru,
     a osobny potok offscreen bywa na macOS pusty przy pierwszym wywołaniu. */
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadFile(scratch);
    /* Kroje z sieci dociągają się po wczytaniu strony. Bez tej chwili
       pierwszy eksport po uruchomieniu wychodził krojem zastępczym —
       a różnicę widać dopiero w gotowym pliku, czyli za późno. */
    await win.webContents.executeJavaScript("document.fonts.ready").catch(() => {});

    const data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: {
        top: PAGE.marginMm / 25.4,
        bottom: PAGE.marginMm / 25.4,
        left: PAGE.marginMm / 25.4,
        right: PAGE.marginMm / 25.4,
      },
    });
    fs.writeFileSync(filePath, data);
    return { filePath, bytes: data.length };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rm(scratch, { force: true }, () => {});
  }
}

/** Jedna notatka → jeden plik PDF. */
async function noteToPdf(note, { filePath, title, locale }) {
  return renderPdf(toDocument(note, { title, locale }), filePath);
}

/**
 * Szuflada → jeden plik PDF z kartką na notatkę.
 *
 * @param {Array<{note: object, title: string}>} items notatki w kolejności
 */
async function folderToPdf(items, { filePath, locale, documentTitle }) {
  return renderPdf(toBook(items, { locale, documentTitle }), filePath);
}

module.exports = { noteToPdf, folderToPdf, toDocument, toBook, bodyOf };
