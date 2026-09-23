"use strict";

/**
 * Smart Inbox Triage — segregacja skrzynki (odebrane + wysłane), ucząca się
 * na Twoich decyzjach.
 *
 * DLACZEGO NIC SIĘ NIE USUWA SAMO. Sito w tym pliku tylko PROPONUJE —
 * dzieli nagłówki na kubełki i podaje powód przy każdym. Kasowanie
 * wymaga zaznaczenia w UI i kliknięcia przycisku (patrz mail:trashSelected
 * w main.js); tu nie ma ani jednej linijki, która by to robiła sama.
 *
 * DLACZEGO PAMIĘĆ JEST DOMENĄ, NIE MODELEM. „sender_domain → licznik
 * wyrzuceń" jest prostym słownikiem trzymanym w store.js. Model dostaje go
 * jako kontekst przy każdym pytaniu, ale to reguły lokalne (patrz
 * ruleFallback) rozstrzygają, gdy modelu nie ma pod ręką — dokładnie jak
 * w main/briefing.js, gdzie reguły też działają bez sieci.
 *
 * DLACZEGO ANOMALIA BIJE HISTORIĘ. Nadawca, którego zawsze się kasuje, może
 * raz napisać coś, czego kasować nie wolno — odpowiedź na wątek, pilny
 * problem, fakturę. Kontrakt z modelem (CONTRACT) i reguły lokalne obie
 * mówią to samo: historia ustawia PIERWSZE przypuszczenie, a nie ostatnie
 * słowo.
 *
 * DRUGA POŁOWA SKRZYNKI JEST WYCHODZĄCA. „Wymaga akcji" nie mówi nic o tym,
 * co JA wysłałem i na co jeszcze nie dostałem odpowiedzi — a to jest osobne
 * pytanie, na które osobno trzeba odpowiedzieć. Dlatego reguły lokalne
 * najpierw ZAWĘŻAJĄ wysłane maile do kandydatów (48h+, bez odpowiedzi,
 * z wyraźnym pytaniem albo ofertą) i dopiero te kilka jedzie do modelu —
 * cała reszta korespondencji wychodzącej nigdy nie opuszcza dysku.
 *
 * Ten plik jest czysty: wchodzą nagłówki i pamięć, wychodzi decyzja. Sieć
 * (wywołanie Gemini) i UI są gdzie indziej — main/main.js i renderer/js/
 * briefing.js. Sprawdza to zwykły Node, scripts/triage-test.js.
 */

const TRASH_CANDIDATE = "TRASH_CANDIDATE";
const GLANCE_ONLY = "GLANCE_ONLY";
const REQUIRES_ACTION = "REQUIRES_ACTION";
const AWAITING_REPLY = "AWAITING_REPLY";
const CATEGORIES = [TRASH_CANDIDATE, GLANCE_ONLY, REQUIRES_ACTION];

/** Ile nagłówków najwyżej wpuszczamy do modelu w jednym pytaniu. */
const MAX_HEADERS = 60;
/** Po ilu godzinach wysłany mail zaczyna „czekać" na odpowiedź. */
const AWAITING_HOURS = 48;

/* ── Adresy ─────────────────────────────────────────────────────── */

/** Sam adres z „Jan Kowalski <jan@example.com>". */
function addressOf(text) {
  const raw = String(text ?? "");
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim().toLowerCase();
}

/** Domena adresu — klucz pamięci. Pusta, gdy adresu nie da się rozpoznać. */
function domainOf(text) {
  const address = addressOf(text);
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1);
}

/** Sama nazwa nadawcy, bez adresu — po niej rozpoznaje się „prawdziwą osobę". */
function nameOf(text) {
  const raw = String(text ?? "").trim();
  const angled = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  return angled?.[1]?.trim() || addressOf(raw);
}

/** Pierwszy adresat z listy „Do" — wysyłamy zwykle do jednej osoby naraz. */
function firstOf(list) {
  const first = Array.isArray(list) ? list[0] : list;
  return first ?? "";
}

/* ── Reguły lokalne (bez sieci) ────────────────────────────────── */

const listish = (mail) =>
  !!mail.listUnsubscribe ||
  /\bno-?reply|do-?not-?reply|newsletter|mailer|notifications?@|bounce/i.test(addressOf(mail.from));

