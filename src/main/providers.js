"use strict";

/**
 * Katalog dostawców — jedno miejsce, w którym wiadomo, kto co potrafi.
 *
 * Aplikacja ma dwa niezależne kroki i każdy może chodzić na innym dostawcy:
 *   1. transkrypcja  (głos → surowy tekst)
 *   2. sito          (surowy tekst → czysty tekst)
 *
 * Jeśli oba kroki używają tego samego dostawcy, wystarczy jeden klucz.
 */

const STT = {
  deepgram: {
    label: "Deepgram (Nova-3 / Nova-2 — Rekomendowany)",
    needsKey: true,
    keyHint: "Klucz z console.deepgram.com",
    keyUrl: "https://console.deepgram.com/",
    models: [
      ["nova-3", "Deepgram Nova-3 — najnowszy, najdokładniejszy i błyskawiczny (~0.3s)"],
      ["nova-2", "Deepgram Nova-2 — sprawdzony, stabilny model produkcyjny"],
      ["nova-2-general", "Deepgram Nova-2 General"],
      ["enhanced", "Deepgram Enhanced"],
      ["base", "Deepgram Base"],
    ],
  },
  gemini: {
    label: "Google Gemini",
    needsKey: true,
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite — domyślny, najluźniejsze limity"],
      ["gemini-3.7-flash", "Gemini 3.7 Flash — szybki, ale zatłoczony na darmowym poziomie"],
      ["gemini-3.1-pro", "Gemini 3.1 Pro — dokładniejszy, wolniejszy"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash — starszy, tańszy"],
    ],
  },
  openai: {
    label: "OpenAI",
    needsKey: true,
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      ["whisper-1", "Whisper v1 — sprawdzony, dedykowany model mowy"],
    ],
  },
  groq: {
    label: "Groq (LPU — ultra-szybki)",
    needsKey: true,
    keyHint: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    models: [
      ["whisper-large-v3-turbo", "Whisper Large v3 Turbo — błyskawiczny (0.4s)"],
      ["whisper-large-v3", "Whisper Large v3 — dokładniejszy"],
    ],
  },
  mock: {
    label: "Atrapa (bez klucza)",
    needsKey: false,
    models: [["mock", "Przykładowe zdania — do klikania bez kluczy"]],
  },
};

const SIEVE = {
  gemini: {
    label: "Google Gemini",
    needsKey: true,
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      ["gemini-3.7-flash", "Gemini 3.7 Flash — szybki, domyślny"],
      ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite — najluźniejsze limity"],
      ["gemini-3.1-pro", "Gemini 3.1 Pro — najlepsza redakcja"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash — starszy, tańszy"],
    ],
  },
  openai: {
    label: "OpenAI",
    needsKey: true,
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      ["gpt-4o-mini", "GPT-4o mini — szybki, tani i dokładny"],
      ["gpt-5.6-terra", "GPT-5.6 Terra — rozsądny domyślny"],
      ["gpt-5.6-sol", "GPT-5.6 Sol — najmocniejszy"],
      ["gpt-5.6-luna", "GPT-5.6 Luna — najtańszy"],
    ],
  },
  groq: {
    label: "Groq (LPU — ultra-szybki)",
    needsKey: true,
    keyHint: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    models: [
      ["llama-3.3-70b-versatile", "Llama 3.3 70B — znakomity i darmowy"],
      ["mixtral-8x7b-32768", "Mixtral 8x7B"],
    ],
  },
  anthropic: {
    label: "Anthropic Claude",
    needsKey: true,
    keyHint: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      ["claude-3-5-haiku-20241022", "Claude 3.5 Haiku — szybki i precyzyjny"],
      ["claude-opus-5", "Claude Opus 5"],
      ["claude-sonnet-5", "Claude Sonnet 5"],
      ["claude-haiku-4-5", "Claude Haiku 4.5 — najszybszy"],
    ],
  },
};

/**
 * Krok trzeci, niezależny od tamtych dwóch: tekst z obrazu (patrz main/shot.js).
 *
 * Lista jest krótka i zaczyna się od najtańszego, bo odczyt zrzutu jest
 * zadaniem odtwórczym — model ma przepisać cudzy napis, a nie go zrozumieć.
 * Płaci się przy tym za każdy obrazek z osobna, więc różnica między
 * najtańszym a najmocniejszym jest tu widoczna na rachunku, a nie w wyniku.
 */
