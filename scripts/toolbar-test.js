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

const PAGES = [
  "index.html",
  "notes.html",
  "widget.html",
  "sticky.html",
  "quick.html",
  "shot.html",
  "meeting.html",
  "briefing.html",
];

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

/* Nazwa składana w kodzie (`href="#${act.icon}"`) nie jest nazwą symbolu
   i nie da się jej sprawdzić czytaniem tekstu. Pilnuje jej za to sprawdzenie
   niżej: te ikony pochodzą ze spisu, a spis porównujemy z listą czynności. */
const literal = (name) => !name.includes("${");

/**
 * Symbole, które kod DOKŁADA w locie.
 *
 * Pasek czynności pod notatką stoi w trzech oknach o trzech różnych
 * szkieletach, a jego ikon nie ma w żadnym z nich — wstrzykuje je
 * `ensureIcons` z js/notes-core.js przy montażu. Z punktu widzenia tego
 * testu są zdefiniowane wszędzie tam, gdzie okno wczytuje ten plik; gdyby
 * nie były, przycisk byłby pusty i nikt by tego nie zgłosił.
 */
const CORE = read("js/notes-core.js");
const INJECTED = [...CORE.matchAll(/^\s{4}"([\w-]+)":$/gm)].map((match) => match[1]);
assert.ok(INJECTED.length >= 5, "nie znalazłem spisu ikon w js/notes-core.js — zmieniła się jego postać");

function scriptsOf(page) {
  return [...read(page).matchAll(/<script src="([^"]+)"/g)]
    .map(([, src]) => path.join(RENDERER, src))
    .filter((file) => fs.existsSync(file));
}

function drawnBy(page) {
  const source = read(page);
  const names = [...source.matchAll(REF)].map((match) => match[1]);
  for (const file of scriptsOf(page)) {
    names.push(...[...fs.readFileSync(file, "utf8").matchAll(REF)].map((match) => match[1]));
  }
  return new Set(names.filter(literal));
}

for (const page of PAGES) {
  const source = read(page);
  const defined = new Set([...source.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]));
  // Okno, które wczytuje notes-core.js, dostaje jego ikony w locie.
  if (scriptsOf(page).some((file) => file.endsWith("notes-core.js"))) {
    for (const name of INJECTED) defined.add(name);
  }
  const used = drawnBy(page);

  for (const name of used) {
    assert.ok(defined.has(name), `${page}: rysuje „#${name}", a takiego symbolu w tym oknie nie ma`);
  }
}
ok("Każde odwołanie trafia w symbol z tego samego okna");

/* ── Pasek czynności: każda czynność ma swój rysunek ──────────────
   Ikony paska są składane z nazwy (`href="#${act.icon}"`), więc powyższe
   sprawdzenie ich nie widzi. Literówka w nazwie zostawiłaby pusty przycisk,
   który dalej działa — czyli dokładnie ten rodzaj usterki, dla którego ten
   plik powstał. Pytamy więc wprost: czy każda czynność wskazuje ikonę,
   którą ensureIcons naprawdę dokłada. */
{
  const icons = [...CORE.matchAll(/\bicon:\s*"([\w-]+)"/g)].map((match) => match[1]);
  assert.ok(icons.length >= 5, "spis czynności w js/notes-core.js zmienił postać");
  for (const icon of icons) {
    assert.ok(
      INJECTED.includes(icon),
      `pasek czynności rysuje „#${icon}", a ensureIcons takiej ikony nie dokłada`,
    );
  }
  ok("Każda czynność w pasku ma rysunek, który naprawdę powstaje");
}

/* ── 3. Górny pasek pisze, dolny decyduje ────────────────────────
   Podział, który powstał po tym, jak wszystko stało w jednym rzędzie:
   pogrubienie obok kasowania, przypinanie obok kursywy. Dwie różne rzeczy
   wyglądały tam na jedną — a przy „Usuń" pomyłka kosztuje notatkę.

   GÓRA to narzędzia PISANIA. Sięga się po nie w trakcie pisania, dziesiątki
   razy. DÓŁ to czynności NA CAŁEJ NOTATCE: przypnij, na pulpit, przesiej,
   udostępnij, usuń. Robi się je raz, kiedy notatka jest już napisana. */

const notes = read("notes.html");
const tools = notes.slice(
  notes.indexOf('<div class="editor__tools">'),
  notes.indexOf("</header>", notes.indexOf('<div class="editor__tools">')),
);

