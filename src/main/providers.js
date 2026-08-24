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
  mock: {
    label: "Atrapa (bez klucza)",
    needsKey: false,
    models: [["mock", "Przykładowe zdania — do klikania bez kluczy"]],
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
      ["gpt-transcribe", "GPT Transcribe — najdokładniejszy"],
      ["gpt-4o-transcribe", "GPT-4o Transcribe"],
      ["gpt-4o-mini-transcribe", "GPT-4o mini Transcribe — najtańszy"],
      ["whisper-1", "Whisper v1 — sprawdzony klasyk"],
    ],
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
      ["gpt-5.6-terra", "GPT-5.6 Terra — rozsądny domyślny"],
      ["gpt-5.6-sol", "GPT-5.6 Sol — najmocniejszy"],
      ["gpt-5.6-luna", "GPT-5.6 Luna — najtańszy"],
    ],
  },
  anthropic: {
    label: "Anthropic Claude",
    needsKey: true,
    keyHint: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
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
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
};

/**
 * Klucz dla danego dostawcy. Szuka po kolei:
 *   1. klucz wpisany w tym kroku
 *   2. klucz z pozostałych kroków, jeśli chodzą na tym samym dostawcy
 *      (jeden klucz OpenAI obsługuje i transkrypcję, i sito, i odczyt zrzutu)
 *   3. zmienna środowiskowa
 */
function keyFor(provider, settings) {
  const { stt, sieve, shot } = settings;
  if (stt.provider === provider && stt.apiKey) return stt.apiKey;
  if (sieve.provider === provider && sieve.apiKey) return sieve.apiKey;
  if (shot?.provider === provider && shot.apiKey) return shot.apiKey;
  for (const name of ENV_KEY[provider] ?? []) {
    if (process.env[name]) return process.env[name];
  }
  return "";
}

module.exports = { STT, SIEVE, OCR, keyFor };
