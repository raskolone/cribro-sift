"use strict";

const { isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");

/**
 * Worker thread do wykonywania ciężkich operacji spotkań:
 * 1. Wysyłanie pełnych plików WAV do Deepgram Batch API
 * 2. Parsowanie wielomegabajtowych odpowiedzi JSON z Deepgramu
 * 3. Scalanie wypowiedzi obu torów po znacznikach czasu (start)
 *
 * Dzięki temu główny proces Electrona pozostaje responsywny i wolny od lagów.
 */

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

/**
 * Wykonuje zapytanie batch do Deepgramu dla pojedynczego pliku WAV.
 *
 * @param {string} wavPath
 * @param {object} options
 * @returns {Promise<Array<{start: number, end: number, text: string}>>}
 */
async function transcribeWavFile(wavPath, options = {}) {
  const { apiKey, model = "nova-3", language = "pl", bilingual = true } = options;
  if (!apiKey) throw new Error("Brak klucza API Deepgram.");
  if (!fs.existsSync(wavPath)) throw new Error(`Plik audio nie istnieje: ${wavPath}`);

  const stat = fs.statSync(wavPath);
  if (stat.size <= 44) {
    // Pusty plik audio (tylko nagłówek)
    return [];
  }

  const audioBytes = fs.readFileSync(wavPath);

  const urlObj = new URL(DEEPGRAM_URL);
  urlObj.searchParams.set("model", model);
  urlObj.searchParams.set("smart_format", "true");
  urlObj.searchParams.set("punctuate", "true");
  urlObj.searchParams.set("utterances", "true");

  if (bilingual) {
    urlObj.searchParams.set("detect_language", "true");
  } else if (language) {
    urlObj.searchParams.set("language", language);
  }

  const response = await fetch(urlObj.toString(), {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: audioBytes,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Deepgram zwrócił błąd ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();
  return parseDeepgramUtterances(data);
}

/**
 * Parsuje odpowiedź Deepgramu wyciągając wypowiedzi z timestampami.
 *
 * @param {object} data
 * @returns {Array<{start: number, end: number, text: string}>}
 */
function parseDeepgramUtterances(data) {
  if (Array.isArray(data?.results?.utterances) && data.results.utterances.length > 0) {
    return data.results.utterances
      .map((u) => ({
        start: Number(u.start ?? 0),
        end: Number(u.end ?? 0),
        text: String(u.transcript ?? "").trim(),
        confidence: u.confidence,
      }))
      .filter((u) => u.text.length > 0);
  }

  // Fallback do paragrafów lub pojedynczych słów, jeśli brak pola utterances
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) return [];

  const paragraphs = alt.paragraphs?.paragraphs;
  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    const out = [];
    for (const p of paragraphs) {
      if (Array.isArray(p.sentences)) {
        for (const s of p.sentences) {
          const text = String(s.text ?? "").trim();
          if (text) {
            out.push({
              start: Number(s.start ?? 0),
              end: Number(s.end ?? 0),
              text,
            });
          }
        }
      }
    }
    if (out.length > 0) return out;
  }

  const fullText = String(alt.transcript ?? "").trim();
  if (!fullText) return [];

  const words = Array.isArray(alt.words) ? alt.words : [];
  const start = words.length ? Number(words[0].start ?? 0) : 0;
  const end = words.length ? Number(words[words.length - 1].end ?? 0) : 0;
  return [{ start, end, text: fullText }];
}

/**
 * Scala wypowiedzi obu torów wyłącznie po czasie początku (start).
 *
 * @param {Array} micUtterances
 * @param {Array} systemUtterances
 * @returns {Array<{speaker: string, lane: string, at: number, start: number, end: number, text: string}>}
 */
function mergeUtterancesByTimeline(micUtterances = [], systemUtterances = []) {
  const taggedMic = micUtterances.map((u) => ({
    speaker: "Ty",
    lane: "mic",
    at: Math.round(Number(u.start ?? 0) * 10) / 10,
    start: Number(u.start ?? 0),
    end: Number(u.end ?? 0),
    text: String(u.text ?? "").trim(),
  }));

  const taggedSystem = systemUtterances.map((u) => ({
    speaker: "Kursant / Rozmówcy",
    lane: "system",
    at: Math.round(Number(u.start ?? 0) * 10) / 10,
    start: Number(u.start ?? 0),
    end: Number(u.end ?? 0),
    text: String(u.text ?? "").trim(),
  }));

  const combined = [...taggedMic, ...taggedSystem].filter((u) => u.text.length > 0);
  combined.sort((a, b) => a.start - b.start);
  return combined;
}

// Jeśli uruchomione jako worker_thread
if (!isMainThread && parentPort) {
  parentPort.on("message", async (msg) => {
    const { id, type, payload } = msg || {};
    try {
      if (type === "transcribe-file") {
        const utterances = await transcribeWavFile(payload.wavPath, payload.options);
        parentPort.postMessage({ id, success: true, result: utterances });
      } else if (type === "merge") {
        const merged = mergeUtterancesByTimeline(payload.micUtterances, payload.systemUtterances);
        parentPort.postMessage({ id, success: true, result: merged });
      } else if (type === "batch-meeting") {
        const { micWav, systemWav, options } = payload;
        const [micUtterances, systemUtterances] = await Promise.all([
          transcribeWavFile(micWav, options),
          transcribeWavFile(systemWav, options),
        ]);
        const transcript = mergeUtterancesByTimeline(micUtterances, systemUtterances);
        parentPort.postMessage({
          id,
          success: true,
          result: { transcript, micUtterances, systemUtterances },
        });
      } else {
        throw new Error(`Nieznany typ zadania workera: ${type}`);
      }
    } catch (err) {
      parentPort.postMessage({ id, success: false, error: err.message || String(err) });
    }
  });
}

module.exports = {
  transcribeWavFile,
  parseDeepgramUtterances,
  mergeUtterancesByTimeline,
};
