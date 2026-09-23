"use strict";
/**
 * Test mechanizmu fallbacku dla Sita (Clean up):
 * Gemini -> Groq (llama-3.3-70b-versatile)
 *   node scripts/sieve-fallback-test.js
 */
const assert = require("assert");
const { sift } = require("../src/main/sieve");
const aiRegistry = require("../src/main/ai-registry");

const calls = [];
let geminiHandler = null;
let groqHandler = null;

global.fetch = async (url, init) => {
  const isGoogle = url.includes("googleapis");
  const isGroq = url.includes("api.groq.com");
  calls.push({ url, init, isGoogle, isGroq });

  if (isGoogle && geminiHandler) return geminiHandler(url, init);
  if (isGroq && groqHandler) return groqHandler(url, init);

  if (isGoogle) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Oczyszczony tekst z Gemini." }] } }],
      }),
    };
  }

  if (isGroq) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Oczyszczony tekst z Groq Llama." } }],
      }),
    };
  }

  return { ok: false, status: 500, text: async () => "Unknown endpoint" };
};

(async () => {
  console.log("Rozpoczynam testy mechanizmu fallbacku Sita...");

  const baseSettings = {
    mesh: "srednie",
    language: "pl",
    sieve: {
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "AIza-test",
      groqApiKey: "gsk-groq-test",
    },
  };

  // 1. Działa Gemini - brak fallbacku
  calls.length = 0;
  geminiHandler = null;
  groqHandler = null;

  let res = await sift({ raw: "yyy to jest test no wiesz", settings: baseSettings });
  assert.equal(res.text, "Oczyszczony tekst z Gemini.");
  assert.equal(res.provider, "gemini");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].isGoogle);
  console.log("✓ Normalne czyszczenie Gemini nie uruchamia fallbacku");

  // 2. Gemini 429 -> Fallback: Groq
  calls.length = 0;
  geminiHandler = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED" } }),
  });

  res = await sift({ raw: "yyy to jest test no wiesz", settings: baseSettings });
  assert.equal(res.text, "Oczyszczony tekst z Groq Llama.");
  assert.equal(res.provider, "groq");
  assert.equal(res.model, "llama-3.3-70b-versatile");
  assert.equal(res.fallback, true);
  assert.ok(calls.some((c) => c.isGoogle));
  assert.ok(calls.some((c) => c.isGroq));
  console.log("✓ Gemini 429 na sicie płynnie przełącza się na fallback Groq");

  // 3. Gemini i Groq oba zawodzą -> sito oddaje surowy tekst jako degraded
  calls.length = 0;
  geminiHandler = async () => ({
    ok: false,
    status: 503,
    text: async () => "Service Unavailable",
  });
  groqHandler = async () => ({
    ok: false,
    status: 500,
    text: async () => "Groq server error",
  });

  res = await sift({ raw: "yyy to jest test no wiesz", settings: baseSettings });
  assert.equal(res.degraded, true, "Sito powinno oddać surowy tekst, gdy wszyscy dostawcy zawiodą");
  assert.ok(calls.some((c) => c.isGoogle));
  assert.ok(calls.some((c) => c.isGroq));
  console.log("✓ Awaria Gemini i Groq oddaje surowy tekst zamiast rzucać błąd");

  // 4. Rejestr AI zarejestrował wpisy
  const registryItems = aiRegistry.list();
  assert.ok(registryItems.length >= 3, "Rejestr AI powinien zawierać zapytania");
  const sieveEntries = registryItems.filter((e) => e.stage === "sieve");
  assert.ok(sieveEntries.length >= 3, "Powinny być wpisy sita");
  console.log("✓ Rejestr zapytań AI poprawnie rejestruje wywołania sita i kody błędów");

  console.log("\nSito: wszystkie 4 testy fallbacku przeszły pomyślnie!");
})();
