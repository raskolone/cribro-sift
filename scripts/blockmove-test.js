"use strict";
/**
 * Przenoszenie linii — rozstrzygnięcia, zanim cokolwiek ruszy w drzewie.
 *   node scripts/blockmove-test.js
 *
 * Przeciąganie punktu listy da się zepsuć na trzy sposoby i żaden z nich
 * nie wygląda na błąd w chwili, w której się dzieje:
 *
 *   — punkt upuszczony między akapity zostaje punktem bez listy i przy
 *     zapisie do Markdownu znika mu punktor;
 *   — kursor tuż nad linią trafia za nią, bo odległość liczono do środków
 *     linii zamiast do krawędzi między nimi;
 *   — odłożenie linii tam, skąd się ją wzięło, liczy się jako zmiana
 *     i podbija czas modyfikacji notatki, a przez to całą synchronizację.
 *
 * Wszystkie trzy są tutaj rozstrzygane bez przeglądarki, więc i sprawdzane
 * bez niej. Zachowanie w prawdziwym drzewie sprawdza scripts/drag-test.js.
 */
const assert = require("assert");

const { landing, nearest, pointless } = require("../src/shared/blockmove");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Czym staje się przeniesiona linia ──────────────────────── */

check(
  "Akapit upuszczony w listę staje się punktem",
  landing({ tag: "P", done: null }, { list: true, task: false }).tag === "LI",
);

check(
  "Akapit upuszczony w listę zadań dostaje stan nieodhaczony",
  landing({ tag: "P", done: null }, { list: true, task: true }).done === "false",
);

check(
  "Zrobione zadanie przeniesione do innej listy zadań zostaje zrobione",
  landing({ tag: "LI", done: "true" }, { list: true, task: true }).done === "true",
);

check(
  "Zadanie przeniesione do zwykłej listy gubi stan — nie ma tam czego odhaczać",
  landing({ tag: "LI", done: "true" }, { list: true, task: false }).done === null,
);

check(
  "Punkt wyprowadzony z listy staje się akapitem — punktu bez listy Markdown nie zna",
  landing({ tag: "LI", done: "true" }, { list: false, task: false }).tag === "P",
);

check(
  "Nagłówek przeniesiony niżej zostaje nagłówkiem",
  landing({ tag: "H2", done: null }, { list: false, task: false }).tag === "H2",
);

check(
  "Kreska rozdzielająca też przeżywa przeprowadzkę",
  landing({ tag: "HR", done: null }, { list: false, task: false }).tag === "HR",
);

/* ── Do której szczeliny ────────────────────────────────────── */

const edges = [100, 140, 180, 220];

check("Kursor tuż nad krawędzią trafia w tę krawędź", nearest(edges, 138) === 1);
check("Kursor powyżej wszystkiego trafia w pierwszą szczelinę", nearest(edges, 10) === 0);
check("Kursor poniżej wszystkiego trafia w ostatnią", nearest(edges, 900) === 3);
check("Brak szczelin to brak trafienia", nearest([], 100) === -1);
check(
  "Przy remisie wygrywa szczelina wcześniejsza — ta, nad którą kursor już stoi",
  nearest([100, 200], 150) === 0,
);

/* ── Co nie jest zmianą ─────────────────────────────────────── */

check("Szczelina tuż nad złapaną linią to jej własne miejsce", pointless(3, 1, 3));
check("Szczelina tuż pod złapaną linią to też jej własne miejsce", pointless(3, 1, 4));
check("Szczelina wyżej jest już zmianą", !pointless(3, 1, 2));
check("Szczelina niżej jest już zmianą", !pointless(3, 1, 5));
check(
  "Przy części zwiniętej własnym miejscem jest cały jej zakres",
  pointless(2, 3, 4) && pointless(2, 3, 5) && !pointless(2, 3, 6),
);

console.log(`\n${passed} sprawdzeń przeszło.`);
