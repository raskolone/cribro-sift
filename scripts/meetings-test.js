"use strict";
/**
 * Zakładka Spotkania i przegródka „Notatki ze spotkań".
 *   node scripts/meetings-test.js
 *
 * Cztery rozstrzygnięcia, każde z innego miejsca, ale wszystkie o tym
 * samym: gdzie ma trafić wzrok, gdy rozmowa się nagrywa i gdy się skończy.
 *
 *   1. Ustawienia spotkań leżą pod kołem zębatym, a nie rozwinięte pod
 *      spisem. Dotyka się ich raz, a spisu codziennie.
 *   2. W trakcie nagrywania domyślna jest TRANSKRYPCJA — jedyna rzecz,
 *      która wtedy rośnie. Po zakończeniu wraca podsumowanie.
 *   3. Notatka ze spotkania ma w Notatniku własną przegródkę, bo powstaje
 *      sama i wrzucona między napisane ręką spychałaby je z ekranu.
 *   4. Nazwa rozmowy przepisana z okna Google Meet jest nazwą, a nie
 *      brakiem nazwy — i podsumowanie już jej nie zmienia.
 *
 * Bez Electrona: notes-core.js dotyka tylko `window`, `t` i `uiLocale`,
 * więc daje się uruchomić w piaskownicy; reszta to czytanie kodu widoku
 * i procesu głównego.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = (...bits) => fs.readFileSync(path.join(root, ...bits), "utf8");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Piaskownica dla notes-core.js ────────────────────────────── */

const sandbox = { window: {}, t: (text) => text, uiLocale: () => "pl-PL" };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("src", "renderer", "js", "notes-core.js"), sandbox);
const { groupNotes, isMeeting } = sandbox.window.NotesCore;

const note = (patch) => ({
  id: Math.random().toString(36).slice(2),
  text: "Treść",
  updatedAt: new Date(Date.now() - Math.random() * 1000).toISOString(),
  pinned: false,
  ...patch,
});

/* ── 1. Przegródka „Notatki ze spotkań" ───────────────────────── */

check("Notatka ze spotkania poznaje się po rodzaju",
  isMeeting({ kind: "meeting" }) && !isMeeting({ kind: "quick" }) && !isMeeting({}));

const mieszane = [
  note({ kind: "meeting", text: "Budżet · Ania" }),
  note({ kind: "quick", text: "Oddzwonić" }),
  note({ text: "Zwykła notatka" }),
];
const { groups, divided } = groupNotes(mieszane);
const klucze = groups.map((g) => g.key);

check("Trzy rodzaje notatek dają trzy przegródki", divided && klucze.length === 3);
check("Spotkania stoją wyżej niż szybkie notatki i niż reszta",
  klucze.join(",") === "meeting,quick,note");
check("Przegródka nazywa się „Notatki ze spotkań”",
  groups[0].label === "Notatki ze spotkań" && groups[0].items.length === 1);
check("Zwykła notatka nie wpada do spotkań ani do szybkich",
  groups[2].items.length === 1 && groups[2].items[0].text === "Zwykła notatka");

const zPrzypiętą = groupNotes([
  note({ kind: "meeting", text: "Przypięte spotkanie", pinned: true }),
  note({ kind: "meeting", text: "Zwykłe spotkanie" }),
]);
check("Przypięcie bije rodzaj: przypięta notatka ze spotkania idzie na samą górę",
  zPrzypiętą.groups[0].key === "pinned" &&
    zPrzypiętą.groups[0].items[0].text === "Przypięte spotkanie" &&
    zPrzypiętą.groups[1].key === "meeting");

check("Same spotkania to jeszcze nie powód do dzielenia listy nagłówkiem",
  groupNotes([note({ kind: "meeting" }), note({ kind: "meeting" })]).divided === false);

/* ── 2. Koło zębate i domyślna zakładka ───────────────────────── */

const widok = read("src", "renderer", "js", "meetings-view.js");

check("Przy „Nagraj spotkanie” stoi koło zębate",
  /data-meet-cog/.test(widok) && /<use href="#i-gear"/.test(widok));
check("Koło zębate mówi, dokąd prowadzi",
  /title="\$\{t\("Jak działają spotkania"\)\}"/.test(widok));
check("Ustawienia rysują się dopiero po otwarciu szuflady",
  /\$\{state\.settingsOpen \? settingsCard\(\) : ""\}/.test(widok));
