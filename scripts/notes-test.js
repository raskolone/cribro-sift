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
 * Tytuł notatki nie jest osobnym polem — jest jej pierwszą linią. Zmiana
 * tytułu przepisuje więc tekst notatki i musi zostawić jego formę w spokoju.
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
const { retitle, groupNotes } = sandbox.window.NotesCore;

cases.push(
  [
    "Nowy tytuł wchodzi w pierwszą linię",
    retitle("Spotkanie z Anią\n\nRaport na czwartek.", "Spotkanie z Anią i Piotrem"),
    "Spotkanie z Anią i Piotrem\n\nRaport na czwartek.",
  ],
  [
    "Nagłówek zostaje nagłówkiem",
    retitle("## Spotkanie\n\nRaport.", "Spotkanie z klientem"),
    "## Spotkanie z klientem\n\nRaport.",
  ],
  [
    "Punkt listy zostaje punktem listy",
    retitle("- zadzwonić do Ani\n- wysłać raport", "zadzwonić do Ani przed 12"),
    "- zadzwonić do Ani przed 12\n- wysłać raport",
  ],
  [
    "Puste linie na początku zostają na miejscu",
    retitle("\n\nRaport.", "Czwartek"),
    "\n\nCzwartek",
  ],
  ["Pusta notatka bierze tytuł jako treść", retitle("", "Czwartek"), "Czwartek"],
  ["Pusty tytuł nie rusza notatki", retitle("Raport.", "   "), "Raport."],
  [
    "Tytuł jest jedną linią, także wklejony",
    retitle("Raport.", " Spotkanie\nz Anią "),
    "Spotkanie z Anią",
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
  "W trybie pulpitu wykłada ją KARTKĄ, a nie szybą nad znaczkiem",
  /if \(mode === "desk"\) \{[\s\S]{0,320}api\.deck\.reveal\(note\.id\)/.test(widget),
);
check(
  "…i taca schodzi, bo patrzy się teraz na kartkę",
  /api\.deck\.reveal\(note\.id\);[\s\S]{0,120}return toBadge\(\);/.test(widget),
);
check(
  "W trybie zwartym, gdzie kartek nie ma, zostaje po staremu",
  /return toSticky\(note\);\n  \}/.test(widget),
);

const sticky = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "js", "sticky.js"), "utf8");
check("Nowa kartka dostaje kursor od pierwszej chwili", /onWrite\?\.\(\(\) => editor\.focusEnd\(\)\)/.test(sticky));

const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
check("…ale zwykłe wyłożenie talii uwagi nie zabiera", /if \(wanted\) win\.show\(\);\s*\n\s*else win\.showInactive\(\);/.test(main));

console.log("\nNotatki: dopisywanie, tytuł i przegródki działają poprawnie.");
