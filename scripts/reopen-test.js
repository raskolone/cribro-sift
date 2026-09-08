"use strict";
/**
 * Test weryfikujący zachowanie reopenIsOurs:
 * Kliknięcie w widget, kartki lub okna pomocnicze (oraz praca w trybie bez Docka)
 * NIE MA PRAWA wywoływać głównego okna aplikacji.
 *
 *   node scripts/reopen-test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ok = (label) => console.log(`✓ ${label}`);
const mainJs = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
const widgetJs = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "js", "widget.js"), "utf8");

// 1. Sprawdzenie, czy reopenIsOurs uwzględnia tryb bez Docka
assert.ok(
  mainJs.includes("store.getSettings().showInDock === false"),
  "reopenIsOurs musi natychmiast wracać true gdy showInDock === false",
);
ok("Brak ikony w Docku chroni przed przypadkowym uaktywnieniem okna głównego");

// 2. Sprawdzenie, czy reopenIsOurs sprawdza współrzędne kursora względem granic widgetu
assert.ok(
  /widget\.getBounds\(\)[\s\S]*?point\.x >= b\.x[\s\S]*?point\.x <= b\.x \+ b\.width/.test(mainJs),
  "reopenIsOurs musi sprawdzać współrzędne kursora względem granic widget.getBounds()",
);
ok("Kursor na oknie widgetu jest rozpoznawany po współrzędnych ekranowych");

// 3. Sprawdzenie, czy widget.js uwzględnia dymki .tip w overUs
assert.ok(
  widgetJs.includes('slot.querySelector(".tip")'),
  "overUs w widget.js musi uwzględniać dymki .tip gniazd tacy",
);
ok("Dymki .tip są włączone do obszaru interakcji tacy widgetu");

// 4. Sprawdzenie, czy COLLAPSE_DELAY daje wystarczająco dużo czasu na czytanie
const delayMatch = widgetJs.match(/COLLAPSE_DELAY\s*=\s*(\d+)/);
assert.ok(delayMatch && Number(delayMatch[1]) >= 800, "COLLAPSE_DELAY musi wynosić co najmniej 800ms");
ok(`COLLAPSE_DELAY zapewnia spokój przy czytaniu opcji (${delayMatch[1]} ms)`);

console.log("\nReopen & Widget Hover: wszystkie sprawdzenia przeszły pomyślnie.");
