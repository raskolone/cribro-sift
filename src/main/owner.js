"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Czyja to instalacja — i co wolno w niej zobaczyć.
 *
 * ══ PO CO TO ISTNIEJE ══
 *
 * Cribro Sift chodzi na cudzych modelach: transkrypcja, sito i odczyt
 * zrzutu ekranu to trzy osobne wywołania do trzech osobnych dostawców.
 * Przy wydaniu aplikacji tych wywołań nie opłaca użytkownik — opłaca je
 * autor, ze swojego klucza. A skoro tak, to trzy rzeczy nie mogą być
 * widoczne z zewnątrz:
 *
 *   1. KLUCZ. Wpisany w polu, z którego da się go odczytać, przestaje być
 *      kluczem autora, a staje się kluczem każdego, kto otworzył
 *      Ustawienia.
 *   2. WYBÓR DOSTAWCY I MODELU. Przełącznik, który zmienia rachunek
 *      płacony przez kogoś innego, nie jest ustawieniem — jest dziurą.
 *   3. NAZWY MODELI. To nie jest sekret w sensie bezpieczeństwa i nie
 *      udajemy, że jest. To decyzja o tym, co aplikacja o sobie mówi:
 *      obiecuje wynik, a nie markę pod spodem. Model wolno wymienić
 *      w środę na lepszy i nie chcemy, żeby ktokolwiek zbudował sobie
 *      nawyk na napisie „Gemini 3.1 Flash-Lite".
 *
 * Dlatego cały krok „Silniki" jest dla zwykłego użytkownika NIEWIDOCZNY,
 * a nie tylko zablokowany. Wyszarzone pole nadal mówi, co w nim stało.
 *
 * ══ CO TO NIE JEST ══
 *
 * To nie jest zabezpieczenie przed kimś, kto rozbierze aplikację na
 * części. Kod Electrona leży w paczce i da się go przeczytać; klucz podany
 * przez zmienną środowiskową da się z procesu wyjąć. To jest granica
 * INTERFEJSU: przełącznika nie ma na ekranie, danych nie ma w oknie i nie
 * jadą one mostem do renderera. Kto chce więcej, musi przestać być
 * użytkownikiem, a zacząć być inżynierem — i to jest tu cała ambicja.
 *
 * Prawdziwe odcięcie klucza od użytkownika wymaga pośrednika po stronie
 * serwera (aplikacja woła nasz punkt, punkt woła dostawcę). To jest
 * następny krok, nie ten.
 *
 * ══ SKĄD WIADOMO, ŻE TO AUTOR ══
 *
 * Trzy drogi, w tej kolejności — pierwsza, która odpowie „tak", kończy
 * pytanie:
 *
 *   1. ZALOGOWANE KONTO. Adres podłączonego konta w chmurze zgadza się
 *      z listą właścicieli. Ta sama zasada, którą rozstrzyga poranek
 *      (patrz `briefing.owner` w main/store.js): funkcja należy do adresu,
 *      a nie do komputera.
 *   2. ZMIENNA ŚRODOWISKOWA `CRIBRO_OWNER=1`. Dla uruchomień z terminala
 *      i dla testów — konta w chmurze nie ma tam po co zakładać.
 *   3. ZNACZNIK NA DYSKU: plik `owner` w katalogu danych aplikacji.
 *      Wyjście awaryjne dla maszyny bez sieci i bez konta. Sam fakt jego
 *      istnienia wystarczy; zawartość nie ma znaczenia.
 *
 * Plik nie zna Electrona — katalog danych dostaje z zewnątrz. Dlatego
 * sprawdza go zwykły Node (scripts/owner-test.js).
 */

/** Adresy, dla których Ustawienia pokazują wszystko. */
const OWNERS = ["maciej.wyrozumski@gmail.com"];

/** Nazwa znacznika w katalogu danych. */
const MARK = "owner";

const clean = (email) => String(email ?? "").trim().toLowerCase();

/** Czy ten adres jest adresem właściciela. */
const ownerEmail = (email) => OWNERS.includes(clean(email));

/**
 * Czy ta instalacja należy do właściciela.
 *
 * @param {object} [where]
 * @param {string|null} [where.email]     adres zalogowanego konta
 * @param {object} [where.env]            zmienne środowiskowe
 * @param {string|null} [where.userData]  katalog danych aplikacji
 * @returns {boolean}
 */
function isOwner({ email = null, env = process.env, userData = null } = {}) {
  if (ownerEmail(email)) return true;
  if (String(env?.CRIBRO_OWNER ?? "") === "1") return true;
  if (userData) {
    try {
      if (fs.existsSync(path.join(userData, MARK))) return true;
    } catch {
      /* katalogu nie ma albo nie wolno go czytać — to po prostu „nie" */
    }
  }
  return false;
}

