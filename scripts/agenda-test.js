"use strict";
/**
 * Kalendarz — co liczy się jako spotkanie i co właśnie się zaczyna.
 *   node scripts/agenda-test.js
 *
 * Najważniejsze przypadki są znowu przeczące: „dentysta" i „odebrać
 * dziecko" to wpisy w kalendarzu, ale nie rozmowy do nagrania. Moduł,
 * który tego nie odróżnia, proponowałby nagrywanie wizyty u lekarza —
 * i byłby wyłączony pierwszego dnia.
 */
const assert = require("assert");
const { parse, isMeeting, upcoming, running, justStarted } = require("../src/main/agenda");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

const teraz = Date.parse("2026-08-29T10:00:00.000Z");
const za = (minutes) => teraz + minutes * 60_000;
const wpis = (patch) => ({
  id: "e1",
  title: "Spotkanie",
  from: za(30),
  to: za(90),
  guests: 0,
  link: null,
  ...patch,
});

/* ── Odczyt odpowiedzi ──────────────────────────────────────── */

const odczyt = parse(
  '{"access":"granted","events":[{"id":"a","title":"Przegląd","from":"2026-08-29T10:30:00Z","to":"2026-08-29T11:00:00Z","guests":3,"link":""}]}',
);
check("Zgoda wraca z odpowiedzi", odczyt.access === "granted");
check("Godziny zamieniają się w liczby", odczyt.events[0].from === za(30));
check("Pusty adres to brak adresu", odczyt.events[0].link === null);
check("Śmieci zamiast JSON-a nie wywracają odczytu", parse("nie-JSON").access === "error");
check("Pusta odpowiedź to pusty spis", parse("").events.length === 0);
check(
  "Wpis bez dat wypada — nie ma go jak umieścić w czasie",
  parse('{"events":[{"id":"a","from":"kiedyś","to":"potem"}]}').events.length === 0,
);
check("Odmowa zgody jest odmową, a nie awarią", parse('{"access":"denied","events":[]}').access === "denied");

/* ── Co jest spotkaniem ─────────────────────────────────────── */

check("Wpis z adresem pokoju to spotkanie", isMeeting(wpis({ link: "https://meet.google.com/abc" })));
check("Wpis z zaproszonymi to spotkanie", isMeeting(wpis({ guests: 4 })));
check("Dentysta to nie spotkanie", isMeeting(wpis({ title: "Dentysta" })) === false);
check(
  "Wpis tylko dla siebie to nie spotkanie",
  isMeeting(wpis({ title: "Napisać raport", guests: 1 })) === false,
);
check("Nic nie jest niczym", isMeeting(null) === false);

/* ── Nadchodzące ────────────────────────────────────────────── */

const plan = [
  wpis({ id: "dentysta", title: "Dentysta", from: za(20), to: za(80) }),
  wpis({ id: "przegląd", title: "Przegląd tygodnia", from: za(45), to: za(105), guests: 3 }),
  wpis({ id: "wczoraj", title: "Było i minęło", from: za(-300), to: za(-240), guests: 3 }),
  wpis({ id: "teraz", title: "Właśnie trwa", from: za(-5), to: za(25), guests: 2 }),
];

const dalej = upcoming(plan, teraz);
check("Spis nadchodzących pomija wpisy bez rozmowy", !dalej.some((e) => e.id === "dentysta"));
check("…i pomija to, co się skończyło", !dalej.some((e) => e.id === "wczoraj"));
check("…a trwające stoi na początku", dalej[0].id === "teraz");
check("…i wszystko idzie po godzinach", dalej.map((e) => e.id).join(",") === "teraz,przegląd");

/* ── Co trwa ────────────────────────────────────────────────── */

check("Trwające spotkanie jest rozpoznane", running(plan, teraz)?.id === "teraz");
check("Przed czasem nic nie trwa", running([plan[1]], teraz) === null);
/* Na spotkania wchodzi się z opóźnieniem — wpis sprzed dziesięciu minut
   wciąż jest tym, na którym się siedzi. */
check(
  "Spóźnione wejście trafia w to samo spotkanie",
  running([wpis({ id: "x", from: za(-9), to: za(-1), guests: 2 })], teraz)?.id === "x",
);
check(
  "Ale nie w spotkanie sprzed godziny",
  running([wpis({ id: "x", from: za(-90), to: za(-60), guests: 2 })], teraz) === null,
);

/* ── Co dopiero ruszyło ─────────────────────────────────────── */

/* „Ruszyło od ostatniego spojrzenia" — nie „trwa". Bez tego rozróżnienia
   nagranie startowałoby przy każdym spojrzeniu przez całe spotkanie. */
const świeże = justStarted(plan, teraz, { since: za(-10) });
check(
  "Spotkanie, które ruszyło od ostatniego spojrzenia, jest zgłoszone",
  świeże.some((e) => e.id === "teraz"),
);
check(
  "…ale przy następnym spojrzeniu już nie",
  justStarted(plan, teraz, { since: za(-2) }).some((e) => e.id === "teraz") === false,
);
check("Wpis bez rozmowy nie rusza niczego", !świeże.some((e) => e.id === "dentysta"));
check(
  "To, co dopiero będzie, jeszcze nie ruszyło",
  !justStarted(plan, teraz, { since: za(-60) }).some((e) => e.id === "przegląd"),
);
/* Pierwsze spojrzenie po starcie aplikacji nie ma „poprzedniego razu"
   — ma wtedy złapać spotkanie, na które ktoś właśnie wchodzi. */
check(
  "Pierwsze spojrzenie łapie spotkanie sprzed chwili",
  justStarted(plan, teraz).some((e) => e.id === "teraz"),
);

console.log(`\n${passed} sprawdzeń przeszło.`);
