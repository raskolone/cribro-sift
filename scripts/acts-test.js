"use strict";
/**
 * Pasek czynności pod notatką — jego treść i skutki.
 *   node scripts/acts-test.js
 *
 * Pasek jest jeden, a stoi w trzech oknach (zakładka Notatki, osobny
 * Notatnik, kartka na pulpicie). Buduje go js/notes-core.js, więc tam da
 * się go sprawdzić bez przeglądarki: wchodzi notatka, wychodzi HTML
 * i wywołania do procesu głównego.
 *
 * Najważniejsze są tu trzy rzeczy, bo każda z nich psuje się po cichu:
 *
 *   1. „Usuń" ma NAPRAWDĘ kasować, a „Przypnij" NAPRAWDĘ przestawiać
 *      flagę — a nie robić czegoś podobnego.
 *   2. Napis na przycisku ma mówić, co się stanie po naciśnięciu.
 *      Notatka leżąca na pulpicie potrzebuje „Zdejmij z pulpitu",
 *      a nie drugi raz „Na pulpit".
 *   3. Znak specjalny ma wyjść z menu taki, jaki tam stoi. Znak ucieka
 *      przez `escape` do HTML-a i wraca do notatki — po drodze łatwo
 *      o „&amp;" zamiast „&".
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? `\n  ${detail}` : ""}`);
  console.log("✓", label);
  passed += 1;
};

/* ── Atrapa okna ──────────────────────────────────────────────────
   notes-core.js jest zwykłym skryptem przeglądarki: wisi na `window`
   i woła `t`. Podstawiamy jedno i drugie, a `document` tylko w tym
   zakresie, w jakim naprawdę go dotyka. */
const nodes = new Map();
global.window = {};
global.t = (text, vars) =>
  String(text).replace(/\{(\w+)\}/g, (_all, key) => String(vars?.[key] ?? ""));
/* Kosze w pasku czynności: to ich szuka `askDelete`, żeby wiedzieć, przy
   którym postawić pytanie. Pusta lista znaczy „w tym oknie nie ma paska" —
   i wtedy kasowanie ma iść bez pytania (patrz askDelete w notes-core.js). */
let slots = [];
global.document = {
  getElementById: (id) => nodes.get(id) ?? null,
  createElementNS: () => ({ setAttribute() {}, style: {}, set innerHTML(_v) {} }),
  querySelectorAll: () => slots,
  createElement: () => ({
    className: "",
    setAttribute() {},
    set innerHTML(_v) {},
    addEventListener() {},
    remove() {},
    contains: () => true,
    querySelector: () => ({ focus() {} }),
  }),
  addEventListener() {},
  removeEventListener() {},
  body: { appendChild() {} },
};
global.setTimeout = setTimeout;

require(path.join(__dirname, "..", "src", "renderer", "js", "notes-core.js"));
const { actionBar, paintActions, runAction, runShare, specialsMenu, ACTIONS, SPECIALS } =
  window.NotesCore;

/* ── 1. Co pasek rysuje ── */

const bar = actionBar();
for (const act of ACTIONS) {
  check(`Pasek ma przycisk „${act.label}"`, bar.includes(`data-act="${act.id}"`));
}
check("Każdy przycisk niesie podpis, nie samą ikonę", (bar.match(/<span>/g) ?? []).length === ACTIONS.length);
check("Kasowanie jest oznaczone jako nieodwracalne", bar.includes("note-act--danger"));
check(
  "Każdy przycisk niesie dymek dla wąskiej stopki",
  ACTIONS.every((act) => bar.includes(`data-tip="${act.label}"`)),
);
check(
  "…i etykietę dla czytnika ekranu",
  ACTIONS.every((act) => bar.includes(`aria-label="${act.label}"`)),
);
check("Systemowy dymek nie jest już rysowany", !bar.includes("title="));
check("Udostępnianie ma własne menu", bar.includes('data-acts-menu="share"'));
check(
  "…a w nim wszystkie drogi wyjścia",
  ["apple", "notion", "text", "md", "pdf", "file"].every((where) =>
    bar.includes(`data-share="${where}"`),
  ),
);

const trimmed = actionBar({ skip: ["desktop"] });
check(
  "Kartka na pulpicie nie dostaje przycisku „Na pulpit”",
  !trimmed.includes('data-act="desktop"') && trimmed.includes('data-act="pin"'),
);

/* ── 2. Napis mówi, co się stanie ── */

