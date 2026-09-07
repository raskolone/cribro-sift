"use strict";
/**
 * Ratunek (main/rescue.js): zapis nagrania, którego transkrypcja nie ma jak
 * dojść do dostawcy, i próba dogonienia zaległości, gdy sieć wraca.
 *   node scripts/rescue-test.js
 */
const assert = require("assert");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

// rescue.js sięga po ścieżkę Electrona już przy ładowaniu (patrz notes-test.js)
// — podstawiamy katalog tymczasowy, własny dla tego uruchomienia testu.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-rescue-"));
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { getPath: () => userData } };
  return load.call(this, request, ...rest);
};

// Domyślnie sieć nie odpowiada — testy, którym to pasuje, nie muszą nic ustawiać.
global.fetch = async () => ({ ok: false, status: 500, text: async () => "" });

const rescue = require("../src/main/rescue");

const settings = {
  mesh: "srednie",
  language: "auto",
  grains: [],
  stt: { provider: "gemini", model: "gemini-3.7-flash", apiKey: "AIza-test" },
  sieve: { provider: "gemini", model: "gemini-3.7-flash", apiKey: "", customInstruction: "" },
};

(async () => {
  /* 1. Zapis trafia na dysk i wraca na liście, razem z powodem */
  const id = rescue.stash(Buffer.from("RIFFfake"), { app: "Test", durationMs: 4000, reason: "brak sieci" });
  let pending = rescue.list();
  assert.equal(pending.length, 1, "zapisane nagranie powinno być na liście");
  assert.equal(pending[0].id, id);
  assert.equal(pending[0].reason, "brak sieci");
  console.log("✓ Zapis trafia na dysk i wraca na liście");

  /* 2. Sieć dalej nie działa — flush nie rusza wpisu i plik zostaje */
  let flushed = await rescue.flush(settings, () => {
    throw new Error("bez sieci nie powinno się nic odzyskać");
  });
  assert.equal(flushed.done, 0, "bez sieci nic nie powinno się udać");
  assert.equal(rescue.list().length, 1, "plik ma zostać, gdy sieć dalej nie działa");
  console.log("✓ Bez sieci nagranie zostaje na kolejną próbę");

  /* 3. Sieć wraca — flush odzyskuje wpis i sam sprząta po sobie */
  global.fetch = async (url) =>
    url.includes("googleapis")
      ? {
          ok: true,
          status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "odzyskany tekst" }] } }] }),
        }
      : { ok: true, status: 200, json: async () => ({}) };

  const rescued = [];
  flushed = await rescue.flush(settings, (entry) => rescued.push(entry));
  assert.equal(flushed.done, 1, "sieć wróciła — powinno się odzyskać dokładnie jedno nagranie");
  assert.equal(rescued[0].text, "odzyskany tekst");
  assert.equal(rescue.list().length, 0, "odzyskany plik ma zniknąć z ratunku");
  console.log("✓ Powrót sieci odzyskuje nagranie i sprząta plik");

  /* 4. Nagrania starsze niż tydzień znikają same, zanim ktokolwiek spróbuje je odzyskać */
  const staleId = rescue.stash(Buffer.from("RIFFfake"), { app: "Test", durationMs: 1000, reason: "stare" });
  const staleFile = path.join(userData, "ratunek", `${staleId}.json`);
  const meta = JSON.parse(fs.readFileSync(staleFile, "utf8"));
  meta.savedAt = new Date(Date.now() - rescue.MAX_AGE_MS - 1000).toISOString();
  fs.writeFileSync(staleFile, JSON.stringify(meta));
  rescue.purgeExpired();
  assert.equal(rescue.list().length, 0, "nagranie starsze niż tydzień powinno zniknąć");
  console.log("✓ Sprzątanie zabiera nagrania starsze niż tydzień");

  console.log("\nRatunek: wszystkie sprawdzenia przeszły.");
})().catch((error) => {
  console.error("✗", error.message);
  process.exit(1);
});
