"use strict";

const { keyFor } = require("./providers");
const { directive, fixedCode, whisperHint } = require("./languages");
const aiRegistry = require("./ai-registry");
const { weightedKeywords, glossaryNames } = require("./glossary");

/**
 * Krok 1 — głos na tekst.
 *
 * Transkrypcja ma być WIERNA: zacięcia, powtórzenia i „yyy" mają zostać.
 * Czyszczeniem zajmuje się dopiero sito, w osobnym wywołaniu. Dzięki temu
 * widać potem w historii, co dokładnie odpadło.
 *
 * Nagranie przychodzi jako WAV 16 kHz mono — format, który przyjmują
 * wszyscy dostawcy bez konwersji.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const MAX_INLINE_BYTES = 18 * 1024 * 1024; // Gemini przyjmuje 20 MB na całe żądanie

/**
 * Po ilu milisekundach przerywamy żądanie, które zamilkło.
 *
 * ══ FETCH SAM Z SIEBIE NIE MA KOŃCA ══
 *
 * Połączenie nawiązane i porzucone — komputer uśpiony w połowie wysyłki,
 * Wi-Fi zamienione na sieć komórkową, serwer trzymający otwarte gniazdo
 * bez odpowiedzi — wisi wtedy, dopóki ktoś go nie zamknie. Nie jest to
 * przypadek teoretyczny: dwie minuty dźwięku to pięć megabajtów wysyłki,
 * a spotkania trwają dokładnie tyle, ile trwa laptop przenoszony między
 * pokojami.
 *
 * Bez tego limitu takie żądanie zatrzymywało w spotkaniach WSZYSTKO, co
 * jest po nim: zamknięcie wpisu, notatkę, podsumowanie i samo wyjście
 * z aplikacji (patrz PATIENCE w main/meeting.js).
 *
 * Trzy minuty, bo tyle wystarcza na najdłuższy odcinek wysyłany łączem
 * słabym, ale działającym — a przerwanie żądania, które JESZCZE by wróciło,
 * kosztuje pieniądze drugi raz.
 */
const DEADLINE = 180_000;

/**
 * `fetch` z terminem. Po nim połączenie jest ZRYWANE, a nie tylko przestajemy
 * na nie czekać — porzucone żądanie nadal wysyła megabajty i nadal kosztuje.
 */
