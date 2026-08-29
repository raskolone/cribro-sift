"use strict";
/**
 * Krojenie toru na odcinki.
 *   node scripts/segments-test.js
 *
 * Trzy rzeczy, które psują transkrypcję po cichu i wszystkie trzy mają tu
 * własne przypadki: słowo przecięte na granicy odcinka, cisza opłacona jak
 * mowa, i zegar, który rozjeżdża się z nagraniem, bo któryś odcinek
 * przepadł. Żadna z nich nie wygląda na błąd w chwili, w której się dzieje.
 */
const assert = require("assert");
const { cutter, loudness, SAMPLE_RATE } = require("../src/main/segments");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/** Sekundy dźwięku: `level` to amplituda 0…1 (0 = cisza). */
function tone(secs, level = 0.3) {
  const samples = Math.round(secs * SAMPLE_RATE);
  const pcm = Buffer.alloc(samples * 2);
  for (let at = 0; at < samples; at += 1) {
    const value = Math.sin((at / SAMPLE_RATE) * 2 * Math.PI * 220) * level;
    pcm.writeInt16LE(Math.round(value * 32767), at * 2);
  }
  return pcm;
}

/* ── Pomiar głośności ───────────────────────────────────────── */

check("Cisza mierzy się jako cisza", loudness(tone(1, 0)) <= -119);
check("Mowa mierzy się dużo wyżej niż cisza", loudness(tone(1, 0.3)) > -20);
check("Pusta porcja nie wywraca pomiaru", loudness(Buffer.alloc(0)) === -120);

/* ── Cięcie ─────────────────────────────────────────────────── */

let cut = cutter({ lane: "mic", span: 10, overlap: 2 });
check("Poniżej długości odcinka nic nie wychodzi", cut.push(tone(6)).length === 0);

let out = cut.push(tone(6));
check("Po przekroczeniu długości wychodzi jeden odcinek", out.length === 1);
check("Odcinek trwa dokładnie tyle, ile zamówiono", Math.abs(out[0].to - out[0].from - 10) < 0.01);
check("Odcinek zaczyna się od zera", out[0].from === 0);

out = cut.push(tone(9));
check(
  "Następny odcinek zaczyna się PRZED końcem poprzedniego — o zakładkę",
  out.length === 1 && Math.abs(out[0].from - 8) < 0.01,
);
check("Numeracja odcinków rośnie", out[0].index === 1);

/* Zakładka jest po to, żeby słowo z granicy było w całości w co najmniej
   jednym odcinku. Bez niej żaden z dwóch sąsiadów nie ma go w całości. */
check("Sąsiednie odcinki zachodzą na siebie", out[0].from < 10);

/* ── Bramka ciszy ───────────────────────────────────────────── */

cut = cutter({ lane: "mic", span: 4, overlap: 0, floor: -45 });
out = cut.push(tone(4, 0));
check("Odcinek samej ciszy jest oznaczony jako cichy", out[0].silent === true);

out = cut.push(tone(4, 0.3));
check("Odcinek z mową nie jest cichy", out[0].silent === false);

/* To jest ta pułapka: odcinek pominięty przez bramkę MUSI przesunąć zegar.
   Inaczej znaczniki w transkrypcji rozjeżdżają się z nagraniem — i to tym
   bardziej, im więcej w spotkaniu było ciszy, czyli zawsze mocno. */
cut = cutter({ lane: "mic", span: 4, overlap: 0, floor: -45 });
cut.push(tone(4, 0));
cut.push(tone(4, 0));
out = cut.push(tone(4, 0.3));
check(
  "Cisza przesuwa zegar tak samo jak mowa — inaczej znaczniki kłamią",
  Math.abs(out[0].from - 8) < 0.01,
);

/* ── Domknięcie ─────────────────────────────────────────────── */

cut = cutter({ lane: "system", span: 10, overlap: 2 });
cut.push(tone(4));
out = cut.flush();
check("Resztka wychodzi odcinkiem — ostatnie zdanie pada w ostatnich sekundach", out.length === 1);
check("Resztka wie, ile trwa", Math.abs(out[0].to - out[0].from - 4) < 0.01);

cut = cutter({ lane: "system", span: 10, overlap: 2 });
cut.push(tone(10));
out = cut.flush();
check(
  "Sama zakładka NIE wychodzi drugi raz — to materiał już wydany",
  out.length === 0,
);

cut = cutter({ lane: "system", span: 10, overlap: 2 });
check("Domknięcie pustego toru nie tworzy odcinka znikąd", cut.flush().length === 0);

/* ── Nadrabianie zaległości ─────────────────────────────────── */

cut = cutter({ lane: "system", span: 5, overlap: 0 });
out = cut.push(tone(17));
check("Jedna duża porcja rozpada się na tyle odcinków, ile w niej jest", out.length === 3);
check(
  "…i lecą po kolei, bez dziur w czasie",
  out.every((piece, at) => Math.abs(piece.from - at * 5) < 0.01),
);
check("Reszta czeka w buforze", Math.abs(cut.pending - 2) < 0.01);

console.log(`\n${passed} sprawdzeń przeszło.`);
