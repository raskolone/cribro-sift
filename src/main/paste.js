"use strict";

const { clipboard } = require("electron");
const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);

/**
 * Ostatni krok: przesiany tekst ląduje w schowku, a jeśli użytkownik
 * sobie tego życzy — od razu wskakuje pod kursor w aktywnej aplikacji.
 *
 * Wklejenie to symulacja ⌘V przez System Events, więc macOS zażąda
 * zgody „Dostępność". Bez niej zostaje sam schowek i to też jest w porządku.
 */

async function osascript(script) {
  const { stdout } = await run("osascript", ["-e", script], { timeout: 5000 });
  return stdout.trim();
}

/** Nazwa aplikacji, w której użytkownik faktycznie pisze — trafia do historii. */
async function frontmostApp() {
  if (process.platform !== "darwin") return null;
  try {
    return await osascript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{copied: boolean, pasted: boolean, error?: string}>}
 */
async function deliver(text, { autoPaste }) {
  if (!text) return { copied: false, pasted: false };

  clipboard.writeText(text);
  if (!autoPaste || process.platform !== "darwin") return { copied: true, pasted: false };

  try {
    await osascript('tell application "System Events" to keystroke "v" using command down');
    return { copied: true, pasted: true };
  } catch (error) {
    return { copied: true, pasted: false, error: String(error.message || error) };
  }
}

module.exports = { deliver, frontmostApp };
