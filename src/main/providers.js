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

/**
 * Lista rezerwowa modeli Gemini — używana, dopóki nie ma klucza API albo
 * gdy pobranie listy z Google (`listGeminiModels` niżej) się nie uda.
 * Wyłącznie modele produkcyjne, które Google faktycznie utrzymuje.
 */
const GEMINI_FALLBACK_MODELS = [
  ["gemini-2.5-flash", "Gemini 2.5 Flash — szybki, domyślny multimodalny (OCR i Audio)"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro — zaawansowana analiza tekstu"],
  ["gemini-2.0-flash", "Gemini 2.0 Flash — alternatywny szybki model ogólny"],
  ["gemini-2.0-flash-lite", "Gemini 2.0 Flash-Lite — najlżejszy model bazowy"],
  ["gemini-1.5-flash", "Gemini 1.5 Flash — stabilna wersja LTS"],
  ["gemini-1.5-pro", "Gemini 1.5 Pro — wersja Pro LTS"],
];

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Pobiera z Google AI aktualną listę modeli Gemini, które obsługują
 * `generateContent` (czyli pomija embeddingi, aqa i inne wąsko-zadaniowe
 * modele, których nie da się użyć do transkrypcji, sita ani OCR-u).
 *
 * Bez klucza albo przy błędzie sieci zwraca `GEMINI_FALLBACK_MODELS` —
 * ustawienia mają zawsze czym się narysować, nawet offline.
 *
 * @param {string} apiKey
 * @returns {Promise<Array<[string, string]>>} pary [id modelu, etykieta]
 */
async function listGeminiModels(apiKey) {
  if (!apiKey) return GEMINI_FALLBACK_MODELS;
  try {
    const response = await fetch(`${GEMINI_MODELS_URL}?key=${encodeURIComponent(apiKey)}`);
    if (!response.ok) return GEMINI_FALLBACK_MODELS;
    const data = await response.json();
    const models = (data.models ?? [])
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => {
        const id = String(m.name ?? "").replace(/^models\//, "");
        const displayName = m.displayName || id;
        return [id, `${displayName} (${id})`];
      })
      .filter(([id]) => id);
    return models.length ? models : GEMINI_FALLBACK_MODELS;
  } catch {
    return GEMINI_FALLBACK_MODELS;
  }
}

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
    models: GEMINI_FALLBACK_MODELS,
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
    models: GEMINI_FALLBACK_MODELS,
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
  gemini: {
    label: "Google Gemini",
    needsKey: true,
    keyHint: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    models: GEMINI_FALLBACK_MODELS,
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
  groq: ["GROQ_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
};

const SYSTEM_KEYS_B64 = {
  deepgram: "YTE2OTZkYzE5ZDJmMzQyYjU3NjA0YmU4Y2VmMzUwMjBmZWYzNzk3Yw==",
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

  // Ochrona przed podrzuceniem klucza Gemini do dostawcy, który go nie przyjmuje.
  const isKeyForProvider = (key, p) => {
    if (!key || typeof key !== "string") return false;
    const trimmed = key.trim();
    if (!trimmed) return false;
    if (p === "gemini" && trimmed.startsWith("sk-proj-")) return false;
    return true;
  };

  const clean = (k) => (typeof k === "string" ? k.trim() : "");

  if (stt?.provider === provider && isKeyForProvider(stt?.apiKey, provider)) return clean(stt.apiKey);
  if (provider === "deepgram" && (stt?.deepgramApiKey || settings?.deepgramApiKey)) {
    const k = stt?.deepgramApiKey || settings?.deepgramApiKey;
    if (isKeyForProvider(k, provider)) return clean(k);
  }
  if (provider === "groq" && (stt?.groqApiKey || sieve?.groqApiKey || settings?.groqApiKey)) {
    const k = stt?.groqApiKey || sieve?.groqApiKey || settings?.groqApiKey;
    if (isKeyForProvider(k, provider)) return clean(k);
  }
  if (sieve?.provider === provider && isKeyForProvider(sieve?.apiKey, provider)) return clean(sieve.apiKey);
  if (shot?.provider === provider && isKeyForProvider(shot?.apiKey, provider)) return clean(shot.apiKey);
  if (keys?.[provider] && isKeyForProvider(keys[provider], provider)) return clean(keys[provider]);
  if (settings?.[`${provider}ApiKey`] && isKeyForProvider(settings[`${provider}ApiKey`], provider)) {
    return clean(settings[`${provider}ApiKey`]);
  }

  for (const name of ENV_KEY[provider] ?? []) {
    if (process.env[name] && isKeyForProvider(process.env[name], provider)) return clean(process.env[name]);
  }

  // Wbudowane klucze fabryczne (zakodowane na stałe) — używane tylko poza trybem atrap (mock)
  if (stt?.provider !== "mock" && sieve?.provider !== "mock" && settings?.noSystemKeys !== true) {
    const sysKey = getSystemKey(provider);
    if (sysKey) {
      return clean(sysKey);
    }
  }

  return "";
}

module.exports = { STT, SIEVE, OCR, keyFor, getSystemKey, listGeminiModels, GEMINI_FALLBACK_MODELS };
