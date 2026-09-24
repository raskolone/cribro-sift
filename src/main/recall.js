"use strict";

/**
 * Zapis rozmowy → lekcja w Cribro Recall.
 *
 * Bez SDK, na samym fetch — tak samo jak Notion (main/notion.js) i Supabase
 * (main/supabase.js). Powód jest ten sam: całe API, którego tu potrzeba, to
 * jeden adres i dwa nagłówki.
 *
 * ══ DLACZEGO WPROST DO RECALL, A NIE PRZEZ SUPABASE ══
 *
 * Supabase w tej aplikacji trzyma konta i notatki. Zapisy spotkań nie jadą
 * tam wcale i nie mają tam jechać (patrz komentarz na początku
 * supabase/schema.sql) — historia rozmów zostaje na dysku. Przepuszczenie
 * transkrypcji przez Supabase oznaczałoby więc najpierw zbudowanie dla niej
 * miejsca tam, a potem drugiego mostu dalej. Recall potrzebuje jednego
 * skoku, a zapis rozmowy nie zostaje po drodze w żadnej trzeciej bazie.
 *
 * ══ CO WYCHODZI, A CO ZOSTAJE ══
 *
 * Wychodzi tekst zapisu rozmowy (liveTranscript), identyfikatory oraz
 * wygenerowana analiza metodyczna (analysis), komu go przypisać. Nagranie
 * nie wychodzi nigdy — ani tu, ani nigdzie indziej.
 *
 * ══ WYSYŁKA JEST KLIKNIĘCIEM, NIE AUTOMATEM ══
 *
 * Nic nie wychodzi samo. Zapis rozmowy z lekcji jest nagraniem drugiego
 * człowieka; decyzja, że ta konkretna rozmowa ma trafić do jego historii
 * lekcji, należy do lektora i zapada za każdym razem osobno. Automatyczna
 * wysyłka „wszystkiego, co się nagrało" byłaby wysyłką także tego, co
 * nagrało się przypadkiem.
 *
 * ══ PONOWNA WYSYŁKA ══
 *
 * Znaczy „ta sama lekcja ma nowy zapis", nie „zrób drugą lekcję obok".
 * Recall rozpoznaje sesję po siftSessionId (czyli po identyfikatorze
 * spotkania z tego komputera) i podmienia transkrypcję w istniejącej lekcji.
 * Dlatego przepisanie nagrania jeszcze raz i wysłanie go ponownie jest
 * bezpieczne.
 */

const { transcriptText } = require("./digest");
const { keyFor } = require("./providers");
const { analyzeLessonTranscript } = require("./lesson-analysis");

/* Ten sam sufit, który stoi po stronie Recall (reguły Firestore i punkt
   odbioru). Ucięcie tutaj daje zrozumiały komunikat zamiast odpowiedzi 413
   po przesłaniu pół megabajta. */
const MAX_TRANSCRIPT = 500_000;
/* Zapas na metadane i na to, że ucinanie liczy znaki, a sufit dotyczy
   tego, co dojdzie na drugą stronę. */
const SEND_CAP = 490_000;

/* Żądanie idzie przez sieć do funkcji, która budzi się z zimna. */
const DEADLINE = 60_000;

/** Czy w ustawieniach jest wszystko, co potrzebne do wysyłki. */
function configured(settings = {}) {
  const cfg = settings.recall ?? {};
  return Boolean(String(cfg.url ?? "").trim() && String(cfg.token ?? "").trim());
}

/**
 * Adres punktu odbioru, znormalizowany.
 *
 * Do wklejenia jest adres funkcji, a ludzie wklejają go ze znakiem „/" na
 * końcu, ze spacją i czasem bez schematu. To nie jest powód, żeby wysyłka
 * nie działała.
 */
function endpoint(raw) {
  let url = String(raw ?? "").trim();
  if (!url) throw new Error("Brak adresu punktu odbioru w Ustawieniach.");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  url = url.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(url)) {
    // Token jedzie w nagłówku, więc po http wyszedłby otwartym tekstem.
    throw new Error("Adres musi być po https.");
  }
  return url;
}

/** Data spotkania jako YYYY-MM-DD w strefie tego komputera. */
function localDay(at) {
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate());
}

/**
 * Zapis rozmowy jako tekst do wysłania.
 *
 * Zostawiamy znaczniki czasu i mówiących — to z nich Recall pozna, kto
 * powiedział zdanie z błędem, a bez tego „he don't know" jest zdaniem
 * niczyim i nie ma czego poprawiać.
 */
