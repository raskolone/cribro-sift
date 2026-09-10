"use strict";

/**
 * Test weryfikujący 7-dniową retencję historii przesianych cleanupów:
 * - Wpisy starsze niż 7 dni są automatycznie usuwane przy starcie i przy addEntry.
 * - Wpisy z ostatnich 7 dni zostają zachowane.
 * - Plik history.json na dysku jest odchudzany.
 *
 *   node scripts/history-test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-history-test-"));
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: { getPath: () => home },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return load.call(this, request, ...rest);
};

const { Store, HISTORY_RETENTION_MS } = require("../src/main/store");

const ok = (label) => console.log(`✓ ${label}`);

// Sprawdzenie stałej retencji
assert.strictEqual(HISTORY_RETENTION_MS, 7 * 24 * 60 * 60 * 1000, "Retencja musi wynosić dokładnie 7 dni w ms");
ok("HISTORY_RETENTION_MS wynosi 7 dni");

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// Przygotowanie historii z wpisami o różnym wieku
const sampleHistory = [
  { id: "fresh-1", at: new Date(now - 1 * DAY).toISOString(), text: "Wczorajsze dyktowanie" },
  { id: "fresh-2", at: new Date(now - 6 * DAY).toISOString(), text: "Sprzed 6 dni" },
  { id: "expired-1", at: new Date(now - 8 * DAY).toISOString(), text: "Sprzed 8 dni (do usunięcia)" },
  { id: "expired-2", at: new Date(now - 30 * DAY).toISOString(), text: "Sprzed miesiąca (do usunięcia)" },
];

fs.writeFileSync(path.join(home, "history.json"), JSON.stringify(sampleHistory, null, 2));

// Inicjalizacja Store powinna automatycznie uruchomić pruneHistory()
const store = new Store();
const historyAfterBoot = store.getHistory();

assert.strictEqual(historyAfterBoot.length, 2, "Po starcie Store powinny zostać tylko 2 świeże wpisy");
assert.ok(historyAfterBoot.some((e) => e.id === "fresh-1"), "Wpis sprzed 1 dnia musi zostać");
assert.ok(historyAfterBoot.some((e) => e.id === "fresh-2"), "Wpis sprzed 6 dni musi zostać");
assert.ok(!historyAfterBoot.some((e) => e.id.startsWith("expired")), "Przedawnione wpisy muszą zniknąć z pamięci");
ok("Store.constructor automatycznie usuwa wpisy starsze niż 7 dni");

// Sprawdzenie zapisu na dysku
const onDisk = JSON.parse(fs.readFileSync(path.join(home, "history.json"), "utf8"));
assert.strictEqual(onDisk.length, 2, "Plik history.json na dysku musi zostać zaktualizowany");
ok("Plik history.json na dysku został odchudzony");

// Ręczne wstrzyknięcie przeterminowanego wpisu i wywołanie addEntry
store.history.push({
  id: "expired-late",
  at: new Date(now - 10 * DAY).toISOString(),
  text: "Stary wpis",
});

const newEntry = store.addEntry({ text: "Nowe dyktowanie z teraz" });
assert.strictEqual(newEntry.text, "Nowe dyktowanie z teraz");

const historyAfterAdd = store.getHistory();
assert.strictEqual(historyAfterAdd.length, 3, "addEntry powinno usunąć stary wpis i dodać nowy (2 + 1 = 3)");
assert.ok(!historyAfterAdd.some((e) => e.id === "expired-late"), "addEntry musi wyczyścić przedawnione wpisy");
assert.strictEqual(historyAfterAdd[0].id, newEntry.id, "Nowy wpis ląduje na początku");
ok("store.addEntry automatycznie czyści wpisy starsze niż 7 dni przed zapisem");

// Sprzątanie katalogu tymczasowego
fs.rmSync(home, { recursive: true, force: true });
console.log("\nHistoria: wszystkie sprawdzenia 7-dniowej retencji przeszły pomyślnie.");
