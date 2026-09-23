"use strict";
/**
 * Raport Skrzynki (Smart Inbox Triage) — reguły, kontrakt i czytanie
 * odpowiedzi modelu, dla odebranych I wysłanych.
 *   node scripts/triage-test.js
 *
 * Sieci tu nie ma: sprawdzamy to, co ROZSTRZYGAMY sami — co model dostaje,
 * co bierzemy z jego odpowiedzi i co robią reguły lokalne, gdy modelu nie
 * ma pod ręką. Najważniejszy przypadek jest ten sam, co w briefing.js:
 * anomalia w treści musi bić pamięć decyzji, nigdy odwrotnie. Dla wysłanych
 * najważniejszy przypadek jest inny: próg 48h i „już odpisali" muszą
 * naprawdę odsiewać, zanim cokolwiek pojedzie do modelu.
 */
const assert = require("assert");
const {
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
  TRASH_CANDIDATE,
  GLANCE_ONLY,
  REQUIRES_ACTION,
} = require("../src/main/inbox-triage");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Adresy ─────────────────────────────────────────────────────── */

check("domainOf bierze domenę z <adres>", domainOf("Ktoś <ktos@example.com>") === "example.com");
check("domainOf działa na gołym adresie", domainOf("ktos@example.com") === "example.com");
check("domainOf na śmieciu zwraca pustkę", domainOf("nie-adres") === "");
check("nameOf bierze nazwę, gdy jest", nameOf("Jan Kowalski <jan@x.pl>") === "Jan Kowalski");
check("nameOf bez nazwy zwraca adres", nameOf("jan@x.pl") === "jan@x.pl");

/* ── Reguły: listish i anomalie ────────────────────────────────── */

check("listish łapie listUnsubscribe", listish({ from: "Ktoś <a@b.com>", listUnsubscribe: true }));
check("listish łapie adresy no-reply/newsletter", listish({ from: "Newsletter <newsletter@firma.com>" }));
check("listish nie łapie zwykłej osoby", !listish({ from: "Magda Nowak <magda@klient.pl>" }));

check("anomalous łapie pytanie w temacie", anomalous({ subject: "Czy dasz radę?", snippet: "" }));
check("anomalous łapie Re:", anomalous({ subject: "Re: build padł", snippet: "" }));
check("anomalous łapie fakturę", anomalous({ subject: "Faktura za wrzesień", snippet: "" }));
check("zwykły newsletter nie jest anomalią", !anomalous({ subject: "Nasz tygodniowy przegląd", snippet: "5 artykułów" }));

/* ── ruleFallback: pamięć jako pierwsze przypuszczenie ───────────── */

const headers = [
  { id: "a", from: "Newsletter <newsletter@firma.com>", subject: "Co nowego", snippet: "", listUnsubscribe: true },
  {
    id: "b",
    from: "GitHub <notifications@github.com>",
    subject: "Re: Pilne: build padł",
    snippet: "Czy możesz zerknąć dziś?",
    listUnsubscribe: true,
    isReply: true,
  },
  { id: "c", from: "Magdalena Nowak <magda@klient.pl>", subject: "Zmiana godziny zajęć", snippet: "Czy 17:00 zamiast 16:00?" },
  { id: "d", from: "Automat <cron@system.local>", subject: "Raport nocny", snippet: "Zadanie zakończone." },
];
const memory = { "github.com": { action: "trash", count: 5 } };

const fallback = ruleFallback(headers, memory);
const byId = Object.fromEntries(fallback.map((entry) => [entry.id, entry]));

check("Zwykły newsletter bez historii trafia do TRASH_CANDIDATE", byId.a.category === TRASH_CANDIDATE);
check(
  "Nadawca zwykle kasowany, ale z pilnym Re: NIE trafia do TRASH_CANDIDATE",
  byId.b.category !== TRASH_CANDIDATE,
);
check("…tylko do GLANCE_ONLY albo REQUIRES_ACTION", [GLANCE_ONLY, REQUIRES_ACTION].includes(byId.b.category));
check("Mail od osoby z pytaniem wprost trafia do REQUIRES_ACTION", byId.c.category === REQUIRES_ACTION);
check("Automat bez historii i bez anomalii ląduje w szarej strefie", byId.d.category === GLANCE_ONLY);

/* ── Prompt: pamięć i maile idą do modelu, treść nie ────────────── */

const { system, user } = buildPrompt({ headers, sentCandidates: [], triageMemory: memory });
check("System opisuje trzy kategorie odebranych", ["TRASH_CANDIDATE", "GLANCE_ONLY", "REQUIRES_ACTION"].every((c) => system.includes(c)));
check("System każe wykrywać anomalie mimo historii", /ANOMALI/i.test(system));
check("System opisuje ocenę wysłanych", /WYSŁANE/i.test(system));
check("Prompt niesie pamięć decyzji", user.includes("github.com") && user.includes("5×"));
check("Prompt niesie maile z tematem", user.includes("Zmiana godziny zajęć"));

/* ── readAnswer: odporność na gadatliwość modelu ─────────────────── */

const czysty = readAnswer('{"emails":[{"id":"a","category":"TRASH_CANDIDATE","reason":"Newsletter."}],"sent":[]}');
check("Czysty JSON parsuje się wprost", czysty?.emails?.[0]?.category === TRASH_CANDIDATE);

