"use strict";
/**
 * Wykrywanie spotkania po tytułach okien.
 *   node scripts/detect-test.js
 *
 * Połowa przypadków to takie, w których wykrywanie ma NIC NIE ZNALEŹĆ —
 * i to jest ważniejsza połowa. Niewykryte spotkanie zostawia wszystko tak,
 * jak jest dzisiaj; wykryte z niczego oznacza znaczek dopominający się
 * o notatki w trakcie oglądania filmu, a przy ustawieniu „sam z siebie"
 * — nagranie cudzych słów bez powodu.
 */
const assert = require("assert");
const { spot, Watcher } = require("../src/main/detect");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Co jest rozmową ────────────────────────────────────────── */

check("Karta Google Meet w rozmowie", spot(["Meet – jrx-kfoz-hys"])?.kind === "meet");
check("Rozmowa w Zoomie", spot(["Zoom Meeting"])?.kind === "zoom");
check("Webinar w Zoomie też", spot(["Zoom Webinar"])?.kind === "zoom");
check("Spotkanie w Teams", spot(["Meeting in Ustalenia | Microsoft Teams"])?.kind === "teams");
check("Spotkanie w Webexie", spot(["Cisco Webex Meetings"])?.kind === "webex");
check(
  "Rozmowa znaleziona wśród innych okien",
  spot(["Notatki — Cribro Sift", "Poczta", "Zoom Meeting", "Finder"])?.kind === "zoom",
);

/* ── Co rozmową NIE jest ───────────────────────────────────── */

check("Strona startowa Google Meet to nie rozmowa", spot(["Google Meet"]) === null);
check("Zoom stojący w tle to nie rozmowa", spot(["Zoom Workplace"]) === null);
check("Sam Zoom to nie rozmowa", spot(["Zoom"]) === null);
check("Czat w Teams to nie rozmowa", spot(["Czat | Microsoft Teams"]) === null);
check("Nasze własne okno to nie rozmowa", spot(["Cribro Sift"]) === null);
check(
  "Film o spotkaniach to nie spotkanie",
  spot(["Jak prowadzić Zoom Meeting — poradnik - YouTube"]) === null,
);
check("Pusty spis nie wymyśla spotkania", spot([]) === null && spot(null) === null);
check("Puste tytuły są pomijane", spot(["", "   ", null]) === null);

/* ── Nazwa spotkania ───────────────────────────────────────── */

check(
  "Nazwa spotkania wychodzi z tytułu karty",
  spot(["Meet – Przegląd tygodnia"])?.title === "Przegląd tygodnia",
);
/* Kod pokoju wygląda jak nazwa i nią nie jest. W nagłówku notatki
   „jrx-kfoz-hys" nie mówi nikomu nic — lepiej nie mieć nazwy wcale. */
check("Kod pokoju nazwą nie jest", spot(["Meet – jrx-kfoz-hys"])?.title === null);
check(
  "Nazwa spotkania w Teams też",
  spot(["Meeting in Ustalenia | Microsoft Teams"])?.title === "Ustalenia",
);
check(
  "Nazwa przeglądarki doklejona do tytułu karty odpada",
  spot(["Meet – Przegląd tygodnia - Google Chrome"])?.title === "Przegląd tygodnia",
);

/* ── Pilnowanie ekranu ─────────────────────────────────────── */

