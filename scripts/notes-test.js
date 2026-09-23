"use strict";
/**
 * Formatowanie tekstu dopisywanego do notatki oraz to, co robi z notatką
 * lista: tytuł i przegródki.
 *   node scripts/notes-test.js
 *
 * Dyktowanie do notatki dokłada tekst w kółko, więc to jedyne miejsce, gdzie
 * kształt notatki powstaje bez udziału człowieka. Jeśli coś ma się rozjechać,
 * rozjedzie się właśnie tutaj.
 *
 * Nazwa notatki JEST osobnym polem (`note.title`). Nazwanie notatki nie ma
 * prawa dopisać ani przepisać jednej litery jej treści — a notatka bez nazwy
 * ma się dalej podpisywać pierwszą linią.
 */
const assert = require("assert");
const Module = require("module");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// store.js sięga po ścieżki Electrona już przy ładowaniu — podstawiamy tyle,
// ile trzeba, żeby dało się go wczytać zwykłym Nodem.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { getPath: () => require("os").tmpdir() } };
  return load.call(this, request, ...rest);
};

const { joinNote } = require("../src/main/store");

const cases = [
  [
    "Pusta notatka bierze tekst bez zmian",
    joinNote("", "Raport na czwartek."),
    "Raport na czwartek.",
  ],
  [
    "Kolejny fragment to nowy akapit",
    joinNote("Raport na czwartek.", "Klient dzwoni w piątek."),
    "Raport na czwartek.\n\nKlient dzwoni w piątek.",
  ],
  [
    "Ogon pustych linii nie mnoży się przy dopisywaniu",
    joinNote("Raport na czwartek.\n\n\n", "Klient dzwoni w piątek."),
    "Raport na czwartek.\n\nKlient dzwoni w piątek.",
  ],
  [
    "Lista zostaje listą",
    joinNote("Do zrobienia:\n- zadzwonić do Ani", "wysłać raport"),
    "Do zrobienia:\n- zadzwonić do Ani\n- wysłać raport",
  ],
  [
    "Nowe zadanie startuje puste, a zaznaczone zostaje zaznaczone",
    joinNote("- [x] zadzwonić do Ani", "wysłać raport"),
    "- [x] zadzwonić do Ani\n- [ ] wysłać raport",
  ],
  [
    "Wcięcie punktu jest zachowane",
    joinNote("- plan\n  - pierwszy krok", "drugi krok"),
    "- plan\n  - pierwszy krok\n  - drugi krok",
  ],
  [
    "Cytat ciągnie się jak lista",
    joinNote("> Ania:", "zróbmy to w czwartek"),
    "> Ania:\n> zróbmy to w czwartek",
  ],
  ["Puste dopisanie nie rusza notatki", joinNote("Raport.", "   "), "Raport."],
];

/* ── Tytuł i przegródki listy ──────────────────────────────────
   notes-core.js jest plikiem renderera, ale liczy na dokładnie trzy rzeczy
   z przeglądarki: `t`, `localStorage` i `window`. Podstawiamy je i sprawdzamy
   go zwykłym Nodem, zamiast klikać po liście ręcznie. */

const sandbox = {
  window: {},
  localStorage: { getItem: () => null, setItem: () => {} },
  t: (text) => text,
};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../src/renderer/js/notes-core.js"), "utf8"),
  sandbox,
);
const { titleOf, rawTitle, ownTitle, saveTitle, previewOf, groupNotes } =
  sandbox.window.NotesCore;

const NAMED = { id: "n1", title: "Plan dnia", text: "Zadzwonić do Ani\n\nWysłać raport." };
const PLAIN = { id: "n2", text: "## Spotkanie\n\nRaport na czwartek." };