/**
 * Ustawienia okrojone do tego, co zwykły użytkownik ma prawo zobaczyć.
 *
 * Kroki potoku zostają jako obiekty — renderer czyta z nich rzeczy, które
 * nie mają nic wspólnego z modelem (`sieve.customInstruction`, `shot.form`,
 * `shot.target`, `shot.hotkey`) — ale dostawca, model i klucz z nich
 * ZNIKAJĄ. Nie są puste: nie ma ich wcale, więc nie da się ich odczytać
 * ani przez pomyłkę wyświetlić.
 *
 * W zamian wchodzi jedno zdanie, które renderer naprawdę potrzebuje
 * usłyszeć: `enginesReady` — czy jest czym mówić i czym przesiewać.
 *
 * @param {object} settings  całe ustawienia ze sklepu
 * @param {boolean} owner
 * @param {(stage: string) => boolean} ready  czy ten krok ma czym działać
 * @returns {object}
 */
function publicSettings(settings, owner, ready = () => true) {
  if (owner) return { ...settings, owner: true, enginesReady: true };

  const strip = (stage) => {
    const { provider, model, apiKey, ...rest } = settings?.[stage] ?? {};
    return rest;
  };

  return {
    ...settings,
    owner: false,
    stt: strip("stt"),
    sieve: strip("sieve"),
    shot: strip("shot"),
    enginesReady: ["stt", "sieve"].every((stage) => ready(stage)),
  };
}

/** Pola, których zapis od zwykłego użytkownika nie ma prawa ruszyć. */
const SEALED = ["provider", "model", "apiKey"];

/**
 * Zmiana ustawień okrojona do tego, co zwykłemu użytkownikowi wolno.
 *
 * Interfejs tych pól nie pokazuje, więc nie ma ich skąd wysłać — ale most
 * jest mostem i przez most da się wysłać cokolwiek. Odsiewamy więc drugi
 * raz, po stronie, która zapisuje.
 */
function sealPatch(patch, owner) {
  if (owner || !patch || typeof patch !== "object") return patch;
  const out = { ...patch };
  for (const stage of ["stt", "sieve", "shot"]) {
    if (!out[stage] || typeof out[stage] !== "object") continue;
    const step = { ...out[stage] };
    for (const field of SEALED) delete step[field];
    if (Object.keys(step).length) out[stage] = step;
    else delete out[stage];
  }
  return out;
}

/**
 * Komunikat bez nazw dostawców i modeli.
 *
 * Awaria potrafi powiedzieć więcej niż całe Ustawienia: „Brak klucza API
 * dla dostawcy «gemini»" wymienia dostawcę, a „429 z api.openai.com" —
 * i dostawcę, i to, kto płaci. Dla zwykłego użytkownika zamieniamy te
 * nazwy na jedno słowo, zostawiając resztę zdania nietkniętą: ma nadal
 * mówić, CO się nie udało.
 */
const NAMES =
  /\b(gemini[\w.-]*|google gemini|openai|open ai|anthropic|claude[\w.-]*|gpt[\w.-]*|whisper[\w.-]*|aistudio|generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com)\b/gi;

function scrub(message, owner) {
  if (owner) return message;
  return (
    String(message ?? "")
      .replace(NAMES, "silnik")
      /* Podmiana zostawia po sobie polszczyznę, którą trzeba domknąć:
         „dostawcy «silnik»" i „z silnik" to zdania, których nikt nie
         napisał ręką. Komunikat ma nadal brzmieć jak zdanie — inaczej sam
         wygląda na awarię. */
      .replace(/dostawc(?:y|a|ę|ą|ę)\s*[„"']?silnik[”"']?/gi, "silnika")
      .replace(/\bz\s+silnik\b/gi, "z silnikiem")
      .replace(/\b(do|od|dla)\s+silnik\b/gi, "$1 silnika")
      .replace(/\bsilnik(?:\s+silnik)+\b/gi, "silnik")
      // Dwa razy to samo słowo obok siebie („silnik v1") nie niesie nic.
      .replace(/\bsilnik\s+v\d+\b/gi, "silnik")
      // Zdanie zaczyna się wielką literą także po podmianie.
      .replace(/(^|[.!?]\s+)silnik/g, (_, before) => `${before}Silnik`)
  );
}

module.exports = { OWNERS, MARK, isOwner, ownerEmail, publicSettings, sealPatch, scrub, SEALED };
