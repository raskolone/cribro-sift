"use strict";
/**
 * Wykrywanie poleceń: co rusza, co nie rusza i co zostaje z wypowiedzi.
 *   node scripts/commands-test.js
 *
 * Rozpoznanie lokalne jest czystą funkcją — wchodzi napis, wychodzi decyzja
 * — więc daje się sprawdzić bez modelu, bez sieci i bez Electrona. I musi
 * być sprawdzone, bo to jedyne miejsce w aplikacji, w którym coś dzieje się
 * z tekstem BEZ pytania: fałszywe trafienie przerabia zwykłe zdanie na listę
 * zadań i wkleja je komuś w rozmowę.
 *
 * Połowa przypadków poniżej to celowo te, w których polecenie ma NIE ruszyć.
 */
const assert = require("assert");

const { detect, catalog, readMarker, DEFAULTS } = require("../src/main/commands");
const { buildSystemPrompt, sift } = require("../src/main/sieve");

const config = structuredClone(DEFAULTS);
const fire = (text) => detect(text, config);

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Trafienia ──────────────────────────────────────────────── */

let hit = fire("Zrób checklistę: mleko, chleb i masło");
check(
  "Wywołanie na początku rusza polecenie i znika z materiału",
  hit.command?.id === "c-checklist" && hit.body === "mleko, chleb i masło",
);

hit = fire("kup mleko, chleb i masło, zrób z tego checklistę");
check(
  "Wywołanie na końcu też rusza — tak się mówi równie często",
  hit.command?.id === "c-checklist" && hit.body === "kup mleko, chleb i masło",
);

hit = fire("MAKE A CHECKLIST: milk, bread");
check(
  "Wielkość liter nie ma znaczenia",
  hit.command?.id === "c-checklist" && hit.body === "milk, bread",
);

hit = fire("Zrób checklistę.\nMleko\nChleb");
check(
  "Złamanie wiersza jest granicą tak samo dobrą jak dwukropek",
  hit.command?.id === "c-checklist" && hit.body === "Mleko\nChleb",
);

hit = fire("Zrób   checklistę,   mleko i chleb");
check(
  "Fraza rozstrzelona spacjami i przecinkiem to nadal ta sama fraza",
  hit.command?.id === "c-checklist" && hit.body === "mleko i chleb",
);

/* ── Nietrafienia: cztery reguły przeciw fałszywym alarmom ──── */

hit = fire("Powiedziałem Ani, żeby zrobiła checklistę");
check(
  "Relacja z rozmowy nie jest poleceniem — inna forma czasownika nie trafia",
  hit.command === null && hit.body === "Powiedziałem Ani, żeby zrobiła checklistę",
);

hit = fire("Zrób checklistę");
check(
  "Polecenie bez materiału nie rusza: to zdanie do kogoś, nie komenda",
  hit.command === null,
);

hit = fire("Zrób punkty kontrolne na przeglądzie i wyślij je Ani");
check(
  "Wywołanie zrośnięte z resztą zdania nie rusza — „punkty\" to tu treść",
  hit.command === null,
);

/* Cena reguły granicy — i powód, dla którego warstwy są dwie. Wypowiedź bez
   żadnej interpunkcji nie trafia LOKALNIE; łapie ją dopiero sito, które
   dostaje zamkniętą listę wywołań i czyta zdanie ze zrozumieniem. */
hit = fire("zrób checklistę mleko chleb masło");
check(
  "Bez interpunkcji dopasowanie lokalne odpuszcza i zostawia rzecz situ",
  hit.command === null && hit.body === "zrób checklistę mleko chleb masło",
);

hit = fire("Cytuję: zrób checklistę: mleko i chleb");
check(
  "Furtka wyłącza wszystkie polecenia i sama znika z tekstu",
  hit.command === null && hit.bypassed === true && hit.body === "zrób checklistę: mleko i chleb",
);

/* ── Rozstrzyganie ──────────────────────────────────────────── */

const overlap = {
  ...config,
  items: [
    { id: "a", name: "Krótkie", enabled: true, where: "edge", triggers: ["zrób listę"], rules: "x" },
    { id: "b", name: "Długie", enabled: true, where: "edge", triggers: ["zrób listę zadań"], rules: "x" },
  ],
};
check(
  "Przy dwóch pasujących wywołaniach wygrywa dłuższe",
  detect("zrób listę zadań: raz, dwa", overlap).command?.id === "b",
);

check(
  "Wyłączone polecenie nie rusza",
  detect("Zrób checklistę: mleko", {
    ...config,
    items: config.items.map((item) => ({ ...item, enabled: false })),
  }).command === null,
);

check(
  "Wyłączone wykrywanie nie rusza niczego",
  detect("Zrób checklistę: mleko", { ...config, enabled: false }).command === null,
);

const startOnly = {
  ...config,
  items: [{ id: "s", name: "Tylko początek", enabled: true, where: "start", triggers: ["zrób punkty"], rules: "x" }],
};
check(
  "„Tylko na początku\" nie łapie frazy z końca wypowiedzi",
  detect("mleko i chleb, zrób punkty", startOnly).command === null &&
    detect("zrób punkty: mleko i chleb", startOnly).command?.id === "s",
);