cases.push(
  ["Nazwa własna wygrywa z pierwszą linią", titleOf(NAMED), "Plan dnia"],
  ["Notatka bez nazwy podpisuje się pierwszą linią", titleOf(PLAIN), "Spotkanie"],
  ["Notatka pusta i nienazwana nie ma się jak nazwać", titleOf({ text: "" }), "Bez tytułu"],
  ["Do przepisania idzie ta nazwa, którą widać", rawTitle(PLAIN), "Spotkanie"],
  ["Białe znaki w nazwie nie robią z niej nazwy", ownTitle({ title: "   " }), ""],
  [
    "Zajawka nazwanej notatki zaczyna się od jej pierwszego zdania",
    previewOf(NAMED),
    "Zadzwonić do Ani Wysłać raport.",
  ],
  [
    "Zajawka nienazwanej pomija pierwszą linię, bo to ona jest tytułem",
    previewOf(PLAIN),
    "Raport na czwartek.",
  ],
);

for (const [name, actual, expected] of cases) {
  assert.strictEqual(actual, expected, `${name}\n  jest:      ${JSON.stringify(actual)}\n  powinno:   ${JSON.stringify(expected)}`);
  console.log("✓", name);
}

/* Kolejność przegródek: przypięte, szybkie, reszta. Przypięta szybka
   notatka idzie na górę, a nie zostaje wśród szybkich. */
const notes = [
  { id: "a", updatedAt: "2026-08-20T10:00:00Z", text: "Zwykła starsza" },
  { id: "b", updatedAt: "2026-08-21T10:00:00Z", text: "Zwykła nowsza" },
  { id: "c", updatedAt: "2026-08-19T10:00:00Z", kind: "quick", text: "Szybka" },
  { id: "d", updatedAt: "2026-08-18T10:00:00Z", kind: "quick", pinned: true, text: "Szybka przypięta" },
];
const { groups, divided } = groupNotes(notes);

// Porównujemy zapisem, nie kształtem: tablice z osobnego kontekstu mają
// własne prototypy i deepStrictEqual widziałby różnicę tam, gdzie jej nie ma.
assert.strictEqual(
  JSON.stringify(groups.map((group) => [group.key, ...group.items.map((note) => note.id)])),
  JSON.stringify([
    ["pinned", "d"],
    ["quick", "c"],
    ["note", "b", "a"],
  ]),
  "Przegródki mają iść: przypięte, szybkie, reszta",
);
assert.strictEqual(divided, true, "Trzy przegródki znaczą nagłówki nad nimi");
console.log("✓", "Przegródki listy idą: przypięte, szybkie notatki, reszta");

const one = groupNotes([{ id: "a", updatedAt: "2026-08-20T10:00:00Z", text: "Sama jedna" }]);
assert.strictEqual(one.divided, false, "Jedna przegródka nie potrzebuje nagłówka");
console.log("✓", "Jedna przegródka obywa się bez nagłówka");

/* ── Plusik zakłada notatkę TAM, GDZIE ONE MIESZKAJĄ ────────────────
   Dwie awarie pod rząd na tym jednym przycisku, obie tego samego rodzaju:
   plusik otwierał okno zarządzania notatkami w miejscu, w którym miała
   powstać notatka. W trybie „pulpit" notatka to kartka na pulpicie —
   i to ona ma się pojawić, gotowa do pisania. */
const widget = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "js", "widget.js"), "utf8");
const check = (label, condition) => {
  assert.ok(condition, label);
  console.log("✓", label);
};

check(
  "Plusik zakłada zwykłą notatkę leżącą od razu na pulpicie",
  /api\.notes\.create\(\{ widget: true \}\)/.test(widget),
);
check(
  "…i wykłada ją KARTKĄ, gotową do pisania",
  /await api\.notes\.create\(\{ widget: true \}\);[\s\S]{0,120}api\.deck\.reveal\(note\.id\)/.test(widget),
);
check(
  "…a menu po łuku schodzi, bo patrzy się teraz na kartkę",
  /api\.deck\.reveal\(note\.id\);[\s\S]{0,120}toBadge\(\);/.test(widget),
);

const sticky = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "js", "sticky.js"), "utf8");
check("Nowa kartka dostaje kursor od pierwszej chwili", /onWrite\?\.\(\(\) => editor\.focusEnd\(\)\)/.test(sticky));
/* Nagłówek kartki nazywa notatkę i na tym kończy swoją władzę: żadnej
   drogi z belki do treści już stąd nie ma. */
