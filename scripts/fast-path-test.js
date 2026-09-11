"use strict";

const assert = require("assert");
const fastPath = require("../src/main/fast-path");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

console.log("Rozpoczynam testy modułu Fast-Path...");

const defaultSettings = {
  mesh: "srednie",
  stt: { turbo: true },
  sieve: { customInstruction: "" },
};

// 1. Czysty tekst kwalifikuje się do Fast-Path
const clean1 = fastPath.check("Będę za 10 minut pod biurem.", defaultSettings);
check("Czyste zdanie przechodzi przez Fast-Path", clean1.eligible && clean1.reason === "clean_fluent_speech");

const clean2 = fastPath.check("Dzień dobry, przesyłam raport kwartalny za pierwszy kwartał 2026 roku.", defaultSettings);
check("Dłuższe zdanie bez zacięć przechodzi przez Fast-Path", clean2.eligible);

// 2. Wypełniacze dyskwalifikują z Fast-Path (wymagają Sita)
const filler1 = fastPath.check("Będę yyy za dziesięć minut.", defaultSettings);
check("Wypełniacz «yyy» trafia do Sita LLM", !filler1.eligible && filler1.reason === "filler_word_detected");

const filler2 = fastPath.check("To jest w sensie dobra decyzja.", defaultSettings);
check("Wata słowna «w sensie» trafia do Sita LLM", !filler2.eligible && filler2.reason === "filler_word_detected");

const filler3 = fastPath.check("Mamy jakby problem z serwerem.", defaultSettings);
check("Wata słowna «jakby» trafia do Sita LLM", !filler3.eligible && filler3.reason === "filler_word_detected");

// 3. Zająknięcia i powtórzenia trafiają do Sita
const stutter1 = fastPath.check("Prz- przepraszam za spóźnienie.", defaultSettings);
check("Zająknięcie z myślnikiem trafia do Sita LLM", !stutter1.eligible && stutter1.reason === "stutter_detected");

const dupl = fastPath.check("Ja ja myślę że warto to zrobić.", defaultSettings);
check("Zdublowane słowo «ja ja» trafia do Sita LLM", !dupl.eligible && dupl.reason === "duplicate_words_detected");

// 4. Autopoprawka
const corr = fastPath.check("Spotkajmy się o piątej znaczy o szóstej.", defaultSettings);
check("Autopoprawka «znaczy» trafia do Sita LLM", !corr.eligible && corr.reason === "autocorrection_detected");

// 5. Polecenia formatujące głosowe
const fmt = fastPath.check("Oto pierwszy punkt nowy akapit a tu drugi.", defaultSettings);
check("Polecenie «nowy akapit» trafia do Sita LLM", !fmt.eligible && fmt.reason === "formatting_cue");

// 6. Gęstość «drobne» (zawsze wymaga LLM do redagowania stylu)
const drobne = fastPath.check("Będę za 10 minut pod biurem.", { ...defaultSettings, mesh: "drobne" });
check("Sito «drobne» zawsze wymaga LLM", !drobne.eligible && drobne.reason === "mesh_drobne_requires_llm");

// 7. Własna instrukcja użytkownika
const custom = fastPath.check("Będę za 10 minut pod biurem.", {
  ...defaultSettings,
  sieve: { customInstruction: "Bez wykrzykników." },
});
check("Własna instrukcja zawsze wymaga LLM", !custom.eligible && custom.reason === "custom_instruction_active");

// 8. Wyłączony tryb Turbo
const off = fastPath.check("Będę za 10 minut pod biurem.", {
  ...defaultSettings,
  stt: { turbo: false },
});
check("Wyłączony tryb Turbo kieruje wszystko do Sita", !off.eligible && off.reason === "turbo_disabled");

console.log(`\nFast-Path: wszystkie ${passed} sprawdzeń przeszło pomyślnie!\n`);
