"use strict";
/**
 * Godzina rozmowy nie ma prawa zniknąć.
 *   node scripts/hour-test.js
 *
 * Test powstał po dwóch godzinnych zajęciach, z których w zapisie zostało
 * ostatnie zdanie. Za każdym razem wyglądało to tak samo: pełny plik WAV,
 * wpis zamknięty jak po udanej transkrypcji i rejestr z jednym odcinkiem
 * — z czego wynikało pokrycie „pełne", z czego wynikało skasowanie
 * nagrania, z czego wynikało, że nie ma już czego przepisać.
 *
 * ── CZEGO PILNUJE, A CZEGO NIE ──
 *
 * coverage-test.js sprawdza RACHUNEK pokrycia i przebieg z pliku. Tutaj
 * chodzi o coś innego i wcześniejszego: o przepisywanie W BIEGU, czyli
 * o drogę od próbki do rejestru. Wszystko, co niżej, to przypadki, które
 * tę drogę naprawdę przerywały — każdy sprawdzony wprost na tym module,
 * zanim został naprawiony.
 *
 * ── DLACZEGO ATRAPA TAPA, A NIE PRAWDZIWY MIKROFON ──
 *
 * Bo pytanie brzmi „co się dzieje z próbkami, które WESZŁY", a nie „czy
 * wchodzą" — od tego drugiego jest tap-test.js i meeting-test.js, które
 * potrzebują Electrona i zgód systemowych. Tutaj godzina rozmowy przelatuje
 * w sekundę i nie potrzebuje niczego poza Node'em.
 *
 * Podmiana idzie przez pamięć modułów i MUSI stać przed wczytaniem
 * meeting.js: ono destrukturyzuje `record` przy wczytywaniu, więc później
 * byłoby już za późno.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tap = require("../src/main/tap");
/** Ostatnio uruchomiony „program pomocniczy" — przez niego wlewamy dźwięk. */
let live = null;
tap.record = ({ dir, onPcm, onError }) => {
  /* Pliki są prawdziwe, choć puste: `stop` je kasuje albo zostawia i test
     ma sprawdzać właśnie to rozstrzygnięcie, a nie atrapę ścieżki. */
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    mic: path.join(dir, "tor-a-mikrofon.wav"),
    system: path.join(dir, "tor-b-system.wav"),
  };
  for (const file of Object.values(files)) fs.writeFileSync(file, tap.wavHeader(0));
  const me = { onPcm, onError, files, seconds: { mic: 0, system: 0 }, stopped: false };
  live = me;
  return {
    files,
    stop: async () => {
      me.stopped = true;
      return { files, mic: me.seconds.mic, system: me.seconds.system };
    },
  };
};

const { Meetings } = require("../src/main/meeting");

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  console.log(`✓ ${label}`);
  passed += 1;
};

/* ── Dźwięk ──────────────────────────────────────────────────────
   Ramki po dziesiątej części sekundy, bo tak sypie prawdziwy tap.
   Mowa to ton na −20 dBFS, cisza to zera — próg bramki leży między nimi
   z zapasem (patrz FLOOR w main/segments.js). */
const RATE = 16000;
const frame = (secs, loud) => {
  const samples = Math.round(secs * RATE);
  const buffer = Buffer.alloc(samples * 2);
  if (!loud) return buffer;
  const amp = Math.round(32768 * Math.pow(10, -20 / 20)) * 1.4;
  for (let at = 0; at < samples; at += 1) buffer.writeInt16LE(Math.round(amp * Math.sin(at / 6)), at * 2);
  return buffer;
};

/** Tyle sekund rozmowy, w której ktoś mówi przez dwie trzecie czasu. */
function talk(seconds, { loud = () => true } = {}) {
  for (let at = 0; at < seconds; at += 0.1) {
    live.seconds.mic += 0.1;
    live.seconds.system += 0.1;
    live.onPcm("mic", frame(0.1, loud(at)));
    live.onPcm("system", frame(0.1, loud(at)));
  }
}

