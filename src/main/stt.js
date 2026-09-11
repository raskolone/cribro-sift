"use strict";

const { keyFor } = require("./providers");
const { directive, fixedCode, whisperHint } = require("./languages");
const aiRegistry = require("./ai-registry");

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

async function dispatchWithProtection(dispatchFn) {
  let firstAttemptOut = null;
  return withRetry(async (attempt = 1) => {
    const temperature = attempt > 1 ? 0.4 : 0.1;
    const out = await dispatchFn({ temperature, attempt });
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

  const primaryProvider = provider || "gemini";
  const primaryModel =
    model ||
    (primaryProvider === "deepgram"
      ? "nova-3"
      : primaryProvider === "gemini"
        ? "gemini-3.1-flash-lite"
        : "whisper-1");
  const primaryKey = keyFor(primaryProvider, settings);

  // Budujemy łańcuch prób: Główny -> Deepgram -> OpenAI -> Groq -> Gemini
  const tiers = [
    {
      provider: primaryProvider,
      model: primaryModel,
      apiKey: primaryKey,
      isFallback: false,
    },
  ];

  if (primaryProvider !== "deepgram") {
    const dgModel = settings.stt?.deepgramModel || "nova-3";
    const dgKey = keyFor("deepgram", settings);
    if (dgKey) {
      tiers.push({
        provider: "deepgram",
        model: dgModel,
        apiKey: dgKey,
        isFallback: true,
      });
    }
  }

  if (primaryProvider !== "openai") {
    const fbModel = settings.stt?.fallbackModel || "whisper-1";
    const fbKey = keyFor("openai", settings);
    tiers.push({
      provider: "openai",
      model: fbModel,
      apiKey: fbKey,
      isFallback: true,
    });
  }

  if (primaryProvider !== "groq") {
    const groqModel = settings.stt?.groqModel || "whisper-large-v3-turbo";
    const groqKey = keyFor("groq", settings);
    tiers.push({
      provider: "groq",
      model: groqModel,
      apiKey: groqKey,
      isFallback: true,
    });
  }

  if (primaryProvider !== "gemini") {
    const geminiKey = keyFor("gemini", settings);
    if (geminiKey) {
      tiers.push({
        provider: "gemini",
        model: "gemini-3.1-flash-lite",
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
          return geminiTranscribe(audio, tier.model, tier.apiKey, language, about, opts);
        }
        if (tier.provider === "openai") {
          return openaiTranscribe(audio, tier.model, tier.apiKey, language, about, opts);
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
  const hint = `\n\n${directive(language)}${hintFor(about)}`;
  const temperature = Number.isFinite(options?.temperature) ? options.temperature : 0.1;

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
      /* Ochrona przed zapętleniem transkrypcji:
         - temperature: 0.1 (lub 0.4 przy retry), aby uniknąć deterministycznego zacięcia greedy
         - maxOutputTokens: 4096 (zamiast 32k tokenów, które blokowały sieć na 2.5 minuty)
         - presencePenalty i frequencyPenalty: penalizują powtarzanie tych samych tokenów w próbkowaniu */
      generationConfig: {
        temperature,
        maxOutputTokens: 4096,
        presencePenalty: 0.3,
        frequencyPenalty: 0.3,
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

async function openaiTranscribe(audio, model, apiKey, language, about, options = {}) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (Number.isFinite(options?.temperature)) {
    form.append("temperature", String(options.temperature));
  }

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
  return { text: (data.text ?? "").trim(), provider: "groq", model: model || "whisper-large-v3-turbo" };
}

async function deepgramTranscribe(audio, model, apiKey, language, about, options = {}) {
  const modelName = model || "nova-3";
  const code = fixedCode(language) || "pl";
  const urlObj = new URL(DEEPGRAM_URL);
  urlObj.searchParams.set("model", modelName);
  urlObj.searchParams.set("smart_format", "true");
  urlObj.searchParams.set("punctuate", "true");

  if (language?.mode === "bilingual") {
    urlObj.searchParams.set("detect_language", "true");
  } else {
    urlObj.searchParams.set("language", code);
  }

  const names = (about?.glossary ?? []).filter(Boolean);
  for (const name of names.slice(0, 50)) {
    urlObj.searchParams.append("keywords", `${name}:2`);
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
  const transcript =
    data.results?.channels?.[0]?.alternatives?.[0]?.transcript ??
    data.results?.channels?.[0]?.alternatives?.[0]?.words?.map((w) => w.word).join(" ") ??
    "";

  return {
    text: transcript.trim(),
    provider: "deepgram",
    model: modelName,
  };
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
  openaiTranscribe,
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
};