check(
  "Przepisany nagłówek kartki idzie w nazwę, nie w tekst notatki",
  /onCommit: async \(title\) => \{\s*await saveTitle\(api, target, title\);/.test(sticky) &&
    !/setMarkdown\([^)]*\)/.test(sticky.slice(sticky.indexOf("function startRename"), sticky.indexOf("function showTitle"))),
);

const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
check("…ale zwykłe wyłożenie talii uwagi nie zabiera", /if \(wanted\) win\.show\(\);\s*\n\s*else win\.showInactive\(\);/.test(main));

/* ── Menu po łuku ───────────────────────────────────────────────────
   Sześć kółek na ćwierćobrocie wokół znaczka: cztery przejścia (Poranek,
   nowa karteczka, Notatnik, okno aplikacji) i dwa nieaktywne miejsca na
   przyszłość. Main.js liczy przesunięcia trygonometrią (arcSlots) i wysyła
   je gotowe do renderera — CSS sam takiego rachunku nie zrobi. */
const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "widget.html"), "utf8");

check("Menu ma sześć gniazd", (html.match(/<button class="slot(?:"| )/g) ?? []).length === 6);
check(
  "…dwa z nich nieaktywne, na przyszłość",
  (html.match(/<button class="slot slot--soon" disabled/g) ?? []).length === 2,
);
check("…a jedno otwiera Notatnik", /data-do="notebook"/.test(html));
check(
  "Okno aplikacji to jedyne gniazdo, które otwiera duże okno — i wyróżnia się kolorem",
  /class="slot slot--primary" data-do="app"/.test(html),
);
check(
  "Łuk liczy się trygonometrią w main.js, nie w CSS-ie",
  /function arcSlots\(tray\)/.test(main) && /Math\.cos\(rad\)/.test(main) && /Math\.sin\(rad\)/.test(main),
);
check(
  "Renderer podstawia gotowe dx/dy na kółka, bez własnego rachunku",
  /function applyArc\(arc\)/.test(widget) && /setProperty\("--dx"/.test(widget),
);
check(
  "Okno zostawia miejsce na łuk w stronę side/dir i samą aureolę po przeciwnej",
  /const trayBack =/.test(main) && /const back = Math\.max\(half, trayBack\);/.test(main),
);
check(
  "Notatnik otwiera się osobnym oknem, nie oknem aplikacji",
  /if \(action === "notebook"\) \{\s*\n\s*createNotesWindow\(\);/.test(main),
);

/* ── Nazwanie notatki nie rusza jej treści ─────────────────────────
   To jest cała różnica między nagłówkiem kartki na pulpicie dawniej
   i dziś: dawniej wpisane w nagłówek słowo lądowało w pierwszej linii
   notatki, więc kartka nazwana „Recall" miała „Recall" także w środku. */

(async function titleField() {
  const sent = [];
  const api = { notes: { update: async (id, patch) => (sent.push({ id, patch }), patch) } };

  const note = { id: "n3", text: "Zadzwonić do Ani\n\nWysłać raport.", title: null };
  const before = note.text;

  await saveTitle(api, note, " Plan   dnia ");
  check("Nazwa idzie w pole title, jedną linią i bez zdwojonych spacji", note.title === "Plan dnia");
  check("…a treść notatki zostaje co do litery", note.text === before);
  check(
    "…i tylko nazwa jedzie do zapisu",
    JSON.stringify(sent.at(-1)) === JSON.stringify({ id: "n3", patch: { title: "Plan dnia" } }),
  );
  check("Nazwana notatka podpisuje się swoją nazwą", titleOf(note) === "Plan dnia");

  await saveTitle(api, note, "   ");
  check("Pusta nazwa zdejmuje własny tytuł", note.title === null);
  check("…i notatka wraca do pierwszej linii", titleOf(note) === "Zadzwonić do Ani");
  check("…dalej nie tknąwszy treści", note.text === before);
})()
  .then(() => console.log("\nNotatki: dopisywanie, tytuł i przegródki działają poprawnie."))
  .catch((problem) => {
    console.error(problem);
    process.exit(1);
  });