async function fetchWithin(url, options, ms = DEADLINE) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: abort.signal });
  } catch (problem) {
    if (problem?.name === "AbortError") {
      throw new Error(`Dostawca nie odpowiedział w ${Math.round(ms / 1000)} s.`);
    }
    throw problem;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Czy błąd wskazuje na przekroczenie limitu zapytań (HTTP 429 / RESOURCE_EXHAUSTED).
 * W odróżnieniu od zwykłych usterek sieciowych, rate limit wymaga dłuższego
 * czasu na zresetowanie okna limitów u dostawcy (np. 15–60 s zamiast 1.5 s).
 */
function isRateLimit(error) {
  const msg = String(error?.message || error || "");
  if (/zwrócił błąd 429\b/i.test(msg)) return true;
  if (/przekroczony limit zapytań/i.test(msg)) return true;
  if (/\b429\b/.test(msg)) return true;
  if (/RESOURCE_EXHAUSTED/i.test(msg)) return true;
  return false;
}

/**
 * Usterki, po których ma sens spróbować jeszcze raz: sieć się potknęła,
 * limit żądań akurat minął, dostawca ma chwilową czkawkę. Klucz odrzucony
 * albo model, którego nie ma, nie znikną same po odczekaniu — te lecą dalej
 * bez ponawiania.
 */
function isTransient(error) {
  /* Zapętlenie jest LOSOWE — ten sam plik wysłany drugi raz zwykle wraca
     normalną transkrypcją, bo model generuje za każdym razem od nowa.
     Dlatego traktujemy je jak czkawkę sieci: jedna powtórka, a dopiero
     druga porażka z rzędu znaczy, że to nie pech. */
  if (error?.kind === "zapętlenie") return true;
  if (isRateLimit(error)) return true;
  const msg = String(error?.message || error || "");
  if (/nie odpowiedział w \d+ s/.test(msg)) return true; // nasz własny czas z fetchWithin
  if (/zwrócił błąd (500|502|503|504)\b/.test(msg)) return true;
  if (/fetch failed|network|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(msg)) return true;
  return false;
}

/* ══ ZAPĘTLONA TRANSKRYPCJA ══

   Model potrafi zaciąć się na jednym słowie i powtarzać je aż do własnego
   limitu odpowiedzi. Zdarzyło się to naprawdę: 7 września 2026, dwadzieścia
   trzy sekundy wahania („No, yyy, wiesz, no, yyy…") wróciły jako 32 765 słów,
   z czego 32 760 razy „no,". Model mielił to przez 143 sekundy — czyli sześć
   razy dłużej, niż trwało samo nagranie, i wciąż poniżej terminu z DEADLINE,
   więc nic tego nie przerwało.

   Taki wpis nie jest tylko bezużyteczny. Jest 131 kilobajtami, które potem
   przy KAŻDYM narysowaniu listy trzeba porównać słowo po słowie z surówką —
   i to on zamrażał okno na kilkanaście sekund (patrz sufit w js/diff.js;
   ten drugi próg jest po to, żeby takie coś w ogóle nie weszło do historii).

   Dwa sita, oba odporne na zwykłą wypowiedź:

     JEDNO SŁOWO NAD WSZYSTKIM   powyżej połowy tekstu. Nikt nie dyktuje
                                 dwustu słów, z których co drugie jest tym
                                 samym słowem.
     UBOGI SŁOWNIK               mniej niż jedno słowo na dwadzieścia jest
                                 nowe. Łapie zapętlenia, które krążą po
                                 kilku słowach („no, yyy, no, yyy…") i tym
                                 samym rozmywają pierwszy próg.

   Oba dotyczą wyłącznie tekstów DŁUGICH. Krótkie powtórzenie bywa prawdą —
   „tak, tak, tak" to zwykłe zniecierpliwienie, a nie usterka. */
const LOOP_MIN_WORDS = 200;
const LOOP_TOP_SHARE = 0.5;
const LOOP_VOCABULARY = 0.05;

/* ══ TRZECIE SITO: TO SAMO SŁOWO POD RZĄD ══

   Dwa progi wyżej liczą UDZIAŁ w całości, więc obudzą się dopiero przy
   dwustu słowach. Nastrojone są pod awarię z 7 września (32 765 słów) i pod
   nią działają — ale krótkiego zatrucia nie widzą wcale.

   Zmierzone na zajęciach: dziewięć razy pod rząd słowo „KONTEKST", czyli
   dziewięć słów. Przez oba progi przeszło to bez zatrzymania, bo dziewięć
   to mniej niż dwieście — i wylądowało w zapisie jako czyjaś wypowiedź.

   Pięć powtórzeń pod rząd wystarczy za dowód, niezależnie od długości
   tekstu. Nikt nie mówi tego samego słowa pięć razy z rzędu; „tak, tak, tak"
   to trzy i dlatego próg jest wyżej niż trzy. */
const LOOP_RUN = 5;

/**
 * Czy transkrypcja wygląda na zapętloną. Zwraca powód albo null.
 *
 * @param {string} text  tekst od dostawcy
 * @returns {string|null}
 */
function loopedTranscript(text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;

  /* Ciąg pod rząd sprawdzamy ZAWSZE, także w krótkim tekście — po to on
     tu jest. Porównanie bez interpunkcji i wielkości liter, bo model sypie
     powtórzenie raz z przecinkiem, raz bez. */
  const bare = (word) => word.toLowerCase().replace(/[.,;:!?…„”"'()\[\]—–-]/g, "");
  let run = 1;
  for (let at = 1; at < words.length; at += 1) {
    const same = bare(words[at]) && bare(words[at]) === bare(words[at - 1]);
    run = same ? run + 1 : 1;
    if (run >= LOOP_RUN) {
      return `dostawca powtórzył słowo „${bare(words[at])}" ${run} razy pod rząd`;
    }
  }

  if (words.length < LOOP_MIN_WORDS) return null;

  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);

  const [top, hits] = [...counts].reduce((best, pair) => (pair[1] > best[1] ? pair : best), ["", 0]);
  if (hits / words.length >= LOOP_TOP_SHARE) {
    return `dostawca zaciął się na słowie „${top}" i powtórzył je ${hits} razy`;
  }
  if (counts.size / words.length < LOOP_VOCABULARY) {
    return `dostawca kręcił się w kółko po ${counts.size} słowach przez ${words.length} słów`;
  }
  return null;
}

/**
 * Automatyczne zwijanie zapętlonych sekwencji w transkrypcji (Self-Healing).
 *
 * Gdy model wejdzie w deterministyczną pętlę i zacznie powtarzać pojedyncze
 * słowo lub całą frazę (np. "no," 32000 razy albo "no, yyy," 200 razy),
 * zwijamy powtórzenia do naturalnej liczby (1-2 wystąpienia).
 *
 * Dzięki temu zachowujemy pierwotną wypowiedź użytkownika, która padła
 * przed zacięciem modelu, zamiast wyrzucać błąd i niszczyć nagranie.
 *
 * @param {string} text
 * @returns {string}
 */
function collapseLoops(text) {
  if (!text || typeof text !== "string") return "";
  let s = text.trim();
  if (!s) return "";

  // Krok 1: Zwijanie wielosłownych n-gramów powtórzonych 3 lub więcej razy (od 8 słów do 1)
  for (let n = 8; n >= 1; n--) {
    const pattern = new RegExp(`((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1){2,}`, "giu");
    s = s.replace(pattern, "$1 $1");
  }

  // Krok 2: Zwijanie powtórzonych słów z drobnymi różnicami interpunkcyjnymi (np. "no, no, no, no.")
  s = s.replace(/([\p{L}\p{N}]+)(?:[,\s]+(?:\1)){3,}[.,?!]?/giu, (match, word) => {
    return `${word}, ${word}`;
  });

  return s.trim();
}

/**
 * Automatyczny bezpiecznik usuwający znaczniki czasu z tekstu transkrypcji.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeTranscript(text) {
  if (!text || typeof text !== "string") return "";
  let s = text;

  // Usuwanie znaczników w nawiasach kwadratowych i okrągłych: [0:03-0:10], (1:23)
  s = s.replace(/\[\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?\]/g, "");
  s = s.replace(/\(\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?\)/g, "");

  // Usuwanie wolnostojących przedziałów i znaczników czasowych: 0:03-0:10, 2:15
  s = s.replace(/\b\d{1,2}:\d{2}(?:-\d{1,2}:\d{2})?\b/g, "");

  // Usuwanie zbędnych spacji przed znakami interpunkcyjnymi (np. ' .' -> '.')
  s = s.replace(/\s+([.,;:!?…])/g, "$1");

  // Normalizacja wielokrotnych spacji do pojedynczej
  s = s.replace(/[^\S\r\n]+/g, " ");

  // Usuwanie spacji na początku lub końcu linii
  s = s.replace(/^[^\S\r\n]+|[^\S\r\n]+$/gm, "");

  // Normalizacja wielokrotnych pustych linii
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

const RETRY_DELAY = 2000;

/**
 * Jedno powtórzenie dla usterek, które same przechodzą.
 *
 * Bez tego krótkie zacięcie sieci — Wi-Fi przełączające punkt dostępu w
 * połowie wysyłki, chwilowy 503 u dostawcy — kończyło się utratą całego
 * nagrania, choć to samo żądanie, wysłane dwie sekundy później, przechodziło
 * bez problemu. Druga porażka z rzędu ma już inny powód niż pech, więc wtedy
 * błąd leci dalej — do main.js, gdzie trafia do ratunku (main/rescue.js).
 */
async function withRetry(run) {
  try {
    return await run(1);
  } catch (error) {
    if (!isTransient(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    return await run(2);
  }
}

const VERBATIM_PROMPT = `Zapisz dokładnie to, co słychać w nagraniu.

Zasady:
- Przepisz mowę wiernie, słowo w słowo, razem z wahaniami („yyy", „eee", „no"), powtórzeniami i urwanymi zdaniami.
- Nie poprawiaj, nie skracaj, nie porządkuj. Od tego jest następny krok.
- Nie dodawaj nic od siebie: żadnych nagłówków, komentarzy, cudzysłowów ani znaczników czasu.
- Zachowaj język, w którym mówiono. Wtrącenia z innego języka zostaw w oryginale.
- Jeśli w nagraniu nie ma mowy, zwróć pusty tekst.
- Kategorycznie nie zapętlaj ani nie powtarzaj w nieskończoność tych samych słów lub dźwięków. Gdy mowa ustała lub nagranie się urywa, zakończ odpowiedź.

Zwróć wyłącznie treść wypowiedzi.`;

/* ══ ZAJĘCIA TO NIE DYKTOWANIE ══

   Prompt wyżej powstał pod dyktowanie: jedna osoba, kilkanaście sekund,
   zdanie do wklejenia gdzie indziej. Zapis zajęć jest czym innym w każdym
   z tych trzech wymiarów i trzy rzeczy trzeba modelowi powiedzieć wprost,
   bo inaczej „poprawia" je z własnej inicjatywy:

     TERMIN ZOSTAJE TERMINEM   model, który nie zna słowa, podmienia je na
                               podobnie brzmiące i znane. Na zajęciach to
                               jest różnica między zapisem a bełkotem —
                               fachowe słowo jest tam treścią, nie ozdobą.
     LICZBA ZOSTAJE LICZBĄ     numer strony, rok, wzór, numer ćwiczenia.
                               Zaokrąglone albo zapisane słownie przestają
                               się do czegokolwiek odnosić.
     ZDANIE URWANE ZOSTAJE     na wykładzie zdania urywają się w pół i tak
                               ma zostać. Domknięte przez model wygląda jak
                               coś, co ktoś powiedział, a nie powiedział.

   Nie ma tu za to nic o wielu mówiących i to jest celowe: odcinek jedzie do
   modelu JEDNYM TOREM naraz (patrz main/meeting.js), więc pytanie „kto
   mówi" nie jest tu zadawane. Odpowiada na nie kabel i diaryzacja. */
const LECTURE_PROMPT = `Zapisz dokładnie to, co słychać w nagraniu zajęć.

Zasady:
- Przepisz mowę wiernie, słowo w słowo, razem z wahaniami, powtórzeniami i urwanymi zdaniami.
- Terminy fachowe, nazwy własne, tytuły i skróty zapisuj dokładnie tak, jak padły. Nie podmieniaj słowa, którego nie znasz, na podobnie brzmiące.
- Liczby, daty, numery stron, lata i wzory zapisuj dokładnie. Nie zaokrąglaj i nie przeliczaj.
- Zdania urwane w pół zostaw urwane. Nie domykaj ich za mówiącego.
- Nie poprawiaj, nie skracaj, nie porządkuj, nie streszczaj. Od tego jest następny krok.
- Nie dodawaj nic od siebie: żadnych nagłówków, komentarzy, cudzysłowów ani znaczników czasu.
- Zachowaj język, w którym mówiono. Wtrącenia z innego języka zostaw w oryginale.
- Jeśli w nagraniu nie ma mowy, zwróć pusty tekst.
- Kategorycznie nie zapętlaj ani nie powtarzaj w nieskończoność tych samych słów. Gdy mowa ustała, zakończ odpowiedź.

Zwróć wyłącznie treść wypowiedzi.`;

/** Który prompt dla tego materiału. Spotkanie ma swój, reszta dyktuje. */
const promptFor = (about) => (about?.kind === "meeting" ? LECTURE_PROMPT : VERBATIM_PROMPT);

/* ══ GEMINI AUDIO — TRANSKRYPCJA I SITO W JEDNYM WYWOŁANIU ══

   Prompty wyżej (VERBATIM_PROMPT, LECTURE_PROMPT) celowo trzymają się
   wiernego zapisu — sito (main/sieve.js) czyści dopiero potem, osobnym
   wywołaniem. Gemini jako GŁÓWNY silnik dyktowania robi to inaczej: model
   dostaje dźwięk i od razu oddaje gotowy, oczyszczony tekst, więc dalszy
   krok sita w potoku dyktowania (main.js#runPipeline) jest zbędny —
   dostawca już go wykonał.

   Dotyczy WYŁĄCZNIE dyktowania (patrz `about?.kind !== "meeting"` przy
   wywołaniu w transcribe() niżej). Zapis zajęć zostaje przy wiernym
   zapisie — tam sito nie tyle czyści, co scala wielu mówców i tego
   Gemini w locie zrobić nie umie. */
const GEMINI_AUDIO_PROMPT = `Jesteś precyzyjnym systemem transkrypcji mowy i asystentem produktywności Cribro Sift.
Twoim zadaniem jest dokładne spisanie mowy z nagrania audio w języku polskim.

Przepisz mowę dokładnie i bez zniekształceń w języku polskim. Bezwzględnie NIE dodawaj żadnych znaczników czasu (np. 0:00-0:10, 1:23), kodów czasowych, etykiet mówcy ani metadanych. Zwróć wyłącznie czysty, ciągły tekst wypowiedzi.

ZASADY:
- Zachowaj naturalne terminy techniczne i słownictwo angielskie bez fonetycznego spolszczania (np. „pull request”, „merge”, „feature”, „commit”, „deployment”, „endpoint”).
- Dodaj poprawną interpunkcję, wielkie litery i przejrzyste akapity.
- Usuń wahania, powtórzenia („ee”, „yy”) oraz zająknięcia.
- Bezwzględnie NIE dodawaj żadnych znaczników czasu (np. 0:00-0:10, 1:23), kodów czasowych, etykiet mówcy ani metadanych.
- Zwróć WYŁĄCZNIE oczyszczony tekst końcowy, bez żadnych wstępów, komentarzy ani cudzysłowów.`;

const MOCK_TRANSCRIPTS = [
  "yyy dobra to znaczy chciałem powiedzieć że eee ta funkcja z sitem no wiesz ona powinna działać tak że użytkownik trzyma dwa klawisze i mówi i potem yyy to znaczy jak puści to się kończy nagranie i tekst leci do schowka automatycznie",
  "hej Aniu eee chciałem zapytać czy dasz radę przesłać mi ten raport do piątku no to znaczy do czwartku bo w piątek mam już spotkanie z klientem i yyy potrzebuję to wcześniej przejrzeć dzięki wielkie",
  "no dobra więc plan na jutro jest taki że yyy po pierwsze robimy przegląd zgłoszeń potem eee to znaczy najpierw kawa a potem przegląd zgłoszeń no i po drugie musimy się zdecydować co robimy z tym starym API bo ono nam yyy leży i kwiczy",
];

/**
 * @param {Buffer} audio  bajty pliku WAV
 * @param {object} settings  całe ustawienia (potrzebne do współdzielenia klucza)
 * @returns {Promise<{text: string, provider: string, model: string}>}
 */
/**
 * Podpowiedź dla modelu: co padło przed chwilą i jakie nazwy własne są
 * w grze.
 *
 * To nie jest treść do przepisania i musi być tak nazwane, bo model
 * dostający sam tekst „na wejściu" chętnie dopisze go do odpowiedzi.
 * Ogon poprzedniego odcinka trzyma ciągłość zdania przeciętego na granicy,
 * a lista imion pilnuje, żeby „Ania" nie stała się „Hanią" w połowie
 * rozmowy — kalendarz wie, kto jest w pokoju (patrz main/agenda.js).
 */
function hintFor(about) {
  const parts = [];
  const names = glossaryNames(about?.glossary ?? []);
  if (names.length) {
    parts.push(`Nazwy własne, które mogą paść: ${names.join(", ")}. Zapisuj je dokładnie tak.`);
  }
  /* ══ OGONA POPRZEDNIEGO ODCINKA TU NIE MA — I TO JEST POPRAWKA PO AWARII ══

     Stał tu kiedyś taki akapit:

       „Poprzedni fragment tej samej wypowiedzi kończył się tak: «…{ogon}».
        To jest KONTEKST, nie treść — nie przepisuj go ponownie."

     Miał trzymać ciągłość imion między odcinkami. Robił co innego: model
     PRZEPISYWAŁ tę instrukcję jako wypowiedź. W zapisie zajęć stało zdanie
     „To jest KONTEKST, nie przepisuj go ponownie" podpisane rozmówcą, a obok
     dziewięć razy pod rząd samo słowo „KONTEKST" podpisane właścicielem
     konta — czyli zdania, których nikt nie powiedział, przypisane ludziom
     z imienia.

     NAKRĘCAŁO SIĘ TO SAMO. Ogon następnego odcinka bierze się z tekstu
     poprzedniego (patrz session.tails w main/meeting.js), więc raz przepisana
     instrukcja wracała do modelu jako kontekst i przepisywała się znowu.
     Jedno potknięcie zostawało do końca spotkania.

     Ciągłość między odcinkami i tak stoi na czymś pewniejszym niż zdanie
     w prompcie: na ZAKŁADCE DŹWIĘKOWEJ (OVERLAP w main/segments.js — każdy
     odcinek zaczyna się trzy sekundy przed końcem poprzedniego) i na zdjęciu
     powtórzenia przy splocie (trimRepeat w main/merge.js). Nazwy własne
     trzyma lista imion wyżej, która jest listą SŁÓW — a lista słów nie ma
     jak wrócić jako czyjaś wypowiedź.

     Gdyby kiedyś wracać do kontekstu tekstowego: nie tędy. Musiałby jechać
     osobnym polem protokołu (Deepgram ma `keywords`, Whisper ma `prompt`),
     a nie akapitem doklejonym do tego, co model ma przepisać. */
  return parts.length ? `\n\n${parts.join("\n")}` : "";
}

/* ══ ZDANIA, KTÓRYCH NIKT NIE POWIEDZIAŁ ══

   Druga linia obrony po zdjęciu ogona wyżej. Model potrafi przepisać własną
   instrukcję także bez naszej pomocy — wystarczy, że „usłyszy" ciszę i sięgnie
   po to, co ma przed oczami. Zdanie z promptu w zapisie rozmowy jest gorsze
   niż dziura: dziurę widać, a zmyślone zdanie podpisane czyimś imieniem
   wygląda dokładnie jak reszta zapisu.

   Szukamy fragmentów WŁASNEGO promptu, nie „podejrzanych sformułowań" —
   to jest zamknięta lista tego, co sami wysłaliśmy, więc nie ma jak trafić
   w prawdziwą wypowiedź. Jedyne ryzyko to ktoś czytający ten prompt na głos,
   a to nie jest sytuacja, którą trzeba obsłużyć.

   ══ WZORCE SĄ DOSŁOWNE, I TO NIE JEST PEDANTERIA ══

   Pierwsza wersja miała tu `/nie przepisuj/i` — krótko i, jak się wydawało,
   celnie. Test złapał na tym zdanie „Nie przepisujcie tego do zeszytu, to
   będzie na slajdach", czyli najzwyklejsze zdanie z zajęć. Sito, które
   wycina wypowiedzi prowadzącego, jest gorsze od usterki, którą naprawia:
   tamta zostawia w zapisie zdanie za dużo, to zabiera zdanie, które padło.

   Każdy wzorzec niżej jest więc CAŁĄ frazą z naszego promptu, a nie jej
   kawałkiem. Trafienie znaczy wtedy jedno: model oddał to, co dostał. */
const PROMPT_ECHO = [
  /\bKONTEKST\b/,
  /nie przepisuj go ponownie/i,
  /poprzedni fragment tej samej wypowiedzi/i,
  /zwróć wyłącznie treść wypowiedzi/i,
  /zapisz dokładnie to, co słychać w nagraniu/i,
  /nazwy własne, które mogą paść/i,
  /jeśli w nagraniu nie ma mowy, zwróć pusty tekst/i,
  /nie zapętlaj ani nie powtarzaj w nieskończoność/i,
  /precyzyjnym systemem transkrypcji mowy/i,
  /zwróć wyłącznie oczyszczony tekst końcowy/i,
];

/**
 * Czy model oddał kawałek instrukcji zamiast transkrypcji.
 *
 * @param {string} text
 * @returns {string|null}  powód albo null
 */
function echoedPrompt(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return null;
  for (const pattern of PROMPT_ECHO) {
    if (pattern.test(clean)) return `model przepisał instrukcję („${clean.slice(0, 60)}…")`;
  }
  return null;
}

async function dispatchWithProtection(dispatchFn) {
  let firstAttemptOut = null;
  return withRetry(async (attempt = 1) => {
    const temperature = attempt > 1 ? 0.4 : 0.1;
    const out = await dispatchFn({ temperature, attempt });

    /* Instrukcja przepisana zamiast dźwięku. Sprawdzane PRZED pętlą, bo to
       jest inna usterka i inaczej się ją naprawia: pętlę da się zwinąć
       (collapseLoops), przepisanej instrukcji nie da się uratować — nie ma
       pod nią żadnej prawdziwej wypowiedzi. Odcinek wraca pusty, czyli
       „nic nie padło", zamiast wnosić do zapisu cudze zdanie.

       Drugie podejście dostaje szansę, bo model generuje za każdym razem
       od nowa i ta sama próbka zwykle wraca normalnie. */
    const echo = echoedPrompt(out.text);
    if (echo) {
      if (attempt === 1) {
        const error = new Error(`Transkrypcja oddała instrukcję — ${echo}.`);
        error.kind = "zapętlenie";
        throw error;
      }
      return { ...out, text: "", promptEcho: echo };
    }

    const looped = loopedTranscript(out.text);
    if (looped) {
      if (attempt === 1) {
        firstAttemptOut = out;
        const error = new Error(`Transkrypcja się zapętliła — ${looped}.`);
        error.kind = "zapętlenie";
        throw error;
      }
      const healed = collapseLoops(out.text) || (firstAttemptOut ? collapseLoops(firstAttemptOut.text) : "");
      if (healed && !loopedTranscript(healed)) {
        return { ...out, text: healed, loopHealed: true };
      }
      const error = new Error(`Transkrypcja się zapętliła — ${looped}.`);
      error.kind = "zapętlenie";
      throw error;
    }
    if (out && typeof out.text === "string") {
      out.text = sanitizeTranscript(out.text);
    }
    return out;
  });
}

async function transcribe(audio, settings, about = null) {
  const { provider, model } = settings.stt ?? {};
  const language = settings.language;

  if (provider === "mock") {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const pick = MOCK_TRANSCRIPTS[Math.floor(Math.random() * MOCK_TRANSCRIPTS.length)];
    return { text: pick, provider, model: "mock" };
  }

  if (audio.length > MAX_INLINE_BYTES) {
    throw new Error(
      `Nagranie jest za długie (${Math.round(audio.length / 1024 / 1024)} MB). Podziel je na krótsze fragmenty.`,
    );
  }

  const primaryProvider = provider || "deepgram";
  const primaryModel = model || "nova-3";
  const primaryKey = keyFor(primaryProvider, settings);

  // Budujemy hierarchię prób: Deepgram Nova-3 -> Deepgram Nova-2 -> Gemini
  const tiers = [
    {
      provider: primaryProvider,
      model: primaryModel,
      apiKey: primaryKey,
      isFallback: false,
    },
  ];

  // Jeśli główny to Deepgram Nova-3, dodajemy drugi model Deepgram (Nova-2) jako pierwszy fallback
  if (primaryProvider === "deepgram") {
    const dgSecondaryModel = primaryModel === "nova-3" ? "nova-2" : "nova-3";
    if (primaryKey) {
      tiers.push({
        provider: "deepgram",
        model: dgSecondaryModel,
        apiKey: primaryKey,
        isFallback: true,
      });
    }
  } else {
    const dgKey = keyFor("deepgram", settings);
    if (dgKey) {
      tiers.push({
        provider: "deepgram",
        model: "nova-3",
        apiKey: dgKey,
        isFallback: true,
      });
    }
  }

  if (primaryProvider !== "gemini") {
    const geminiKey = keyFor("gemini", settings);
    if (geminiKey) {
      tiers.push({
        provider: "gemini",
        model: "gemini-2.5-flash",
        apiKey: geminiKey,
        isFallback: true,
      });
    }
  }

  let firstError = null;
  const errors = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];

    if (!tier.apiKey) {
      if (!tier.isFallback) {
        firstError = new Error(`Brak klucza API dla dostawcy „${tier.provider}”.`);
        errors.push(firstError);
      }
      continue;
    }

    const req = aiRegistry.start({
      stage: "stt",
      stageLabel: "Transkrypcja",
      provider: tier.provider,
      model: tier.model,
      isFallback: tier.isFallback,
      inputInfo: `${Math.round(audio.length / 1024)} kB WAV`,
    });

    try {
      const dispatchFn = (opts) => {
        if (tier.provider === "deepgram") {
          return deepgramTranscribe(audio, tier.model, tier.apiKey, language, about, opts);
        }
        if (tier.provider === "gemini") {
          // Główny silnik dyktowania (nie spotkanie, nie fallback) dostaje
          // wariant, który transkrybuje i czyści tekst w jednym wywołaniu —
          // patrz GEMINI_AUDIO_PROMPT. Spotkania i tiery zapasowe zostają
          // przy wiernym zapisie, bo dalszy potok wciąż na niego liczy
          // (diaryzacja, sito).
          if (!tier.isFallback && about?.kind !== "meeting") {
            return geminiTranscribeAudio(audio, tier.model, tier.apiKey, language, about, opts);
          }
          return geminiTranscribe(audio, tier.model, tier.apiKey, language, about, opts);
        }
        if (tier.provider === "groq") {
          return groqTranscribe(audio, tier.model, tier.apiKey, language, about, opts);
        }
        throw new Error(`Nieznany dostawca transkrypcji: ${tier.provider}`);
      };

      const out = await dispatchWithProtection(dispatchFn);

      // Sprawdzenie na fałszywą ciszę (pusty tekst przy nagraniu z wyraźnym dźwiękiem > 32 kB):
      const emptyOnSound = !out?.text?.trim() && audio.length > 32000;
      if (emptyOnSound) {
        const hasNextWithKey = tiers.slice(i + 1).some((t) => t.apiKey);
        if (hasNextWithKey) {
          const silenceErr = new Error(`Dostawca ${tier.provider} zwrócił pusty tekst mimo dźwięku`);
          req.failure({ error: silenceErr, outputInfo: "Pusta odpowiedź mimo dźwięku" });
          errors.push(silenceErr);
          if (!firstError) firstError = silenceErr;
          continue;
        }
      }

      req.success({
        statusCode: 200,
        outputInfo: `${out?.text?.length ?? 0} znaków`,
        textPreview: out?.text ?? "",
      });

      if (tier.isFallback) {
        return {
          ...out,
          fallback: true,
          primaryProvider,
          primaryError: firstError ? (firstError.message || String(firstError)) : null,
        };
      }
      return out;
    } catch (err) {
      req.failure({ error: err, outputInfo: err.message });
      errors.push(err);
      if (!firstError) firstError = err;
    }
  }

  if (firstError) {
    if (errors.length > 1) {
      const summary = errors.map((e) => e.message || String(e)).join(" | ");
      const combined = new Error(`Wszystkie próby transkrypcji nie powiodły się: ${summary}`);
      combined.primaryError = firstError;
      combined.errors = errors;
      throw combined;
    }
    throw firstError;
  }

  throw new Error(`Brak klucza API dla dostawcy „${primaryProvider}”.`);
}

async function geminiTranscribe(audio, model, apiKey, language, about, options = {}) {
  const cleanKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const hint = `\n\n${directive(language)}${hintFor(about)}`;
  const temperature = Number.isFinite(options?.temperature) ? options.temperature : 0.1;

  const url = cleanKey
    ? `${GEMINI_URL}/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`
    : `${GEMINI_URL}/${model}:generateContent`;

  const response = await fetchWithin(url, {
    method: "POST",
    headers: { "x-goog-api-key": cleanKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: promptFor(about) + hint },
            { inlineData: { mimeType: "audio/wav", data: audio.toString("base64") } },
          ],
        },
      ],
      /* Ochrona przed zapętleniem transkrypcji:
         - temperature: 0.1 (lub 0.4 przy retry), aby uniknąć deterministycznego zacięcia greedy
         - maxOutputTokens: 4096 (zamiast 32k tokenów, które blokowały sieć na 2.5 minuty) */
      generationConfig: {
        temperature,
        maxOutputTokens: 4096,
      },
    }),
  });

  if (!response.ok) throw new Error(await describeError(response, "Gemini"));

  const data = await response.json();
  const blocked = data.promptFeedback?.blockReason;
  if (blocked) throw new Error(`Gemini odrzucił nagranie (${blocked}).`);

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  return { text, provider: "gemini", model };
}