/* ── Znacznik od sita (warstwa B) ───────────────────────────── */

let marker = readMarker("⟦polecenie: c-checklist⟧\n- [ ] Kupić mleko", config);
check(
  "Znacznik z pierwszej linii jest czytany i obcinany",
  marker.id === "c-checklist" && marker.text === "- [ ] Kupić mleko",
);

marker = readMarker("⟦polecenie: brak⟧\nZwykły tekst", config);
check(
  "Nieznany znacznik znika z tekstu, ale nie uruchamia niczego",
  marker.id === null && marker.text === "Zwykły tekst",
);

marker = readMarker("Zwykły tekst bez znacznika", config);
check(
  "Tekst bez znacznika zostaje nietknięty",
  marker.id === null && marker.text === "Zwykły tekst bez znacznika",
);

/* ── Prompt ─────────────────────────────────────────────────── */

const list = catalog(config);
check(
  "Katalog dla sita jest zamknięty i niesie identyfikatory oraz wywołania",
  list.includes("ZAMKNIĘTA LISTA") &&
    list.includes("[c-checklist]") &&
    list.includes("zrób checklistę"),
);
check("Wyłączone wykrywanie nie wysyła katalogu", catalog({ ...config, enabled: false }) === null);

const withCommand = buildSystemPrompt("srednie", [], "", null, config.items[2], config);
check(
  "Trafienie lokalne daje situ regułę polecenia zamiast katalogu",
  withCommand.includes("POLECENIE — MAIL") && !withCommand.includes("ZAMKNIĘTA LISTA"),
);
check(
  "Polecenie może narzucić własną gęstość, nie ruszając pokrętła w Sicie",
  withCommand.includes("DROBNE"),
);
check(
  "Zakaz odpowiadania obowiązuje także przy poleceniu",
  withCommand.includes("NIE ODPOWIADASZ"),
);

/* ── Migracja ustawień ──────────────────────────────────────── */

/* Zestaw startowy dokłada się PO ID, więc aktualizacja aplikacji nie może
   ani nadpisać polecenia przerobionego przez użytkownika, ani wskrzesić
   tego, które skasował. Bez zakładki removedBuiltins jedno i drugie działo
   się przy każdym starcie. */
{
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-commands-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      schema: 4,
      commands: {
        enabled: true,
        bypass: ["cytuję"],
        removedBuiltins: ["c-mail"],
        items: [
          { id: "c-checklist", name: "Moja checklista", enabled: true, where: "edge", triggers: ["zrób listę"], rules: "x" },
        ],
      },
    }),
  );

  const Module = require("module");
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return { app: { getPath: () => dir } };
    return load.call(this, request, ...rest);
  };
  const { Store } = require("../src/main/store");
  Module._load = load;

  const migrated = new Store().getSettings().commands;
  const ids = migrated.items.map((item) => item.id);

  check("Migracja nie tyka polecenia przerobionego przez użytkownika",
    migrated.items.find((item) => item.id === "c-checklist")?.name === "Moja checklista");
  check("Migracja dokłada wbudowane, których jeszcze nie ma", ids.includes("c-bullets"));
  check("Skasowane wbudowane nie wraca przy aktualizacji", !ids.includes("c-mail"));

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── Sito od końca do końca ─────────────────────────────────── */

let answer = "⟦polecenie: c-checklist⟧\n- [ ] Kupić mleko";
global.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: answer }] } }] }),
});

const settings = {
  mesh: "srednie",
  language: "auto",
  grains: [],
  commands: config,
  stt: { provider: "gemini", model: "gemini-3.7-flash", apiKey: "AIza-test" },
  sieve: { provider: "gemini", model: "gemini-3.7-flash", apiKey: "", customInstruction: "" },
};

(async () => {
  let out = await sift({ raw: "mleko i chleb", settings, detect: true });
  check(
    "Sito rozpoznało polecenie po swojej stronie: znacznik znika, tekst zostaje",
    out.command === "c-checklist" && out.commandBy === "sieve" && out.text === "- [ ] Kupić mleko",
  );

  answer = "Zwykłe zdanie po przesianiu.";
  out = await sift({ raw: "yyy zwykłe zdanie", settings, detect: true });
  check(
    "Bez znacznika nic nie ruszyło i tekst jest nietknięty",
    out.command === null && out.commandBy === null && out.text === "Zwykłe zdanie po przesianiu.",
  );

  answer = "- [ ] Kupić mleko";
  out = await sift({ raw: "mleko", settings, command: config.items[0], detect: false });
  check(
    "Trafienie lokalne jest rozstrzygnięte przed sitem i znacznika nie potrzebuje",
    out.command === "c-checklist" && out.commandBy === "exact",
  );

  console.log(`\nPolecenia: ${passed} sprawdzeń przeszło. Rozpoznanie trzyma się krawędzi wypowiedzi.`);
})().catch((error) => {
  console.error("✗", error.message);
  process.exit(1);
});
