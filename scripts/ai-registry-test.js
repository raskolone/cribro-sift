"use strict";
/**
 * Test rejestru zapytań AI:
 *   node scripts/ai-registry-test.js
 */
const assert = require("assert");
const aiRegistry = require("../src/main/ai-registry");

console.log("Rozpoczynam testy rejestru zapytań AI...");

aiRegistry.clear();
assert.equal(aiRegistry.list().length, 0, "Rejestr po clear() powinien być pusty");

// 1. Zapis udanego zapytania
const req1 = aiRegistry.start({
  stage: "stt",
  stageLabel: "Transkrypcja",
  provider: "gemini",
  model: "gemini-3.1-flash-lite",
  isFallback: false,
  inputInfo: "35 kB WAV",
});

const item1 = req1.success({ statusCode: 200, outputInfo: "68 znaków", textPreview: "Cześć, to jest test dyktowania." });
assert.equal(item1.status, "ok");
assert.equal(item1.statusCode, 200);
assert.equal(item1.isFallback, false);
assert.ok(item1.durationMs >= 0);
console.log("✓ Poprawna rejestracja sukcesu 200 OK");

// 2. Zapis błędu 429 (rate limit)
const req2 = aiRegistry.start({
  stage: "stt",
  stageLabel: "Transkrypcja",
  provider: "gemini",
  model: "gemini-3.7-flash",
  isFallback: false,
  inputInfo: "50 kB WAV",
});

const item2 = req2.failure({ error: new Error("Gemini zwrócił błąd 429: RESOURCE_EXHAUSTED"), statusCode: 429 });
assert.equal(item2.status, "rate_limit");
assert.equal(item2.statusCode, 429);
assert.equal(item2.statusLabel, "429 Limit");
console.log("✓ Poprawne rozpoznanie błędu 429 Limit");

// 3. Zapis błędu 503 (przeciążenie)
const req3 = aiRegistry.start({
  stage: "sieve",
  stageLabel: "Sito (Clean up)",
  provider: "gemini",
  model: "gemini-3.7-flash",
  isFallback: false,
  inputInfo: "120 znaków",
});

const item3 = req3.failure({ error: new Error("Gemini zwrócił błąd 503: This model is currently experiencing high demand"), statusCode: 503 });
assert.equal(item3.status, "overload");
assert.equal(item3.statusCode, 503);
assert.equal(item3.statusLabel, "503 Przeciążenie");
console.log("✓ Poprawne rozpoznanie błędu 503 Przeciążenie");

// 4. Zapis udanego fallbacku
const req4 = aiRegistry.start({
  stage: "stt",
  stageLabel: "Transkrypcja",
  provider: "openai",
  model: "whisper-1",
  isFallback: true,
  inputInfo: "50 kB WAV",
});

const item4 = req4.success({ statusCode: 200, outputInfo: "45 znaków", textPreview: "To jest transkrypcja z fallbacku." });
assert.equal(item4.isFallback, true);
assert.equal(item4.status, "ok");
console.log("✓ Poprawne oznaczenie isFallback: true");

// 5. Lista zapytań
const list = aiRegistry.list();
assert.equal(list.length, 4);
assert.equal(list[0].id, item4.id, "Ostatnie zapytanie powinno być pierwsze na liście");
console.log("✓ Lista zwraca najnowsze wpisy na początku");

console.log("\nRejestr AI: wszystkie sprawdzenia przeszły pomyślnie!");
