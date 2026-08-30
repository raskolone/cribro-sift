"use strict";
/**
 * Notatka ze spotkania: jak się nazywa i co w niej stoi.
 *   node scripts/meetnote-test.js
 *
 * Notatka ze spotkania powstaje SAMA po każdej nagranej rozmowie i sama
 * musi się nazwać — nikt nie siada po godzinnej rozmowie do wymyślania
 * nagłówka. Nazwa jest przy tym jedyną rzeczą, po której się ją potem
 * znajdzie: w Notatniku leży obok trzydziestu innych i widać z niej
 * dokładnie jedną linijkę.
 *
 * Sieci tu nie ma. Model pisze nazwę SPOTKANIA (z treści rozmowy, patrz
 * scripts/digest-test.js); nazwę NOTATKI składamy sami, dokładając do niej
 * to, czego model nie wie na pewno: z kim ta rozmowa była. Ta druga połowa
 * liczy się lokalnie, z listy zaproszonych i z podpisów w zapisie —
 * i dokładnie ją sprawdza ten plik.
 */
const assert = require("assert");
const {
  noteTitle,
  withWhom,
  humanName,
  firstSentence,
  asNote,
} = require("../src/main/digest");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

const JA = "Maciej Wyrozumski";

/* ── Kto to w ogóle jest ──────────────────────────────────────── */

check("Podpis z adresem oddaje samo imię i nazwisko",
  humanName("Ania Kowalska <ania@firma.pl>") === "Ania Kowalska");
check("Podpis w cudzysłowie też",
  humanName('"Ania Kowalska" <ania@firma.pl>') === "Ania Kowalska");
check("Sam adres zostaje człowiekiem, a nie domeną cudzej firmy",
  humanName("ania.kowalska@firma.pl") === "ania kowalska");
check("Zwykłe imię przechodzi bez zmian", humanName("Marek") === "Marek");

/* ── Z kim była rozmowa ───────────────────────────────────────── */

check("We dwoje: zostaje ta druga osoba",
  withWhom({ people: [JA, "Ania Kowalska"] }, { me: JA }) === "Ania Kowalska");

check("We troje: obie osoby, wymienione",
  withWhom({ people: [JA, "Ania", "Marek"] }, { me: JA }) === "Ania i Marek");

check("Powyżej dwóch nazwisk wyliczanka zamienia się w grupę",
  withWhom({ people: [JA, "Ania", "Marek", "Zosia"] }, { me: JA }) === "zespół (3 osoby)");

check("Liczba mnoga jest polska, a nie „5 osoby”",
  withWhom({ people: ["a", "b", "c", "d", "e"] }, {}) === "zespół (5 osób)");

/* Nagranie z menu nie zna kalendarza — ale zapis rozmowy zna podpisy. */
check("Bez kalendarza pytamy zapisu, kto mówił",
  withWhom(
    {
      transcript: [
        { speaker: "Ty", text: "a" },
        { speaker: "Ania Kowalska", text: "b" },
        { speaker: "Ania Kowalska", text: "c" },
      ],
    },
    { me: JA },
  ) === "Ania Kowalska");

check("„Rozmówcy” to nie jest niczyje imię",
  withWhom({ transcript: [{ speaker: "Ty" }, { speaker: "Rozmówcy" }] }, { me: JA }) === "");

check("Siebie nie wymieniamy, choćby zapis pisał inaczej wielkością liter",
  withWhom({ people: ["maciej wyrozumski", "Ania"] }, { me: JA }) === "Ania");

check("Rozmowa z samym sobą nie ma „z kim”",
  withWhom({ people: [JA] }, { me: JA }) === "");

check("Zaproszeni biją mówiących: kalendarz zna imię, zapis bywa bezimienny",
  withWhom(
    { people: [JA, "Ania Kowalska"], transcript: [{ speaker: "Rozmówcy" }] },
    { me: JA },
  ) === "Ania Kowalska");

/* ── Nazwa notatki ────────────────────────────────────────────── */

