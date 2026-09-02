"use strict";

const { execFile } = require("child_process");

/**
 * Kalendarz drogą okrężną — przez Kalendarz.app, a nie przez EventKit.
 *
 * ══ DLACZEGO TA DROGA W OGÓLE ISTNIEJE ══
 *
 * Pierwsza droga — EventKit w programie pomocniczym (main/agenda.js →
 * cribro-tap --agenda) — jest lepsza pod każdym względem: szybka, nie budzi
 * cudzej aplikacji i czyta wszystkie kalendarze dodane w systemie. Ma jedną
 * wadę: NA macOS 26 NIE DA SIĘ JEJ UŻYĆ.
 *
 * Zmierzone, nie zgadnięte. `requestFullAccessToEvents()` wraca fałszem
 * NATYCHMIAST, stan zgody zostaje „notDetermined", a w dzienniku systemowym
 * nie ma ani jednego wpisu od tccd — czyli EventKit odmawia u siebie, zanim
 * w ogóle spyta system o zgodę. Sprawdzone w czterech układach i we
 * wszystkich tak samo:
 *
 *   1. goła binarka z terminala,
 *   2. goła binarka z opisem zgody wklejonym w sekcję __TEXT,__info_plist,
 *   3. ta sama binarka w pakiecie .app z własnym Info.plist,
 *   4. PRAWDZIWY, podpisany cribro-tap uruchomiony z aplikacji Electrona.
 *
 * Zgody TCC na tej maszynie działają — okno „chce dostępu do sterowania
 * aplikacją Kalendarz" pojawia się bez problemu. Nie działa dokładnie jedno:
 * proces potomny proszący o kalendarz przez EventKit. Nie ma go jak
 * przedstawić człowiekowi, więc system nie pyta, tylko odmawia.
 *
 * ══ CO ROBI TA DROGA ══
 *
 * Pyta Kalendarz.app przez Apple Events — czyli tym samym mechanizmem,
 * którym aplikacja wysyła notatkę do Notatek Apple (main/share.js) i wkleja
 * tekst pod kursor (main/paste.js). Zgoda nazywa się wtedy „Automatyzacja",
 * pyta o nią zwykłe okno systemowe i jest przypisana DO CRIBRO — bo to
 * Cribro wysyła zdarzenie, choćby wykonywał je osascript.
 *
 * Aplikacja ma już wszystko, czego ta droga potrzebuje:
 * `NSAppleEventsUsageDescription` w Info.plist i uprawnienie
 * `com.apple.security.automation.apple-events` w podpisie.
 *
 * ══ CZEGO TA DROGA NIE UMIE ══
 *
 * Budzi Kalendarz.app, jeśli nie chodzi — pierwsze pytanie trwa wtedy kilka
 * sekund. Widzi tylko te kalendarze, które widzi Kalendarz.app (w praktyce
 * te same). I nie zna adresów zaproszonych inaczej niż z pola uczestników.
 * Dlatego jest DRUGA W KOLEJCE, a nie pierwsza: gdy EventKit kiedyś ruszy —
 * na innym systemie albo po poprawce Apple — wygra bez zmiany w kodzie.
 *
 * Rozstrzygnięcia są czyste: skrypt wchodzi tekstem, wychodzi tablicą
 * wpisów. Sprawdza je zwykły Node (scripts/agenda-test.js).
 */

/**
 * Ile najdłużej czekamy. Pierwsze pytanie budzi Kalendarz.app.
 *
 * Zmierzone na koncie z dziesięcioma kalendarzami i ~1700 wydarzeniami:
 * 15–40 sekund, zależnie od tego, czy Calendar.app ma coś w swoim
 * wewnętrznym cache'u. Sześćdziesiąt sekund to zapas ponad najgorszy
 * zmierzony przypadek, nie liczba wzięta z sufitu — patrz komentarz przy
 * SCRIPT niżej po to, skąd w ogóle bierze się ten koszt.
 */
const PATIENCE = 60_000;