function transcriptFor(meeting) {
  const text = transcriptText(meeting?.transcript, { cap: SEND_CAP }).trim();
  if (!text) throw new Error("To spotkanie nie ma jeszcze zapisu rozmowy.");
  if (text.length > MAX_TRANSCRIPT) throw new Error("Zapis rozmowy jest za długi.");
  return text;
}

/**
 * Wysyłka jednego spotkania wraz z opcjonalną analizą metodyczną.
 *
 * @param {object} args
 * @param {object} args.settings     ustawienia aplikacji (czyta recall oraz klucze API)
 * @param {object} args.meeting      wpis spotkania ze sklepu
 * @param {string} args.studentEmail adres kursanta w Recall
 * @param {string} [args.topic]      temat lekcji; domyślnie tytuł spotkania lub temat z analizy
 * @param {object} [args.analysis]   gotowy obiekt analizy lekcji (opcjonalny)
 * @param {boolean} [args.skipAnalysis] czy pominąć analizę przez Gemini (np. w testach)
 * @returns {Promise<{lessonId: string, studentUid: string, action: string, analysis?: object}>}
 */
async function send({ settings = {}, meeting, studentEmail, topic, analysis, skipAnalysis = false } = {}) {
  const cfg = settings.recall ?? {};
  const url = endpoint(cfg.url);
  const token = String(cfg.token ?? "").trim();
  if (!token) throw new Error("Brak tokena wysyłki w Ustawieniach.");

  const email = String(studentEmail ?? "").trim();
  if (!email || !email.includes("@")) throw new Error("Podaj adres e-mail kursanta.");
  if (!meeting?.id) throw new Error("Nie wiadomo, które spotkanie wysłać.");

  const transcript = transcriptFor(meeting);

  let lessonAnalysis = analysis ?? null;
  if (!lessonAnalysis && !skipAnalysis) {
    const geminiKey = keyFor("gemini", settings);
    if (geminiKey) {
      try {
        lessonAnalysis = await analyzeLessonTranscript(transcript, { apiKey: geminiKey });
      } catch (err) {
        console.warn("[Recall] Analiza transkrypcji przez Gemini nie powiodła się:", err?.message || err);
      }
    }
  }

  const determinedTopic = String(topic ?? lessonAnalysis?.topic ?? meeting.title ?? "").trim() || undefined;

  const body = {
    siftSessionId: meeting.id,
    transcript,
    liveTranscript: transcript,
    studentEmail: email,
    date: localDay(meeting.at),
    topic: determinedTopic,
  };
  if (lessonAnalysis) {
    body.analysis = lessonAnalysis;
  }
  if (!body.date) delete body.date;

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), DEADLINE);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        /* Token w WŁASNYM nagłówku, nie w Authorization.

           Funkcje Firebase drugiej generacji stoją na Cloud Run, a ten sam
           przechwytuje nagłówek Authorization: Bearer … i próbuje
           zweryfikować go jako token Google. Nasz token nim nie jest, więc
           brama odpowiada stroną HTML „401 Unauthorized", a do funkcji nie
           dochodzi nic — sprawdzone na wdrożonej funkcji 2026-09-13. Ta sama
           wysyłka bez tego nagłówka dochodzi bez problemu. */
        "x-sift-token": token,
      },
      body: JSON.stringify(body),
      signal: stop.signal,
    });
  } catch (problem) {
    if (problem?.name === "AbortError") throw new Error("Recall nie odpowiedział w 60 s.");
    throw new Error("Nie udało się połączyć z Recall: " + problem.message);
  } finally {
    clearTimeout(timer);
  }

  /* Odpowiedź czytamy jako tekst i dopiero próbujemy rozebrać — funkcja
     potrafi zwrócić stronę błędu Google (HTML), a wtedy json() rzuca
     wyjątkiem o składni zamiast powiedzieć, co się stało. */
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok || !data?.ok) {
    const detail = data?.error || raw.slice(0, 200) || "HTTP " + response.status;
    if (response.status === 401) throw new Error("Recall odrzucił token wysyłki.");
    if (response.status === 404) throw new Error("Recall nie zna kursanta: " + email);
    throw new Error("Recall odmówił: " + detail);
  }

  return {
    lessonId: data.lessonId,
    studentUid: data.studentUid,
    action: data.action,
    analysis: lessonAnalysis,
  };
}

module.exports = {
  send,
  configured,
  endpoint,
  localDay,
  transcriptFor,
  MAX_TRANSCRIPT,
  analyzeLessonTranscript,
};
