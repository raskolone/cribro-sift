"use strict";
/**
 * Krok „Silniki" należy do właściciela.
 *   node scripts/owner-test.js
 *
 * Transkrypcja, sito i odczyt zrzutu chodzą na cudzych modelach, a przy
 * wydanej aplikacji płaci za nie autor, ze swojego klucza. Przełącznik,
 * który zmienia cudzy rachunek, nie jest ustawieniem — jest dziurą; klucz
 * w polu, z którego da się go odczytać, przestaje być kluczem autora.
 * Dlatego cały ten krok jest dla zwykłego użytkownika NIEWIDOCZNY, a nie
 * tylko zablokowany: wyszarzone pole nadal mówi, co w nim stało.
 *
 * Dlaczego akurat tak i CZYM TO NIE JEST — mówi nagłówek src/main/owner.js.
 * Krótko: to jest granica interfejsu, nie zabezpieczenie przed kimś, kto
 * rozbierze paczkę na części.
 *
 * Plik nie zna Electrona — katalog danych i zmienne środowiskowe wchodzą
 * z zewnątrz, więc sprawdza go zwykły Node.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  OWNERS,
  MARK,
  isOwner,
  ownerEmail,
  publicSettings,
  sealPatch,
  scrub,
} = require("../src/main/owner");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Kto jest właścicielem ────────────────────────────────────── */

check("Lista właścicieli nie jest pusta", OWNERS.length >= 1);
check("Adres właściciela jest rozpoznawany", ownerEmail(OWNERS[0]));
check("…także zapisany inaczej wielkością liter i ze spacjami",
  ownerEmail(`  ${OWNERS[0].toUpperCase()} `));
check("Cudzy adres nie jest", !ownerEmail("ktos.inny@gmail.com"));
check("Brak konta to nie właściciel", !ownerEmail(null) && !ownerEmail(""));

const pusto = { env: {}, userData: null };
check("Bez konta, bez zmiennej i bez znacznika — zwykły użytkownik",
  !isOwner({ ...pusto, email: "ktos@example.com" }));
check("Zalogowane konto właściciela otwiera krok „Silniki”",
  isOwner({ ...pusto, email: OWNERS[0] }));
check("CRIBRO_OWNER=1 otwiera go bez konta",
  isOwner({ email: null, env: { CRIBRO_OWNER: "1" }, userData: null }));
check("CRIBRO_OWNER=0 nie otwiera niczego",
  !isOwner({ email: null, env: { CRIBRO_OWNER: "0" }, userData: null }));

/* Znacznik na dysku — wyjście awaryjne dla maszyny bez sieci i bez konta. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-owner-"));
check("Katalog danych bez znacznika niczego nie otwiera",
  !isOwner({ email: null, env: {}, userData: dir }));
fs.writeFileSync(path.join(dir, MARK), "");
check("Znacznik w katalogu danych otwiera krok „Silniki”",
  isOwner({ email: null, env: {}, userData: dir }));
check("Katalog, którego nie ma, nie wywraca pytania",
  !isOwner({ email: null, env: {}, userData: path.join(dir, "nie-ma-takiego") }));
fs.rmSync(dir, { recursive: true, force: true });

/* ── Co widzi renderer ────────────────────────────────────────── */

const USTAWIENIA = {
  uiLanguage: "pl",
  mesh: "srednie",
  stt: { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "AIza-tajne" },
  sieve: {
    provider: "openai",
    model: "gpt-5.6-terra",
    apiKey: "sk-tajne",
    customInstruction: "Bez wykrzykników.",
  },
  shot: {
    provider: "openai",
    model: "gpt-5.6-luna",
    apiKey: "sk-tajne",
    hotkey: "Control+Alt+S",
    target: "new",
    form: "text",
  },
};

const mój = publicSettings(USTAWIENIA, true, () => true);
check("Właściciel widzi wszystko", mój.stt.apiKey === "AIza-tajne" && mój.owner === true);

const cudzy = publicSettings(USTAWIENIA, false, () => true);

for (const krok of ["stt", "sieve", "shot"]) {
  for (const pole of ["provider", "model", "apiKey"]) {
    check(`Zwykły użytkownik nie dostaje ${krok}.${pole} — pole nie istnieje, nie jest puste`,
      !(pole in cudzy[krok]));
  }
}

/* Klucza nie ma NIGDZIE w tym, co jedzie mostem. Sprawdzamy cały ładunek,
   a nie pola po kolei: wyciek najłatwiej wchodzi bokiem, dopisanym gdzie
   indziej polem. */