/**
 * Skrypt w JXA — JavaScript, nie AppleScript.
 *
 * Powód jest jeden i praktyczny: daty. AppleScript liczy je własną
 * arytmetyką, po której trzeba by je jeszcze przepisać na coś, co rozumie
 * Node; JXA oddaje je jako liczby milisekund i sprawa się kończy.
 *
 * ══ DLACZEGO TU NIE MA „whose" — I DLACZEGO WCZEŚNIEJ BYŁ BŁĄD ══
 *
 * Wcześniejsza wersja filtrowała datę PRZEZ `events.whose({...})` i potem
 * czytała z wyniku siedem właściwości batchem — z komentarzem, że to jest
 * „jedno pytanie na właściwość, nie na wpis". Brzmiało to jak optymalizacja
 * i mierzyło się dobrze na małym koncie. Na koncie z tysiącem kilkuset
 * wydarzeń w dziesięciu kalendarzach mierzy się inaczej: KAŻDY dostęp do
 * właściwości na wyniku `whose()` PRZELICZA CAŁY FILTR OD NOWA. Siedem
 * właściwości na kalendarzu z 723 wpisami to siedem pełnych przebiegów —
 * zmierzone: 62 sekundy na SAM ten jeden kalendarz, z zerem trafień
 * w oknie. Na dziesięciu kalendarzach całość nie kończyła się nawet po
 * dwóch i pół minuty.
 *
 * Naprawa jest w tym, co NIE filtruje: `calendars[c].events.startDate()`
 * (JEDNA właściwość, bez `whose`) czyta datę początku KAŻDEGO wydarzenia
 * jednym przebiegiem — i to jest jedyny kosztowny krok, jaki tu został.
 * Okno czasowe sprawdzamy POTEM, w zwykłym JavaScripcie, za darmo.
 *
 * Dla nielicznych trafień (w oknie kilkunastu godzin to zwykle
 * pojedyncze wpisy) sięgamy po resztę danych przez INDEKS NA SUROWEJ
 * KOLEKCJI — `calendars[c].events[i].properties()` — a nie przez indeks
 * na wyniku `whose()`. Różnica zmierzona na tym samym koncie: 0,5 sekundy
 * kontra 19. Indeks na surowej kolekcji jest zwykłym odwołaniem
 * pozycyjnym; indeks na `whose()` wciąż jest indeksem W FILTRZE i wciąż
 * go przelicza.
 *
 * Całość na tym koncie (dziesięć kalendarzy, ~1700 wydarzeń łącznie):
 * niecałe 40 sekund, zawsze się kończy. Wcześniej: nieskończoność.
 */
