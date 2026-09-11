"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/**
 * Rejestr zapytań do modeli AI.
 *
 * Śledzi każde wywołanie modelu (STT, Sito/Clean up, OCR, Podsumowanie),
 * rejestruje czas trwania, błędy (429, 503 itp.), użycie fallbacków
 * oraz emituje zdarzenia na żywo do interfejsu w zakładce „Modele AI".
 */

const MAX_ENTRIES = 120;
let entries = [];
let broadcaster = null;

function filePath() {
  try {
    const dir = app?.getPath?.("userData") ?? process.cwd();
    return path.join(dir, "ai-requests.json");
  } catch {
    return path.join(process.cwd(), "ai-requests.json");
  }
}

function load() {
  try {
    const p = filePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(data)) {
        entries = data.slice(0, MAX_ENTRIES);
      }
    }
  } catch {}
}

function save() {
  try {
    const p = filePath();
    fs.writeFileSync(p, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2));
  } catch {}
}

// Inicjalizacja z dysku
load();

function setBroadcaster(fn) {
  broadcaster = fn;
}

function list() {
  return [...entries];
}

function clear() {
  entries = [];
  save();
  if (broadcaster) broadcaster("ai:registry:cleared", {});
  return true;
}

function record(entry) {
  const item = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  entries.unshift(item);
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
  }
  save();
  if (broadcaster) {
    try {
      broadcaster("ai:request:new", item);
    } catch {}
  }
  return item;
}

/**
 * Rejestruje początek zapytania i zwraca uchwyt do domknięcia z wynikiem.
 */
function start({ stage, stageLabel, provider, model, isFallback = false, inputInfo = "" }) {
  const t0 = Date.now();
  return {
    success: ({ statusCode = 200, outputInfo = "", textPreview = "" } = {}) => {
      const durationMs = Date.now() - t0;
      return record({
        stage,
        stageLabel: stageLabel || stage,
        provider,
        model,
        isFallback,
        inputInfo,
        outputInfo,
        textPreview: textPreview ? String(textPreview).slice(0, 160) : "",
        statusCode,
        status: "ok",
        statusLabel: "200 OK",
        durationMs,
      });
    },
    failure: ({ error, statusCode = null, outputInfo = "" } = {}) => {
      const durationMs = Date.now() - t0;
      const msg = String(error?.message || error || "Nieznany błąd");
      let statusLabel = "Błąd";
      let status = "error";

      if (statusCode === 429 || /429|limit|RESOURCE_EXHAUSTED/i.test(msg)) {
        status = "rate_limit";
        statusLabel = "429 Limit";
        statusCode = 429;
      } else if (statusCode === 503 || /503|demand|overload/i.test(msg)) {
        status = "overload";
        statusLabel = "503 Przeciążenie";
        statusCode = 503;
      } else if (statusCode === 500 || /500|Internal/i.test(msg)) {
        status = "server_error";
        statusLabel = "500 Błąd";
        statusCode = 500;
      } else if (/timeout|nie odpowiedział w/i.test(msg)) {
        status = "timeout";
        statusLabel = "Timeout";
      } else if (error?.kind === "zapętlenie") {
        status = "loop";
        statusLabel = "Zapętlenie";
      }

      return record({
        stage,
        stageLabel: stageLabel || stage,
        provider,
        model,
        isFallback,
        inputInfo,
        outputInfo: outputInfo || msg,
        error: msg,
        statusCode,
        status,
        statusLabel,
        durationMs,
      });
    },
  };
}

module.exports = {
  start,
  record,
  list,
  clear,
  setBroadcaster,
};