/**
 * Gemini jako główny silnik dyktowania: transkrypcja i czyszczenie językowe
 * w JEDNYM wywołaniu multimodalnym (patrz GEMINI_AUDIO_PROMPT wyżej).
 * Wynik ma `cleaned: true` — main.js#runPipeline czyta tę flagę i pomija
 * dalszy krok sita, bo dostawca już go wykonał.
 *
 * `thinkingBudget: 0` wyłącza bufor myślenia (transkrypcja nie potrzebuje
 * rozumowania, tylko szybkiej odpowiedzi), `temperature: 0.1` trzyma model
 * blisko tego, co naprawdę usłyszał.
 */
async function geminiTranscribeAudio(audio, model, apiKey, language, about, options = {}) {
  const cleanKey = typeof apiKey === "string" ? apiKey.trim() : "";
  const hint = `\n\n${directive(language)}${hintFor(about)}`;
  const temperature = Number.isFinite(options?.temperature) ? options.temperature : 0.1;

  const url = cleanKey
    ? `${GEMINI_URL}/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`
    : `${GEMINI_URL}/${model}:generateContent`;

  const response = await fetchWithin(url, {
    method: "POST",
    headers: { "x-goog-api-key": cleanKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: GEMINI_AUDIO_PROMPT + hint }] },
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "audio/wav", data: audio.toString("base64") } }],
        },
      ],
      generationConfig: {
        temperature,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!response.ok) throw new Error(await describeError(response, "Gemini"));

  const data = await response.json();
  const blocked = data.promptFeedback?.blockReason;
  if (blocked) throw new Error(`Gemini odrzucił nagranie (${blocked}).`);

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  return { text, provider: "gemini", model, cleaned: true };
}