/** Temat/fragment, który wygląda na coś, czego nie wolno przegapić. */
const anomalous = (mail) => {
  const text = `${mail.subject ?? ""} ${mail.snippet ?? ""}`;
  return (
    !!mail.isReply ||
    /\?/.test(text) ||
    /\b(pilne|urgent|asap|faktura|invoice|termin płatności|deadline)\b/i.test(text) ||
    /^\s*re\s*:/i.test(mail.subject ?? "")
  );
}

/** Czy nazwa nadawcy wygląda na człowieka, a nie na automat/dział. */
const personLike = (mail) => {
  const name = nameOf(mail.from);
  return /^[\p{L}][\p{L}.'-]*\s+[\p{L}][\p{L}.'-]*/u.test(name) && !listish(mail);
};

/**
 * Kategoryzacja bez modelu — to samo pytanie, na które model odpowiada
 * lepiej, ale które nie może zostać bez odpowiedzi, gdy modelu nie ma
 * (brak klucza, sieć padła, odmowa). Używa WYŁĄCZNIE tego, co już wiemy:
 * reguł jak w briefing.js i pamięci decyzji z triageMemory.
 */
function ruleFallback(headers, triageMemory = {}) {
  return (headers ?? []).map((mail) => {
    const domain = domainOf(mail.from);
    const memory = triageMemory[domain];
    const usuallyTrashed = memory?.action === "trash" && (memory?.count ?? 0) >= 1;
    const listy = listish(mail);
    const odd = anomalous(mail);

    if ((listy || usuallyTrashed) && !odd) {
      return {
        id: mail.id,
        category: TRASH_CANDIDATE,
        reason: usuallyTrashed
          ? `Domena, którą zwykle usuwasz (${memory.count}×).`
          : "Wygląda na newsletter albo powiadomienie automatyczne.",
      };
    }

    if ((listy || usuallyTrashed) && odd) {
      return {
        id: mail.id,
        category: GLANCE_ONLY,
        reason: usuallyTrashed
          ? "Zwykle to usuwasz, ale ten temat wygląda na coś ważnego — rzuć okiem."
          : "Automat, ale temat sugeruje coś więcej niż zwykłe powiadomienie.",
      };
    }

    if (odd || mail.starred) {
      return { id: mail.id, category: REQUIRES_ACTION, reason: "Pytanie wprost albo coś, co wygląda na pilne." };
    }

    if (personLike(mail)) {
      return { id: mail.id, category: REQUIRES_ACTION, reason: "Nadawca wygląda na osobę, nie na automat." };
    }

    return { id: mail.id, category: GLANCE_ONLY, reason: "Za mało historii, żeby zdecydować samemu." };
  });
}

/* ── Wysłane, które czekają na odpowiedź ─────────────────────────── */

/** Fragment, który wygląda na prośbę, pytanie albo ofertę — czyli coś, co
    naprawdę oczekuje reakcji drugiej strony, a nie samo „FYI". */
const asksSomething = (mail) => {
  const text = `${mail.subject ?? ""} ${mail.snippet ?? ""}`;
  return /\?/.test(text) || /\b(ofert[aęy]|propozycj[aęi]|wycen[aęy]|zapraszam|proszę o|czy (dasz|pasuje|możesz))\b/i.test(text);
};

const HOUR_MS = 3_600_000;

/** Ile dni minęło od wysłania, licząc pełne doby. */
function daysSince(at, now = Date.now()) {
  return Math.max(0, Math.floor((now - Number(at ?? 0)) / (24 * HOUR_MS)));
}

/**
 * Wysłane maile, które LOKALNIE wyglądają na czekające: minęło ponad
 * AWAITING_HOURS, nikt (wedle tego, co wiemy) nie odpisał, a treść zawierała
 * wyraźną prośbę. To jest pre-filtr przed modelem — patrz komentarz na
 * górze pliku: reszta korespondencji wychodzącej nigdy tam nie trafia.
 */
function awaitingCandidates(sent, { now = Date.now(), hours = AWAITING_HOURS } = {}) {
  return (sent ?? []).filter(
    (mail) => !mail.repliedAt && asksSomething(mail) && now - Number(mail.at ?? 0) >= hours * HOUR_MS,
  );
}

