"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Dziennik aktywności aplikacji — plik `activity.log` w katalogu użytkownika (userData).
 *
 * Zapisuje każde wykonane zadanie (dyktowanie, transkrypcja, przesianie,
 * nagranie spotkania, odzyskanie zaległości) oraz każdą zmianę stanu danych
 * (dodanie wpisu, utworzenie/edycja notatki, zapis ustawień).
 */

function getLogPath() {
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), "activity.log");
    }
  } catch {
    // środowisko testowe bez pełnego Electrona
  }
  return path.join(process.cwd(), "activity.log");
}

function formatLine(level, category, description, meta = null) {
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const base = `[${now}] [${level.toUpperCase()}] [${category.toUpperCase()}] ${description}`;
  if (meta && Object.keys(meta).length > 0) {
    try {
      return `${base} ${JSON.stringify(meta)}\n`;
    } catch {
      return `${base}\n`;
    }
  }
  return `${base}\n`;
}

function append(line) {
  try {
    const file = getLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, "utf8");
  } catch (err) {
    // Błąd zapisu do logu nie może zatrzymać głównego procesu aplikacji
    console.error("Błąd zapisu do activity.log:", err.message);
  }
}

function log(level, category, description, meta = null) {
  const line = formatLine(level, category, description, meta);
  append(line);
}

/** Zarejestrowanie wykonanego zadania w aplikacji */
function logTask(category, description, meta = null) {
  log("ZADANIE", category, description, meta);
}

/** Zarejestrowanie zmiany w danych lub stanie */
function logChange(category, description, meta = null) {
  log("ZMIANA", category, description, meta);
}

/** Zarejestrowanie błędu lub niepowodzenia operacji */
function logError(category, description, meta = null) {
  log("BŁĄD", category, description, meta);
}

function getPath() {
  return getLogPath();
}

function tail(lines = 100) {
  try {
    const file = getLogPath();
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, "utf8");
    const allLines = content.split("\n").filter(Boolean);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

function clear() {
  try {
    const file = getLogPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

module.exports = {
  log,
  logTask,
  logChange,
  logError,
  getPath,
  tail,
  clear,
};
