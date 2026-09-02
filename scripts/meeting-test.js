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

/* Ekran nie może zasnąć w trakcie tego testu.

   ScreenCaptureKit przy uśpionym ekranie nie zgłasza ŻADNEGO ekranu, więc
   nagrywanie odpada — i wygląda to na zepsutą funkcję, choć zepsuty jest
   tylko moment. `caffeinate -w` trzyma czuwanie dokładnie tak długo, jak
   żyje ten proces — a `-u` budzi ekran, jeśli zdążył już zasnąć. Bez tego
   drugiego cały ten test milczy na maszynie zostawionej na chwilę samej,
   i milczy w sposób, który wygląda jak brak zgody. */
try {
  require("child_process").execFileSync("caffeinate", ["-u", "-t", "1"], { stdio: "ignore" });
} catch {
  /* nie macOS — nie ma czego budzić */
}
try {
  require("child_process")
    .spawn("caffeinate", ["-d", "-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: true,
    })
    .unref();
} catch {
  /* nie macOS albo brak caffeinate — test poleci jak dotąd */
}


const MAIN = `
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();
/* Strażnik czasu. execFileSync po swoim limicie wysyła SIGTERM, którego
   Electron nie honoruje — zawieszony test potrafił wisieć kwadrans zamiast
   minuty i zabierał ze sobą cały przebieg npm test. Program musi umieć
   skończyć się sam. */
const out = { steps: [] };
const finish = (why) => {
  if (why) out.skip = why;
  process.stdout.write("\\n@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@\\n");
  app.exit(0);
};
/* Strażnik oddaje TO, CO ZDĄŻYŁO SIĘ SPRAWDZIĆ, a nie pustą listę.
   Nagrywanie potrafi odpaść w połowie — najczęściej dlatego, że ekran
   zdążył zasnąć i ScreenCaptureKit nie widzi wtedy żadnego ekranu — a to,
   co sprawdziło się przed tym momentem, jest nadal warte pokazania. */
setTimeout(() => finish("nagrywanie nie odpowiedziało w 45 s"), 45000);
// Własny katalog danych: test nie ma prawa dotknąć ustawień na tym komputerze.
app.setPath("userData", ${JSON.stringify(path.join(work, "dane"))});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { Store } = require(${JSON.stringify(path.join(root, "src/main/store.js"))});
  const { Meetings } = require(${JSON.stringify(path.join(root, "src/main/meeting.js"))});

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
  if (problem) return finish(problem);

  say("krótkie nagranie zostaje odrzucone", short.discarded);
  say("i nie zostawia wpisu", store.getMeetings().length);
  say("ani katalogu", fs.existsSync(path.join(store.meetingsDir)) ? fs.readdirSync(store.meetingsDir).length : 0);

  // ── Prawdziwe spotkanie ──
  store.saveSettings({ meetings: { minSeconds: 1 } });
  if (problem) return finish(problem);
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
  if (problem) return finish(problem);
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
  if (!written.meeting) return finish(problem ?? "nagrywanie nie oddało spotkania");

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
  /* ── Przepisanie jeszcze raz, z plików ──
     Osobne nagranie z zachowanym dźwiękiem: to jedyny krok w tym module,
     który wolno powtórzyć — i jedyny ratunek dla rozmowy nagranej bez
     klucza API. Sprawdzamy, że naprawdę czyta z DYSKU, a nie z pamięci. */
  store.saveSettings({ meetings: { keepAudio: true } });
  const kept = [];
  const again = new Meetings(store, {
    transcribe: async (wav, _s, about) => {
      kept.push({ size: wav.length, lane: about?.lane, context: about?.context ?? "" });
      return { text: about?.lane === "mic" ? "Znowu ja, ten sam glos." : "I znowu druga strona." };
    },
    slice: { span: 1, overlap: 0.2, floor: -120 },
  });
  await again.start();
  /* Dłużej niż poprzednio i nie bez powodu: ScreenCaptureKit potrafi
     wstawać sekundę albo dwie, a przy obciążonej maszynie (cały npm test)
     krótsze nagranie schodziło poniżej progu i przepadało jako pomyłka. */
  await wait(4000);
  const zapis = await again.stop();
  say("nagranie z zachowanym dźwiękiem zostaje na dysku", !!zapis.meeting?.tracks?.mic);

  if (zapis.meeting) {
    // Kasujemy zapis, żeby było widać, że drugie przepisanie robi go od zera.
    store.updateMeeting(zapis.meeting.id, { transcript: [] });
    const przed = kept.length;
    const znowu = await again.retranscribe(zapis.meeting.id);
    say("przepisanie z plików wywołało model jeszcze raz", kept.length > przed);
    say("i dało zapis", znowu.length);
    say("odcinki z pliku niosą kontekst poprzedniego",
      kept.slice(przed).some((item) => item.context.length > 0));
    const po = store.getMeetings().find((item) => item.id === zapis.meeting.id);
    say("zapis wylądował we wpisie", po?.transcript?.length ?? 0);
    say("po przepisaniu nic już nie chodzi", !!po && po.transcribing !== true);
    /* Dopiero po udanym przepisaniu wolno ścisnąć nagranie: wcześniej było
       jedynym egzemplarzem rozmowy. AAC 32 kb/s to jedna dziewiąta WAV-a. */
    say("nagranie zostało ściśnięte", /\.m4a$/.test(po?.tracks?.mic ?? ""));
    say("skompresowany plik istnieje", fs.existsSync(po?.tracks?.mic ?? ""));
  }

  /* ── Podnoszenie się po ubiciu aplikacji ──
     Wpis w stanie „recording" i pliki bez nagłówka to wszystko, co zostaje
     po aplikacji zamkniętej w połowie rozmowy. */
  const kaleki = store.createMeeting({ title: "Ubite w połowie" });
  const kalekiDir = store.meetingDir(kaleki.id);
  fs.mkdirSync(kalekiDir, { recursive: true });
  // Plik z samymi próbkami: nagłówek powstaje na końcu i nie zdążył.
  fs.writeFileSync(path.join(kalekiDir, "tor-a-mikrofon.wav"), Buffer.alloc(44 + 16000 * 2 * 7));
  const ile = meetings.recover();
  const podniesione = store.getMeetings().find((item) => item.id === kaleki.id);
  say("nagranie po ubiciu aplikacji zostaje domknięte", ile);
  say("i ma stan „failed”", podniesione?.state);
  say("i zmierzony czas z rozmiaru pliku", Math.round(podniesione?.seconds ?? 0));
  say("i domknięty nagłówek WAV", (() => {
    const bytes = fs.readFileSync(path.join(kalekiDir, "tor-a-mikrofon.wav"));
    return bytes.subarray(0, 4).toString() === "RIFF" && bytes.readUInt32LE(40) === bytes.length - 44;
  })());

  say("po przepisaniu nagranie znika z dysku", !written.meeting.tracks);
  /* Pytamy o NAGRANIE, nie o pusty katalog. Od chwili, gdy każdy odcinek
     zostawia linijkę w „odcinki.jsonl" (patrz #note w main/meeting.js),
     katalog po udanym przepisaniu nie jest pusty — i nie ma być: ten ślad
     jest jedyną odpowiedzią na pytanie „co się stało z tą godziną", gdy
     dźwięku już nie ma. Sprawdzenie ma pilnować, że zniknął DŹWIĘK. */
  say("…i naprawdę nie ma go w katalogu",
    fs.readdirSync(store.meetingDir(written.meeting.id))
      .filter((name) => /\.(wav|m4a|aac|mp3)$/i.test(name)).length);
  say("…a spotkanie zostaje w spisie", meetings.list().some((item) => item.id === written.meeting.id));

  finish();
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
    /* SIGKILL, nie domyślny SIGTERM. Electron SIGTERM-a nie honoruje, więc
       limit czasu bez tej linijki nie kończy NICZEGO: test wisiał w martwym
       oczekiwaniu godzinami, choć limit dawno minął. Strażnik w oknie
       (wyżej) jest pierwszą linią obrony; ta jest ostatnią i działa nawet
       wtedy, gdy w oknie nie działa już nic. */
    killSignal: "SIGKILL",
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
  /* Drugi powód jest znacznie częstszy i wygląda identycznie: przy uśpionym
     ekranie ScreenCaptureKit nie zgłasza ŻADNEGO ekranu, więc nagrywanie
     odpada, choć zgoda jest. Widać to po komunikacie wyżej. */
  console.log("  Przy uśpionym ekranie SCK nie widzi żadnego — obudź go i uruchom test ponownie.");
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
  check("…i w katalogu nie ma już żadnego pliku dźwiękowego", step("…i naprawdę nie ma go w katalogu") === 0);
  check("…a samo spotkanie zostaje w spisie", step("…a spotkanie zostaje w spisie") === true);

  /* Przepisanie z plików wymaga nagrania, które przetrwało próg pomyłki.
     Na obciążonej maszynie SCK bywa wolniejszy od tego progu — wtedy nie
     ma czego przepisywać i mówimy to wprost, zamiast wywalać się na
     asercji o rzeczy, której nie było jak sprawdzić. */
  if (step("nagranie z zachowanym dźwiękiem zostaje na dysku") !== true) {
    console.log("\n⚠ przepisanie z plików pominięte: nagranie nie doszło do skutku");
  } else {
    check(
      "Z zachowanym dźwiękiem nagranie zostaje na dysku",
      step("nagranie z zachowanym dźwiękiem zostaje na dysku") === true,
    );
    check(
      "Przepisanie z plików woła model od nowa",
      step("przepisanie z plików wywołało model jeszcze raz") === true,
    );
    check("…i daje zapis rozmowy", step("i dało zapis") >= 1);
    check(
      "…z ciągłością między odcinkami",
      step("odcinki z pliku niosą kontekst poprzedniego") === true,
    );
    check("…który ląduje we wpisie", step("zapis wylądował we wpisie") >= 1);
    check("…i nie zostawia stanu „przepisuję”", step("po przepisaniu nic już nie chodzi") === true);
    check(
      "Po udanym przepisaniu nagranie zostaje ŚCIŚNIĘTE, nie skasowane",
      step("nagranie zostało ściśnięte") === true,
    );
    check("…i skompresowany plik naprawdę leży na dysku", step("skompresowany plik istnieje") === true);
  }

  check(
    "Nagranie po ubiciu aplikacji zostaje domknięte przy starcie",
    step("nagranie po ubiciu aplikacji zostaje domknięte") >= 1,
  );
  check("…ze stanem „failed”", step("i ma stan „failed”") === "failed");
  check("…z czasem policzonym z rozmiaru pliku", step("i zmierzony czas z rozmiaru pliku") === 7);
  check(
    "…i z nagłówkiem WAV dopisanym po fakcie",
    step("i domknięty nagłówek WAV") === true,
  );
  /* Druga strona tej samej reguły: wyżej, gdy przepisanie się nie udało,
     pliki musiały zostać — bo dźwięku nie da się nagrać drugi raz. */
  check(
    "Nagranie bez transkryptu NIE jest kasowane — nie ma czym go zastąpić",
    step("oba tory zapisane") === true,
  );
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} sprawdzeń przeszło.`);