const ładunek = JSON.stringify(cudzy);
check("W całym ładunku nie ma ani jednego klucza",
  !ładunek.includes("AIza-tajne") && !ładunek.includes("sk-tajne"));
check("…ani jednej nazwy modelu",
  !/gemini|gpt-|claude|whisper/i.test(ładunek));

check("Ustawienia niezwiązane z silnikiem zostają nietknięte",
  cudzy.sieve.customInstruction === "Bez wykrzykników." &&
    cudzy.shot.hotkey === "Control+Alt+S" &&
    cudzy.shot.target === "new" &&
    cudzy.mesh === "srednie");

check("Zamiast nazw wchodzi jedno zdanie: czy jest czym mówić",
  cudzy.owner === false && cudzy.enginesReady === true);
check("…i mówi „nie”, gdy nie ma czym",
  publicSettings(USTAWIENIA, false, (stage) => stage !== "sieve").enginesReady === false);

/* ── Czego nie wolno zapisać ──────────────────────────────────── */

const podmiana = { stt: { provider: "mock", apiKey: "cudzy" }, mesh: "drobne" };
const przepuszczone = sealPatch(podmiana, false);
check("Zapis dostawcy i klucza od zwykłego użytkownika nie przechodzi",
  !("stt" in przepuszczone) && przepuszczone.mesh === "drobne");
check("Właścicielowi zapis przechodzi w całości",
  sealPatch(podmiana, true).stt.apiKey === "cudzy");
check("Zmiana obok silnika zostaje, choć leży w tym samym kroku",
  sealPatch({ sieve: { apiKey: "x", customInstruction: "Krótko." } }, false).sieve
    .customInstruction === "Krótko.");
check("Pusty krok po odsianiu znika, zamiast lecieć jako {}",
  !("sieve" in sealPatch({ sieve: { apiKey: "x" } }, false)));

/* ── Czego nie wolno powiedzieć w błędzie ─────────────────────── */

const AWARIE = [
  'Brak klucza API dla dostawcy „gemini" — podsumowanie potrzebuje modelu.',
  "OpenAI odrzucił klucz (401).",
  "Gemini odmówił podsumowania (SAFETY).",
  "Nie udało się połączyć z api.openai.com.",
  "Model claude-opus-5 nie odpowiedział w czasie.",
  "Whisper v1 zwrócił pusty tekst.",
];

for (const awaria of AWARIE) {
  const cichy = scrub(awaria, false);
  check(`Błąd nie wymienia dostawcy: „${cichy}"`,
    !/gemini|openai|anthropic|claude|gpt|whisper/i.test(cichy));
}
check("Awaria nadal mówi, CO się nie udało",
  scrub(AWARIE[0], false).includes("podsumowanie potrzebuje modelu"));
check("Właściciel dostaje błąd taki, jaki padł", scrub(AWARIE[1], true) === AWARIE[1]);
check("Zdanie bez nazw przechodzi bez zmian",
  scrub("Nagranie zostało przerwane.", false) === "Nagranie zostało przerwane.");

/* ── Interfejs nie ma z czego narysować kroku ─────────────────── */

const app = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "js", "app.js"), "utf8");
check("Karta „Silniki” pyta o właściciela, zanim cokolwiek narysuje",
  /function renderEngines\(\)\s*\{\s*\n\s*if \(!state\.settings\?\.owner\) return "";/.test(app));
check("Pojedynczy krok potoku też pyta",
  /function engineBlock\([\s\S]{0,400}?if \(!state\.settings\?\.owner\) return "";/.test(app));

const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
check("Ustawienia wychodzą do okna wyłącznie przez visibleSettings",
  !/broadcast\("settings:changed", store\.getSettings\(\)\)/.test(main) &&
    /ipcMain\.handle\("settings:get", \(\) => visibleSettings\(\)\)/.test(main));
check("Katalog dostawców nie jedzie do zwykłego użytkownika",
  /ipcMain\.handle\("providers:get", \(\) =>\s*\n?\s*ownerHere\(\)/.test(main));
check("Sprawdzanie połączenia jest zamknięte po stronie procesu głównego",
  (main.match(/onlyOwner\("Sprawdzanie silnika"\)/g) ?? []).length === 3);

console.log(`\nSilniki: ${passed} sprawdzeń przeszło. Krok należy do właściciela i nikt inny go nie widzi.`);