check("O czym i z kim — jedną linijką",
  noteTitle(
    { title: "Budżet na trzeci kwartał", people: [JA, "Ania Kowalska"] },
    { me: JA },
  ) === "Budżet na trzeci kwartał · Ania Kowalska");

check("Imię, które już stoi w nazwie, nie wraca po kropce",
  noteTitle({ title: "Rozmowa z Anią Kowalską", people: [JA, "Ania Kowalska"] }, { me: JA }) ===
    "Rozmowa z Anią Kowalską");

check("Rozmowa bez nazwy bierze ją z pierwszego zdania podsumowania",
  noteTitle({ summary: "Ustalono termin raportu na czwartek. Reszta bez zmian." }, {}) ===
    "Ustalono termin raportu na czwartek");

check("Nagłówek podsumowania nie jest zdaniem — zdejmujemy z niego zapis Markdowna",
  firstSentence("**O czym było**\nRozmowa o budżecie na przyszły kwartał.") ===
    "O czym było");

check("Rozmowa bez wszystkiego nazywa się „Spotkanie”, a nie „undefined”",
  noteTitle({}, {}) === "Spotkanie");

const długa = noteTitle(
  {
    title: "Przegląd kwartalny działu produktu wraz z omówieniem wyników sprzedaży",
    people: [JA, "Ania Kowalska"],
  },
  { me: JA },
);
check("Nazwa nie urywa się w połowie słowa", długa.length <= 72 && !/\s…$/.test(długa));
check("…i mówi wprost, że została przycięta", długa.endsWith("…"));

/* ── Kartka, która z tego wychodzi ────────────────────────────── */

const rozmowa = {
  title: "Budżet na trzeci kwartał",
  at: "2026-08-30T09:00:00.000Z",
  where: "Google Meet",
  people: [JA, "Ania Kowalska"],
  summary: "**Ustalenia**\n- Raport idzie w czwartek.\n\n**Zadania**\n- Ania: przysłać dane, wtorek",
  notes: "Sprawdzić limity.",
  transcript: [
    { speaker: "Ty", at: 0, text: "Zdążymy z raportem?" },
    { speaker: "Ania Kowalska", at: 12, text: "Dane wyślę we wtorek." },
  ],
};

const kartka = asNote(rozmowa, { me: JA });

check("Nagłówek notatki to nazwa złożona z treści i z rozmówcy",
  kartka.split("\n")[0] === "# Budżet na trzeci kwartał · Ania Kowalska");

/* CAŁY ZAPIS ROZMOWY JEST W NOTATCE i to jest powód, dla którego nagranie
   wolno skasować: gdyby notatka niosła sam wniosek, kasowanie dźwięku
   byłoby kasowaniem jedynego egzemplarza tego, co naprawdę padło. */
check("Zapis rozmowy stoi w notatce w całości",
  kartka.includes("## Zapis rozmowy") &&
    kartka.includes("Dane wyślę we wtorek.") &&
    kartka.includes("Zdążymy z raportem?"));

check("Zadania z podsumowania stają się listą do odhaczenia",
  kartka.includes("- [ ] Ania: przysłać dane, wtorek"));

check("Notatki pisane ręką w trakcie rozmowy też są",
  kartka.includes("## Notatki z rozmowy") && kartka.includes("Sprawdzić limity."));

check("Kto był — z kalendarza, bez skracania",
  kartka.includes("**Kto był:** Maciej Wyrozumski, Ania Kowalska"));

const bezZapisu = asNote(rozmowa, { transcript: false, me: JA });
check("Kopia do schowka może iść bez zapisu, ale z tą samą nazwą",
  !bezZapisu.includes("## Zapis rozmowy") &&
    bezZapisu.startsWith("# Budżet na trzeci kwartał · Ania Kowalska"));

console.log(`\nNotatka ze spotkania: ${passed} sprawdzeń przeszło. Nazywa się sama i niesie cały zapis.`);
