"use strict";

/**
 * Test weryfikacyjny dla eksportu spotkań do Markdown i PDF oraz rozdzielenia live i final transcript.
 *   node scripts/meeting-export-test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { meetingToMarkdown, toMeetingDocument } = require("../src/main/pdf");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

const sampleMeeting = {
  id: "m-test-1",
  title: "Spotkanie architektoniczne · Zaawansowane sito AI",
  at: "2026-09-25T10:00:00.000Z",
  seconds: 1845, // ~30 min 45 s
  language: "Polski",
  bilingual: false,
  draft: [
    { speaker: "Rozmówca 1", text: "Szkic live który może być niedokładny...", at: 0 },
  ],
  transcript: [
    { speaker: "Maciej", text: "Cześć wszystkim, omówmy architekturę sita AI oraz transkrypcji.", at: 5 },
    { speaker: "Anna", text: "Zgadzam się. Załączam specyfikację z polskimi znakami: zażółć gęślą jaźń.", at: 25 },
    { speaker: "Maciej", text: "Świetnie, przechodzimy do zadań.", at: 60 },
  ],
  summary: "Podsumowanie ustaleń ze spotkania architektonicznego.\nZatwierdzono nowy schemat eksportu dokumentów.",
  tasks: [
    "Przygotować testy integracyjne",
    "Zweryfikować eksporty Markdown i PDF",
  ],
};

// 1. Weryfikacja formatu Markdown
const md = meetingToMarkdown(sampleMeeting, { locale: "pl-PL" });

check("Markdown zawiera tytuł spotkania jako H1", md.includes("# Spotkanie architektoniczne · Zaawansowane sito AI"));
check("Markdown zawiera metadane: datę, czas trwania, język i źródło",
  md.includes("- Data:") &&
  md.includes("- Czas trwania: 30 min 45 s") &&
  md.includes("- Język: Polski") &&
  md.includes("- Źródło: pełne nagranie")
);
check("Markdown zawiera sekcję Transkrypcja z mówcami i timestampami",
  md.includes("## Transkrypcja") &&
  md.includes("**Maciej** (00:05): Cześć wszystkim") &&
  md.includes("**Anna** (00:25): Zgadzam się")
);
check("Markdown poprawnie koduje polskie znaki", md.includes("zażółć gęślą jaźń"));
check("Markdown zawiera sekcję Podsumowanie", md.includes("## Podsumowanie") && md.includes("Podsumowanie ustaleń ze spotkania"));
check("Markdown zawiera sekcję Zadania z checkboxami", md.includes("## Zadania") && md.includes("- [ ] Przygotować testy integracyjne"));

// 2. Weryfikacja dokumentu HTML dla PDF
const html = toMeetingDocument(sampleMeeting, { locale: "pl-PL" });

check("HTML PDF zawiera metatag UTF-8", html.includes('<meta charset="utf-8" />'));
check("HTML PDF zawiera tytuł dokumentu", html.includes("Spotkanie architektoniczne · Zaawansowane sito AI"));
check("HTML PDF zawiera metryczkę z czasem i źródłem", html.includes("Źródło: pełne nagranie") && html.includes("30 min 45 s"));
check("HTML PDF zawiera transkrypcję", html.includes("zażółć gęślą jaźń"));
check("HTML PDF zawiera podsumowanie i zadania", html.includes("<h2>Podsumowanie</h2>") && html.includes("<h2>Zadania</h2>"));

// 3. Test odporności na brak pól opcjonalnych
const emptyMeeting = {
  id: "m-empty",
  at: "2026-09-25T10:00:00.000Z",
  seconds: 0,
};
const emptyMd = meetingToMarkdown(emptyMeeting);
check("Markdown z pustego spotkania ma bezpieczny tytuł domyślny", emptyMd.includes("# Spotkanie"));
check("Puste spotkanie nie generuje fałszywych sekcji podsumowania", !emptyMd.includes("## Podsumowanie"));
check("Puste spotkanie nie generuje fałszywych sekcji zadań", !emptyMd.includes("## Zadania"));

console.log(`\nEksport spotkań (Markdown & PDF): wszystkie ${passed} sprawdzeń przeszły pomyślnie.`);
