"use strict";
/**
 * Test mechanizmu zapasowego (fallback) dla transkrypcji:
 * Gemini -> OpenAI (whisper-1) oraz ochrona nagrań przed utratą.
 *   node scripts/fallback-test.js
 */
const assert = require("assert");
const { transcribe } = require("../src/main/stt");
const { keyFor } = require("../src/main/providers");
const rescue = require("../src/main/rescue");

const calls = [];
let geminiHandler = null;
let openaiHandler = null;

global.fetch = async (url, init) => {
  const isGoogle = url.includes("googleapis");
  const isLocalOpenAi = url.includes("api.openai.com");
  calls.push({ url, init, isGoogle, isLocalOpenAi });

  if (isGoogle && geminiHandler) {
    return geminiHandler(url, init);
  }
  if (isLocalOpenAi && openaiHandler) {
    return openaiHandler(url, init);
  }

  if (isGoogle) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "transkrypcja z gemini" }] } }],
      }),
    };
  }

  if (isLocalOpenAi) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ text: "transkrypcja z openai whisper" }),
    };
  }

  return { ok: false, status: 500, text: async () => "Unknown endpoint" };
};

const audioDummy = Buffer.alloc(40000, 1); // 40 kB (> 32 kB mowy)

(async () => {
  console.log("Rozpoczynam sprawdzanie mechanizmu fallbacku...");

  /* 1. Normalna ścieżka: Gemini działa, brak fallbacku */
  calls.length = 0;
  geminiHandler = null;
  openaiHandler = null;

  const baseConfig = {
    language: "pl",
    stt: {
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      apiKey: "AIza-test",
      fallbackProvider: "openai",
      fallbackModel: "whisper-1",
      fallbackApiKey: "sk-fallback",
    },
  };

  let res = await transcribe(audioDummy, baseConfig);
  assert.equal(res.text, "transkrypcja z gemini");
  assert.equal(res.provider, "gemini");
  assert.equal(calls.length, 1, "Powinno być tylko jedno wywołanie do Gemini");
  assert.ok(calls[0].isGoogle);
  console.log("✓ Normalna transkrypcja Gemini nie uruchamia fallbacku");

  /* 2. Gemini zwraca 429 (rate limit) -> automatyczny fallback na OpenAI whisper-1 */
  calls.length = 0;
  geminiHandler = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED: rate limit exceeded" } }),
  });

  res = await transcribe(audioDummy, baseConfig);
  assert.equal(res.text, "transkrypcja z openai whisper");
  assert.equal(res.provider, "openai");
  assert.equal(res.model, "whisper-1");
  assert.equal(res.fallback, true, "Powinna być flaga fallback: true");
  assert.ok(calls.some((c) => c.isGoogle), "Powinno być wywołanie do Gemini");
  assert.ok(calls.some((c) => c.isLocalOpenAi), "Powinno być wywołanie fallbacku do OpenAI");
  console.log("✓ Gemini 429 (rate limit) płynnie przełącza się na OpenAI whisper-1");

  /* 3. Gemini zwraca 500 lub błąd sieciowy -> fallback na OpenAI whisper-1 */
  calls.length = 0;
  geminiHandler = async () => ({
    ok: false,
    status: 503,
    text: async () => "Service Unavailable",
  });

  res = await transcribe(audioDummy, baseConfig);
  assert.equal(res.text, "transkrypcja z openai whisper");
  assert.equal(res.provider, "openai");
  assert.equal(res.model, "whisper-1");
  assert.equal(res.fallback, true);
  console.log("✓ Gemini 503 Service Unavailable przełącza się na fallback OpenAI");

  /* 4. Gemini zwraca pusty tekst przy nagraniu z dźwiękiem -> fallback OpenAI ratuje mowę */
  calls.length = 0;
  geminiHandler = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "   " }] } }],
    }),
  });

  res = await transcribe(audioDummy, baseConfig);
  assert.equal(res.text, "transkrypcja z openai whisper");
  assert.equal(res.fallback, true);
  console.log("✓ Fałszywa cisza z Gemini zostaje uratowana przez OpenAI whisper-1");

  /* 5. Brak klucza Gemini, ale obecny klucz OpenAI -> bezpośredni fallback */
  calls.length = 0;
  geminiHandler = null;
  const noGeminiKeyConfig = {
    language: "pl",
    stt: {
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      apiKey: "",
      fallbackProvider: "openai",
      fallbackModel: "whisper-1",
      fallbackApiKey: "sk-fallback",
    },
  };

  res = await transcribe(audioDummy, noGeminiKeyConfig);
  assert.equal(res.text, "transkrypcja z openai whisper");
  assert.equal(res.provider, "openai");
  assert.equal(res.fallback, true);
  console.log("✓ Brak klucza Gemini automatycznie kieruje zapytanie do OpenAI");

  /* 6. Współdzielenie kluczy przez keyFor */
  const sieveKeyConfig = {
    stt: { provider: "gemini", apiKey: "", fallbackApiKey: "" },
    sieve: { provider: "openai", apiKey: "sk-from-sieve" },
  };
  assert.equal(keyFor("openai", sieveKeyConfig), "sk-from-sieve", "Powinien wziąć klucz z sita");

  const shotKeyConfig = {
    stt: { provider: "gemini", apiKey: "" },
    sieve: { provider: "gemini", apiKey: "" },
    shot: { provider: "openai", apiKey: "sk-from-shot" },
  };
  assert.equal(keyFor("openai", shotKeyConfig), "sk-from-shot", "Powinien wziąć klucz ze zrzutu");

  const fallbackFieldConfig = {
    stt: { provider: "gemini", apiKey: "", fallbackApiKey: "sk-from-field" },
  };
  assert.equal(keyFor("openai", fallbackFieldConfig), "sk-from-field", "Powinien wziąć klucz z fallbackApiKey");
  console.log("✓ keyFor prawidłowo współdzieli klucz OpenAI z sita, zrzutu i pola fallbacku");

  /* 7. Oba modele zawodzą -> rzucany jest błąd łączony */
  geminiHandler = async () => ({
    ok: false,
    status: 429,
    text: async () => "Gemini limit",
  });
  openaiHandler = async () => ({
    ok: false,
    status: 500,
    text: async () => "OpenAI server error",
  });

  let threw = false;
  try {
    await transcribe(audioDummy, baseConfig);
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("Gemini"), "Komunikat błędu powinien wspominać Gemini");
    assert.ok(err.message.includes("OpenAI"), "Komunikat błędu powinien wspominać OpenAI");
  }
  assert.ok(threw, "Przy awarii obu modeli powinien zostać rzucony błąd");
  console.log("✓ Awaria obu modeli generuje spójny błąd i nie gubi kontekstu");

  console.log("\nFallback: wszystkie 7 sprawdzeń przeszło pomyślnie!");
})().catch((err) => {
  console.error("✗ Błąd testu:", err);
  process.exit(1);
});
