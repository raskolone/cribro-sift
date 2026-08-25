"use strict";
/**
 * Paski narzędzi i ikony — sprawdzane w szablonach, nie okiem.
 *   node scripts/toolbar-test.js
 *
 * Trzy rzeczy potrafią zepsuć pasek tak, że nic nie wybuchnie i nikt tego
 * nie zauważy przy zwykłym klikaniu:
 *
 *   1. IKONA BEZ `fill`. Domyślne wypełnienie w SVG to CZERŃ, a nie „nic".
 *      Rysunek bez tego jednego atrybutu wychodzi czarną plamą wielkości
 *      przycisku — i dokładnie tak przez jakiś czas wyglądała karteczka
 *      przy „Widoczna w widgecie".
 *   2. ODWOŁANIE DO NIEISTNIEJĄCEGO ZNAKU. `<use href="#i-czegoś">` po
 *      przemianowaniu symbolu nie rysuje NICZEGO i nie mówi ani słowa.
 *      Zostaje pusty przycisk, który dalej działa.
 *   3. MENU BEZ PRZYCISKU (albo odwrotnie). Nasłuch kliknięć siedzi
 *      w js/notes.js i zna menu z nazwy; szablon może się z nim rozjechać
 *      przy pierwszej zmianie nazwy identyfikatora.
 *   4. SLAJD PRZEWODNIKA BEZ RYSUNKU. Scena jest wskazywana nazwą, więc
 *      literówka zostawia pusty prostokąt zamiast ilustracji — cicho
 *      i tylko na tym jednym slajdzie.
 *
 * Wszystkie trzy da się sprawdzić na samym tekście szablonów, bez
 * przeglądarki — i to jest cały ten plik.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ok = (label) => console.log(`✓ ${label}`);
const RENDERER = path.join(__dirname, "..", "src", "renderer");
const read = (file) => fs.readFileSync(path.join(RENDERER, file), "utf8");

const PAGES = ["index.html", "notes.html", "widget.html", "sticky.html", "quick.html", "shot.html"];

/* ── 1. Każdy rysunek mówi, czym jest wypełniony ──────────────────
   Albo wprost przy kształcie, albo arkuszem dla całego `svg` w tym
   szablonie (tak robią widget.html i sticky.html). Jedno z dwojga musi
   być — inaczej zostaje czerń. */

const SHAPE = /<(?:path|rect|circle|line|polyline|polygon)\b[^>]*>/g;

for (const page of PAGES) {
  const source = read(page);
  // Arkusz szablonu bierze rysunki na siebie? Wtedy atrybuty są zbędne.
  const sheetFills = /svg\s*\{[^}]*\bfill:\s*none/.test(source);
  if (sheetFills) continue;

  for (const [, name, body] of source.matchAll(/<symbol id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
    for (const shape of body.match(SHAPE) ?? []) {
      assert.ok(
        /\bfill=/.test(shape) || /\bstroke=/.test(shape),
        `${page}: kształt w symbolu „${name}" nie mówi, czym jest wypełniony — ` +
          `bez fill="none" wyjdzie czarna plama:\n  ${shape.trim()}`,
      );
    }
  }
}
ok("Każdy rysunek niesie fill albo stroke — żaden nie wyjdzie czarną plamą");

/* ── 2. Każde `use` trafia w istniejący symbol ────────────────────
   Symbole są miejscowe: `<use href="#i-czegoś">` szuka ich w TYM oknie
   i w niczym innym. Rysują nie tylko szablony, ale i skrypty, które okno
   wczytuje (widoki powstają przez innerHTML) — więc pytamy szablon, co
   wczytuje, i zaglądamy tam razem z nim. */

const REF = /href="#([^"]+)"/g;

function drawnBy(page) {
  const source = read(page);
  const names = [...source.matchAll(REF)].map((match) => match[1]);
  for (const [, src] of source.matchAll(/<script src="([^"]+)"/g)) {
    const file = path.join(RENDERER, src);
    if (!fs.existsSync(file)) continue;
    names.push(...[...fs.readFileSync(file, "utf8").matchAll(REF)].map((match) => match[1]));
  }
  return new Set(names);
}

for (const page of PAGES) {
  const source = read(page);
  const defined = new Set([...source.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]));
  const used = drawnBy(page);

  for (const name of used) {
    assert.ok(defined.has(name), `${page}: rysuje „#${name}", a takiego symbolu w tym oknie nie ma`);
  }
}
ok("Każde odwołanie trafia w symbol z tego samego okna");

/* ── 3. Pasek notatki czyta się w grupach ─────────────────────────
   Kreski nie są ozdobą: to po nich widać, gdzie kończy się „piszę",
   a zaczyna „cała notatka" — i dlaczego kosz stoi sam. */

const notes = read("notes.html");
const tools = notes.slice(
  notes.indexOf('<div class="editor__tools">'),
  notes.indexOf("</header>", notes.indexOf('<div class="editor__tools">')),
);

assert.equal(
  (tools.match(/class="editor__sep"/g) ?? []).length,
  3,
  "pasek notatki ma trzy kreski: za dyktowaniem, za pisaniem i przed koszem",
);
ok("Pasek notatki jest rozdzielony na grupy trzema kreskami");