function fakeBar() {
  const buttons = new Map();
  for (const act of ACTIONS) {
    buttons.set(act.id, {
      dataset: { labelOn: act.on, labelOff: act.label },
      title: "",
      attrs: {},
      span: { textContent: "" },
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      querySelector() {
        return this.span;
      },
    });
  }
  return {
    buttons,
    querySelector: (selector) => {
      const hit = /\[data-act="([\w-]+)"\]/.exec(selector);
      return hit ? (buttons.get(hit[1]) ?? null) : null;
    },
  };
}

{
  const root = fakeBar();
  paintActions(root, { pinned: false, widget: false });
  check("Notatka nieprzypięta: przycisk mówi „Przypnij”", root.buttons.get("pin").span.textContent === "Przypnij");
  check("…i nie jest wciśnięty", root.buttons.get("pin").attrs["aria-pressed"] === "false");

  paintActions(root, { pinned: true, widget: true });
  check("Przypięta: ten sam przycisk mówi „Odepnij”", root.buttons.get("pin").span.textContent === "Odepnij");
  check("…i jest wciśnięty", root.buttons.get("pin").attrs["aria-pressed"] === "true");
  check(
    "Leżąca na pulpicie mówi „Z pulpitu”",
    root.buttons.get("desktop").span.textContent === "Z pulpitu",
  );
  /* Dymek nie jest już systemowym `title`, tylko `data-tip` (rysuje go
     .note-act::after w css/note-acts.css — systemowy budził się po sekundzie
     i wyglądał jak wklejka z innego programu). Sprawdzamy więc oba napisy,
     które ma dziś przycisk: ten dla oka i ten dla czytnika ekranu. */
  check(
    "Dymek zgadza się z napisem — inaczej mówiłyby co innego",
    root.buttons.get("desktop").dataset.tip === "Z pulpitu",
  );
  check(
    "…i czytnik ekranu słyszy to samo",
    root.buttons.get("desktop").attrs["aria-label"] === "Z pulpitu",
  );
  check(
    "Systemowego dymka już nie ma — dwa dymki naraz to jeden za dużo",
    !root.buttons.get("desktop").title,
  );
  check(
    "Przycisk bez stanu („Przesiej”) nie udaje wciśniętego",
    root.buttons.get("sift").attrs["aria-pressed"] === "false",
  );
}

/* ── 3. Co czynność naprawdę robi ── */

function fakeApi() {
  const calls = [];
  return {
    calls,
    notes: {
      update: async (id, patch) => calls.push(["update", id, patch]),
      remove: async (id) => calls.push(["remove", id]),
      sift: async (id) => (calls.push(["sift", id]), { text: "przesiane" }),
      toAppleNotes: async (id) => calls.push(["apple", id]),
      toNotion: async (id) => (calls.push(["notion", id]), { updated: true }),
      markdown: async (id) => (calls.push(["markdown", id]), "# md"),
      pdf: async (id) => (calls.push(["pdf", id]), { canceled: false }),
      export: async (id) => (calls.push(["export", id]), { canceled: true }),
    },
    system: { copy: async (text) => calls.push(["copy", text]) },
  };
}

