"use strict";
/**
 * Sylwetka efektu genie — sprawdzana rachunkiem, nie okiem.
 *   node scripts/genie-test.js
 *
 * Animację łatwo popsuć tak, że dalej „jakoś działa": kartka rozlewa się
 * na pełną szerokość przy jednej piątej drogi, albo na końcu zostaje
 * z ogonkiem, albo szyjka odrywa się od znaczka. Każda z tych rzeczy jest
 * niewidoczna na nieruchomym zrzucie, a rzuca się w oczy w ruchu.
 */
const assert = require("assert");
const { points } = require("../src/renderer/js/genie");

const ok = (label) => console.log(`✓ ${label}`);

/** Szerokość strumienia na każdej poprzeczce, w ułamku kartki. */
function widths(p, opts = {}) {
  const sideways = opts.dir === "left" || opts.dir === "right";
  const axis = sideways ? 1 : 0; // którą współrzędną mierzymy w poprzek
  const all = points(p, opts);
  const half = all.length / 2;
  const near = all.slice(0, half);
  const far = all.slice(half).reverse();
  return near.map((pt, i) => (far[i][axis] - pt[axis]) / 100);
}

const opts = { anchor: 0.5, neckHalf: 0.09, dir: "up" };

/* ── 1. Koniec ruchu to czysty prostokąt ── */
const full = widths(1, opts);
assert.ok(
  full.every((w) => Math.abs(w - 1) < 0.01),
  `przy p=1 kartka ma być pełnym prostokątem, a najwęższe miejsce to ${Math.min(...full).toFixed(3)}`,
);
ok("Na końcu ruchu zostaje prostokąt, bez ogonka po szyjce");

/* ── 2. Początek ruchu to punkt przy znaczku ── */
const start = widths(0.02, opts);
assert.ok(Math.max(...start) < 0.3, "przy starcie kartka ma być wąska");
ok("Na starcie z kartki widać wąski strumień, nie lejek");

/* ── 3. Rozlewanie jest stopniowe ──
   To jest ten błąd, który miała pierwsza wersja: przy 18% drogi sylwetka
   sięgała trzech czwartych szerokości kartki. */
const early = Math.max(...widths(0.18, opts));
assert.ok(early < 0.4, `przy 18% drogi szerokość ${early.toFixed(2)} to za dużo`);
const mid = Math.max(...widths(0.55, opts));
assert.ok(mid > early && mid < 0.9, `przy 55% drogi oczekiwano rozsądnej szerokości, jest ${mid.toFixed(2)}`);
ok("Szerokość rośnie stopniowo, a nie skokiem na starcie");

/* ── 4. Ruch jest monotoniczny ──
   Sylwetka ma tylko rosnąć. Cofnięcie się w połowie widać jako drgnięcie. */
let previous = 0;
for (let p = 0; p <= 1.0001; p += 0.05) {
  const now = Math.max(...widths(p, opts));
  assert.ok(now >= previous - 1e-6, `szerokość cofnęła się przy p=${p.toFixed(2)}`);
  previous = now;
}
ok("Szerokość tylko rośnie — bez drgnięcia w połowie");

/* ── 5. Szyjka trzyma się znaczka, także gdy znaczek jest z boku ── */
for (const anchor of [0.1, 0.5, 0.9]) {
  const all = points(0.5, { ...opts, anchor });
  const half = all.length / 2;
  // Pierwszy punkt lewej i ostatni prawej to poprzeczka tuż przy znaczku.
  const neckCentre = (all[0][0] + all[all.length - 1][0]) / 2 / 100;
  assert.ok(
    Math.abs(neckCentre - anchor) < 0.02,
    `szyjka odjechała od znaczka: ${neckCentre.toFixed(3)} zamiast ${anchor}`,
  );
  // ...a drugi koniec wraca na środek kartki.
  const farCentre = (all[half - 1][0] + all[half][0]) / 2 / 100;
  assert.ok(
    Math.abs(farCentre - 0.5) < 0.06,
    `daleki koniec nie wrócił na środek: ${farCentre.toFixed(3)}`,
  );
}
ok("Szyjka zostaje przy znaczku, a kartka wraca na swój środek");

/* ── 6. Cztery kierunki ──
   Kartka wychodzi w stronę, w którą jest miejsce. Szyjka musi wtedy siedzieć
   przy tej krawędzi kartki, która dotyka znaczka — a nie przy przeciwnej. */
const NECK_EDGE = {
  up: [1, 100], //  [współrzędna, wartość] — dół kartki
  down: [1, 0], //  góra
  left: [0, 100], // prawa krawędź
  right: [0, 0], //  lewa
};

for (const [dir, [axis, edge]] of Object.entries(NECK_EDGE)) {
  const shape = points(0.5, { ...opts, dir });
  assert.equal(
    shape[0][axis],
    edge,
    `przy kierunku „${dir}" szyjka miała siedzieć na krawędzi ${edge}%`,
  );

  // Ta sama sylwetka, tylko obrócona: szerokości muszą się zgadzać co do joty.
  const straight = widths(0.5, { ...opts, dir: "up" });
  const turned = widths(0.5, { ...opts, dir });
  straight.forEach((w, i) =>
    assert.ok(
      Math.abs(w - turned[i]) < 1e-9,
      `kierunek „${dir}" zmienił kształt, a miał go tylko obrócić`,
    ),
  );
}
ok("Kartka wychodzi w cztery strony i w każdą ma ten sam kształt");

console.log("\nEfekt genie: sylwetka zgodna.");
