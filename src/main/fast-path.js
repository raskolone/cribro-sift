"use strict";

/**
 * Inteligentny Fast-Path (Tryb Turbo) dla transkrypcji i sita.
 *
 * ══ PO CO TO ISTNIEJE ══
 *
 * Modele mowy nowej generacji (jak Deepgram Nova-3) same stawiają
 * interpunkcję, wielkie litery, akapity i formatują liczby (np. „15:30", „23 maja").
 *
 * Gdy użytkownik dyktuje płynnie — bez zacięć, bez „yyy", bez powtórzeń —
 * wywołanie modelu językowego (LLM) z 800-tokenowym promptem dodaje
 * od 600 do 1500 ms zbędnego opóźnienia i niczego w tekście nie zmienia.
 *
 * Fast-Path analizuje transkrypcję deterministycznymi regułami:
 *   - jeśli tekst jest czysty i naturalny → wklejamy NATYCHMIAST (~250-350 ms!)
 *   - jeśli występują wahania, szum mowy lub wybrano gęste sito „Drobne" →
 *     potok bez wahania przekazuje tekst do Sita LLM.
 */

// Wypełniacze mowy w języku polskim i angielskim
const FILLERS = [
  // Polskie wahania i dźwięki
  "yyy", "eee", "mmm", "yhm", "uhm", "ehm", "aha",
  // Polskie waty słowne
  "w sensie", "jakby", "no wiesz", "tak jakby", "generalnie",
  // Angielskie wypełniacze
  "um", "uh", "er", "ah", "like", "you know", "i mean",
];

const FILLER_REGEX = new RegExp(
  `(^|[\\s,.;:!?])(${FILLERS.map((f) => f.replace(/\s+/g, "\\s+")).join("|")})([\\s,.;:!?]|$)`,
  "i"
);

// Zająknięcia fonetyczne z dywizem (np. "prz- przepraszam", "w- wczoraj")
const STUTTER_REGEX = /\b[\p{L}]{1,4}-\s*[\p{L}]+/iu;

// Zdublowane sąsiadujące słowa (np. "ja ja", "to to jest")
const DUPLICATE_WORDS_REGEX = /\b([\p{L}]{2,})\s+\1\b/iu;

// Znaczniki autopoprawki (np. "znaczy", "to znaczy", "nie, o")
const CORRECTION_REGEX = /\b(nie,\s*o|znaczy|to znaczy)\b/i;

// Polecenia formatujące wypowiedziane na głos (np. "nowy akapit", "nowa linia")
const FORMAT_CUES_REGEX = /\b(nowy akapit|nowa linia|myślnik|punkt)\b/i;

/**
 * Sprawdza, czy tekst kwalifikuje się do natychmiastowego ominięcia Sita LLM.
 *
 * @param {string} raw - surowy transkrypt
 * @param {object} settings - aktualne ustawienia aplikacji
 * @param {object} [cue] - wynik lokalnego dopasowania poleceń (detectCommand)
 * @returns {{ eligible: boolean, reason: string }}
 */
function check(raw, settings = {}, cue = null) {
  // 1. Czy Tryb Turbo jest włączony w ustawieniach
  if (settings.stt?.turbo === false) {
    return { eligible: false, reason: "turbo_disabled" };
  }

  const text = (raw ?? "").trim();
  if (!text) {
    return { eligible: false, reason: "empty" };
  }

  // 2. Jeśli rozpoznano polecenie lokalne — sito musi zadziałać, aby obsłużyć ujście/reguły
  if (cue?.command) {
    return { eligible: false, reason: "command_detected" };
  }

  // 3. Poziom „Drobne” wymaga przeredagowania stylu i układu przez LLM
  if (settings.mesh === "drobne") {
    return { eligible: false, reason: "mesh_drobne_requires_llm" };
  }

  // 4. Własna instrukcja użytkownika wymaga modelu językowego
  if (settings.sieve?.customInstruction?.trim()) {
    return { eligible: false, reason: "custom_instruction_active" };
  }

  // 5. Sprawdzenie obecności zdefiniowanych poleceń głosowych w tekście
  if (settings.commands?.length) {
    for (const cmd of settings.commands) {
      if (cmd.phrase && text.toLowerCase().includes(cmd.phrase.toLowerCase().trim())) {
        return { eligible: false, reason: "voice_command_phrase" };
      }
    }
  }

  // 6. Sprawdzenie poleceń formatujących mowy ("nowy akapit", "nowa linia")
  if (FORMAT_CUES_REGEX.test(text)) {
    return { eligible: false, reason: "formatting_cue" };
  }

  // 7. Wypełniacze mowy ("yyy", "w sensie", itp.)
  if (FILLER_REGEX.test(text)) {
    return { eligible: false, reason: "filler_word_detected" };
  }

  // 8. Zająknięcia fonetyczne ("prz- przepraszam")
  if (STUTTER_REGEX.test(text)) {
    return { eligible: false, reason: "stutter_detected" };
  }

  // 9. Podwojone słowa z rzędu ("ja ja myślę")
  if (DUPLICATE_WORDS_REGEX.test(text)) {
    return { eligible: false, reason: "duplicate_words_detected" };
  }

  // 10. Autopoprawki ("spotkajmy się o piątej… znaczy o szóstej")
  if (CORRECTION_REGEX.test(text)) {
    return { eligible: false, reason: "autocorrection_detected" };
  }

  // Tekst jest czysty, poprawnie interpunkcjonowany przez Deepgram i gotowy!
  return { eligible: true, reason: "clean_fluent_speech" };
}

module.exports = {
  check,
  FILLERS,
  FILLER_REGEX,
  STUTTER_REGEX,
  DUPLICATE_WORDS_REGEX,
  CORRECTION_REGEX,
  FORMAT_CUES_REGEX,
};
