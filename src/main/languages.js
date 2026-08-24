"use strict";

/**
 * Języki dyktowania.
 *
 * Trzy tryby, bo to trzy różne sytuacje:
 *
 *   SINGLE      mówisz w jednym języku i wiesz w jakim. Dostawca dostaje
 *               ten kod wprost — najmniej miejsca na pomyłkę.
 *
 *   BILINGUAL   mówisz w dwóch i przełączasz się w obrębie zdania
 *               („musimy zrobić deploy na stagingu przed piątkiem").
 *               To nie jest to samo, co rozpoznawanie automatyczne:
 *               automat wybiera JEDEN język dla całego nagrania i resztę
 *               przekręca albo tłumaczy. Tutaj mówimy modelowi wprost,
 *               że przeplatanie jest oczekiwane, i zakazujemy tłumaczenia
 *               w którąkolwiek stronę.
 *
 *   AUTO        nie wiadomo, co padnie. Model rozpoznaje sam.
 *
 * Ten sam opis idzie do obu kroków — transkrypcji i sita. Gdyby dostał go
 * tylko pierwszy krok, sito i tak „poprawiłoby" angielskie wtrącenia na
 * polskie, bo bez tej wiedzy wyglądają jak przekręcenia.
 */

const LANGUAGES = {
  pl: { pl: "polski", en: "Polish", label: "PL" },
  en: { pl: "angielski", en: "English", label: "EN" },
  de: { pl: "niemiecki", en: "German", label: "DE" },
  fr: { pl: "francuski", en: "French", label: "FR" },
  es: { pl: "hiszpański", en: "Spanish", label: "ES" },
  it: { pl: "włoski", en: "Italian", label: "IT" },
  uk: { pl: "ukraiński", en: "Ukrainian", label: "UK" },
  cs: { pl: "czeski", en: "Czech", label: "CS" },
};

const DEFAULT_LANGUAGE = { mode: "bilingual", primary: "pl", secondary: "en" };

/** Ustawienia języka w jednym kształcie, niezależnie od tego, co leży w pliku. */
function normalize(language) {
  // Do wersji 0.1 język był jednym napisem: "auto" albo kod.
  if (typeof language === "string") {
    return language === "auto"
      ? { ...DEFAULT_LANGUAGE, mode: "auto" }
      : { mode: "single", primary: language, secondary: "en" };
  }
  const merged = { ...DEFAULT_LANGUAGE, ...(language ?? {}) };
  if (!LANGUAGES[merged.primary]) merged.primary = DEFAULT_LANGUAGE.primary;
  if (!LANGUAGES[merged.secondary]) merged.secondary = DEFAULT_LANGUAGE.secondary;
  // Dwa razy ten sam język to nie dwujęzyczność, tylko jeden język.
  if (merged.mode === "bilingual" && merged.primary === merged.secondary) merged.mode = "single";
  return merged;
}

const nameOf = (code) => LANGUAGES[code]?.pl ?? code;

/** Krótka etykieta na tacę widgetu i do paska menu: PL, EN, PL·EN, AUTO. */
function shortLabel(language) {
  const { mode, primary, secondary } = normalize(language);
  if (mode === "auto") return "AUTO";
  if (mode === "bilingual") return `${LANGUAGES[primary].label}·${LANGUAGES[secondary].label}`;
  return LANGUAGES[primary].label;
}

/** Zdanie o języku dla promptu — to samo dla transkrypcji i dla sita. */
function directive(language) {
  const { mode, primary, secondary } = normalize(language);

  if (mode === "single") {
    return `JĘZYK
Nagranie jest w języku ${nameOf(primary)} (kod „${primary}"). Zapisz je w tym języku.
Pojedyncze wtrącenia z innych języków zostaw w oryginale — nie tłumacz ich.`;
  }

  if (mode === "bilingual") {
    return `JĘZYK — DWUJĘZYCZNIE
Mówiący swobodnie przełącza się między dwoma językami: ${nameOf(primary)} („${primary}")
i ${nameOf(secondary)} („${secondary}"). Przełączenie zdarza się w obrębie jednego zdania.

- Zapisz każde słowo w tym języku, w którym padło.
- NIE TŁUMACZ w żadną stronę i nie ujednolicaj wypowiedzi do jednego języka.
- Terminy techniczne, nazwy narzędzi i zwroty branżowe wypowiedziane w drugim
  języku zostają w nim, nawet w środku zdania w pierwszym języku.
- Odmienione zapożyczenia zapisz tak, jak zabrzmiały.`;
  }

  return `JĘZYK
Rozpoznaj język wypowiedzi samodzielnie i zapisz ją w tym języku.
Wtrącenia z innych języków zostaw w oryginale — nie tłumacz ich.`;
}

/**
 * Kod dla dostawców, którzy przyjmują jeden język wprost (Whisper).
 * Przy dwóch językach i przy automacie oddajemy null: narzucony kod kazałby
 * modelowi zmielić drugi język na pierwszy.
 */
function fixedCode(language) {
  const { mode, primary } = normalize(language);
  return mode === "single" ? primary : null;
}

/** Krótka podpowiedź dla Whispera — biasuje dekoder, nie jest poleceniem. */
function whisperHint(language) {
  const { mode, primary, secondary } = normalize(language);
  if (mode !== "bilingual") return null;
  return `Wypowiedź w dwóch językach: ${nameOf(primary)} i ${nameOf(secondary)}. Zapisz każde słowo w jego własnym języku.`;
}

module.exports = { LANGUAGES, DEFAULT_LANGUAGE, normalize, directive, fixedCode, whisperHint, shortLabel };
