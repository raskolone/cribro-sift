"use strict";
/**
 * Czy zapis rozmowy jest CAŁY — i czy aplikacja wie, kiedy nie jest.
 *   node scripts/coverage-test.js
 *
 * Test powstał po godzinie zajęć, z której w notatce zostały dwie linijki.
 * Nagranie skasowało się jak po udanej transkrypcji, bo warunkiem był
 * niepusty transkrypt, a nie kompletny. Pilnujemy tu trzech rzeczy naraz,
 * bo dopiero wszystkie trzy dają „całą transkrypcję":
 *
 *   1. odcinek, który się nie udał, jest POWTARZANY, a nie gubiony;
 *   2. każdy odcinek zostawia ślad, więc na końcu wiadomo, ile z rozmowy
 *      naprawdę weszło do zapisu;
 *   3. nagranie NIE GINIE, dopóki zostało choć trochę rozmowy do przepisania.
 *
 * Idzie to przez `retranscribe`, czyli przez przebieg z pliku — jedyną
 * drogę, którą da się przejść bez mikrofonu i bez zgód systemowych.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Meetings } = require("../src/main/meeting");
const { wavHeader } = require("../src/main/tap");

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  console.log(`✓ ${label}`);
  passed += 1;
};

/* ── Nagranie na dysku ────────────────────────────────────────────
   Sześć minut „mowy": szum na poziomie, który przechodzi bramkę ciszy.
   Przy odcinku 60-sekundowym daje to sześć odcinków na tor. */
const SR = 16000;
const SECONDS = 360;
const SPAN = 60;

function speechWav(file) {
  const pcm = Buffer.alloc(SECONDS * SR * 2);
  for (let at = 0; at + 1 < pcm.length; at += 2) {
    pcm.writeInt16LE(Math.round((Math.random() * 2 - 1) * 7000), at);
  }
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]));
}

