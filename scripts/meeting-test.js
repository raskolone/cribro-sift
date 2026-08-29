"use strict";
/**
 * Przebieg spotkania: od kliknięcia do dwóch plików i wpisu w spisie.
 *   node scripts/meeting-test.js
 *
 * Sprawdza to, czego nie widzą testy niższych warstw. tap-test.js pilnuje
 * rozplotu ramek, blockmove-test.js rozstrzygnięć — a tutaj chodzi o rzecz
 * prostszą i ważniejszą: czy po zakończeniu rozmowy naprawdę COŚ ZOSTAJE,
 * i czy zostaje tam, gdzie potem będzie szukane.
 *
 * Biegnie w Electronie, bo składu danych nie da się utworzyć bez niego
 * (app.getPath), a podstawianie atrapy sklepu sprawdzałoby atrapę.
 * Katalog danych jest tymczasowy, więc nie tyka ustawień na tym komputerze.
 *
 * Nagrywanie wymaga zgody „Nagrywanie ekranu”. Bez niej test kończy się
 * głośnym pominięciem, a nie cichym przejściem — patrz komentarz
 * w scripts/tap-test.js.
 */
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-meeting-"));

const MAIN = `
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();
/* Strażnik czasu. execFileSync po swoim limicie wysyła SIGTERM, którego
   Electron nie honoruje — zawieszony test potrafił wisieć kwadrans zamiast
   minuty i zabierał ze sobą cały przebieg npm test. Program musi umieć
   skończyć się sam. */
setTimeout(() => {
  process.stdout.write("\\n@@WYNIK@@" + JSON.stringify({ steps: [], skip: "nagrywanie nie odpowiedziało w 45 s" }) + "@@KONIEC@@\\n");
  app.exit(0);
}, 45000);
// Własny katalog danych: test nie ma prawa dotknąć ustawień na tym komputerze.
app.setPath("userData", ${JSON.stringify(path.join(work, "dane"))});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { Store } = require(${JSON.stringify(path.join(root, "src/main/store.js"))});
  const { Meetings } = require(${JSON.stringify(path.join(root, "src/main/meeting.js"))});

  const out = { steps: [] };
  const say = (name, value) => out.steps.push({ name, value });

  const store = new Store();
  say("gałąź ustawień istnieje", !!store.getSettings().meetings);
  say("domyślnie pyta, zamiast nagrywać sama", store.getSettings().meetings.detect);
  say("domyślnie nie zostawia nagrania", store.getSettings().meetings.keepAudio);

  let changes = 0;
  let problem = null;
  const meetings = new Meetings(store, {
    onChange: () => { changes += 1; },
    onError: (message) => { problem = message; },
  });

  say("na starcie nic nie nagrywa", meetings.recording);

  // ── Pomyłka: za krótkie nagranie ginie bez śladu ──
  await meetings.start();
  say("po starcie nagrywa", meetings.recording);
  say("wpis powstaje OD RAZU, nie po zakończeniu", store.getMeetings().length);
  say("i ma stan „recording”", store.getMeetings()[0] && store.getMeetings()[0].state);
  await wait(2500);
  const short = await meetings.stop();

  /* Błąd helpera rozstrzyga się TUTAJ, przed asercjami o odrzuceniu.
     Gdy nagrywanie odmówi, #fail zatrzymuje je samo — a wtedy stop() nie ma
     już czego odrzucać i test pytałby o zachowanie, którego nie wywołał. */
  if (problem) { out.skip = problem; process.stdout.write("\\n@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@\\n"); app.exit(0); return; }

  say("krótkie nagranie zostaje odrzucone", short.discarded);
  say("i nie zostawia wpisu", store.getMeetings().length);
  say("ani katalogu", fs.existsSync(path.join(store.meetingsDir)) ? fs.readdirSync(store.meetingsDir).length : 0);

  // ── Prawdziwe spotkanie ──
  store.saveSettings({ meetings: { minSeconds: 1 } });
  await meetings.start();
  await wait(3000);
  const done = await meetings.stop();
  say("dłuższe nagranie zostaje", !done.discarded && !!done.meeting);

  if (done.meeting) {
    const m = done.meeting;
    say("wpis ma stan „done”", m.state);
    say("wpis wie, ile trwał", Math.round(m.seconds));
    say("oba tory zapisane", !!(m.tracks && fs.existsSync(m.tracks.mic) && fs.existsSync(m.tracks.system)));
    const mic = fs.readFileSync(m.tracks.mic);
    say("tor mikrofonu to WAV z domkniętym nagłówkiem",
      mic.subarray(0, 4).toString() === "RIFF" && mic.readUInt32LE(40) === mic.length - 44);
    say("pliki leżą w katalogu tego spotkania", m.tracks.mic.includes(m.id));
    say("spis pokazuje jedno spotkanie", meetings.list().length);
  }

  say("każda zmiana stanu została ogłoszona", changes);
  say("po zakończeniu znowu nic nie nagrywa", meetings.recording);

  /* ── Przepisywanie w biegu ──
     Osobne nagrywanie, bo trzeba mu podmienić dwie rzeczy: przepisywanie
     (żeby nie wołać cudzego serwera) i długość odcinka (żeby na trzech
     sekundach w ogóle powstały odcinki, a nie jeden ogryzek). Reszta drogi
     jest ta sama — prawdziwy dźwięk, prawdziwa krajalnica, prawdziwy splot. */
  const said = [];
  const scribe = new Meetings(store, {
    // Tor mikrofonu i tor systemu mówią co innego — inaczej splot uznałby
    // jedno za echo drugiego i miałby rację.
    transcribe: async (wav, _settings, about) => {
      said.push({ size: wav.length, lane: about?.lane });
      return {
        text: about?.lane === "mic" ? "Tu mowie ja, po swojemu." : "A tu druga strona rozmowy.",
      };
    },
    slice: { span: 1, overlap: 0.2, floor: -120 },
  });

  await scribe.start();
  await wait(3200);
  /* Pytamy o zapis PRZED zakończeniem. O to w tym etapie chodzi: po
     „Koniec" ma być gotowe, a nie dopiero zaczęte. */
  const live = store.getMeetings().find((item) => item.state === "recording");
  say("zapis rośnie w trakcie rozmowy", live?.transcript?.length ?? 0);
  const written = await scribe.stop();

  /* Nagrywanie mogło odpaść dopiero tutaj — zgody „Nagrywanie ekranu"
     bywa, że nie ma. Bez tego wyjścia dalsze pytania leciałyby po pustce
     i test wieszałby się zamiast powiedzieć, czego brakuje. */
  if (!written.meeting) {
    out.skip = problem ?? "nagrywanie nie oddało spotkania";
    process.stdout.write("\\n@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@\\n");
    app.exit(0);
    return;
  }

  say("odcinki poszły do przepisania w trakcie rozmowy", said.length);
  say("każdy odcinek to domknięty WAV", said.every((item) => item.size > 44));
  say("odcinki przyszły z obu torów", [...new Set(said.map((item) => item.lane))].sort().join("+"));
  const lines = written.meeting.transcript ?? [];
  say("zapis rozmowy wylądował we wpisie", lines.length);
  say("zapis wie, kto mówił", [...new Set(lines.map((line) => line.speaker))].sort().join("+"));
  say("zapis ma treść", lines.every((line) => !!line.text));
  say("znaczniki czasu rosną", lines.every((line, at) => at === 0 || line.at >= lines[at - 1].at));

  /* Ustawienie mówi „nagranie ginie po transkrypcji" i ma to robić naprawdę.
     Wyżej (bez klucza API) nic się nie przepisało i pliki ZOSTAŁY — bo nie
     ma czym ich zastąpić. Tutaj przepisanie się udało, więc mają zniknąć. */
  say("po przepisaniu nagranie znika z dysku", !written.meeting.tracks);
  say("…i naprawdę nie ma go w katalogu",
    fs.readdirSync(store.meetingDir(written.meeting.id)).length);
  say("…a spotkanie zostaje w spisie", meetings.list().some((item) => item.id === written.meeting.id));

  process.stdout.write("\\n@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@\\n");
  app.exit(0);
});
`;

