"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);

/**
 * Wyprowadzanie notatek na zewnątrz.
 *
 * Notatki Apple sterujemy przez AppleScript — to jedyna droga, jaką macOS
 * udostępnia aplikacjom trzecim. Przy pierwszym użyciu system zapyta o zgodę
 * na sterowanie aplikacją Notatki; bez niej dostaniemy błąd -1743.
 */

/** Ucieczka dla łańcucha wstawianego do kodu AppleScript. */
function escapeAppleScript(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Notatki Apple przyjmują treść jako HTML i biorą pierwszą linię za tytuł.
 * Dzięki temu nie musimy przekazywać znaków nowej linii do AppleScriptu —
 * a to one najczęściej rozwalają cudzysłowy w wygenerowanym kodzie.
 */
function toHtml(text) {
  const escapeHtml = (line) =>
    line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines = String(text ?? "").split("\n");
  const [first, ...rest] = lines;

  const head = first?.trim() ? `<div><b>${escapeHtml(first.trim())}</b></div>` : "";
  const body = rest
    .map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>"))
    .join("");

  return head + body || "<div><br></div>";
}

/**
 * @returns {Promise<{ok: true}>}
 * @throws gdy brakuje zgody albo Notatki nie odpowiadają
 */
async function toAppleNotes(text) {
  if (process.platform !== "darwin") throw new Error("Notatki Apple są dostępne tylko na macOS.");
  if (!String(text ?? "").trim()) throw new Error("Notatka jest pusta — nie ma czego wysyłać.");

  const html = escapeAppleScript(toHtml(text));
  const script = `
    tell application "Notes"
      activate
      make new note with properties {body:"${html}"}
    end tell`;

  try {
    await run("osascript", ["-e", script], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true };
  } catch (error) {
    const detail = String(error.stderr || error.message || error);

    // −1743 to odmowa zgody na sterowanie inną aplikacją.
    if (detail.includes("-1743") || /not (been )?authoriz|permission/i.test(detail)) {
      throw new Error(
        "macOS nie pozwolił sterować Notatkami. Ustawienia systemowe → Prywatność i ochrona → Automatyzacja → Cribro Sift → zaznacz „Notatki”.",
      );
    }
    if (detail.includes("-600") || /isn't running|nie jest uruchomiona/i.test(detail)) {
      throw new Error("Nie udało się uruchomić aplikacji Notatki.");
    }
    throw new Error(`Notatki Apple odmówiły: ${detail.slice(0, 200)}`);
  }
}

/** Zamiana notatki na Markdown — pierwsza linia zostaje nagłówkiem. */
function toMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  const [first, ...rest] = lines;
  if (!first?.trim()) return String(text ?? "");
  return [`# ${first.trim()}`, ...rest].join("\n");
}

module.exports = { toAppleNotes, toMarkdown, toHtml };