/** Sklep tylko z tym, czego dotyka retranscribe. */
function fakeStore(dir, meeting) {
  const state = { ...meeting };
  return {
    now: () => state,
    getSettings: () => ({
      stt: { provider: "mock", model: "mock" },
      meetings: { keepAudio: false },
    }),
    getMeetings: () => [state],
    updateMeeting: (_id, patch) => Object.assign(state, patch),
    meetingDir: () => dir,
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-coverage-"));
  const files = {
    mic: path.join(dir, "tor-a-mikrofon.wav"),
    system: path.join(dir, "tor-b-system.wav"),
  };
  speechWav(files.mic);
  speechWav(files.system);
  return { dir, files };
}

const run = async (label, transcribe) => {
  const { dir, files } = setup();
  const store = fakeStore(dir, { id: "m1", tracks: { ...files }, people: [] });
  const meetings = new Meetings(store, {
    transcribe,
    slice: { span: SPAN, overlap: 1 },
    backoff: 1, // w teście liczy się liczba podejść, nie czekanie między nimi
  });
  let thrown = null;
  try {
    await meetings.retranscribe("m1");
  } catch (problem) {
    thrown = problem;
  }
  return { state: store.now(), dir, files, thrown, label };
};

(async () => {
  /* ── 1. Wszystko się udaje ── */
  {
    let calls = 0;
    const out = await run("czysty przebieg", async () => {
      calls += 1;
      return { text: `zdanie numer ${calls}` };
    });
    check("Cała rozmowa idzie do zapisu", out.state.transcript.length > 0);
    check("Pokrycie jest pełne", out.state.coverage.complete === true);
    check("…i nie zgłasza braków", out.state.transcriptError === null);
    check("Żaden odcinek nie przepadł", out.state.coverage.failed === 0);
    check(
      "Zapisanych minut tyle, ile mówionych",
      out.state.coverage.writtenSeconds === out.state.coverage.spokenSeconds,
    );
    check("Nagranie skasowane, bo jest czym je zastąpić", out.state.tracks === null);
    check("…i plików naprawdę nie ma", !fs.existsSync(out.files.mic));
  }

  /* ── 2. Dostawca mruga: dwa razy błąd, za trzecim się udaje ── */
  {
    const tries = new Map();
    const out = await run("powtórki", async (_wav, _settings, about) => {
      const key = `${about.lane}-${about.from}`;
      const seen = (tries.get(key) ?? 0) + 1;
      tries.set(key, seen);
      if (seen < 3) throw new Error("sieć mrugnęła");
      return { text: `odcinek ${key}` };
    });
    check("Mrugnięcie sieci nie gubi odcinka — jest powtarzany", out.thrown === null);
    check("…i zapis mimo to jest pełny", out.state.coverage.complete === true);
    check("…za trzecim podejściem", [...tries.values()].every((n) => n === 3));
    check("Nagranie wolno skasować", out.state.tracks === null);
  }

  /* ── 3. Dostawca oddaje PUSTY tekst mimo mowy ── */
  {
    let calls = 0;
    const out = await run("puste odpowiedzi", async () => {
      calls += 1;
      return { text: "" };
    });
    check("Pusta odpowiedź na odcinek z mową jest powtarzana", calls > 12);
    check("Zapis wie, że nie jest całością", out.state.coverage.complete === false);
    check("…i mówi o tym wprost", /Zapis obejmuje/.test(out.state.transcriptError ?? ""));
    check("NAGRANIE ZOSTAJE — nie ma czym go zastąpić", out.state.tracks !== null);
    check("…i plik naprawdę leży na dysku", fs.existsSync(out.files.mic));
  }

  /* ── 4. Jeden odcinek pada na zawsze, reszta jest dobra ── */
  {
    const out = await run("jeden stracony odcinek", async (_wav, _settings, about) => {
      if (about.lane === "mic" && about.from === 0) throw new Error("ten jeden nie wyszedł");
      return { text: `odcinek ${about.lane} od ${Math.round(about.from)}` };
    });
    check("Stracony odcinek NIE przerywa reszty przebiegu", out.thrown === null);
    check("…reszta rozmowy jest w zapisie", out.state.transcript.length > 3);
    check("…strata jest policzona", out.state.coverage.failed === 1);
    check("…zapis nie udaje kompletnego", out.state.coverage.complete === false);
    check("…a nagranie zostaje do powtórki", out.state.tracks !== null);
  }

  /* ── 5. Rachunek pokrycia ── */
  {
    const tally = Meetings.tally([
      { state: "done", voiced: 90 },
      { state: "done", voiced: 60 },
      { state: "silent", voiced: 0 },
      { state: "failed", voiced: 100 },
      { state: "empty", voiced: 0 },
    ]);
    check("Cisza nie liczy się jako strata", tally.silent === 1 && tally.spokenSeconds === 250);
    check("Zapisane to tylko to, co przepisane", tally.writtenSeconds === 150);
    check("Pusty odcinek bez mowy nie psuje kompletności", tally.empty === 1);
    check("Stracony odcinek psuje", tally.complete === false);
    check(
      "Bez strat pokrycie jest pełne",
      Meetings.tally([{ state: "done", voiced: 10 }, { state: "silent", voiced: 0 }]).complete === true,
    );
    check(
      "Pusty rejestr NIE jest pełnym pokryciem — nagranie ma zostać",
      Meetings.tally([]).complete === false,
    );
    check(
      "Sama cisza jest kompletna: nie było czego zapisać",
      Meetings.tally([{ state: "silent", voiced: 0 }]).complete === true,
    );
    check(
      "Mowa bez ani jednego zapisanego słowa nie jest kompletna",
      Meetings.tally([{ state: "empty", voiced: 1 }, { state: "silent", voiced: 0 }]).complete === false,
    );
  }

  console.log(`\n${passed} sprawdzeń przeszło.`);
})().catch((problem) => {
  console.error(`\n✗ ${problem.message}`);
  process.exit(1);
});