async function groqTranscribe(audio, model, apiKey, language, about, options = {}) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  form.append("model", model || "whisper-large-v3-turbo");
  form.append("response_format", "json");
  if (Number.isFinite(options?.temperature)) {
    form.append("temperature", String(options.temperature));
  }

  const code = fixedCode(language);
  if (code) form.append("language", code);
  const hint = [whisperHint(language), hintFor(about).trim()].filter(Boolean).join(" ");
  if (hint) form.append("prompt", hint);

  const response = await fetchWithin(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) throw new Error(await describeError(response, "Groq"));

  const data = await response.json();
  return {
    text: (data.text ?? "").trim(),
    provider: "groq",
    model: model || "whisper-large-v3-turbo",
  };
}

/**
 * Rozbicie słów z diaryzacji na tury mówców.
 *
 * Deepgram oddaje przy `diarize=true` numer mówiącego PRZY KAŻDYM SŁOWIE.
 * Nam potrzebna jest tura — ciąg słów jednej osoby — bo zapis rozmowy składa
 * się z wypowiedzi, nie ze słów.
 *
 * Numer jest lokalny dla jednego żądania i to jest ważne przy czytaniu tego,
 * co z tego wychodzi: „mówca 0" w jednym odcinku nie musi być „mówcą 0"
 * w następnym. Zszywaniem numerów między odcinkami zajmuje się main/merge.js,
 * bo dopiero tam widać całe spotkanie.
 *
 * @returns {Array<{speaker:number, from:number, to:number, text:string}>}
 */
