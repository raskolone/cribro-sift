"use strict";
/**
 * Podsumowanie spotkania — polecenie dla modelu i czytanie odpowiedzi.
 *   node scripts/digest-test.js
 *
 * Sieci tu nie ma i nie powinno być: sprawdzamy to, co ROZSTRZYGAMY sami,
 * czyli co model dostaje i co z jego odpowiedzi bierzemy. Jakość samego
 * podsumowania nie jest rzeczą, którą da się sprawdzić asercją.
 *
 * Najważniejszy przypadek jest przewrotny: własne wytyczne NIE MOGĄ
 * skasować zakazów. Wytyczne pisze człowiek i pisze je o układzie tekstu;
 * zakaz zmyślania ustaleń nie jest kwestią układu.
 */
const assert = require("assert");
const { digest, buildPrompt, readAnswer, transcriptText, material, TEMPLATES } =
  require("../src/main/digest");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

const rozmowa = {
  transcript: [
    { speaker: "Rozmówcy", lane: "system", at: 0, text: "Czy zdążymy z raportem przed poniedziałkiem?" },
    { speaker: "Ty", lane: "mic", at: 14, text: "Dam radę, ale potrzebuję danych z wtorku." },
    { speaker: "Rozmówcy", lane: "system", at: 41, text: "Wyślę je dziś wieczorem." },
  ],
  notes: "Ania przysyła dane do czwartku.",
};

/* ── Zapis jako tekst ───────────────────────────────────────── */

const talk = transcriptText(rozmowa.transcript);
check("Każda wypowiedź dostaje znacznik czasu", talk.split("\n").every((row) => /^\[\d+:\d\d\]/.test(row)));
check("…i podpis mówiącego", talk.includes("] Ty: Dam radę"));
check("Puste wypowiedzi nie tworzą pustych wierszy",
  transcriptText([{ speaker: "Ty", at: 0, text: "   " }]) === "");

/* Zapis dłuższy niż limit ucinamy od POCZĄTKU. Ustalenia zapadają na
   końcu rozmowy — to ich nie wolno zgubić. */
const długa = Array.from({ length: 200 }, (_, at) => ({
  speaker: at % 2 ? "Ty" : "Rozmówcy",
  at: at * 30,
  text: `Zdanie numer ${at} o czymś tam.`,
}));
const ucięta = transcriptText(długa, { cap: 400 });
check("Za długi zapis mieści się w limicie", ucięta.length <= 460);
check("…i zostaje z niego KONIEC, nie początek", ucięta.includes("numer 199") && !ucięta.includes("numer 0."));

/* ── Materiał ───────────────────────────────────────────────── */

const dane = material(rozmowa);
check("Notatki stoją PRZED zapisem — są ważniejsze", dane.indexOf("NOTATKI") < dane.indexOf("ZAPIS"));
check("Zapis jedzie w całości", dane.includes("Wyślę je dziś wieczorem"));
check("Spotkanie bez notatek nie dostaje pustego nagłówka",
  !material({ transcript: rozmowa.transcript }).includes("NOTATKI"));
check("Pusty zapis jest nazwany wprost, a nie przemilczany",
  material({ notes: "coś" }).includes("(pusty)"));

/* ── Polecenie ──────────────────────────────────────────────── */

const gotowe = buildPrompt(rozmowa, { template: "generic" });
check("Gotowy szablon niesie swój układ", gotowe.system.includes("**Ustalenia**"));
check("…i każe pominąć sekcję bez treści", gotowe.system.includes("POMIJASZ W CAŁOŚCI"));

const własne = buildPrompt(rozmowa, {
  template: "custom",
  instructions: "Same zadania, w punktach, po angielsku.",
});
check("Własne wytyczne trafiają do polecenia", własne.system.includes("Same zadania, w punktach"));
check("…i zastępują układ gotowego szablonu", !własne.system.includes("**Otwarte**"));
check("…ale NIE kasują zakazów", własne.system.includes("Nie dopisujesz ustaleń"));
check("…ani formatu odpowiedzi z tytułem", własne.system.includes("TYTUŁ:"));
check("Wybrany szablon wraca w wyniku", własne.template === "custom");

