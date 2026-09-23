"use strict";

/**
 * MailService — jedna bramka do skrzynki, niezależnie od tego, co po
 * drugiej stronie: dziś atrapa, jutro IMAP albo Gmail OAuth.
 *
 * Warstwa wyżej (main.js, inbox-triage.js) zna tylko ten interfejs —
 * `fetchHeaders` i `trash` — i nigdy protokołu pocztowego. Dzięki temu
 * podpięcie prawdziwej skrzynki jest wymianą TEGO JEDNEGO pliku, a UI, sito
 * kategoryzujące i pamięć decyzji zostają nietknięte.
 *
 * Nagłówki, nie treść: `snippet` jest jedynym fragmentem treści, jaki stąd
 * wychodzi (patrz briefing.js — ta sama zasada). Kategoryzacja poczty nie
 * potrzebuje całego maila, żeby rozpoznać newsletter.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms) => Date.now() - ms;

/** Skrzynka przykładowa — celowo pomieszana, żeby było co kategoryzować. */
const MOCK_HEADERS = [
  {
    id: "m1",
    threadId: "t1",
    from: "Substack Digest <digest@substack.com>",
    to: ["ty@example.com"],
    subject: "Twój tygodniowy przegląd czytelni",
    snippet: "5 nowych artykułów od autorów, których obserwujesz w tym tygodniu.",
    at: ago(2 * HOUR),
    unread: true,
    starred: false,
    listUnsubscribe: true,
  },
  {
    id: "m2",
    threadId: "t2",
    from: "GitHub <notifications@github.com>",
    to: ["ty@example.com"],
    subject: "[cribro/sift] Nowy komentarz w #142",
    snippet: "maciejw skomentował: „Warto by to jeszcze przetestować na Windows”.",
    at: ago(5 * HOUR),
    unread: true,
    starred: false,
    listUnsubscribe: true,
  },
  {
    id: "m3",
    threadId: "t3",
    from: "LinkedIn <notifications-noreply@linkedin.com>",
    to: ["ty@example.com"],
    subject: "Masz 3 nowe powiadomienia",
    snippet: "Zobacz, kto obejrzał Twój profil w tym tygodniu.",
    at: ago(1 * DAY),
    unread: true,
    starred: false,
    listUnsubscribe: true,
  },
  {
    id: "m4",
    threadId: "t4",
    from: "Figma <no-reply@figma.com>",
    to: ["ty@example.com"],
    subject: "Ktoś skomentował Twój projekt",
    snippet: "Ania Kowalska dodała komentarz w pliku „Landing v3”.",
    at: ago(3 * HOUR),
    unread: true,
    starred: false,
    listUnsubscribe: true,
  },
  /* Anomalia: nadawca, którego historia mówi „trash", ale ten konkretny
     mail wygląda na coś, czego nie wolno wyrzucić bez patrzenia. Sam
     mail-service tego nie wie — to sito w inbox-triage.js ma to złapać. */
  {
    id: "m5",
    threadId: "t5",
    from: "GitHub <notifications@github.com>",
    to: ["ty@example.com"],
    subject: "Re: [cribro/sift] Pilne: build produkcyjny nie przechodzi",
    snippet: "Pytanie wprost do Ciebie: czy możesz zerknąć dziś, bo release stoi.",
    at: ago(40 * MINUTE),
    unread: true,
    starred: false,
    listUnsubscribe: true,
    isReply: true,
  },
  {
    id: "m6",
    threadId: "t6",
    from: "Biuro Rachunkowe Kowalscy <biuro@kowalscy-ksiegowosc.pl>",
    to: ["ty@example.com"],
    subject: "Faktura VAT 09/2026",
    snippet: "W załączniku faktura za wrzesień. Termin płatności: 14 dni.",
    at: ago(1 * DAY + 2 * HOUR),
    unread: true,
    starred: false,
    listUnsubscribe: false,
  },
  {
    id: "m7",
    threadId: "t7",
    from: "Magdalena Nowak <magda@klient-abc.pl>",
    to: ["ty@example.com"],
    subject: "Kolejne zajęcia — zmiana godziny?",
    snippet: "Czy dałoby się przesunąć czwartkowe zajęcia na 17:00 zamiast 16:00?",
    at: ago(3 * HOUR),
    unread: true,
    starred: false,
    listUnsubscribe: false,
  },
  /* Zaufana domena, dziwny temat — szara strefa: ani ewidentny szum,
     ani ewidentnie ważne. */
  {
    id: "m8",
    threadId: "t8",
    from: "Zespół Cribro <no-reply@cribro.app>",
    to: ["ty@example.com"],
    subject: "Twoje konto wymaga weryfikacji w ciągu 24h",
    snippet: "Zauważyliśmy logowanie z nowego urządzenia. Potwierdź, że to Ty.",
    at: ago(20 * MINUTE),
    unread: true,
    starred: false,
    listUnsubscribe: false,
  },
  {
    id: "m9",
    threadId: "t9",
    from: "Newsletter Cribro <newsletter@cribro.app>",
    to: ["ty@example.com"],
    subject: "Co nowego w Cribro — wrzesień 2026",
    snippet: "Nowy tryb dyktowania, szybszy eksport i poprawki stabilności.",
    at: ago(2 * DAY),
    unread: true,
    starred: false,
    listUnsubscribe: true,
  },
  {
    id: "m10",
    threadId: "t10",
    from: "Tomasz Kaczmarek <tomasz@nowyklient.com>",
    to: ["ty@example.com"],
    subject: "Zapytanie o kurs indywidualny",
    snippet: "Dzień dobry, jestem zainteresowany kursem 1:1 — jakie są dostępne terminy?",
    at: ago(6 * HOUR),
    unread: true,
    starred: false,
    listUnsubscribe: false,
  },
];

