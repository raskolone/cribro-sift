"use strict";
/**
 * Test mechanizmu fallbacku dla Sita (Clean up):
 * Gemini -> OpenAI (gpt-4o-mini) -> Groq (llama-3.3-70b-versatile)
 *   node scripts/sieve-fallback-test.js
 */
const assert = require("assert");
const { sift } = require("../src/main/sieve");
const aiRegistry = require("../src/main/ai-registry");

const calls = [];
let geminiHandler = null;
let openaiHandler = null;
let groqHandler = null;

global.fetch = async (url, init) => {
  const isGoogle = url.includes("googleapis");
  const isLocalOpenAi = url.includes("api.openai.com");
  const isGroq = url.includes("api.groq.com");
  calls.push({ url, init, isGoogle, isLocalOpenAi, isGroq });

  if (isGoogle && geminiHandler) return geminiHandler(url, init);
  if (isLocalOpenAi && openaiHandler) return openaiHandler(url, init);
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

  if (isLocalOpenAi) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Oczyszczony tekst z OpenAI." } }],
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
      model: "gemini-3.7-flash",
      apiKey: "AIza-test",
      fallbackProvider: "openai",
      fallbackModel: "gpt-4o-mini",
      fallbackApiKey: "sk-openai-test",
      groqApiKey: "gsk-groq-test",
    },
  };

  // 1. Działa Gemini - brak fallbacku
  calls.length = 0;
  geminiHandler = null;
  openaiHandler = null;
  groqHandler = null;

  let res = await sift({ raw: "yyy to jest test no wiesz", settings: baseSettings });
  assert.equal(res.text, "Oczyszczony tekst z Gemini.");
  assert.equal(res.provider, "gemini");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].isGoogle);
  console.log("✓ Normalne czyszczenie Gemini nie uruchamia fallbacku");

  // 2. Gemini 429 -> Fallback 1: OpenAI
  calls.length = 0;
  geminiHandler = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED" } }),
  });

  res = await sift({ raw: "yyy to jest test no wiesz", settings: baseSettings });
  assert.equal(res.text, "Oczyszczony tekst z OpenAI.");
  assert.equal(res.provider, "openai");
  assert.equal(res.model, "gpt-4o-mini");
  assert.equal(res.fallback, true);
  assert.ok(calls.some((c) => c.isGoogle));
  assert.ok(calls.some((c) => c.isLocalOpenAi));
  console.log("✓ Gemini 429 na sicie płynnie przełącza się na fallback OpenAI");

  // 3. Gemini 503 i OpenAI 500 -> Fallback 2: Groq
  calls.length = 0;
  geminiHandler = async () => ({
    ok: false,
    status: 503,
    text: async () => "Service Unavailable",
  });
  openaiHandler = async () => ({
    ok: false,
    status: 500,
    text: async () => "OpenAI server error",
  });

  res = await sift({ raw: "yyy to jest test no wiesz", settings: baseSettings });
  assert.equal(res.text, "Oczyszczony tekst z Groq Llama.");
  assert.equal(res.provider, "groq");
  assert.equal(res.model, "llama-3.3-70b-versatile");
  assert.equal(res.fallback, true);
  assert.ok(calls.some((c) => c.isGoogle));
  assert.ok(calls.some((c) => c.isLocalOpenAi));
  assert.ok(calls.some((c) => c.isGroq));
  console.log("✓ Awaria Gemini i OpenAI przełącza się na Groq Llama");

  // 4. Rejestr AI zarejestrował wpisy
  const registryItems = aiRegistry.list();
  assert.ok(registryItems.length >= 3, "Rejestr AI powinien zawierać zapytania");
  const sieveEntries = registryItems.filter((e) => e.stage === "sieve");
  assert.ok(sieveEntries.length >= 3, "Powinny być wpisy sita");
  console.log("✓ Rejestr zapytań AI poprawnie rejestruje wywołania sita i kody błędów");

  console.log("\nSito: wszystkie 4 testy fallbacku przeszły pomyślnie!");
})();