/** Sklep tylko z tym, czego dotyka przebieg nagrania. */
function fakeStore(root) {
  const rows = [];
  let next = 0;
  return {
    rows,
    getSettings: () => ({ stt: { provider: "mock" }, meetings: { minSeconds: 90 } }),
    createMeeting: (about) => {
      const row = { id: `m${(next += 1)}`, ...about, state: "recording" };
      rows.push(row);
      return row;
    },
    updateMeeting: (id, patch) => {
      const row = rows.find((item) => item.id === id);
      Object.assign(row, patch);
      return row;
    },
    getMeetings: () => rows,
    deleteMeeting: (id) => {
      const at = rows.findIndex((item) => item.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
    meetingDir: (id) => {
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-hour-"));

(async () => {
  /* ── 1. Zwykła godzina ─────────────────────────────────────────
     Trzydzieści trzy odcinki na tor. Rejestr ma znać każdy z nich —
     to jest ta liczba, która w straconych zajęciach wynosiła jeden. */
  {
    const store = fakeStore(path.join(work, "zwykla"));
    const meetings = new Meetings(store, {
      transcribe: async (_wav, _settings, about) => ({ text: `[${about.lane} ${Math.round(about.from)}]` }),
    });
    await meetings.start({ title: "godzina" });
    talk(3800);
    const { meeting, coverage } = await meetings.stop();

    check("Godzina rozmowy to 66 odcinków w rejestrze, a nie jeden", coverage.segments === 66);
    check("…wszystkie przepisane", coverage.done === 66);
    check("…żaden nie został w drodze", coverage.pending === 0);
    check("Zapis zaczyna się na początku rozmowy, a nie na jej końcu", meeting.transcript[0].at === 0);
    check("Pokrycie jest pełne", coverage.complete === true);
    check("…i sięga końca nagrania", coverage.truncated === false);

    /* Rejestr na dysku. Do niego sięga się wtedy, gdy zapis wyszedł dziwny
       i pamięci procesu dawno nie ma — czyli zawsze za późno, żeby go
       dopisywać. */
    const lines = fs
      .readFileSync(path.join(work, "zwykla", meeting.id, "odcinki.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    check("Każdy odcinek zostawia ślad na dysku, także ostatni", lines.filter((l) => l.state === "done").length === 66);
    check(
      "…a ostatni odcinek sięga końca nagrania",
      Math.max(...lines.map((l) => l.to)) >= 3790,
    );
  }

  /* ── 2. Dostawca, który nie odpowiada ──────────────────────────
     Trzeci rodzaj niepowodzenia, obok błędu i pustej odpowiedzi:
     brak jakiejkolwiek odpowiedzi. `fetch` nie ma własnego terminu, więc
     bez tego limitu `stop` NIE WRACAŁ WCALE — a razem z nim nie wracało
     zamknięcie wpisu, notatka, podsumowanie i wyjście z aplikacji. */
  {
    const store = fakeStore(path.join(work, "wisi"));
    const said = [];
    const meetings = new Meetings(store, {
      transcribe: () => new Promise(() => {}),
      patience: 300,
      drain: 700,
      onError: (message) => said.push(message),
    });
    await meetings.start({ title: "wisi" });
    talk(400);

    const began = Date.now();
    const { meeting, coverage } = await meetings.stop();
    const took = Date.now() - began;

    check("Zamknięcie wraca, choć dostawca milczy", took < 5000);
    check("Odcinki, które nie wróciły, są policzone jako straty", coverage.failed === coverage.segments);
    check("…więc zapis nie udaje kompletnego", coverage.complete === false);
    check("NAGRANIE ZOSTAJE — jest jedynym egzemplarzem rozmowy", meeting.tracks !== null);
    check("…i wiadomo o tym wprost", said.some((line) => /nie wróciło z przepisywania/.test(line)));
  }

  /* ── 3. Nowa rozmowa w trakcie zamykania poprzedniej ───────────
     Zamykanie czeka na odcinki u dostawcy i potrafi trwać minutami.
     Dopóki stan nagrania leżał w polach obiektu, wchodziło w ten czas
     następne nagranie — a kończące się zerowało mu krajalnice. Druga
     rozmowa kończyła się wtedy ZEREM odcinków przy pełnym pliku WAV. */
  {
    const store = fakeStore(path.join(work, "dwie"));
    let slow = true;
    const meetings = new Meetings(store, {
      transcribe: async (_wav, _settings, about) => {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 400));
        return { text: `[${about.lane} ${Math.round(about.from)}]` };
      },
    });

    await meetings.start({ title: "pierwsza" });
    talk(600);
    const closing = meetings.stop(); // „Koniec" — i od razu następna rozmowa

    await new Promise((resolve) => setTimeout(resolve, 10));
    slow = false;
    await meetings.start({ title: "druga" });
    talk(600);

    const first = await closing;
    const second = await meetings.stop();

    check("Pierwsza rozmowa dostaje swoje odcinki", first.coverage.segments === 12);
    check("…i swój zapis", first.meeting.transcript.length > 0);
    check("DRUGA ROZMOWA TEŻ — a to ona ginęła w całości", second.coverage.segments === 12);
    check("…z pełnym zapisem", second.meeting.transcript.length > 0);
    check("…i pełnym pokryciem", second.coverage.complete === true);
    check("Dwa nagrania to dwa osobne wpisy", store.rows.length === 2);
  }

  /* ── 4. Meldunek, który się wywraca ────────────────────────────
     Uchwyty prowadzą do okien, a okno bywa zamknięte w chwili, w której
     coś do niego mówimy. Wyjątek stamtąd leciał przez pętlę po odcinkach
     i zabierał ze sobą CAŁĄ RESZTĘ porcji — a krajalnica miała już swój
     zegar przesunięty za nie wszystkie, więc odcinki znikały bez śladu. */
  {
    /* Ta sama rozmowa dwa razy: raz z uchwytami zdrowymi, raz z takimi,
       które się wywracają. Rejestr ma wyjść IDENTYCZNY — porównanie mówi
       więcej niż liczba wpisana z ręki i nie zestarzeje się przy zmianie
       długości odcinka. */
    const run = async (broken) => {
      const store = fakeStore(path.join(work, broken ? "wywrotka" : "wzorzec"));
      const boom = () => {
        throw new Error("okno zniknęło");
      };
      const meetings = new Meetings(store, {
        transcribe: async (_wav, _settings, about) => ({ text: `[${about.lane}]` }),
        ...(broken
          ? { onSilence: boom, onIdle: boom, onTranscript: boom, onChange: boom }
          : {}),
      });
      await meetings.start({ title: "z wywrotką" });
      /* Kwadrans ciszy, potem mowa — cisza w obu torach wywołuje oba
         meldunki naraz, a każdy z nich się wywraca. */
      talk(1200, { loud: (at) => at > 900 });
      return (await meetings.stop()).coverage;
    };

    const healthy = await run(false);
    const broken = await run(true);

    check("Wywrotka meldunku nie gubi ani jednego odcinka", broken.segments === healthy.segments);
    check("…ani jednego przepisanego", broken.done === healthy.done);
    check("…a mowa po niej jest w zapisie", broken.done > 0);
  }

  /* ── 5. Godzina samej ciszy ────────────────────────────────────
     Wygląda w rejestrze identycznie jak nagranie udane bez rozmowy —
     i tak samo kończyło się skasowaniem plików. A jest to najczęstszy
     obraz awarii: program pomocniczy padł, mikrofon trafił na wyciszone
     urządzenie, dźwięk poszedł w słuchawki, których nikt nie nosił.
     Kasując takie nagranie, kasuje się jedyny dowód, co się stało. */
  {
    const store = fakeStore(path.join(work, "cisza"));
    const meetings = new Meetings(store, {
      transcribe: async () => ({ text: "nie powinno paść" }),
    });
    await meetings.start({ title: "cisza" });
    talk(3800, { loud: () => false });
    const { meeting, coverage } = await meetings.stop();

    check("Sama cisza przez godzinę NIE jest przepisaną rozmową", coverage.complete === false);
    check("…nagranie zostaje na dysku", meeting.tracks !== null);
    check("…a odcinki są policzone jako ciche, nie jako zapisane", coverage.silent === coverage.segments);
  }

  /* ── 6. Cisza w obu torach jest meldowana ──────────────────────
     Po tym meldunku main.js kończy nagranie rozmowy, z której wszyscy
     wyszli. Wisi na nim druga droga do końca spotkania, więc ma padać. */
  {
    const store = fakeStore(path.join(work, "pusty"));
    let idle = 0;
    const meetings = new Meetings(store, {
      transcribe: async () => ({ text: "coś" }),
      onIdle: () => (idle += 1),
    });
    await meetings.start({ title: "pusty pokój" });
    talk(200, { loud: () => true });
    check("Dopóki ktoś mówi, cisza się nie liczy", meetings.quietSeconds < 1);
    talk(1400, { loud: () => false });
    check("Pusty pokój melduje się dokładnie raz", idle === 1);
    check("…i widać po dźwięku, że nikogo nie ma", meetings.quietSeconds > 0);
    await meetings.stop();
  }

  /* ── 7. Program pomocniczy pada w połowie ──────────────────────
     Zostają dwa pliki WAV i zwykle jest w nich cała rozmowa bez ostatniej
     minuty. Wpis musi do nich prowadzić — bez tego „Przepisz jeszcze raz"
     odpowiada, że nagranie skasowano po transkrypcji, choć leży na dysku
     nietknięte. */
  {
    const store = fakeStore(path.join(work, "awaria"));
    const meetings = new Meetings(store, {
      transcribe: async () => ({ text: "coś padło" }),
    });
    await meetings.start({ title: "urwana" });
    talk(300);
    live.onError("Nagrywanie przerwało się samo.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const row = store.rows[0];

    check("Przerwane nagranie zostaje w spisie jako nieudane", row.state === "failed");
    check("…i wie, gdzie leży jego dźwięk", !!row.tracks?.mic && fs.existsSync(row.tracks.mic));
    check("…i ile go jest", row.seconds > 0);
    check("Aplikacja nie uważa się już za nagrywającą", meetings.recording === false);
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${passed} sprawdzeń przeszło.`);
})().catch((problem) => {
  fs.rmSync(work, { recursive: true, force: true });
  console.error(`\n✗ ${problem.message}`);
  process.exit(1);
});