/** Decyzja „czeka na odpowiedź" bez modelu — kandydat już przeszedł filtr,
    więc tu tylko układamy to, co pokazujemy. */
function ruleFallbackSent(candidates, { now = Date.now() } = {}) {
  return (candidates ?? []).map((mail) => ({
    id: mail.id,
    to: nameOf(firstOf(mail.to)),
    about: String(mail.subject ?? "").trim() || "(bez tematu)",
    reason: `Brak odpowiedzi od ${daysSince(mail.at, now)} dni.`,
  }));
}

/* ── Pytanie do modelu ─────────────────────────────────────────── */

const CONTRACT = `Jesteś asystentem Inbox Zero i sekretarzem korespondencji wychodzącej. Dostajesz dwie listy: maile ODEBRANE do skategoryzowania i maile WYSŁANE, które mogą wciąż czekać na odpowiedź.

CZĘŚĆ 1 — MAILE ODEBRANE. Kategoryzuj każdy do: TRASH_CANDIDATE, GLANCE_ONLY, REQUIRES_ACTION. Grupuj powiadomienia i newslettery. Używaj historii użytkownika, ale WYKRYWAJ ANOMALIE: jeśli nadawca z grupy TRASH_CANDIDATE wyśle maila z tematem wskazującym na pilny problem, odpowiedź człowieka (Re:) lub fakturę, zawsze oznacz to jako GLANCE_ONLY lub REQUIRES_ACTION.

ZASADY CZĘŚCI 1:
- TRASH_CANDIDATE: newslettery, powiadomienia automatyczne, rozsyłki — nic, co wymaga odpowiedzi.
- GLANCE_ONLY: anomalie, dziwne tematy z zaufanych/automatycznych domen, sytuacje niepewne.
- REQUIRES_ACTION: ludzie, klienci, faktury, pytania wprost, wszystko wymagające reakcji.
- Historia użytkownika (triageMemory) mówi, co ZWYKLE robi z daną domeną — to jest PIERWSZE przypuszczenie, nie ostatnie słowo. Anomalia w treści zawsze podbija kategorię wyżej (TRASH_CANDIDATE → GLANCE_ONLY lub REQUIRES_ACTION), nigdy w dół.
- Każdy mail z listy ODEBRANE musi pojawić się dokładnie raz w "emails", z tym samym "id".

CZĘŚĆ 2 — MAILE WYSŁANE. Lista WYSŁANE zawiera TYLKO maile już wstępnie wytypowane jako możliwe kandydatury (wysłane ponad 48h temu, bez odpowiedzi, z pytaniem albo ofertą) — Twoim zadaniem jest potwierdzić lub odrzucić każdy z nich. Dla potwierdzonych dodaj wpis do "sent": "id" (to samo id wejściowe), "to" (imię i nazwisko albo nazwa adresata), "about" (czego dotyczyła prośba/oferta, jednym krótkim zdaniem po polsku), "reason" (jednozdaniowe uzasadnienie po polsku, np. że to była konkretna prośba, na którą nie ma odpowiedzi). Mail, który mimo wszystko NIE wymaga już follow-upu (np. treść była tylko grzecznościowa), pomijasz — nie umieszczasz go w "sent".

Nie usuwasz niczego i nie proponujesz nieodwracalnych działań — tylko kategoryzujesz i podajesz jednozdaniowy powód po polsku.

Odpowiadasz WYŁĄCZNIE poprawnym JSON-em w formacie:
{"emails": [{"id": "<id wejściowe>", "category": "TRASH_CANDIDATE|GLANCE_ONLY|REQUIRES_ACTION", "reason": "<jedno krótkie zdanie po polsku>"}], "sent": [{"id": "<id wejściowe>", "to": "<adresat>", "about": "<czego dotyczyła prośba>", "reason": "<jedno krótkie zdanie po polsku>"}]}

Bez markdownu, bez bloków kodu, bez niczego poza samym JSON-em.`;

/** Schemat wymuszający strukturę odpowiedzi Gemini (responseSchema). */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
          reason: { type: "string" },
        },
        required: ["id", "category", "reason"],
      },
    },
    sent: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          to: { type: "string" },
          about: { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "to", "about", "reason"],
      },
    },
  },
  required: ["emails", "sent"],
};