check("Wybór szuflady zostaje między uruchomieniami",
  /localStorage\.setItem\("cribro:meet-settings"/.test(widok));
check("Nagłówek „Jak działają spotkania” został tam, gdzie był — w środku",
  /<h3>\$\{t\("Jak działają spotkania"\)\}<\/h3>/.test(widok));

check("W trakcie nagrywania domyślna jest transkrypcja, a nie tylko na starcie",
  /if \(!state\.tabByHand\) state\.tab = "transcript";/.test(widok));
check("Ręka ma pierwszeństwo: wybrana zakładka zostaje do końca rozmowy",
  /state\.tabByHand = true;/.test(widok));
check("Nowe nagranie zaczyna liczenie od nowa",
  /if \(started\) state\.tabByHand = false;/.test(widok));
check("Koniec rozmowy oddaje ekran podsumowaniu",
  /if \(ended && !state\.tabByHand\) state\.tab = "summary";/.test(widok));

check("Przycisk prowadzi do notatki, zamiast robić ją drugi raz",
  /data-meet-note="\$\{meeting\.id\}">\$\{t\("Pokaż notatkę"\)\}/.test(widok));

/* ── 3. Nazwa z okna Google Meet ──────────────────────────────── */

const { spot } = require("../src/main/detect");

check("Karta Meet z nazwą pokoju oddaje tę nazwę",
  spot(["Meet – Przegląd tygodnia — Google Chrome"])?.title === "Przegląd tygodnia");
check("Kod pokoju nazwą nie jest",
  spot(["Meet – jrx-kfoz-hys"])?.title === null);
check("Strona startowa Meet to nie rozmowa", spot(["Google Meet"]) === null);

const main = read("src", "main", "main.js");
check("Nazwa z okna rozmowy bije nazwę z kalendarza",
  /const fromRoom = spot\?\.title \?\? null;[\s\S]{0,200}title: fromRoom \?\? live\?\.title \?\? null,/.test(main));
check("Nagranie włączone ręką najpierw pyta ekran o nazwę",
  /await meetings\.start\(about \?\? aboutMeeting\(await roomOnScreen\(\)\)\)/.test(main));
check("Podsumowanie nie przemianowuje rozmowy, która ma już nazwę z pokoju",
  /const named = meeting\.titleByHand \|\| meeting\.titleFrom === "room";/.test(main));
check("Skąd wzięła się nazwa, wie wpis spotkania",
  /titleFrom: fromRoom \? "room" : live\?\.title \? "calendar" : null,/.test(main));

/* ── 4. Notatka powstaje sama ─────────────────────────────────── */

check("Notatka zakłada się po zakończeniu nagrania",
  /keepMeetingNote\(meeting\.id\);/.test(main));
check("…i przyjmuje podsumowanie, gdy to dojdzie",
  /keepMeetingNote\(id\);\n    return patch;/.test(main));
check("Notatka wie, kim jest właściciel konta — to część jej nazwy",
  /keepNote\(store, id, \{\n\s*me: whoAmI\(\),/.test(main));
check("Założenie i odświeżenie melduje się osobno",
  /if \(action === "created"\) broadcast\("note:new", note\);/.test(main) &&
    /else if \(action === "updated"\) broadcast\("note:changed", note\);/.test(main));

/* Same rozstrzygnięcia — czego nie wskrzeszać, czego nie nadpisywać —
   sprawdza scripts/meetnote-live-test.js na prawdziwym sklepie. Tutaj
   pilnujemy tylko tego, że są w jednym miejscu i że nie znają Electrona. */
const reguły = read("src", "main", "meetnote.js");
check("Rozstrzygnięcia leżą osobno i nie znają Electrona",
  !/require\("electron"\)/.test(reguły) && /function keepNote\(store, id/.test(reguły));
check("Notatka niesie CAŁY zapis rozmowy — dlatego wolno skasować nagranie",
  /asNote\(meeting, \{ transcript: true, me \}\)/.test(reguły));
check("Rodzaj „meeting” trafia do notatki — po nim poznaje ją przegródka",
  /kind: "meeting",/.test(reguły));

console.log(`\nSpotkania: ${passed} sprawdzeń przeszło. Ustawienia pod kołem, zapis na wierzchu, notatka sama.`);