function turnsFrom(words) {
  const turns = [];
  for (const word of words ?? []) {
    const said = String(word?.punctuated_word ?? word?.word ?? "").trim();
    if (!said) continue;
    const who = Number.isFinite(word?.speaker) ? word.speaker : 0;
    const last = turns[turns.length - 1];
    if (last && last.speaker === who) {
      last.text = `${last.text} ${said}`;
      last.to = Number(word?.end ?? last.to);
      continue;
    }
    turns.push({
      speaker: who,
      from: Number(word?.start ?? 0),
      to: Number(word?.end ?? 0),
      text: said,
    });
  }
  return turns;
}

async function deepgramTranscribe(audio, model, apiKey, language, about, options = {}) {
  const modelName = model || "nova-3";
  const code = fixedCode(language) || "pl";
  const urlObj = new URL(DEEPGRAM_URL);
  urlObj.searchParams.set("model", modelName);
  urlObj.searchParams.set("smart_format", "true");
  urlObj.searchParams.set("punctuate", "true");

  /* ══ DIARYZACJA — TYLKO TAM, GDZIE JEST CO DZIELIĆ ══

     Tor mikrofonu ma jedną osobę i ta osoba jest znana z okablowania:
     to właściciel komputera. Puszczanie po nim diaryzacji nie tylko nic nie
     wnosi — MOŻE ZASZKODZIĆ, bo model, który dostał pytanie „ilu tu mówi",
     czasem odpowiada „dwóch" na jednym człowieku i pogłosie w pokoju.
     A „kto jest mną" to jedyna rzecz w tym module, która dziś jest pewna,
     i nie ma powodu zamieniać pewności sprzętowej na zgadywanie modelu.

     Tor systemu to co innego: tam siedzą wszyscy zdalni rozmówcy zmieszani
     w jedno wejście i bez diaryzacji trzy osoby na zajęciach zostają jedną
     etykietą „Rozmówcy". Dopiero tu numer mówiącego coś wnosi. */
  if (about?.diarize) urlObj.searchParams.set("diarize", "true");

  if (language?.mode === "bilingual") {
    urlObj.searchParams.set("detect_language", "true");
  } else {
    urlObj.searchParams.set("language", code);
  }

  const isNova3 = modelName.toLowerCase().includes("nova-3");
  const keywordParam = isNova3 ? "keyterm" : "keywords";
  for (const keyword of weightedKeywords(about?.glossary, 50)) {
    // Dla Nova-3 (keyterm) Deepgram nie przyjmuje wag :waga, tylko sam termin
    const term = isNova3 ? keyword.replace(/:\d+$/, "") : keyword;
    urlObj.searchParams.append(keywordParam, term);
  }

  const response = await fetchWithin(urlObj.toString(), {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "audio/wav",
    },
    body: audio,
  });

  if (!response.ok) throw new Error(await describeError(response, "Deepgram"));

  const data = await response.json();
  const best = data.results?.channels?.[0]?.alternatives?.[0] ?? {};
  const transcript = best.transcript ?? best.words?.map((w) => w.word).join(" ") ?? "";

  const out = {
    text: transcript.trim(),
    provider: "deepgram",
    model: modelName,
  };
  /* Tury jadą OBOK tekstu, a nie zamiast niego. Zapis ma powstać także
     wtedy, gdy diaryzacja nic nie zwróci — jedna etykieta na tor jest
     gorsza od trzech, ale nieporównanie lepsza od pustego odcinka. */
  if (about?.diarize) {
    const turns = turnsFrom(best.words);
    if (turns.length) out.turns = turns;
  }
  return out;
}

