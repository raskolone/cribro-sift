"use strict";

/**
 * Moduł analizy i podsumowania transkrypcji lekcji w Cribro Sift.
 *
 * Używa Google Gemini 2.5 Flash z ResponseSchema / Structured Outputs,
 * aby deterministycznie wyekstrahować kluczowe dane z lekcji 1-na-1
 * bez zbędnego narzutu i bez bloków markdown.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";

const SYSTEM_INSTRUCTION = "Jesteś precyzyjnym analitykiem metodycznym w szkole językowej Cribro English.\n" +
  "Przeanalizuj transkrypcję lekcji 1-na-1 i wyekstrahuj kluczowe dane.\n" +
  "Zasady:\n" +
  "- Prawda w transkrypcji: Wyciągaj wyłącznie słówka i błędy, które FAKTYCZNIE padły na lekcji.\n" +
  "- Język: Notatki, wyjaśnienia i podsumowania po polsku. Hasła angielskie, zdania i korekty po angielsku.\n" +
  "- Selekcja (80/20): Wybierz 4-10 kluczowych zwrotów i 3-6 najważniejszych korekt błędów kursanta.\n" +
  "- Notatki lektora: 'studentSpeaking' to 2-4 zdania podsumowania swobody wypowiedzi kursanta. 'studentInsights' to trwałe fakty o kursancie (praca, projekty, plany, blokady) lub pusty ciąg \"\".\n" +
  "- Zwróć wyłącznie poprawny JSON.";

const LESSON_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      description: "Temat lekcji",
    },
    summaryPoints: {
      type: "array",
      items: { type: "string" },
      description: "Lista punktów podsumowujących lekcję",
    },
    vocabularyItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          translation: { type: "string" },
          contextSentence: { type: "string" },
          category: {
            type: "string",
            enum: ["idiom", "collocation", "business", "general"],
          },
        },
        required: ["term", "translation", "contextSentence", "category"],
      },
      description: "Kluczowe słówka i zwroty",
    },
    areasForImprovement: {
      type: "array",
      items: {
        type: "object",
        properties: {
          originalError: { type: "string" },
          correctedForm: { type: "string" },
          ruleExplanation: { type: "string" },
        },
        required: ["originalError", "correctedForm", "ruleExplanation"],
      },
      description: "Korekty błędów kursanta",
    },
    homeworkProposal: {
      type: "string",
      description: "Propozycja pracy domowej",
    },
    nextLessonPlan: {
      type: "string",
      description: "Plan na kolejną lekcję",
    },
    studentSpeaking: {
      type: "string",
      description: "Podsumowanie swobody wypowiedzi kursanta",
    },
    studentInsights: {
      type: "string",
      description: "Trwałe fakty o kursancie",
    },
  },
  required: [
    "topic",
    "summaryPoints",
    "vocabularyItems",
    "areasForImprovement",
    "homeworkProposal",
    "nextLessonPlan",
    "studentSpeaking",
    "studentInsights",
  ],
};

/**
 * Bezpieczne parsowanie odpowiedzi JSON z Gemini.
 */
function parseAnalysisResponse(raw) {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  if (text.startsWith("```json")) {
    text = text.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (text.startsWith("```")) {
    text = text.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      topic: String(parsed.topic ?? "").trim(),
      summaryPoints: Array.isArray(parsed.summaryPoints)
        ? parsed.summaryPoints.map((p) => String(p ?? "").trim()).filter(Boolean)
        : [],
      vocabularyItems: Array.isArray(parsed.vocabularyItems)
        ? parsed.vocabularyItems
            .map((item) => ({
              term: String(item?.term ?? "").trim(),
              translation: String(item?.translation ?? "").trim(),
              contextSentence: String(item?.contextSentence ?? "").trim(),
              category: ["idiom", "collocation", "business", "general"].includes(item?.category)
                ? item.category
                : "general",
            }))
            .filter((v) => v.term)
        : [],
      areasForImprovement: Array.isArray(parsed.areasForImprovement)
        ? parsed.areasForImprovement
            .map((item) => ({
              originalError: String(item?.originalError ?? "").trim(),
              correctedForm: String(item?.correctedForm ?? "").trim(),
              ruleExplanation: String(item?.ruleExplanation ?? "").trim(),
            }))
            .filter((a) => a.originalError || a.correctedForm)
        : [],
      homeworkProposal: String(parsed.homeworkProposal ?? "").trim(),
      nextLessonPlan: String(parsed.nextLessonPlan ?? "").trim(),
      studentSpeaking: String(parsed.studentSpeaking ?? "").trim(),
      studentInsights: String(parsed.studentInsights ?? "").trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Analiza transkrypcji lekcji za pomocą Gemini 2.5 Flash.
 *
 * @param {string} transcript      surowy zapis rozmowy z lekcji
 * @param {object} options
 * @param {string} options.apiKey  klucz API Google Gemini
 * @param {string} [options.model] opcjonalny model (domyślnie gemini-2.5-flash)
 * @param {number} [options.timeoutMs] deadline zapytania (domyślnie 60s)
 * @returns {Promise<object>} ustrukturyzowana analiza lekcji
 */
async function analyzeLessonTranscript(transcript, { apiKey, model = DEFAULT_MODEL, timeoutMs = 60000 } = {}) {
  const text = String(transcript ?? "").trim();
  if (!text) throw new Error("Brak treści transkrypcji do analizy.");
  if (!apiKey) throw new Error("Brak klucza API dla Gemini (wymagany do analizy transkrypcji).");

  const { describeError } = require("./stt");
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);

  try {
    const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: `Oto surowa transkrypcja lekcji do analizy metodycznej:\n\n${text}` }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: LESSON_ANALYSIS_SCHEMA,
        },
      }),
      signal: stop.signal,
    });

    if (!response.ok) {
      throw new Error(await describeError(response, "Gemini"));
    }

    const data = await response.json();
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini odmówił przetworzenia transkrypcji (${data.promptFeedback.blockReason}).`);
    }

    const rawText = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    const analysis = parseAnalysisResponse(rawText);
    if (!analysis) {
      throw new Error("Odpowiedź Gemini nie zawiera poprawnej struktury analizy lekcji.");
    }

    return analysis;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Analiza transkrypcji przez Gemini przekroczyła limit czasu.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  analyzeLessonTranscript,
  parseAnalysisResponse,
  SYSTEM_INSTRUCTION,
  LESSON_ANALYSIS_SCHEMA,
  DEFAULT_MODEL,
};