const OCR = {
  openai: {
    label: "OpenAI",
    needsKey: true,
    keyHint: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      ["gpt-5.6-luna", "GPT-5.6 Luna — najtańszy, domyślny"],
      ["gpt-5.6-terra", "GPT-5.6 Terra — pewniejszy przy piśmie odręcznym"],
      ["gpt-4o-mini", "GPT-4o mini — starszy, tani klasyk"],
    ],
  },
  mock: {
    label: "Atrapa (bez klucza)",
    needsKey: false,
    models: [["mock", "Przykładowy odczyt — do klikania bez kluczy"]],
  },
};

const ENV_KEY = {
  deepgram: ["DEEPGRAM_API_KEY", "DEEPGRAM_TOKEN"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
};

const SYSTEM_KEYS_B64 = {
  deepgram: "YTE2OTZkYzE5ZDJmMzQyYjU3NjA0YmU4Y2VmMzUwMjBmZWYzNzk3Yw==",
  openai: "c2stcHJvai1Kcy1lY1c4bDd5Z0V2TGpBLU5SSkdXcUxTSS0yUEg2ZnlvMnBmcDBpYlp1Q2JGMjBGUUNVVkhoVGp0NGp1Q21RTFpMbXo4MTVKU1QzQmxia0ZKTnNtVDE5VTV1SFBHU01UUkhvMVdJaE5LdUp4VWwteEg5WTJaejBPY1NiWmhRSlVMU1JnRFp0Yk9oeFFLQjJJaElpbzc0NVFB",
};

function getSystemKey(provider) {
  const b64 = SYSTEM_KEYS_B64[provider];
  if (!b64) return "";
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Klucz dla danego dostawcy. Szuka po kolei:
 *   1. klucz wpisany w tym kroku
 *   2. klucz z pozostałych kroków, jeśli chodzą na tym samym dostawcy
 *   3. dedykowane pola fallbacku (np. fallbackApiKey, groqApiKey, deepgramApiKey)
 *   4. zmienna środowiskowa
 *   5. wbudowany klucz systemowy aplikacji
 */
function keyFor(provider, settings) {
  const { stt, sieve, shot, keys } = settings ?? {};

  // Ochrona przed podrzuceniem klucza OpenAI do Gemini (np. gdy sieve.apiKey ma sk-proj-...)
  const isKeyForProvider = (key, p) => {
    if (!key || typeof key !== "string") return false;
    if (p === "gemini" && key.startsWith("sk-proj-")) return false;
    if (p === "openai" && key.startsWith("AIza")) return false;
    return true;
  };

  if (stt?.provider === provider && isKeyForProvider(stt?.apiKey, provider)) return stt.apiKey;
  if (provider === "deepgram" && (stt?.deepgramApiKey || settings?.deepgramApiKey)) {
    return stt?.deepgramApiKey || settings?.deepgramApiKey;
  }
  if (provider === "openai" && isKeyForProvider(stt?.fallbackApiKey, "openai")) return stt.fallbackApiKey;
  if (provider === "groq" && (stt?.groqApiKey || sieve?.groqApiKey || settings?.groqApiKey)) {
    return stt?.groqApiKey || sieve?.groqApiKey || settings?.groqApiKey;
  }
  if (sieve?.provider === provider && isKeyForProvider(sieve?.apiKey, provider)) return sieve.apiKey;
  if (provider === "openai" && isKeyForProvider(sieve?.apiKey, "openai")) return sieve.apiKey;
  if (provider === "openai" && isKeyForProvider(sieve?.fallbackApiKey, "openai")) return sieve.fallbackApiKey;
  if (shot?.provider === provider && isKeyForProvider(shot?.apiKey, provider)) return shot.apiKey;
  if (keys?.[provider] && isKeyForProvider(keys[provider], provider)) return keys[provider];
  if (settings?.[`${provider}ApiKey`] && isKeyForProvider(settings[`${provider}ApiKey`], provider)) {
    return settings[`${provider}ApiKey`];
  }

  for (const name of ENV_KEY[provider] ?? []) {
    if (process.env[name]) return process.env[name];
  }

  // Wbudowane klucze fabryczne (zakodowane na stałe) — używane tylko poza trybem atrap (mock)
  if (stt?.provider !== "mock" && sieve?.provider !== "mock" && settings?.noSystemKeys !== true) {
    const sysKey = getSystemKey(provider);
    if (sysKey) {
      return sysKey;
    }
  }

  return "";
}

module.exports = { STT, SIEVE, OCR, keyFor, getSystemKey };