/* Kosz jest ostatni i za własną kreską. Sąsiadujący z pinezką był jedną
   pomyłką od skasowania notatki, którą chciało się tylko przypiąć. */
const lastSep = tools.lastIndexOf('class="editor__sep"');
const trash = tools.indexOf('id="del"');
assert.ok(trash > lastSep, "kosz ma stać za ostatnią kreską");
assert.ok(
  !/id="(pin|widgetPin|share)"/.test(tools.slice(lastSep)),
  "za ostatnią kreską ma być sam kosz — nic, w co da się trafić zamiast niego",
);
ok("Kosz stoi sam, za własną kreską, na końcu paska");

/* ── 4. Formaty z paska to formaty, które edytor zna ──────────────
   Przycisk z literówką w `data-format` nie robi nic i nie mówi nic. */

const KNOWN = new Set([
  "bold",
  "italic",
  "code",
  "h1",
  "h2",
  "h3",
  "toggle",
  "divider",
  "bullet",
  "todo",
  "quote",
]);
const ALIGN = new Set(["left", "center", "right", "justify"]);

for (const page of PAGES) {
  const source = read(page);
  for (const [, kind] of source.matchAll(/data-format="([^"]+)"/g)) {
    assert.ok(KNOWN.has(kind), `${page}: „${kind}" nie jest formatem, który zna js/editor.js`);
  }
  for (const [, kind] of source.matchAll(/data-align="([^"]+)"/g)) {
    assert.ok(ALIGN.has(kind), `${page}: „${kind}" nie jest wyrównaniem`);
  }
}
ok("Każdy przycisk formatowania woła format, który edytor naprawdę zna");

/* ── 5. Menu paska i ich przyciski chodzą parami ──────────────────
   Lista menu jest w js/notes.js i to ona jest źródłem prawdy — szablon
   ma się z nią zgadzać, a nie odwrotnie. */

const script = fs.readFileSync(path.join(RENDERER, "js", "notes.js"), "utf8");
const list = script.slice(script.indexOf("const BAR_MENUS = ["), script.indexOf("];", script.indexOf("const BAR_MENUS = [")));
const pairs = [...list.matchAll(/\["#([^"]+)",\s*(?:"#([^"]+)"|'([^']+)')\]/g)];

assert.ok(pairs.length >= 3, "BAR_MENUS w js/notes.js miało wymieniać menu paska");

/* Menu paska stoją w szablonie, ale menu szuflady powstaje w kodzie razem
   z metryczką notatki — szukamy więc w obu miejscach naraz. */
const markup = notes + script;

for (const [, menu, byId] of pairs) {
  assert.ok(markup.includes(`id="${menu}"`), `nigdzie nie powstaje menu „#${menu}" z BAR_MENUS`);
  // Przycisk sprawdzamy tam, gdzie jest wpisany identyfikatorem; menu
  // szuflady otwiera się przez data-act i ma własny wiersz niżej.
  if (byId) {
    assert.ok(markup.includes(`id="${byId}"`), `nigdzie nie powstaje przycisk „#${byId}" do menu „#${menu}"`);
  }
}
assert.ok(
  script.includes('data-act="folder-menu"'),
  "menu szuflady otwiera przycisk z data-act=\"folder-menu\" — bez niego zostaje menu bez klamki",
);
ok("Każde menu paska ma w szablonie i menu, i przycisk, który je otwiera");

/* ── 6. Przewodnik: slajd bez rysunku i rysunek bez kadru ─────────
   Slajd wskazuje scenę po nazwie. Literówka w tej nazwie nie wybucha —
   zostaje pusty prostokąt tam, gdzie miał być rysunek, i nikt tego nie
   zauważy poza tym jednym slajdem. */

const guide = fs.readFileSync(path.join(RENDERER, "js", "onboarding.js"), "utf8");
const scenes = new Set([...guide.matchAll(/^    (\w+): `$/gm)].map((match) => match[1]));
const used = [...guide.matchAll(/^      art: "(\w+)",$/gm)].map((match) => match[1]);

assert.ok(scenes.size >= 6, "ART w js/onboarding.js miało zawierać sceny przewodnika");
assert.ok(used.length >= 6, "SLIDES w js/onboarding.js miało zawierać slajdy");
for (const name of used) {
  assert.ok(scenes.has(name), `slajd przewodnika woła scenę „${name}", której nie ma w ART`);
}
for (const name of scenes) {
  assert.ok(used.includes(name), `scena „${name}" nie stoi na żadnym slajdzie`);
}
ok(`Każdy slajd przewodnika ma swój rysunek (${used.length} slajdów)`);

/* Jeden kadr dla wszystkich scen. Rysunki mają być tej samej wielkości —
   slajd, na którym ilustracja nagle rośnie o połowę, czyta się jak inny
   ekran, a nie jak następna strona tej samej rzeczy. */
const frames = new Set([...guide.matchAll(/viewBox="([^"]+)"/g)].map((match) => match[1]));
assert.equal(
  frames.size,
  1,
  `sceny przewodnika mają ${frames.size} różne kadry: ${[...frames].join(" | ")}`,
);
ok("Wszystkie sceny przewodnika stoją w jednym kadrze");

console.log(
  `\nPaski i przewodnik: ${PAGES.length} szablonów i ${used.length} slajdów sprawdzonych.`,
);
