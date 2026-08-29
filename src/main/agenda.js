"use strict";

const { execFile } = require("child_process");
const { helperPath } = require("./tap");

/**
 * Kalendarz — co jest w planie i co właśnie się zaczyna.
 *
 * Wykrywanie po oknach (main/detect.js) odpowiada na pytanie „czy rozmowa
 * TRWA". Kalendarz odpowiada na inne: „co ma się zacząć" — i tylko on zna
 * NAZWĘ spotkania, zanim ono się zacznie. To jest cała różnica w wartości:
 * z okna przeglądarki wychodzi „jxg-hfsa-qvb", z kalendarza „Przegląd
 * tygodnia z Anią".
 *
 * SKĄD BIERZEMY KALENDARZ. Z systemowego, przez EventKit (patrz
 * native/tap/main.swift, tryb --agenda). Widać w nim wszystko, co ktoś
 * dodał w macOS: Google, iCloud, Exchange. Google Calendar podpięty
 * w Ustawieniach systemowych jest tam tak samo widoczny jak reszta,
 * a kosztuje zero kluczy API i zero okien logowania.
 *
 * CO SIĘ LICZY JAKO SPOTKANIE. Nie każdy wpis w kalendarzu: „dentysta"
 * i „odebrać dziecko" to nie są rozmowy do nagrania. Liczy się wpis,
 * w którym jest adres pokoju rozmowy ALBO ktoś jeszcze poza nami. Reszta
 * to plan dnia, a nie spotkanie.
 *
 * Rozstrzygnięcia są czyste — wchodzi lista wpisów, wychodzi decyzja.
 * Sprawdza je zwykły Node (scripts/agenda-test.js).
 */

/** Ile najdłużej czekamy na odpowiedź programu pomocniczego. */
const PATIENCE = 8000;
/** Jak daleko w przód pytamy kalendarz. */
const HOURS = 12;
/**
 * Ile minut po rozpoczęciu wpis wciąż „się zaczyna".
 *
 * Na spotkania wchodzi się z opóźnieniem i to jest norma, nie wyjątek.
 * Nagranie włączone pięć minut po godzinie ma dalej dotyczyć TEGO wpisu.
 */
const GRACE = 10;

/**
 * Odpowiedź programu pomocniczego na obiekt.
 *
 * @param {string} line  jedna linia JSON
 * @returns {{access: string, events: Array}}
 */
function parse(line) {
  let data;
  try {
    data = JSON.parse(String(line ?? "").trim() || "{}");
  } catch {
    return { access: "error", events: [] };
  }
  const events = (data.events ?? [])
    .map((event) => ({
      id: String(event.id ?? ""),
      title: String(event.title ?? "").trim(),
      from: Date.parse(event.from),
      to: Date.parse(event.to),
      guests: Number(event.guests) || 0,
      link: String(event.link ?? "").trim() || null,
    }))
    .filter((event) => event.id && Number.isFinite(event.from) && Number.isFinite(event.to));
  return { access: data.access ?? "error", events };
}

/**
 * Czy ten wpis to rozmowa, a nie punkt planu dnia.
 *
 * Adres pokoju rozstrzyga od razu. Poza tym liczy się obecność innych
 * ludzi: „dentysta" nie ma zaproszonych, „przegląd tygodnia" ma.
 */
function isMeeting(event) {
  if (!event) return false;
  if (event.link) return true;
  return event.guests >= 2;
}

/** Wpisy, które dopiero będą — po kolei, same rozmowy. */
function upcoming(events, now = Date.now(), { limit = 5 } = {}) {
  return (events ?? [])
    .filter(isMeeting)
    .filter((event) => event.to > now)
    .sort((a, b) => a.from - b.from)
    .slice(0, limit);
}

/**
 * Wpis, który właśnie trwa.
 *
 * Trwa znaczy: zaczął się (z zapasem na spóźnienie) i jeszcze się nie
 * skończył. Przy dwóch nakładających się wygrywa ten, który zaczął się
 * później — czyli ten, na który się właśnie weszło.
 */
function running(events, now = Date.now(), { grace = GRACE } = {}) {
  const window = grace * 60_000;
  const live = (events ?? [])
    .filter(isMeeting)
    .filter((event) => now >= event.from && now < event.to + window)
    .sort((a, b) => b.from - a.from);
  return live[0] ?? null;
}

/**
 * Wpis, który dopiero co się zaczął i nie był jeszcze obsłużony.
 *
 * Osobno od `running`, bo pytanie jest inne: nie „co teraz trwa", tylko
 * „co ruszyło od ostatniego spojrzenia". Bez tego nagranie startowałoby
 * przy każdym spojrzeniu przez całe spotkanie.
 */
function justStarted(events, now, { since = null, grace = GRACE } = {}) {
  /* Pierwsze spojrzenie po włączeniu nie ma „poprzedniego razu" — bierzemy
     wtedy zapas na spóźnienie, żeby spotkanie, na które ktoś właśnie
     wchodzi, nie przepadło tylko dlatego, że aplikacja wstała minutę temu. */
  const floor = since ?? now - grace * 60_000;
  return (events ?? [])
    .filter(isMeeting)
    .filter((event) => event.from <= now && event.from > floor)
    .sort((a, b) => a.from - b.from);
}

/** Spis spotkań z kalendarza systemowego. */
function read({ hours = HOURS, helper = helperPath() } = {}) {
  return new Promise((resolve) => {
    if (!helper) return resolve({ access: "missing", events: [] });
    execFile(
      helper,
      ["--agenda", "--hours", String(hours)],
      { timeout: PATIENCE, encoding: "utf8" },
      (problem, stdout) => {
        if (problem && !stdout) return resolve({ access: "error", events: [] });
        resolve(parse(stdout));
      },
    );
  });
}

module.exports = { read, parse, isMeeting, upcoming, running, justStarted, HOURS, GRACE };