/** Wysłane przez użytkownika — celowo z jednym już odebranym wątkiem (s5)
    i jednym za świeżym, by było widać, że próg 48h i „bez odpowiedzi"
    naprawdę odsiewają, a nie tylko wymieniają wszystko. */
const MOCK_SENT = [
  {
    id: "s1",
    threadId: "t7",
    to: ["Magdalena Nowak <magda@klient-abc.pl>"],
    subject: "Re: Kolejne zajęcia — zmiana godziny?",
    snippet: "Jasne, 17:00 pasuje. Czy potwierdzasz też termin płatności za wrzesień?",
    at: ago(3 * DAY),
    repliedAt: null,
  },
  {
    id: "s2",
    threadId: "t10",
    to: ["Tomasz Kaczmarek <tomasz@nowyklient.com>"],
    subject: "Oferta kursu indywidualnego 1:1",
    snippet: "W załączniku przesyłam ofertę i dostępne terminy. Czy któryś z nich pasuje?",
    at: ago(4 * DAY),
    repliedAt: null,
  },
  {
    id: "s3",
    threadId: "t11",
    to: ["Ania Kowalska <ania@partner.pl>"],
    subject: "Propozycja współpracy — webinar",
    snippet: "Proponuję termin webinaru na przyszły tydzień, daj znać czy pasuje.",
    at: ago(6 * DAY),
    repliedAt: null,
  },
  {
    id: "s4",
    threadId: "t12",
    to: ["Biuro Rachunkowe Kowalscy <biuro@kowalscy-ksiegowosc.pl>"],
    subject: "Re: Faktura VAT 09/2026",
    snippet: "Dzięki, płatność poszła dzisiaj.",
    at: ago(5 * HOUR),
    repliedAt: null,
  },
  {
    id: "s5",
    threadId: "t13",
    to: ["Piotr Zieliński <piotr@stalyklient.pl>"],
    subject: "Re: Materiały do lekcji",
    snippet: "Wysyłam materiały, do zobaczenia w czwartek. Daj znać czy dotarły.",
    at: ago(2 * DAY),
    repliedAt: ago(1 * DAY),
  },
];

/** Nagłówki z ostatnich dni. Prawdziwy backend dostanie tu zapytanie IMAP/Gmail. */
async function fetchHeaders({ max = 40 } = {}) {
  return MOCK_HEADERS.slice(0, max).map((mail) => ({ ...mail }));
}

/** Ostatnio wysłane przez użytkownika — materiał dla „Oczekujące na odpowiedź". */
async function fetchSent({ max = 40 } = {}) {
  return MOCK_SENT.slice(0, max).map((mail) => ({ ...mail }));
}

/**
 * Przenosi wskazane maile do kosza. Human-in-the-loop: to wywołanie
 * przychodzi WYŁĄCZNIE po zatwierdzeniu w UI (patrz mail:trashSelected
 * w main.js) — nic tu nie usuwa się samo.
 */
async function trash(ids) {
  return { trashed: [...new Set(ids ?? [])] };
}

module.exports = { fetchHeaders, fetchSent, trash, MOCK_HEADERS, MOCK_SENT };