/** Komunikat, z którym da się cokolwiek zrobić, zamiast samego kodu HTTP. */
async function describeError(response, who) {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 240);
  try {
    detail = JSON.parse(body).error?.message ?? detail;
  } catch {
    /* nie każdy błąd jest JSON-em */
  }

  if (response.status === 401 || response.status === 403) {
    return `${who}: klucz API odrzucony (${response.status}). Sprawdź, czy wkleiłeś go w całości.`;
  }
  if (response.status === 404) {
    return `${who}: nie ma takiego modelu (404). Wybierz inny z listy w Ustawieniach.`;
  }
  if (response.status === 429) {
    return `${who}: przekroczony limit zapytań (429). Poczekaj chwilę i spróbuj ponownie.`;
  }
  return `${who} zwrócił błąd ${response.status}: ${detail}`;
}

module.exports = {
  transcribe,
  deepgramTranscribe,
  geminiTranscribe,
  geminiTranscribeAudio,
  groqTranscribe,
  describeError,
  hintFor,
  fetchWithin,
  DEADLINE,
  isTransient,
  isRateLimit,
  withRetry,
  loopedTranscript,
  collapseLoops,
  sanitizeTranscript,
  echoedPrompt,
  turnsFrom,
  promptFor,
  LECTURE_PROMPT,
  GEMINI_AUDIO_PROMPT,
};

