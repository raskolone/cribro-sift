"use strict";

const assert = require("assert");
const {
  analyzeLessonTranscript,
  parseAnalysisResponse,
  SYSTEM_INSTRUCTION,
  LESSON_ANALYSIS_SCHEMA,
  DEFAULT_MODEL,
} = require("../src/main/lesson-analysis");
const recall = require("../src/main/recall");

let failures = 0;
const check = (name, fn) => {
  try {
    const done = fn();
    if (done instanceof Promise) {
      return done.then(
        () => console.log("  ✓ " + name),
        (error) => {
          failures += 1;
          console.log("  ✗ " + name + "\n    " + error.message);
        },
      );
    }
    console.log("  ✓ " + name);
  } catch (error) {
    failures += 1;
    console.log("  ✗ " + name + "\n    " + error.message);
  }
  return Promise.resolve();
};

const sampleAnalysis = {
  topic: "Business Negotiations & Phrasal Verbs",
  summaryPoints: [
    "Przeanalizowano zwroty negocjacyjne.",
    "Omówiono różnicę między agree to a agree on.",
    "Skorygowano błędy czasu przeszłego."
  ],
  vocabularyItems: [
    {
      term: "bottom line",
      translation: "kwestia zasadnicza / wynik finansowy",
      contextSentence: "Our bottom line is clear.",
      category: "business"
    },
    {
      term: "concede",
      translation: "ustąpić",
      contextSentence: "We can concede on this point.",
      category: "general"
    }
  ],
  areasForImprovement: [
    {
      originalError: "I have went yesterday",
      correctedForm: "I went yesterday",
      ruleExplanation: "Z określeniem yesterday używamy Past Simple."
    }
  ],
  homeworkProposal: "Przetłumacz 5 zdań z negocjacji.",
  nextLessonPlan: "Diplomatic Language w trudnych rozmowach.",
  studentSpeaking: "Kursant mówił swobodnie, z dużą pewnością siebie, lecz momentami mylił czasy przeszłe.",
  studentInsights: "Pracuje w branży IT/Fintech, planuje wystąpienie na konferencji w Londynie."
};

const real = global.fetch;

(async () => {
  console.log("Moduł analizy transkrypcji lekcji (lesson-analysis)");

  await check("stałe i schemat są poprawnie zdefiniowane", () => {
    assert.strictEqual(DEFAULT_MODEL, "gemini-2.5-flash");
    assert.match(SYSTEM_INSTRUCTION, /Cribro English/);
    assert.match(SYSTEM_INSTRUCTION, /Prawda w transkrypcji/);
    assert.strictEqual(LESSON_ANALYSIS_SCHEMA.type, "object");
    assert.deepStrictEqual(LESSON_ANALYSIS_SCHEMA.required, [
      "topic",
      "summaryPoints",
      "vocabularyItems",
      "areasForImprovement",
      "homeworkProposal",
      "nextLessonPlan",
      "studentSpeaking",
      "studentInsights"
    ]);
  });

  await check("parseAnalysisResponse poprawnie parsuje czysty JSON", () => {
    const res = parseAnalysisResponse(JSON.stringify(sampleAnalysis));
    assert.deepStrictEqual(res, sampleAnalysis);
  });

  await check("parseAnalysisResponse radzi sobie z blokami markdown", () => {
    const raw = "```json\n" + JSON.stringify(sampleAnalysis) + "\n```";
    const res = parseAnalysisResponse(raw);
    assert.strictEqual(res.topic, sampleAnalysis.topic);
    assert.strictEqual(res.vocabularyItems.length, 2);
  });

  await check("parseAnalysisResponse normalizuje błędne lub puste pola", () => {
    const partial = {
      topic: " Temat ",
      vocabularyItems: [{ term: "word", translation: "słowo", contextSentence: "sentence", category: "unknown" }],
      areasForImprovement: [{ originalError: "error", correctedForm: "fix", ruleExplanation: "rule" }],
    };
    const res = parseAnalysisResponse(JSON.stringify(partial));
    assert.strictEqual(res.topic, "Temat");
    assert.strictEqual(res.vocabularyItems[0].category, "general");
    assert.strictEqual(res.homeworkProposal, "");
    assert.strictEqual(res.studentInsights, "");
  });

  await check("analyzeLessonTranscript odrzuca brak transkrypcji lub brak klucza API", async () => {
    await assert.rejects(() => analyzeLessonTranscript("", { apiKey: "key" }), /Brak treści transkrypcji/);
    await assert.rejects(() => analyzeLessonTranscript("some text", { apiKey: "" }), /Brak klucza API/);
  });

  await check("analyzeLessonTranscript wykonuje poprawne zapytanie do Gemini z thinkingBudget: 0", async () => {
    let capturedUrl = "";
    let capturedBody = null;
    let capturedHeaders = null;

    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(sampleAnalysis) }]
                }
              }
            ]
          };
        }
      };
    };

    const result = await analyzeLessonTranscript("Teacher: Hello Jan.\nStudent: I have went yesterday to client.", {
      apiKey: "test-gemini-key",
      model: "gemini-2.5-flash"
    });

    assert.strictEqual(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    assert.strictEqual(capturedHeaders["x-goog-api-key"], "test-gemini-key");
    assert.strictEqual(capturedBody.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.strictEqual(capturedBody.generationConfig.responseMimeType, "application/json");
    assert.deepStrictEqual(capturedBody.generationConfig.responseSchema, LESSON_ANALYSIS_SCHEMA);
    assert.strictEqual(result.topic, sampleAnalysis.topic);
    assert.strictEqual(result.studentSpeaking, sampleAnalysis.studentSpeaking);
  });

  await check("recall.send dołącza analysis do payloadu wysyłanego do Recall", async () => {
    let capturedPayload = null;

    global.fetch = async (url, opts) => {
      if (url.includes("ingestTranscript") || url.includes("recall.example.com")) {
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ ok: true, action: "created", lessonId: "sift-999", studentUid: "student-123" });
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: JSON.stringify(sampleAnalysis) }] } }]
          };
        }
      };
    };

    const meeting = {
      id: "meeting-xyz",
      at: "2026-09-24T10:00:00.000Z",
      title: "Lekcja próbna",
      transcript: [{ at: 0, speaker: "Teacher", text: "Hello" }, { at: 5, speaker: "Student", text: "Hi" }]
    };

    const settings = {
      recall: { url: "https://recall.example.com/api/transcript/ingest", token: "secret-token" },
      sieve: { apiKey: "test-key", provider: "gemini" }
    };

    const result = await recall.send({
      settings,
      meeting,
      studentEmail: "kursant@example.com"
    });

    assert.strictEqual(result.lessonId, "sift-999");
    assert.strictEqual(capturedPayload.siftSessionId, "meeting-xyz");
    assert.strictEqual(capturedPayload.studentEmail, "kursant@example.com");
    assert.strictEqual(capturedPayload.topic, sampleAnalysis.topic);
    assert.deepStrictEqual(capturedPayload.analysis, sampleAnalysis);
  });

  global.fetch = real;

  if (failures) {
    console.log("\n✗ " + failures + " nieudanych testów");
    process.exit(1);
  }
  console.log("\n✓ Wszystkie testy modułu lesson-analysis przeszły pomyślnie!");
})();
