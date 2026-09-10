"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-logger-"));
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { getPath: () => tmpDir } };
  return load.call(this, request, ...rest);
};

const logger = require("../src/main/logger");

(() => {
  const logFile = logger.getPath();
  assert.equal(logFile, path.join(tmpDir, "activity.log"), "Ścieżka logu powinna wskazywać na activity.log w userData");

  logger.logTask("DYKTOWANIE", "Zakończono transkrypcję", { durationMs: 1500 });
  logger.logChange("USTAWIENIA", "Zmieniono język na pl");
  logger.logError("SIEĆ", "Brak połączenia z serwerem");

  assert(fs.existsSync(logFile), "Plik activity.log powinien powstać na dysku");

  const lines = logger.tail(10);
  assert.equal(lines.length, 3, "Powinny być 3 wpisy w pliku logu");
  assert(lines[0].includes("[ZADANIE] [DYKTOWANIE] Zakończono transkrypcję"), "Pierwsza linia to zadanie dyktowania");
  assert(lines[1].includes("[ZMIANA] [USTAWIENIA] Zmieniono język na pl"), "Druga linia to zmiana ustawień");
  assert(lines[2].includes("[BŁĄD] [SIEĆ] Brak połączenia z serwerem"), "Trzecia linia to błąd sieci");

  console.log("✓ Zapis zadań, zmian i błędów do activity.log działa poprawnie");
  console.log("✓ Odczyt ostatnich linii (tail) działa poprawnie");
  console.log("\nLogger: wszystkie sprawdzenia przeszły.");
})();
