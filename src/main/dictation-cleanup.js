"use strict";

/**
 * Smart Dictation Clean-up — mikro-filtr interpunkcji tuż przed wklejeniem.
 *
 * Deepgram Nova 3 jest szybki, ale bez przecinków i z gubioną pisownią
 * angielskich wtrąceń ("past simple", "present perfect"). Sito (main/sieve.js)
 * już to naprawia, ale jest wolniejsze i uruchamia się tylko wtedy, gdy
 * Fast-Path go nie ominął. Ten moduł jest DODATKIEM stawianym tuż przed
 * wklejeniem, niezależnie od tego, którą drogą tekst dotarł — i dlatego
 * ma twardy limit czasu: przy dyktowaniu liczy się brak zauważalnego
 * opóźnienia bardziej niż ładna interpunkcja. Po przekroczeniu limitu albo
 * błędzie dostawcy wklejamy tekst SUROWY, nigdy nie czekamy dłużej.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 700;
const MIN_WORDS = 3;

const SYSTEM = `Jesteś mikro-filtrem tekstu dyktowanego pod kursor. Twoim jedynym zadaniem jest:
1. Dodać naturalną interpunkcję (przecinki, kropki, znaki zapytania) i wielkie litery.
2. Poprawić pisownię zwrotów angielskich oraz pojęć techniczno-językowych wplecionych w polską mowę (np. nazwy czasów gramatycznych, idiomy, pojęcia IT/biznesowe).
3. ZACHOWAĆ dokładnie oryginalne słowa i ich kolejność.
ZWRÓĆ TYLKO POPRAWIONY TEKST. Zakaz cudzysłowów, wyjaśnień, komentarzy i wstępów.`;

async function callGeminiCleanup(rawText, { model, apiKey, signal }) {
  const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: rawText }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: Math.max(100, rawText.length * 2) },
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Gemini odmówił odpowiedzi (${response.status})`);
  const data = await response.json();
  if (data.promptFeedback?.blockReason) return rawText;
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return text || rawText;
}

/**
 * @param {string} rawText   surowy transkrypt, tuż przed wklejeniem
 * @param {{ model: string, apiKey: string }} config
 * @returns {Promise<string>} poprawiony tekst albo — przy zwłoce/błędzie — surowy
 */
async function cleanDictatedText(rawText, { model, apiKey } = {}) {
  const text = String(rawText ?? "");
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

  // Za krótki fragment nie zyskuje nic na interpunkcji, a każde wywołanie
  // sieci ma swój koszt i ryzyko — nie warto ich brać dla dwóch słów.
  if (wordCount < MIN_WORDS || !apiKey) return text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await callGeminiCleanup(text, { model, apiKey, signal: controller.signal });
  } catch (error) {
    console.log("[CLEANUP-BYPASS] Wklejam surowy tekst:", error.message);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { cleanDictatedText, TIMEOUT_MS, MIN_WORDS };