/** Materiał dla modelu: nagłówki odebrane, kandydaci z wysłanych i pamięć decyzji. */
function buildPrompt({ headers = [], sentCandidates = [], triageMemory = {} } = {}) {
  const picks = headers.slice(0, MAX_HEADERS);

  const mails = picks.map((mail, index) => ({
    id: mail.id ?? String(index),
    from: nameOf(mail.from),
    domain: domainOf(mail.from),
    subject: String(mail.subject ?? "").trim() || "(bez tematu)",
    snippet: String(mail.snippet ?? "").slice(0, 240),
  }));

  const sent = sentCandidates.map((mail, index) => ({
    id: mail.id ?? `sent-${index}`,
    to: nameOf(firstOf(mail.to)),
    subject: String(mail.subject ?? "").trim() || "(bez tematu)",
    snippet: String(mail.snippet ?? "").slice(0, 240),
    daysAgo: daysSince(mail.at),
  }));

  const memoryLines = Object.entries(triageMemory)
    .filter(([, entry]) => entry?.count)
    .map(([domain, entry]) => `- ${domain}: zwykle "${entry.action}" (${entry.count}×)`);

  const user = [
    "=== PAMIĘĆ DECYZJI UŻYTKOWNIKA (triageMemory) ===",
    memoryLines.length ? memoryLines.join("\n") : "Brak historii — to pierwsza segregacja.",
    "",
    "=== MAILE ODEBRANE DO SKATEGORYZOWANIA ===",
    JSON.stringify(mails, null, 2),
    "",
    "=== MAILE WYSŁANE — KANDYDACI NA „CZEKA NA ODPOWIEDŹ” ===",
    sent.length ? JSON.stringify(sent, null, 2) : "Brak kandydatów.",
  ].join("\n");

  return { system: CONTRACT, user };
}

/* ── Odpowiedź modelu ──────────────────────────────────────────── */

/** Zdejmuje ewentualne ```json ... ``` — model bywa gadatliwy mimo zakazu. */
function stripFence(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Odpowiedź modelu na listę decyzji. Zwraca `null`, gdy odpowiedzi nie da
 * się zaufać (zły JSON, brak listy) — wołający ma wtedy sięgnąć po
 * ruleFallback / ruleFallbackSent zamiast pokazać połowiczny wynik.
 */
function readAnswer(raw) {
  const text = stripFence(String(raw ?? ""));
  if (!text) return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!Array.isArray(data?.emails)) return null;

  const emails = data.emails
    .filter((entry) => entry && typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id,
      category: CATEGORIES.includes(entry.category) ? entry.category : GLANCE_ONLY,
      reason: String(entry.reason ?? "").trim() || "Bez podanego powodu.",
    }));

  const sent = (Array.isArray(data.sent) ? data.sent : [])
    .filter((entry) => entry && typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id,
      to: String(entry.to ?? "").trim(),
      about: String(entry.about ?? "").trim() || "(bez tematu)",
      reason: String(entry.reason ?? "").trim() || "Brak odpowiedzi.",
    }));

  return { emails, sent };
}

/**
 * Łączy nagłówki z decyzjami (od modelu albo z ruleFallback) w trzy grupy
 * gotowe do pokazania. Mail bez decyzji (model pominął pozycję) dostaje
 * GLANCE_ONLY — brak pewności ma prowadzić do „zerknij", nigdy do „usuń".
 */
function groupByCategory(headers, decisions) {
  const byId = new Map((decisions ?? []).map((entry) => [entry.id, entry]));
  const groups = { [TRASH_CANDIDATE]: [], [GLANCE_ONLY]: [], [REQUIRES_ACTION]: [] };

  for (const mail of headers ?? []) {
    const decision = byId.get(mail.id) ?? { category: GLANCE_ONLY, reason: "Model nie ocenił tej pozycji." };
    const category = CATEGORIES.includes(decision.category) ? decision.category : GLANCE_ONLY;
    groups[category].push({
      id: mail.id,
      from: nameOf(mail.from),
      domain: domainOf(mail.from),
      subject: String(mail.subject ?? "").trim() || "(bez tematu)",
      snippet: mail.snippet ?? "",
      at: mail.at ?? null,
      link: mail.threadId ? `https://mail.google.com/mail/u/0/#inbox/${mail.threadId}` : null,
      reason: decision.reason,
    });
  }

  return {
    trashCandidate: groups[TRASH_CANDIDATE],
    glanceOnly: groups[GLANCE_ONLY],
    requiresAction: groups[REQUIRES_ACTION],
  };
}