const SCRIPT = `
function run(argv) {
  const from = new Date(Number(argv[0]));
  const to = new Date(Number(argv[1]));
  const detail = Number(argv[2]) || 8;
  const mayLaunch = argv[3] === "1";

  const cal = Application("Calendar");

  /* NIE BUDZIMY KALENDARZA SAMI.

     Samo pytanie o cokolwiek uruchamia Kalendarz.app, jeśli nie chodzi —
     a to jest cudza aplikacja, która wstaje na kilkadziesiąt sekund,
     zaczyna synchronizację i staje w Docku. Zaglądanie do kalendarza co
     minutę nie może tego robić.

     Budzimy go WYŁĄCZNIE wtedy, gdy człowiek właśnie kliknął „Poproś
     o dostęp" — bo wtedy jest to dokładnie ta rzecz, o którą poprosił.
     W tle pytamy tylko wtedy, gdy Kalendarz i tak już chodzi. */
  if (!mayLaunch && !cal.running()) return "ASLEEP";

  const calendars = cal.calendars();

  /* PRZEBIEG PIERWSZY, KOSZTOWNY: która pozycja w którym kalendarzu leży
     w oknie czasowym. Jedna właściwość, bez filtra — patrz komentarz nad
     tym skryptem po to, żeby zrozumieć, czemu akurat tak. */
  const hits = [];
  for (let c = 0; c < calendars.length; c += 1) {
    let starts;
    try {
      starts = calendars[c].events.startDate();
    } catch (e) {
      continue; // kalendarz, którego nie da się odpytać, po prostu pomijamy
    }
    for (let i = 0; i < starts.length; i += 1) {
      const s = starts[i];
      if (s && s.getTime() > from.getTime() && s.getTime() < to.getTime()) hits.push([c, i]);
    }
  }

  /* PRZEBIEG DRUGI, TANI: reszta danych — ale tylko dla tych nielicznych
     pozycji, i indeksem na SUROWEJ kolekcji, nie na wyniku filtra. */
  const out = [];
  for (let h = 0; h < hits.length; h += 1) {
    const c = hits[h][0];
    const i = hits[h][1];
    try {
      const p = calendars[c].events[i].properties();
      out.push({
        id: String(p.uid || ""),
        title: String(p.summary || ""),
        from: p.startDate ? p.startDate.getTime() : 0,
        to: p.endDate ? p.endDate.getTime() : 0,
        location: String(p.location || ""),
        url: String(p.url || ""),
        notes: String(p.description || ""),
        people: [],
        emails: [],
        guests: 0,
        ref: [c, i],
      });
    } catch (e) {
      continue; // wpis, którego nie da się odczytać, po prostu pomijamy
    }
  }

  /* KTO ZAPROSZONY — tylko dla najbliższych kilku wpisów.

     Lista uczestników nie da się wziąć hurtem: każde nazwisko to osobne
     przekroczenie granicy procesu, a przy stu wpisach w kalendarzu robi się
     z tego kilkaset zapytań i dwie minuty czekania. A potrzebna jest do
     dwóch rzeczy naraz — do rozstrzygnięcia „czy to w ogóle spotkanie"
     i do podpisania drugiego toru rozmowy imieniem — i obie dotyczą
     wyłącznie tego, co ZARAZ się zacznie. Reszty kalendarza nikt nie
     ogląda: spis pokazuje pięć najbliższych wpisów.

     Wpis z adresem pokoju jest rozmową bez pytania kogokolwiek o zdanie,
     więc pytamy tylko o te bez adresu i tylko o kilka najwcześniejszych. */
  out.sort(function (a, b) { return a.from - b.from; });
  let asked = 0;
  for (let i = 0; i < out.length && asked < detail; i += 1) {
    const ref = out[i].ref;
    try {
      // Indeks na SUROWEJ kolekcji, tak samo jak wyżej przy .properties()
      // — a nie ponowne whose(), które by tu znaczyło jeszcze jeden pełny
      // przebieg przez kalendarz za każdego z tych kilku wpisów.
      const ev = calendars[ref[0]].events[ref[1]];
      const who = ev.attendees();
      const names = [];
      const mails = [];
      for (let a = 0; a < who.length; a += 1) {
        try { names.push(String(who[a].displayName() || who[a].email() || "")); } catch (x) {}
        try { mails.push(String(who[a].email() || "")); } catch (x) {}
      }
      out[i].people = names.filter(Boolean);
      out[i].emails = mails.filter(Boolean);
      out[i].guests = out[i].people.length;
      asked += 1;
    } catch (x) {
      asked += 1; // wpis, który nie chce oddać uczestników, nie zatrzymuje reszty
    }
  }

  for (let i = 0; i < out.length; i += 1) delete out[i].ref;
  return JSON.stringify(out);
}
`;

/** Adresy pokoi rozmów — po nich poznajemy, że wpis to spotkanie. */
const ROOMS = ["meet.google.com", "zoom.us/j/", "teams.microsoft.com/l/meetup", "webex.com/meet"];

/**
 * Adres rozmowy wyłuskany z pola, w którym akurat siedzi.
 *
 * Kalendarze wpisują go gdzie popadnie: Google w „location" albo w opisie,
 * Outlook w treści. To samo rozstrzygnięcie, co w native/tap/main.swift —
 * i z tego samego powodu: wpis z adresem pokoju jest rozmową bez względu
 * na to, ilu ludzi zaproszono.
 */