{
  const api = fakeApi();
  const note = { id: "n1", pinned: false, widget: false, text: "treść" };
  const said = [];
  const say = (text) => said.push(text);

  (async () => {
    let gone = await runAction("pin", note, { api, say });
    check("„Przypnij” przestawia flagę w notatce", note.pinned === true);
    check("…i mówi o tym procesowi głównemu", api.calls.some(([what, , patch]) => what === "update" && patch.pinned === true));
    check("…i nie kasuje niczego", gone === false);

    gone = await runAction("desktop", note, { api, say });
    check("„Na pulpit” ustawia widget", note.widget === true);

    gone = await runAction("sift", note, { api, say });
    check("„Przesiej” bierze wynik do notatki", note.text === "przesiane");
    check("…i melduje, że pracuje", said.includes("Przesiewam notatkę…"));

    /* ── KASOWANIE PYTA, ZANIM SKASUJE ──

       Samo okienko z pytaniem siedzi w js/ask.js i ma własne życie
       w przeglądarce; tutaj podstawiamy je atrapą i sprawdzamy to, co
       naprawdę należy do paska: czy odpowiedź człowieka rozstrzyga o tym,
       czy notatka ginie.

       Brak paska w oknie (skrót klawiszowy, menu) znaczy, że nie ma gdzie
       postawić pytania — i wtedy kasujemy, bo milcząca odmowa wyglądałaby
       jak zepsuty przycisk. */
    slots = [];
    window.CribroAsk = undefined;
    gone = await runAction("delete", note, { api, say });
    check("„Usuń” naprawdę kasuje", api.calls.some(([what, id]) => what === "remove" && id === "n1"));
    check("…i mówi o tym wprost, żeby okno mogło się zamknąć", gone === true);

    /* Z paskiem pytanie staje pod koszem i czeka na odpowiedź. */
    const asked = [];
    /* `askDelete` pyta dziś wprost o PRZYCISKI w slotach paska
       ('.note-acts__slot [data-act="delete"]') i odsiewa je po
       `offsetParent`, czyli po tym, czy są widoczne. Atrapa oddaje więc
       przycisk, a nie slot. */
    slots = [{ offsetParent: {} }];
    const answerWith = (answer) => {
      window.CribroAsk = {
        danger(options) {
          asked.push(options);
          return Promise.resolve(answer);
        },
      };
    };

    const before = api.calls.length;
    answerWith(false);
    gone = await runAction("delete", note, { api, say });
    check("„Zostaw” zostawia notatkę w spokoju", api.calls.length === before);
    check("…i mówi oknu, że nic nie zniknęło", gone === false);
    check(
      "Pytanie mówi wprost, że nie da się tego cofnąć",
      /nie da się jej przywrócić/.test(asked[0]?.body ?? ""),
    );
    check("…i stoi przy koszu, a nie na środku ekranu", !!asked[0]?.anchor);

    answerWith(true);
    gone = await runAction("delete", note, { api, say });
    check("„Skasuj” dopiero teraz kasuje", api.calls.length === before + 1);
    check("…i dopiero teraz okno może się zamknąć", gone === true);

    window.CribroAsk = undefined;
    slots = [];
    gone = await runAction("delete", note, { api, say });
    check("„Usuń” naprawdę kasuje", api.calls.some(([what, id]) => what === "remove" && id === "n1"));
    check("…i mówi o tym wprost, żeby okno mogło się zamknąć", gone === true);


    /* ── 4. Wysyłka ── */
    const out = fakeApi();
    const spoken = [];
    await runShare("md", note, { api: out, say: (text) => spoken.push(text) });
    check("„Kopiuj jako Markdown” kopiuje Markdown, nie surowy tekst", out.calls.some(([what, text]) => what === "copy" && text === "# md"));

    await runShare("notion", note, { api: out, say: (text) => spoken.push(text) });
    check("Wysyłka do Notion melduje dwa razy: że idzie i że doszła", spoken.filter((line) => /Notion/.test(line)).length === 2);
    check("…i rozróżnia nową stronę od zaktualizowanej", spoken.includes("Zaktualizowane w Notion"));

    await runShare("file", note, { api: out, say: (text) => spoken.push(text) });
    check("Anulowany zapis do pliku niczego nie melduje", !spoken.includes("Zapisane do pliku"));

    /* ── 5. Znaki specjalne ── */
    const menu = specialsMenu();
    const all = SPECIALS.flatMap(([, chars]) => chars);
    check(`Menu ma wszystkie ${all.length} znaków`, (menu.match(/data-char=/g) ?? []).length === all.length);
    check("Myślnik jest w menu — najczęściej szukany znak w polskim zdaniu", menu.includes('data-char="—"'));
    check("Polski cudzysłów otwierający też", menu.includes('data-char="„"'));
    check(
      "Same znaki nie idą do tłumaczenia — tylko nazwy grup",
      /class="chars__row" data-i18n="skip"/.test(menu) && menu.includes("<b>Interpunkcja</b>"),
    );
    /* Znak wraca do notatki przez `data-char`, więc musi przetrwać ucieczkę
       do HTML-a i z powrotem. „&" i „<" nie ma w spisie, ale ta droga ma
       działać także wtedy, gdy ktoś je dopisze. */
    check(
      "Żaden znak nie zgubił się po drodze przez HTML",
      all.every((ch) => menu.includes(`data-char="${ch.replace(/&/g, "&amp;").replace(/</g, "&lt;")}"`)),
    );

    console.log(`\nPasek czynności: ${passed} sprawdzeń przeszło. Jeden pasek, trzy okna, te same skutki.`);
  })().catch((problem) => {
    console.error(`\n✗ ${problem.message}`);
    process.exit(1);
  });
}
