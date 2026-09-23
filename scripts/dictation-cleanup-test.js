"use strict";
/**
 * Smart Dictation Clean-up — mikro-filtr interpunkcji, bez sieci.
 *   node scripts/dictation-cleanup-test.js
 */
const assert = require("assert");
const { cleanDictatedText, TIMEOUT_MS } = require("../src/main/dictation-cleanup");

let passed = 0;
const ok = (label) => (console.log(`✓ ${label}`), (passed += 1));

(async () => {
  // Za krótki fragment — bez sieci, sam się nie zmienia.
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ candidates: [] }) };
  };
  const krotkie = await cleanDictatedText("tak jasne", { model: "m", apiKey: "k" });
  assert.equal(krotkie, "tak jasne");
  assert.equal(called, false, "krótki fragment nie ma prawa wywołać sieci");
  ok("Fragment krótszy niż trzy słowa zostaje bez zmian, bez sieci");

  // Bez klucza — tak samo, bez sieci.
  called = false;
  const bezKlucza = await cleanDictatedText("zróbmy dzisiaj revision bo kursant", { model: "m" });
  assert.equal(bezKlucza, "zróbmy dzisiaj revision bo kursant");
  assert.equal(called, false);
  ok("Brak klucza API — surowy tekst, bez sieci");

  // Gemini odpowiada na czas — poprawiony tekst wraca.
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "Zróbmy dzisiaj revision, bo kursant ma problem." }] } }],
    }),
  });
  const poprawione = await cleanDictatedText("zróbmy dzisiaj revision bo kursant ma problem", {
    model: "gemini-2.0-flash-lite",
    apiKey: "k",
  });
  assert.equal(poprawione, "Zróbmy dzisiaj revision, bo kursant ma problem.");
  ok("Gemini odpowiada na czas — wraca poprawiony tekst");

  // Gemini nie zdąża — po limicie wraca surowy tekst, a nie błąd.
  global.fetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => resolve({ ok: true, status: 200, json: async () => ({ candidates: [] }) }),
        TIMEOUT_MS + 500,
      );
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  const started = Date.now();
  const spoznione = await cleanDictatedText("zróbmy dzisiaj revision bo kursant ma problem", {
    model: "m",
    apiKey: "k",
  });
  const elapsed = Date.now() - started;
  assert.equal(spoznione, "zróbmy dzisiaj revision bo kursant ma problem");
  assert.ok(elapsed < TIMEOUT_MS + 200, `limit czasu musi zadziałać (minęło ${elapsed} ms)`);
  ok("Przekroczony limit 700 ms — wklejamy surowy tekst, bez czekania na odpowiedź");

  // Dostawca odmawia — surowy tekst, bez wywalania dyktowania.
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "Błąd serwera" });
  const odmowa = await cleanDictatedText("zróbmy dzisiaj revision bo kursant", {
    model: "m",
    apiKey: "k",
  });
  assert.equal(odmowa, "zróbmy dzisiaj revision bo kursant");
  ok("Odmowa dostawcy — surowy tekst, dyktowanie nie pada");

  console.log(`\nCzyszczenie dyktowania: ${passed} sprawdzeń przeszło.`);
})().catch((error) => {
  console.error("\n✗", error.message);
  process.exit(1);
});
