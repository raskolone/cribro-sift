"use strict";

const { keyFor } = require("./providers");
const { directive, fixedCode, whisperHint } = require("./languages");

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
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
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
  const msg = String(error?.message || error || "");
  if (/nie odpowiedział w \d+ s/.test(msg)) return true; // nasz własny czas z fetchWithin
  if (/zwrócił błąd (429|500|502|503|504)\b/.test(msg)) return true;
  if (/przekroczony limit zapytań/.test(msg)) return true;
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
    return await run();
  } catch (error) {
    if (!isTransient(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    return await run();
  }
}

const VERBATIM_PROMPT = `Zapisz dokładnie to, co słychać w nagraniu.

Zasady:
- Przepisz mowę wiernie, słowo w słowo, razem z wahaniami („yyy", „eee", „no"), powtórzeniami i urwanymi zdaniami.
- Nie poprawiaj, nie skracaj, nie porządkuj. Od tego jest następny krok.
- Nie dodawaj nic od siebie: żadnych nagłówków, komentarzy, cudzysłowów ani znaczników czasu.
- Zachowaj język, w którym mówiono. Wtrącenia z innego języka zostaw w oryginale.
- Jeśli w nagraniu nie ma mowy, zwróć pusty tekst.

Zwróć wyłącznie treść wypowiedzi.`;

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
  const names = (about?.glossary ?? []).filter(Boolean);
  if (names.length) {
    parts.push(`Nazwy własne, które mogą paść: ${names.join(", ")}. Zapisuj je dokładnie tak.`);
  }
  const before = String(about?.context ?? "").trim();
  if (before) {
    parts.push(
      `Poprzedni fragment tej samej wypowiedzi kończył się tak: „…${before}". To jest KONTEKST, nie treść — nie przepisuj go ponownie.`,
    );
  }
  return parts.length ? `\n\n${parts.join("\n")}` : "";
}

async function transcribe(audio, settings, about = null) {
  const { provider, model } = settings.stt;
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

  const apiKey = keyFor(provider, settings);
  if (!apiKey) throw new Error(`Brak klucza API dla dostawcy „${provider}".`);

  const dispatch =
    provider === "gemini"
      ? () => geminiTranscribe(audio, model, apiKey, language, about)
      : provider === "openai"
        ? () => openaiTranscribe(audio, model, apiKey, language, about)
        : null;
  if (!dispatch) throw new Error(`Nieznany dostawca transkrypcji: ${provider}`);

  return withRetry(async () => {
    const out = await dispatch();
    const looped = loopedTranscript(out.text);
    if (looped) {
      /* Rzucamy, zamiast oddać tekst: zapętlona odpowiedź nie jest gorszą
         transkrypcją, tylko żadną — a zapisana w historii psuje potem całą
         listę (patrz komentarz przy loopedTranscript). */
      const error = new Error(`Transkrypcja się zapętliła — ${looped}.`);
      error.kind = "zapętlenie";
      throw error;
    }
    return out;
  });
}

async function geminiTranscribe(audio, model, apiKey, language, about) {
  const hint = `\n\n${directive(language)}${hintFor(about)}`;

  const response = await fetchWithin(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: VERBATIM_PROMPT + hint },
            { inlineData: { mimeType: "audio/wav", data: audio.toString("base64") } },
          ],
        },
      ],
      // Zero temperatury: transkrypcja to odczyt, nie twórczość.
      generationConfig: { temperature: 0 },
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

async function openaiTranscribe(audio, model, apiKey, language, about) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  form.append("model", model);
  form.append("response_format", "json");

  // Kod języka tylko wtedy, gdy język jest jeden. Narzucony przy dwóch
  // językach kazałby Whisperowi zmielić drugi na pierwszy — czyli dokładnie
  // to, czego dwujęzyczne dyktowanie ma unikać.
  const code = fixedCode(language);
  if (code) form.append("language", code);
  /* Whisper ma na to własne pole i jest ono dokładnie tym: podpowiedzią
     o brzmieniu nazw i o tym, co padło przed chwilą. */
  const hint = [whisperHint(language), hintFor(about).trim()].filter(Boolean).join(" ");
  if (hint) form.append("prompt", hint);

  const response = await fetchWithin(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) throw new Error(await describeError(response, "OpenAI"));

  const data = await response.json();
  return { text: (data.text ?? "").trim(), provider: "openai", model };
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
  describeError,
  hintFor,
  fetchWithin,
  DEADLINE,
  isTransient,
  withRetry,
  loopedTranscript,
};