fs.writeFileSync(path.join(work, "main.js"), MAIN);

const electron = require("electron");
let stdout = "";
try {
  stdout = execFileSync(electron, [path.join(work, "main.js")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_ENABLE_LOGGING: "" },
    timeout: 120_000,
  });
} catch (problem) {
  console.error(problem.stdout ?? "");
  console.error(problem.stderr ?? "");
  throw new Error("Electron nie dokończył testu.");
}

const payload = /@@WYNIK@@([\s\S]*?)@@KONIEC@@/.exec(stdout);
if (!payload) {
  console.error(stdout);
  throw new Error("Okno nie oddało wyniku.");
}
const out = JSON.parse(payload[1]);
const step = (name) => out.steps.find((item) => item.name === name)?.value;

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

check("Ustawienia mają gałąź spotkań", step("gałąź ustawień istnieje") === true);
check("Domyślnie pyta, zamiast nagrywać sama", step("domyślnie pyta, zamiast nagrywać sama") === "ask");
check("Domyślnie nie zostawia nagrania na dysku", step("domyślnie nie zostawia nagrania") === false);
check("Na starcie nic nie nagrywa", step("na starcie nic nie nagrywa") === false);
check("Po starcie nagrywa", step("po starcie nagrywa") === true);
check(
  "Wpis powstaje od razu, nie po zakończeniu — inaczej godzina rozmowy ginie razem z aplikacją",
  step("wpis powstaje OD RAZU, nie po zakończeniu") === 1,
);
check("…i od razu ma stan „recording”", step("i ma stan „recording”") === "recording");
if (!out.skip) {
  check("Nagranie krótsze niż próg jest pomyłką i ginie", step("krótkie nagranie zostaje odrzucone") === true);
  check("…nie zostawiając wpisu", step("i nie zostawia wpisu") === 0);
  check("…ani katalogu", step("ani katalogu") === 0);
}