/* Puste własne wytyczne to nie „bez wytycznych" — bo wynikiem byłby
   zlepek zdań bez żadnego układu. */
const puste = buildPrompt(rozmowa, { template: "custom", instructions: "   " });
check("Puste własne wytyczne wracają do gotowego szablonu", puste.template === "generic");
check("…i mają jego układ", puste.system.includes("**Ustalenia**"));

/* ── Odpowiedź ──────────────────────────────────────────────── */

check("Tytuł wychodzi z pierwszej linii", readAnswer("TYTUŁ: Plan na kwartał\n\nTreść.").title === "Plan na kwartał");
check("…a treść zostaje bez niego", readAnswer("TYTUŁ: Plan\n\nTreść.").summary === "Treść.");
check("Gwiazdki i cudzysłowy wokół tytułu odpadają",
  readAnswer('TYTUŁ: **„Plan na kwartał"**\n\nTreść.').title === "Plan na kwartał");
check("TITLE po angielsku też się liczy", readAnswer("TITLE: Weekly review\n\nText.").title === "Weekly review");
/* Tytułu nie wymuszamy: pierwsza linia treści awansowana na nazwę byłaby
   gorsza niż brak nazwy. */
check("Odpowiedź bez tytułu zostaje samą treścią", readAnswer("Po prostu treść.").title === null);
check("…i nie gubi pierwszej linii", readAnswer("Po prostu treść.").summary === "Po prostu treść.");
check("Pusta odpowiedź nie wymyśla tytułu", readAnswer("").title === null);

/* ── Przebieg ───────────────────────────────────────────────── */

(async () => {
  const ustawienia = {
    stt: { provider: "gemini", apiKey: "" },
    sieve: { provider: "openai", model: "gpt-x", apiKey: "sk-test" },
    meetings: { template: "generic" },
  };

  let widziane = null;
  const wynik = await digest(rozmowa, ustawienia, {
    ask: async (call) => {
      widziane = call;
      return "TYTUŁ: Raport przed poniedziałkiem\n\n**O czym było**\nTermin raportu.";
    },
  });
  check("Podsumowanie wraca z tytułem", wynik.title === "Raport przed poniedziałkiem");
  check("…i z treścią", wynik.summary.startsWith("**O czym było**"));
  check("Dostawca jest ten sam, co przy sicie", widziane.provider === "openai" && widziane.model === "gpt-x");
  check("Model dostaje i notatki, i zapis",
    widziane.user.includes("Ania przysyła dane") && widziane.user.includes("Wyślę je dziś"));

  /* Spotkanie bez treści: mówimy o tym wprost, zamiast wołać model
     i płacić za odpowiedź na puste pytanie. */
  let wołano = false;
  await digest({ transcript: [], notes: "" }, ustawienia, { ask: async () => (wołano = true) })
    .then(() => check("Puste spotkanie NIE idzie do modelu", false))
    .catch((problem) => {
      check("Puste spotkanie nie idzie do modelu", wołano === false);
      check("…i mówi, czego brakuje", problem.message.includes("zapis rozmowy jest pusty"));
    });

  // Brak klucza to nie awaria sieci, tylko brakująca konfiguracja.
  await digest(rozmowa, { stt: { provider: "gemini", apiKey: "" }, sieve: { provider: "openai", model: "gpt-x" }, meetings: {} }, { ask: async () => "x" })
    .then(() => check("Brak klucza jest zgłaszany", false))
    .catch((problem) => check("Brak klucza jest zgłaszany po ludzku", problem.message.includes("Brak klucza API")));

  check("Szablony mają nazwę i podpowiedź", !!TEMPLATES.generic.name && !!TEMPLATES.generic.hint);

  console.log(`\n${passed} sprawdzeń przeszło.`);
})();