/**
 * Kandydaci z wysłanych + decyzje (od modelu albo z ruleFallbackSent) →
 * gotowa lista „czeka na odpowiedź". Obecność w `decisions` JEST sygnałem
 * potwierdzenia — kandydat pominięty przez model po prostu nie trafia do
 * wyniku, zamiast lądować w nim z domyślnym zgadywaniem.
 */
function groupAwaiting(candidates, decisions, { now = Date.now() } = {}) {
  const byId = new Map((decisions ?? []).map((entry) => [entry.id, entry]));
  const out = [];
  for (const mail of candidates ?? []) {
    const decision = byId.get(mail.id);
    if (!decision) continue;
    out.push({
      id: mail.id,
      to: decision.to || nameOf(firstOf(mail.to)),
      about: decision.about || String(mail.subject ?? "").trim() || "(bez tematu)",
      subject: String(mail.subject ?? "").trim() || "(bez tematu)",
      days: daysSince(mail.at, now),
      at: mail.at ?? null,
      link: mail.threadId ? `https://mail.google.com/mail/u/0/#inbox/${mail.threadId}` : null,
      reason: decision.reason,
    });
  }
  return out.sort((a, b) => b.days - a.days);
}

/* ── Wywołanie modelu ──────────────────────────────────────────── */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * `analyzeMail` — jedno pytanie do Gemini, z wymuszonym JSON Schema
 * (responseMimeType + responseSchema), więc CONTRACT opisuje ZASADY,
 * a schema pilnuje KSZTAŁTU odpowiedzi; jedno nie zastępuje drugiego.
 * Ocenia RAZEM odebrane (kategorie) i wysłane (czeka/nie czeka).
 *
 * Zawsze zwraca decyzje — gdy modelu zabrakło (brak klucza, sieć padła,
 * odpowiedź nie do sparsowania), po cichu spada na reguły lokalne. Poranek
 * robi to samo ze zdaniem od sita: propozycja jest dodatkiem, a lista
 * maili musi stać sama, nawet bez modelu.
 */
async function analyzeMail(headers, sent, triageMemory = {}, { apiKey, model = "gemini-2.5-flash", now = Date.now() } = {}) {
  const candidates = awaitingCandidates(sent, { now });

  if (!apiKey) {
    return {
      emails: ruleFallback(headers, triageMemory),
      sent: ruleFallbackSent(candidates, { now }),
      sentCandidates: candidates,
      degraded: true,
      error: "Brak klucza API dla Gemini.",
    };
  }

  const { system, user } = buildPrompt({ headers, sentCandidates: candidates, triageMemory });

  try {
    const { describeError } = require("./stt");
    const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });
    if (!response.ok) throw new Error(await describeError(response, "Gemini"));

    const data = await response.json();
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini odmówił segregacji (${data.promptFeedback.blockReason}).`);
    }
    const raw = (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    const answer = readAnswer(raw);
    if (!answer) throw new Error("Odpowiedź modelu nie jest poprawnym JSON-em.");

    return { emails: answer.emails, sent: answer.sent, sentCandidates: candidates, degraded: false, error: null };
  } catch (error) {
    return {
      emails: ruleFallback(headers, triageMemory),
      sent: ruleFallbackSent(candidates, { now }),
      sentCandidates: candidates,
      degraded: true,
      error: error.message || String(error),
    };
  }
}

module.exports = {
  TRASH_CANDIDATE,
  GLANCE_ONLY,
  REQUIRES_ACTION,
  AWAITING_REPLY,
  CATEGORIES,
  MAX_HEADERS,
  AWAITING_HOURS,
  addressOf,
  domainOf,
  nameOf,
  listish,
  anomalous,
  asksSomething,
  daysSince,
  awaitingCandidates,
  ruleFallback,
  ruleFallbackSent,
  buildPrompt,
  readAnswer,
  groupByCategory,
  groupAwaiting,
  analyzeMail,
  CONTRACT,
  RESPONSE_SCHEMA,
};