assert.equal(
  (tools.match(/class="editor__sep"/g) ?? []).length,
  2,
  "górny pasek ma dwie kreski: za dyktowaniem i za narzędziami pisania",
);
ok("Górny pasek jest rozdzielony na grupy dwiema kreskami");

/* Czynności na całej notatce NIE MAJĄ prawa stać w górnym pasku. Kasowanie
   sąsiadujące z kursywą było jedną pomyłką od skasowania notatki, którą
   chciało się tylko pochylić. */
for (const [id, co] of [
  ["del", "kosz"],
  ["pin", "pinezka"],
  ["widgetPin", "kartka na pulpicie"],
  ["share", "udostępnianie"],
  ["siftNote", "sito"],
]) {
  assert.ok(
    !new RegExp(`id="${id}"`).test(tools),
    `${co} nie ma czego szukać w górnym pasku — czynności na notatce stoją na dole`,
  );
}
ok("W górnym pasku nie ma żadnej czynności na całej notatce");

/* Pasek czynności stoi w KAŻDYM oknie, które pokazuje notatkę. Notatka jest
   jedna; okno, w którym nie da się jej przypiąć ani skasować, byłoby oknem
   z inną notatką. */
for (const page of ["notes.html", "sticky.html"]) {
  assert.ok(
    /id="acts"/.test(read(page)),
    `${page}: nie ma miejsca na pasek czynności pod notatką`,
  );
}
{
  const core = read("js/notes-core.js");
  const ids = [...core.matchAll(/\{ id: "([\w-]+)", icon:/g)].map((match) => match[1]);
  assert.deepEqual(
    ids,
    ["pin", "desktop", "sift", "share", "delete"],
    "pasek czynności ma pięć przycisków w tej kolejności — usuwanie jako ostatnie",
  );
  assert.ok(
    /id: "delete"[^}]*danger: true/.test(core),
    "kasowanie ma być oznaczone jako czynność nieodwracalna (danger)",
  );
}
ok("Każde okno z notatką ma ten sam pasek czynności, z koszem na końcu");

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

/* ── 6. Pasek spotkania ───────────────────────────────────────────
   Trzy rzeczy, które w nim łatwo popsuć po cichu — i wszystkie trzy widać
   w samym tekście widoku, bez przeglądarki. */

const meet = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "js", "meetings-view.js"), "utf8");

/* Zakładka „Rozmowa" pokazywała te same zdania trzeci raz, obok zapisu
   i obok wniosku. Wróciłaby najłatwiej przez skopiowanie sąsiedniego
   wiersza — dlatego pytamy o nią wprost. */
assert.ok(!/tab\("talk"/.test(meet), `zakładki „Rozmowa" w pasku spotkania nie ma`);
assert.ok(!/state\.tab === "talk"/.test(meet), `po zakładce „Rozmowa" nie została gałąź treści`);
ok(`Spotkanie ma trzy zakładki — bez „Rozmowy"`);

/* Kasowanie jest jedyną rzeczą w tym module, której nie da się cofnąć.
   Napis „Usuń" stał w rzędzie nazw zakładek i czytało się go jako czwartą
   z nich; kosz nie udaje zakładki. */
assert.ok(
  /data-meet-remove="\$\{meeting\.id\}"[\s\S]{0,160}#i-trash/.test(meet),
  "kasowanie spotkania jest koszem, nie napisem",
);
assert.ok(
  /meet__ico--danger/.test(meet),
  "kosz ma własną, czerwoną odmianę — inaczej wygląda jak każda inna ikona",
);
ok("Kasowanie spotkania to czerwony kosz, a nie napis w rzędzie zakładek");

/* Osobne okno spotkania. W samym oknie spotkania tego przycisku być nie
   może: otwierałby to, w czym się właśnie stoi. */
assert.ok(/data-meet-open=/.test(meet), "spotkanie da się otworzyć w osobnym oknie");
assert.ok(
  /state\.solo\s*\n?\s*\?\s*""/.test(meet),
  `w oknie jednego spotkania przycisku „Pokaż w osobnym oknie" nie ma`,
);
ok("Spotkanie otwiera się w osobnym oknie — i tylko z okna głównego");

console.log(
  `\nPaski i przewodnik: ${PAGES.length} szablonów i ${used.length} slajdów sprawdzonych.`,
);