(async () => {
  /* Spojrzeniami sterujemy RĘCZNIE, a nie zegarem. Test oparty na czekaniu
     „aż minie odstęp" mówi o szybkości tej maszyny, a nie o tym, czy
     strażnik liczy spojrzenia jak trzeba — i przy pierwszym obciążonym
     przebiegu zaczyna migać. Zegar sprawdzamy osobno, na samym końcu. */
  let screen = ["Finder"];
  const said = [];
  const watch = new Watcher({
    list: async () => screen,
    onChange: (meeting) => said.push(meeting ? meeting.kind : null),
    every: 10_000,
  });

  await watch.look();
  check("Pusty ekran nie melduje niczego", said.length === 0);

  screen = ["Zoom Meeting"];
  await watch.look();
  check("Pojawienie się rozmowy jest meldowane", said.join(",") === "zoom");

  await watch.look();
  check("…i meldowane RAZ, a nie co spojrzenie", said.join(",") === "zoom");

  /* Zniknięcie dopiero za drugim razem: spis okien bywa przez chwilę
     niepełny, a znaczek gasnący i zapalający się co osiem sekund byłby
     gorszy niż brak wykrywania. */
  screen = ["Finder"];
  await watch.look();
  check("Jedno spojrzenie bez rozmowy jeszcze niczego nie kończy", said.length === 1);
  await watch.look();
  check("Dwa z rzędu — koniec rozmowy", said.join(",") === "zoom,");

  screen = ["Meet – jrx-kfoz-hys"];
  await watch.look();
  check("Następna rozmowa jest meldowana od nowa", said.join(",") === "zoom,,meet");

  watch.stop();
  check("Zatrzymanie kończy bieżące spotkanie", said.join(",") === "zoom,,meet,");
  check("…i nie pilnuje dalej", watch.running === false);

  /* Zegar: start ma patrzeć OD RAZU i patrzeć dalej sam z siebie.
     Tu odstęp jest naprawdę krótki, więc sprawdzamy tylko tyle. */
  let looks = 0;
  const ticking = new Watcher({
    list: async () => { looks += 1; return []; },
    onChange: () => {},
    every: 20,
  });
  ticking.start();
  check("Start patrzy od razu, nie dopiero po odstępie", looks === 1);
  await wait(90);
  ticking.stop();
  check("…i patrzy dalej sam z siebie", looks >= 2);

  /* Awaria spisu okien to zwykle odmowa zgody „Nagrywanie ekranu".
     Ma dojść do kogoś, kto potrafi coś z tym zrobić, a nie zabić pętli. */
  const problems = [];
  const broken = new Watcher({
    list: async () => { throw new Error("brak zgody"); },
    onChange: () => {},
    onError: (problem) => problems.push(problem.message),
    every: 20,
  });
  broken.start();
  await wait(60);
  broken.stop();
  check("Awaria spisu okien jest zgłaszana, a nie połykana", problems[0] === "brak zgody");
  check("…i nie zatrzymuje pilnowania", problems.length >= 2);

  /* ── Rytm ───────────────────────────────────────────────────
     Spis okien kosztuje kilkadziesiąt milisekund procesu GŁÓWNEGO, więc
     pytanie zadawane co osiem sekund przez całą dobę jest realnym obciążeniem
     — i przez większość doby odpowiedź brzmi tak samo. Rytm ma więc zwalniać,
     gdy nic się nie dzieje, i wracać natychmiast, gdy coś się zaczyna. */
  {
    const pacing = new Watcher({
      list: async () => [],
      onChange: () => {},
      every: 8000,
      idle: 32_000,
      patience: 3,
    });
    check("Na początku pytamy szybko", pacing.pace === 8000);
    pacing.empty = 2;
    check("…i przy dwóch pustych spojrzeniach nadal szybko", pacing.pace === 8000);
    pacing.empty = 3;
    check("Po trzech pustych spojrzeniach zwalniamy", pacing.pace === 32_000);
    pacing.hurry();
    check("Wezwanie z zewnątrz wraca na szybki rytm", pacing.pace === 8000);
  }

  {
    /* Zwolnienie NIE MOŻE przeżyć pojawienia się rozmowy — ani jej
       zniknięcia. Jedno i drugie jest chwilą, w której liczy się każda
       sekunda: przy pojawieniu trzeba zdążyć zapytać o notatki, przy
       zniknięciu — zakończyć nagranie. */
    let screen = [];
    const waking = new Watcher({
      list: async () => screen,
      onChange: () => {},
      every: 20,
      idle: 5000,
      patience: 2,
    });
    waking.start();
    await wait(120);
    check("Pusty ekran zwalnia pilnowanie", waking.pace === 5000);
    screen = ["Zoom Meeting"];
    await waking.look();
    check("Rozmowa na ekranie natychmiast przyspiesza", waking.pace === 20);
    screen = [];
    await waking.look();
    await waking.look();
    check("…a jej zniknięcie też, bo trzeba kończyć nagranie", waking.pace === 20);
    waking.stop();
  }

  console.log(`\n${passed} sprawdzeń przeszło.`);
})();
