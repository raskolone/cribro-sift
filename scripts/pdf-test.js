"use strict";
/**
 * Notatka i szuflada jako kartka. Bez okna i bez drukowania.
 *   node scripts/pdf-test.js
 *
 * ══ O CO TU CHODZI ══
 *
 * PDF wychodzi z Cribro NA ZEWNĄTRZ — na papier, do skrzynki, do cudzego
 * czytnika — i to jest jedyne miejsce, w którym notatka opuszcza aplikację
 * w postaci, której nikt już nie poprawi. Błąd widać dopiero w gotowym
 * pliku, czyli wtedy, gdy jest za późno.
 *
 * Samego drukowania tu nie ma: `printToPDF` należy do okna Electrona,
 * a okno nie mówi nic o tym, CO w nim stanęło. Sprawdzamy więc dokument
 * przed drukiem — bo wszystkie rozstrzygnięcia zapadają właśnie tam.
 *
 * Dwie rzeczy, na których łatwo się przewrócić:
 *
 *   1. TYTUŁ ZDJĘTY Z TREŚCI. Tytuł notatki nie jest osobnym polem, tylko
 *      jej pierwszą linią — a na kartce stoi już u góry, w metryczce.
 *      Zostawiony też w treści wygląda jak pomyłka. Ale notatka zaczynająca
 *      się od zadania ma tytuł wzięty Z TEGO ZADANIA, więc zdjęcie go
 *      z treści kasowałoby z kartki całe zadanie.
 *
 *   2. SZUFLADA TO ZBIÓR OSOBNYCH RZECZY. Notatki sklejone w jeden ciąg
 *      czytałyby się jak jedna, bardzo długa notatka. Każda zaczyna nową
 *      stronę i ma własną metryczkę.
 */
const assert = require("assert");
const Module = require("module");

/* pdf.js sięga po okno Electrona w chwili wczytania. Do sprawdzania
   dokumentu okno nie jest potrzebne, więc podstawiamy puste — tak samo
   jak scripts/hotkey-test.js podstawia globalShortcut. */
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { BrowserWindow: class {} };
  return load.call(this, request, ...rest);
};

const { toDocument, toBook, bodyOf } = require("../src/main/pdf");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

const note = (text, extra = {}) => ({
  text,
  updatedAt: "2026-08-31T09:00:00.000Z",
  ...extra,
});

/* ── Tytuł zdjęty z treści — i kiedy nie ─────────────────────────── */

check(
  "Nagłówek powtarzający tytuł znika z treści",
  bodyOf("# Plan na jutro\n\nPrzegląd zgłoszeń.", "Plan na jutro").trim() === "Przegląd zgłoszeń.",
);
check(
  "Zwykłe zdanie powtarzające tytuł też",
  bodyOf("Plan na jutro\n\nPrzegląd zgłoszeń.", "Plan na jutro").trim() === "Przegląd zgłoszeń.",
);
check(
  "Zadanie ZOSTAJE, choć dało tytuł — inaczej z kartki zniknęłaby robota",
  bodyOf("- [ ] zadzwonić do Ani\n- [ ] wysłać raport", "zadzwonić do Ani").includes(
    "- [ ] zadzwonić do Ani",
  ),
);
check(
  "Punkt listy też zostaje",
  bodyOf("- mleko\n- chleb", "mleko").includes("- mleko"),
);
check(
  "Treść niezaczynająca się od tytułu zostaje w całości",
  bodyOf("Zupełnie co innego.", "Plan na jutro").trim() === "Zupełnie co innego.",
);

/* ── Jedna kartka ──────────────────────────────────────────────── */

const jedna = toDocument(note("Plan na jutro\n\nPrzegląd zgłoszeń.", { folder: "Praca", tags: ["pilne"] }), {
  title: "Plan na jutro",
});

check("Jedna notatka to jedna kartka", (jedna.match(/class="sheet"/g) ?? []).length === 1);
check("Tytuł stoi w metryczce", /<h1>Plan na jutro<\/h1>/.test(jedna));
check("Szuflada dojeżdża do metryczki", /Praca/.test(jedna));
check("Etykieta dojeżdża z krzyżykiem", /#pilne/.test(jedna));
check("Tytuł nie stoi drugi raz w treści", (jedna.match(/Plan na jutro/g) ?? []).length === 2);

/* Kartka jest JASNA, choć aplikacja jest ciemna — wydrukowany ciemny PDF
   wychodzi czarnym prostokątem i zużywa pół kartridża. */
check("Kartka jedzie z jasną paletą, nie z motywem aplikacji", /--bg: #ffffff/.test(jedna));
check(
  "Arkusze są WKLEJONE, nie podlinkowane — w pakiecie ścieżka prowadzi w środek asara",
  !/<link[^>]+href="file:/.test(jedna) && /<style>/.test(jedna),
);

/* Zwinięty nagłówek w pliku do wydrukowania byłby treścią, której nikt
   nie rozwinie. */
check("Zwinięte części są na kartce rozwinięte", /\[data-folded="true"\] \{ display: revert/.test(jedna));

/* ── Cała szuflada ─────────────────────────────────────────────── */

const items = [
  { note: note("Pierwsza\n\nTreść jedna.", { folder: "Praca" }), title: "Pierwsza" },
  { note: note("Druga\n\nTreść dwa.", { folder: "Praca" }), title: "Druga" },
  { note: note("Trzecia\n\nTreść trzy.", { folder: "Praca" }), title: "Trzecia" },
];
const ksiazka = toBook(items, { documentTitle: "Praca" });

check("Trzy notatki to trzy kartki", (ksiazka.match(/class="sheet"/g) ?? []).length === 3);
check(
  "Każda kartka ma własną metryczkę, a nie jedną wspólną",
  (ksiazka.match(/class="head"/g) ?? []).length === 3,
);
check(
  "Każda następna kartka zaczyna nową stronę",
  /\.sheet \+ \.sheet \{ break-before: page; \}/.test(ksiazka),
);
check("Dokument nazywa się nazwą szuflady, nie tytułem pierwszej notatki", /<title>Praca<\/title>/.test(ksiazka));
check(
  "Kolejność z wejścia jest kolejnością na kartkach",
  ksiazka.indexOf("Pierwsza") < ksiazka.indexOf("Druga") &&
    ksiazka.indexOf("Druga") < ksiazka.indexOf("Trzecia"),
);
check(
  "Arkusze są w dokumencie RAZ, nie raz na kartkę",
  (ksiazka.match(/--bg: #ffffff/g) ?? []).length === 1,
);

check(
  "Pusta szuflada odmawia zdaniem, a nie pustym plikiem",
  (() => {
    try {
      toBook([], {});
      return false;
    } catch (problem) {
      return /pusta/.test(problem.message);
    }
  })(),
);

/* Bez podanej nazwy dokument bierze tytuł pierwszej kartki — tak nazwie
   plik czytnik i tak pokaże go podgląd. */
check(
  "Bez nazwy szuflady dokument bierze tytuł pierwszej notatki",
  /<title>Pierwsza<\/title>/.test(toBook(items, {})),
);

console.log(`\nKartka: ${passed} sprawdzeń przeszło. To, co wychodzi na papier, wychodzi całe.`);
