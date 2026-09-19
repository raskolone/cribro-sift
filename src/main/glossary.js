"use strict";

/**
 * Żargon, którego Deepgram i sito nie znają z natury.
 *
 * Polska mowa z angielskimi wtrąceniami technicznymi jest dla modelu
 * akustycznego najtrudniejszym przypadkiem: "Claude Code" nie brzmi jak
 * nic, czego Nova-3 uczyła się na polskich nagraniach, więc leci fonetyczne
 * zgadywanie ("klot kod", "kłod kod"). Dwa niezależne ratunki:
 *
 *   1. AKUSTYCZNY — lista `keywords` z wagami, wysyłana do Deepgramu razem
 *      z zapytaniem. Podnosi prawdopodobieństwo tych słów W SAMYM
 *      ROZPOZNAWANIU, zanim jeszcze powstanie tekst do poprawek.
 *   2. JĘZYKOWY — gdy akustyka i tak przepuści przekręcenie, sito (i mikro-
 *      filtr tuż przed wklejeniem) dostają gotową listę „słyszysz X, zapisz Y".
 *
 * Użytkownik dokłada WŁASNE słowa w Ustawieniach → Ziarna (`settings.grains`).
 * Ta lista jest osobna i wbudowana na stałe — pokrywa żargon wspólny dla tej
 * aplikacji i pracy Maćka (Cribro, EdTech, narzędzia programistyczne), więc
 * nie ma sensu kazać nikomu wpisywać go ręcznie przy pierwszym
 * uruchomieniu.
 */

/** Waga 3 = nazwa własna, która nigdy nie ma naturalnego polskiego odpowiednika
 *  i regularnie ginie w transkrypcji całością (dwa słowa, nie jedno).
 *  Waga 2 = pojedyncze słowo, które model zwykle już łapie, ale bywa
 *  mylone z podobnie brzmiącym polskim wyrazem. */
const BUILTIN_TERMS = [
  ["Claude Code", 3],
  ["Claude", 2],
  ["Notion", 2],
  ["Firestore", 2],
  ["Firebase", 2],
  ["Cribro", 3],
  ["Recall", 2],
  ["TypeScript", 2],
  ["JavaScript", 2],
  ["React", 2],
  ["Antigravity", 2],
  ["Tailwind", 2],
  ["Gemini", 2],
  ["Deepgram", 2],
  ["GitHub", 2],
  ["VS Code", 2],
];

/** Waga, jaką dostają słowa z Ziaren użytkownika — te same co dotąd, żeby
 * nie zmieniać zachowania nikomu, kto już sobie tę listę ułożył. */
const USER_GRAIN_WEIGHT = 2;

/** Najczęstsze fonetyczne wypadki tych samych nazw — to, co Deepgram
 * naprawdę zapisuje, gdy akustyka go zawiedzie. Klucz do zrozumienia dla
 * sita i mikro-filtra: nie zgadują na oślep, dostają gotowe pary. */
const PHONETIC_FIXES = [
  { heard: ["klot kod", "claud code", "kłod kod", "klaud kod"], say: "Claude Code" },
  { heard: ["klot", "klaud", "kload"], say: "Claude" },
  { heard: ["noszyn", "noszen", "noszn"], say: "Notion" },
  { heard: ["fajerstor", "fajer stor", "fajerstore"], say: "Firestore" },
  { heard: ["fajerbejs", "fajer bejs"], say: "Firebase" },
  { heard: ["kribro", "kribrou"], say: "Cribro" },
  { heard: ["rikol", "rikoll"], say: "Recall" },
  { heard: ["tajpskript", "tajp skrypt"], say: "TypeScript" },
  { heard: ["dżawaskript", "dżawa skrypt"], say: "JavaScript" },
  { heard: ["riakt", "rijakt"], say: "React" },
  { heard: ["antigrawiti", "anty grawiti", "antygrawiti"], say: "Antigravity" },
  { heard: ["tejlłind", "tailłind", "tejlwind"], say: "Tailwind" },
  { heard: ["dżems", "dżemini", "gemini"], say: "Gemini" },
  { heard: ["dipgram", "dip gram"], say: "Deepgram" },
  { heard: ["gitub", "githab"], say: "GitHub" },
  { heard: ["wi es kod", "wi es kołd"], say: "VS Code" },
];

/**
 * `keywords` dla Deepgramu: wbudowany żargon plus Ziarna użytkownika,
 * bez duplikatów (wygrywa wbudowana waga, jeśli ktoś wpisał to samo słowo
 * ręcznie) i obcięte do `cap` — Deepgram ma twardy limit długości adresu.
 */
function weightedKeywords(userGrains = [], cap = 50) {
  const seen = new Map();
  for (const [term, weight] of BUILTIN_TERMS) seen.set(term.toLowerCase(), [term, weight]);
  for (const raw of userGrains ?? []) {
    const term = String(raw ?? "").trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.set(term.toLowerCase(), [term, USER_GRAIN_WEIGHT]);
  }
  return [...seen.values()].slice(0, cap).map(([term, weight]) => `${term}:${weight}`);
}

/** Płaska lista nazw (bez wag) — do podpowiedzi tekstowych, którym Deepgram
 * `keywords` nie dotyczy (np. hint dla Gemini w main/stt.js). */
function glossaryNames(userGrains = []) {
  const names = BUILTIN_TERMS.map(([term]) => term);
  for (const raw of userGrains ?? []) {
    const term = String(raw ?? "").trim();
    if (term && !names.some((n) => n.toLowerCase() === term.toLowerCase())) names.push(term);
  }
  return names;
}

/** Blok do wklejenia w prompt sita / mikro-filtra: gotowe pary
 * „usłyszysz — zapisz", żeby model nie zgadywał, tylko podstawiał. */
function phoneticGuide() {
  return PHONETIC_FIXES.map((fix) => `- "${fix.heard.join('" / "')}" → "${fix.say}"`).join("\n");
}

module.exports = { BUILTIN_TERMS, PHONETIC_FIXES, weightedKeywords, glossaryNames, phoneticGuide };