if (out.skip) {
  console.log(`\n⚠ dalsza część pominięta: ${out.skip}`);
  console.log("  Zgody „Nagrywanie ekranu” udziela się zainstalowanej aplikacji.");
} else {
  check("Prawdziwe spotkanie zostaje w spisie", step("dłuższe nagranie zostaje") === true);
  check("…ze stanem „done”", step("wpis ma stan „done”") === "done");
  check("…i ze zmierzonym czasem", step("wpis wie, ile trwał") >= 2);
  check("Oba tory wylądowały na dysku", step("oba tory zapisane") === true);
  check("Tor mikrofonu jest domkniętym WAV-em", step("tor mikrofonu to WAV z domkniętym nagłówkiem") === true);
  check("Pliki leżą w katalogu swojego spotkania", step("pliki leżą w katalogu tego spotkania") === true);
  check("Spis pokazuje to spotkanie", step("spis pokazuje jedno spotkanie") === 1);
  check("Po zakończeniu znowu nic nie nagrywa", step("po zakończeniu znowu nic nie nagrywa") === false);
  check("Każda zmiana stanu została ogłoszona oknu", step("każda zmiana stanu została ogłoszona") >= 4);

  /* Transkrypcja w biegu. Sprawdzamy DROGĘ, nie jakość przepisania:
     czy próbki doszły do krajalnicy, czy odcinki pojechały do przepisania
     jeszcze w trakcie rozmowy i czy z dwóch torów powstał jeden zapis
     z podziałem na mówiących. */
  check(
    "Odcinki jadą do przepisania w trakcie rozmowy, a nie po niej",
    step("odcinki poszły do przepisania w trakcie rozmowy") >= 2,
  );
  check("Każdy odcinek jest domkniętym WAV-em", step("każdy odcinek to domknięty WAV") === true);
  check("Kroimy oba tory, nie jeden", step("odcinki przyszły z obu torów") === "mic+system");
  check(
    "Zapis rośnie JUŻ W TRAKCIE rozmowy, a nie dopiero po niej",
    step("zapis rośnie w trakcie rozmowy") >= 1,
  );
  check("Zapis rozmowy ląduje we wpisie", step("zapis rozmowy wylądował we wpisie") >= 1);
  check("Zapis rozdziela mówiących na dwa tory", step("zapis wie, kto mówił") === "Rozmówcy+Ty");
  check("Każda wypowiedź ma treść", step("zapis ma treść") === true);
  check("Znaczniki czasu idą do przodu", step("znaczniki czasu rosną") === true);
  check(
    "Po udanym przepisaniu nagranie znika z dysku — tak, jak mówi ustawienie",
    step("po przepisaniu nagranie znika z dysku") === true,
  );
  check("…i katalog spotkania naprawdę jest pusty", step("…i naprawdę nie ma go w katalogu") === 0);
  check("…a samo spotkanie zostaje w spisie", step("…a spotkanie zostaje w spisie") === true);
  /* Druga strona tej samej reguły: wyżej, gdy przepisanie się nie udało,
     pliki musiały zostać — bo dźwięku nie da się nagrać drugi raz. */
  check(
    "Nagranie bez transkryptu NIE jest kasowane — nie ma czym go zastąpić",
    step("oba tory zapisane") === true,
  );
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} sprawdzeń przeszło.`);