const wBlokuKodu = readAnswer('```json\n{"emails":[{"id":"a","category":"GLANCE_ONLY","reason":"x"}],"sent":[]}\n```');
check("JSON w bloku ```json``` też się parsuje", wBlokuKodu?.emails?.[0]?.category === GLANCE_ONLY);

check("Zepsuty JSON zwraca null, nie rzuca wyjątku", readAnswer("to nie jest JSON") === null);
check("Brak listy `emails` zwraca null", readAnswer('{"coś":"innego"}') === null);

const zŁaKategorią = readAnswer('{"emails":[{"id":"a","category":"COKOLWIEK","reason":"x"}],"sent":[]}');
check("Nieznana kategoria spada bezpiecznie do GLANCE_ONLY", zŁaKategorią?.emails?.[0]?.category === GLANCE_ONLY);

const zSent = readAnswer('{"emails":[],"sent":[{"id":"s1","to":"Magda","about":"zmiana godziny","reason":"brak odpowiedzi"}]}');
check("sent parsuje się z odpowiedzi modelu", zSent?.sent?.[0]?.to === "Magda");

const bezSent = readAnswer('{"emails":[]}');
check("Brak pola sent w odpowiedzi nie wywala parsowania — pusta lista", Array.isArray(bezSent?.sent) && bezSent.sent.length === 0);

/* ── groupByCategory: trzy kubełki, żaden mail nie ginie ─────────── */

const grouped = groupByCategory(headers, fallback);
check(
  "Każdy mail trafia do dokładnie jednej grupy",
  grouped.trashCandidate.length + grouped.glanceOnly.length + grouped.requiresAction.length === headers.length,
);
check("Grupa trashCandidate zawiera domenę i powód", grouped.trashCandidate[0]?.domain === "firma.com" && !!grouped.trashCandidate[0]?.reason);

const bezDecyzji = groupByCategory(headers, []);
check("Mail bez decyzji modelu trafia bezpiecznie do GLANCE_ONLY, nie do TRASH_CANDIDATE", bezDecyzji.trashCandidate.length === 0);

/* ── Wysłane: próg 48h i „już odpisali" naprawdę odsiewają ───────── */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

const sent = [
  { id: "s1", to: ["Magda <magda@klient.pl>"], subject: "Zmiana godziny zajęć", snippet: "Czy 17:00 pasuje?", at: now - 3 * DAY, repliedAt: null },
  { id: "s2", to: ["Ktoś <k@firma.pl>"], subject: "Re: dzięki", snippet: "Super, do zobaczenia.", at: now - 5 * DAY, repliedAt: null },
  { id: "s3", to: ["Nowy Klient <nowy@firma.pl>"], subject: "Oferta współpracy", snippet: "Czy ta oferta Ci pasuje?", at: now - 5 * HOUR, repliedAt: null },
  { id: "s4", to: ["Ania <ania@firma.pl>"], subject: "Propozycja terminu", snippet: "Czy pasuje Ci wtorek?", at: now - 4 * DAY, repliedAt: now - 1 * DAY },
];

check("asksSomething łapie pytanie", asksSomething({ subject: "x", snippet: "Czy 17:00 pasuje?" }));
check("asksSomething nie łapie zwykłej grzeczności", !asksSomething({ subject: "Re: dzięki", snippet: "Super, do zobaczenia." }));
check("daysSince liczy pełne doby", daysSince(now - 3 * DAY, now) === 3);

const candidates = awaitingCandidates(sent, { now });
const candidateIds = candidates.map((m) => m.id);
check("Mail z pytaniem po 48h+ bez odpowiedzi jest kandydatem", candidateIds.includes("s1"));
check("Mail bez pytania NIE jest kandydatem mimo braku odpowiedzi", !candidateIds.includes("s2"));
check("Mail za świeży (<48h) NIE jest kandydatem", !candidateIds.includes("s3"));
check("Mail, na który już odpisano, NIE jest kandydatem", !candidateIds.includes("s4"));

const sentFallback = ruleFallbackSent(candidates, { now });
check("ruleFallbackSent oddaje dokładnie kandydatów", sentFallback.length === candidates.length);
check("ruleFallbackSent podaje adresata", sentFallback.find((e) => e.id === "s1")?.to === "Magda");

const awaiting = groupAwaiting(candidates, sentFallback, { now });
check("groupAwaiting zwraca tyle samo pozycji co decyzje", awaiting.length === sentFallback.length);
check("groupAwaiting liczy dni", awaiting.find((e) => e.id === "s1")?.days === 3);

const bezPotwierdzenia = groupAwaiting(candidates, [], { now });
check("Kandydat pominięty przez model znika z wyniku, nie zostaje z domysłem", bezPotwierdzenia.length === 0);

/* ── analyzeMail: brak klucza nie wywala okna, tylko spada na reguły ── */

(async () => {
  const wynik = await analyzeMail(headers, sent, memory, { apiKey: "", now });
  check("Bez klucza API analiza jest zdegradowana, ale nie pusta", wynik.degraded === true && wynik.emails.length === headers.length);
  check("…i mówi po ludzku, czego brakuje", wynik.error.includes("klucza"));
  check("…a wysłane i tak przechodzą przez regułę lokalną", wynik.sent.length === candidates.length);

  console.log(`\n${passed} sprawdzeń przeszło.`);
})();
