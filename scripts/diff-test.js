"use strict";

/**
 * Porównanie surowej transkrypcji z przesianą — i jego koszt.
 *
 * Sama poprawność różnicy to połowa sprawy. Druga połowa jest taka, że
 * tę różnicę liczy się dla KAŻDEGO wpisu historii naraz, synchronicznie,
 * przy pierwszym rysowaniu okna — a LCS kosztuje n×m. Jedno długie
 * dyktowanie potrafiło więc zatrzymać całe okno na kilkanaście sekund
 * (zmierzone: 32 765 słów, miliard komórek, piętnaście sekund głuchego
 * okna). Dlatego czas jest tu sprawdzany na równi z wynikiem.
 *
 *   node scripts/diff-test.js
 */

const assert = require("assert");
const path = require("path");

/* js/diff.js pisze do window — w Node podstawiamy je pod globalny obiekt. */
global.window = {};
require(path.join(__dirname, "..", "src", "renderer", "js", "diff.js"));
const { diffWords } = global.window;
const MAX_CELLS = diffWords.MAX_CELLS;

/** Tekst każdego rodzaju osobno — tak, jak czyta go oko na ekranie. */
const of = (parts, type) =>
  parts
    .filter((part) => part.type === type)
    .map((part) => part.text)
    .join("")
    .trim();

/* 1. Sito wyrzuca wtręty — mają wyjść jako „odsiane", reszta jako „zostało" */
{
  const parts = diffWords("no więc yyy chciałem powiedzieć", "więc chciałem powiedzieć");
  assert.equal(of(parts, "gone"), "no  yyy", `odsiane: ${JSON.stringify(of(parts, "gone"))}`);
  assert.equal(of(parts, "kept"), "więc chciałem powiedzieć");
  assert.equal(of(parts, "added"), "");
  console.log("✓ Wtręty wychodzą jako odsiane, reszta zostaje");
}

/* 2. Sito poprawia słowo — poprawka jest „dodana", nie „odsiana" */
{
  const parts = diffWords("poszłem do sklepu", "poszedłem do sklepu");
  assert.equal(of(parts, "gone"), "poszłem");
  assert.equal(of(parts, "added"), "poszedłem");
  assert.equal(of(parts, "kept"), "do sklepu");
  console.log("✓ Poprawione słowo jest dodane, a nie tylko odsiane");
}

/* 3. Sito niczego nie zmieniło — wszystko ma zostać, nic nie ma krzyczeć.
      To jest też najkrótsza droga przez zdejmowanie wspólnego początku
      i końca: po nim nie zostaje ani jedna komórka do policzenia. */
{
  const text = "zdanie, którego sito nie tknęło";
  const parts = diffWords(text, text);
  assert.equal(of(parts, "gone"), "");
  assert.equal(of(parts, "added"), "");
  assert.equal(of(parts, "kept"), text);
  console.log("✓ Tekst nietknięty przez sito jest w całości zachowany");
}

/* 4. Wspólny początek i koniec nie zmieniają WYNIKU, tylko koszt.
      Różnica ma wyjść ta sama, co gdyby liczyć ją bez skracania. */
{
  const head = "to jest długi wspólny początek zdania ";
  const tail = " i tak samo wspólny koniec";
  const parts = diffWords(`${head}yyy no wiesz środek${tail}`, `${head}środek${tail}`);
  assert.equal(of(parts, "gone"), "yyy no wiesz");
  assert.equal(of(parts, "kept"), `${head}środek${tail}`.trim());
  console.log("✓ Skrócenie o wspólny początek i koniec nie zmienia różnicy");
}

/* 5. Pusty surowy tekst — wpis sprzed zapisywania surówki */
{
  const parts = diffWords("", "sam przesiany tekst");
  assert.equal(of(parts, "added"), "sam przesiany tekst");
  console.log("✓ Brak surowego tekstu nie wywraca porównania");
}

/* ══ KOSZT ══ */

/* 6. Dyktowanie długie, ale prawdziwe — musi się policzyć i to szybko.
      Dwa tysiące słów to jakieś kwadrans mówienia bez przerwy. */
{
  const words = (n, seed) => Array.from({ length: n }, (_, i) => `s${(i * seed) % 700}`).join(" ");
  const raw = words(2000, 7);
  const sifted = raw
    .split(" ")
    .filter((_, i) => i % 5)
    .join(" ");
  const started = Date.now();
  const parts = diffWords(raw, sifted);
  const took = Date.now() - started;
  assert.ok(parts, "prawdziwie długie dyktowanie ma się policzyć, a nie odpaść");
  assert.ok(took < 2000, `dwa tysiące słów liczyło się ${took} ms — za wolno`);
  console.log(`✓ Dwa tysiące słów liczy się w ${took} ms`);
}

/* 7. Wpis, który zatrzymywał okno. Bez sufitu jest to miliard komórek
      i piętnaście sekund; z sufitem — odmowa, i to natychmiastowa.

      Teksty muszą różnić się CO KILKA SŁÓW, od pierwszego do ostatniego.
      Dwa długie teksty o wspólnym początku albo końcu schodzą bowiem
      do zera komórek już na skracaniu (patrz sprawdzenie 4) i nie mówią
      nic o samym suficie. */
{
  const raw = Array.from({ length: 33000 }, (_, i) => `a${i % 900}`).join(" ");
  const sifted = Array.from({ length: 33000 }, (_, i) => (i % 3 ? `a${i % 900}` : `b${i % 900}`)).join(" ");
  const started = Date.now();
  const parts = diffWords(raw, sifted);
  const took = Date.now() - started;
  assert.equal(parts, null, "przy tej długości różnica ma być odmówiona, nie policzona");
  assert.ok(took < 1000, `odmowa zajęła ${took} ms — miała być natychmiastowa`);
  console.log(`✓ Dyktowanie ponad sufit odmawia różnicy w ${took} ms zamiast wieszać okno`);
}

/* 8. Sufit jest tam, gdzie go opisano — nie „gdzieś wysoko”. Gdyby ktoś
      go podniósł, wraca kwadratowy koszt i wraca zamrożone okno. */
{
  assert.ok(Number.isFinite(MAX_CELLS), "sufit ma być liczbą");
  assert.ok(MAX_CELLS <= 32_000_000, `sufit ${MAX_CELLS} jest za wysoki na jeden wątek`);
  /* Krótszy bok pod sufitem nie może przekroczyć zakresu Uint16Array,
     bo tablica LCS jest właśnie z niego. */
  assert.ok(Math.sqrt(MAX_CELLS) < 65535, "pod sufitem długość LCS musi mieścić się w Uint16");
  console.log(`✓ Sufit stoi na ${(MAX_CELLS / 1e6).toFixed(0)} mln komórek`);
}

console.log("\nRóżnica: wszystkie sprawdzenia przeszły.");