function meetingLink(...fields) {
  for (const field of fields) {
    for (const word of String(field ?? "").split(/[\s<>"'()[\],]+/)) {
      if (ROOMS.some((room) => word.includes(room))) return word;
    }
  }
  return null;
}

/**
 * Odpowiedź skryptu na wpisy w postaci, której używa reszta aplikacji.
 *
 * Ten sam kształt, co `parse` w main/agenda.js — bo to jest ta sama rzecz
 * wzięta inną drogą, a nie druga rzecz o podobnym kształcie.
 *
 * @param {string} raw  wyjście osascript
 * @returns {{access: string, events: Array}}
 */
function readEvents(raw) {
  const text = String(raw ?? "").trim();
  /* Kalendarz.app śpi, a my go nie budzimy — patrz `mayLaunch` w skrypcie.
     To nie jest awaria ani odmowa: to jest „nie ma kogo zapytać". */
  if (text === "ASLEEP") return { access: "asleep", events: [] };

  let rows;
  try {
    rows = JSON.parse(text || "[]");
  } catch {
    return { access: "error", events: [] };
  }
  if (!Array.isArray(rows)) return { access: "error", events: [] };

  const events = rows
    .map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.title ?? "").trim(),
      from: Number(row.from),
      to: Number(row.to),
      guests: Number(row.guests) || 0,
      people: (row.people ?? []).map((name) => String(name).trim()).filter(Boolean),
      emails: (row.emails ?? [])
        .map((mail) => String(mail).trim().toLowerCase())
        .filter(Boolean),
      link: meetingLink(row.location, row.url, row.notes),
    }))
    .filter((event) => event.id && Number.isFinite(event.from) && Number.isFinite(event.to));

  return { access: "granted", events };
}

/**
 * Co osascript powiedział, gdy się nie udało.
 *
 * Odmowa zgody na automatyzację ma własny numer (-1743) i własne wyjście:
 * przełącznik w Ustawieniach systemowych, w sekcji Automatyzacja. Reszta to
 * awarie, o których mówimy jak o awariach.
 */
function readFailure(message) {
  const text = String(message ?? "");
  if (text.includes("-1743") || /not (allowed|authorized)/i.test(text)) return "denied";
  if (text.includes("-1728")) return "error"; // Kalendarz nie oddał obiektu
  if (/timed? out|-1712/i.test(text)) return "timeout";
  if (text.includes("-600") || /isn'?t running/i.test(text)) return "error";
  return "error";
}

/**
 * Spis spotkań z Kalendarza.app.
 *
 * @param {object} [options]
 * @param {number} [options.hours]     jak daleko w przód
 * @param {number} [options.back]      ile godzin wstecz
 * @param {number} [options.patience]  ile najdłużej czekamy
 * @param {Function} [options.run]     wywołanie osascript; wstrzykiwane w teście
 * @returns {Promise<{access: string, events: Array}>}
 */
function read({ hours = 12, back = 1, patience = PATIENCE, detail = 8, launch = false, run } = {}) {
  const now = Date.now();
  const from = now - Math.max(1, back) * 3600_000;
  const to = now + hours * 3600_000;

  const call =
    run ??
    ((args, done) =>
      execFile(
        "osascript",
        args,
        { timeout: patience, encoding: "utf8", maxBuffer: 8 << 20 },
        done,
      ));

  return new Promise((resolve) => {
    const args = [
      "-l", "JavaScript", "-e", SCRIPT,
      String(from), String(to), String(detail), launch ? "1" : "0",
    ];
    call(args, (problem, stdout, stderr) => {
      if (problem) {
        return resolve({ access: readFailure(stderr || problem.message), events: [] });
      }
      resolve(readEvents(stdout));
    });
  });
}

module.exports = { read, readEvents, readFailure, meetingLink, SCRIPT, PATIENCE };
