"use strict";
/**
 * Test mechanizmu zapasowego (fallback) dla transkrypcji:
 * Deepgram Nova-3 -> Deepgram Nova-2 -> Gemini oraz ochrona nagrań przed utratą.
 *   node scripts/fallback-test.js
 */
const assert = require("assert");
const { transcribe } = require("../src/main/stt");
const { keyFor } = require("../src/main/providers");

const calls = [];
let deepgramHandler = null;
let geminiHandler = null;

global.fetch = async (url, init) => {
  const isGoogle = url.includes("googleapis");
  const isDeepgram = url.includes("api.deepgram.com");
  calls.push({ url, init, isGoogle, isDeepgram });

  if (isDeepgram && deepgramHandler) {
    return deepgramHandler(url, init);
  }
  if (isGoogle && geminiHandler) {
    return geminiHandler(url, init);
  }

  if (isDeepgram) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: "transkrypcja z deepgram", words: [] }] }] },
      }),
    };
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

  return { ok: false, status: 500, text: async () => "Unknown endpoint" };
};

const audioDummy = Buffer.alloc(40000, 1); // 40 kB (> 32 kB mowy)

(async () => {
  console.log("Rozpoczynam sprawdzanie mechanizmu fallbacku...");

  /* 1. Normalna ścieżka: Deepgram działa, brak fallbacku */
  calls.length = 0;
  deepgramHandler = null;
  geminiHandler = null;

  const baseConfig = {
    language: "pl",
    stt: {
      provider: "deepgram",
      model: "nova-3",
      apiKey: "dg-test",
    },
  };

  let res = await transcribe(audioDummy, baseConfig);
  assert.equal(res.text, "transkrypcja z deepgram");
  assert.equal(res.provider, "deepgram");
  assert.equal(calls.length, 1, "Powinno być tylko jedno wywołanie do Deepgram");
  console.log("✓ Normalna transkrypcja Deepgram nie uruchamia fallbacku");

  /* 2. Deepgram Nova-3 zwraca 429 -> automatyczny fallback na Deepgram Nova-2 */
  calls.length = 0;
  deepgramHandler = async (url) => {
    if (url.includes("model=nova-3")) {
      return { ok: false, status: 429, text: async () => "rate limit exceeded" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: "transkrypcja z nova-2", words: [] }] }] },
      }),
    };
  };

  res = await transcribe(audioDummy, baseConfig);
  assert.equal(res.text, "transkrypcja z nova-2");
  assert.equal(res.provider, "deepgram");
  assert.equal(res.fallback, true, "Powinna być flaga fallback: true");
  console.log("✓ Deepgram Nova-3 429 (rate limit) płynnie przełącza się na Nova-2");

  /* 3. Deepgram całkowicie zawodzi -> fallback na Gemini */
  calls.length = 0;
  deepgramHandler = async () => ({ ok: false, status: 503, text: async () => "Service Unavailable" });
  geminiHandler = null;

  const withGeminiKey = {
    language: "pl",
    stt: { provider: "deepgram", model: "nova-3", apiKey: "dg-test" },
    sieve: { provider: "gemini", apiKey: "AIza-test" },
  };

  res = await transcribe(audioDummy, withGeminiKey);
  assert.equal(res.text, "transkrypcja z gemini");
  assert.equal(res.provider, "gemini");
  assert.equal(res.fallback, true);
  console.log("✓ Awaria obu prób Deepgram przełącza się na fallback Gemini");

  /* 4. Deepgram zwraca pusty tekst przy nagraniu z dźwiękiem -> fallback Gemini ratuje mowę */
  calls.length = 0;
  deepgramHandler = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      results: { channels: [{ alternatives: [{ transcript: "   ", words: [] }] }] },
    }),
  });
  geminiHandler = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "transkrypcja z gemini" }] } }],
    }),
  });

  res = await transcribe(audioDummy, withGeminiKey);
  assert.equal(res.text, "transkrypcja z gemini");
  assert.equal(res.fallback, true);
  console.log("✓ Fałszywa cisza z Deepgram zostaje uratowana przez Gemini");

  /* 5. Współdzielenie kluczy przez keyFor */
  const sieveKeyConfig = {
    stt: { provider: "gemini", apiKey: "" },
    sieve: { provider: "gemini", apiKey: "sk-from-sieve" },
  };
  assert.equal(keyFor("gemini", sieveKeyConfig), "sk-from-sieve", "Powinien wziąć klucz z sita");

  const shotKeyConfig = {
    stt: { provider: "deepgram", apiKey: "" },
    sieve: { provider: "gemini", apiKey: "" },
    shot: { provider: "gemini", apiKey: "sk-from-shot" },
  };
  assert.equal(keyFor("gemini", shotKeyConfig), "sk-from-shot", "Powinien wziąć klucz ze zrzutu");
  console.log("✓ keyFor prawidłowo współdzieli klucz Gemini z sita i zrzutu");

  /* 6. Wszystkie próby zawodzą -> rzucany jest błąd łączony */
  calls.length = 0;
  deepgramHandler = async () => ({ ok: false, status: 429, text: async () => "Deepgram limit" });
  geminiHandler = async () => ({ ok: false, status: 500, text: async () => "Gemini server error" });

  let threw = false;
  try {
    await transcribe(audioDummy, withGeminiKey);
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes("Deepgram"), "Komunikat błędu powinien wspominać Deepgram");
    assert.ok(err.message.includes("Gemini"), "Komunikat błędu powinien wspominać Gemini");
  }
  assert.ok(threw, "Przy awarii wszystkich prób powinien zostać rzucony błąd");
  console.log("✓ Awaria wszystkich prób generuje spójny błąd i nie gubi kontekstu");

  console.log("\nFallback: wszystkie 6 sprawdzeń przeszło pomyślnie!");
})().catch((err) => {
  console.error("✗ Błąd testu:", err);
  process.exit(1);
});
