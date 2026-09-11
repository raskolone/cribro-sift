"use strict";
/**
 * Test mechanizmu odzyskiwania po utracie połączenia w trakcie spotkania.
 *   node scripts/recovery-test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tap = require("../src/main/tap");
let live = null;
tap.record = ({ dir, onPcm, onError }) => {
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

const RATE = 16000;
const frame = (secs, loud = true) => {
  const samples = Math.round(secs * RATE);
  const buffer = Buffer.alloc(samples * 2);
  if (!loud) return buffer;
  const amp = Math.round(32768 * Math.pow(10, -20 / 20)) * 1.4;
  for (let at = 0; at < samples; at += 1) buffer.writeInt16LE(Math.round(amp * Math.sin(at / 6)), at * 2);
  return buffer;
};

function talk(seconds) {
  for (let at = 0; at < seconds; at += 0.1) {
    live.seconds.mic += 0.1;
    live.seconds.system += 0.1;
    live.onPcm("mic", frame(0.1, true));
    live.onPcm("system", frame(0.1, true));
  }
}

function fakeStore(root) {
  const rows = [];
  let next = 0;
  return {
    rows,
    getSettings: () => ({ stt: { provider: "mock" }, meetings: { minSeconds: 5 } }),
    createMeeting: (about) => {
      const row = { id: `m${(next += 1)}`, ...about, state: "recording" };
      rows.push(row);
      return row;
    },
    updateMeeting: (id, patch) => {
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, patch);
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-recovery-"));

(async () => {
  /* ── 1. Chwilowa utrata sieci i samoczynne uzdrowienie w trakcie ── */
  {
    const store = fakeStore(path.join(work, "uzdrowienie"));
    let online = true;
    const errors = [];
    const meetings = new Meetings(store, {
      slice: { span: 2, overlap: 0.2 },
      backoff: 10,
      patience: 300,
      drain: 2000,
      probeInterval: 50,
      onError: (msg) => errors.push(msg),
      transcribe: async (_wav, _settings, about) => {
        if (!online) {
          throw new Error("fetch failed: ENOTFOUND api.openai.com");
        }
        return { text: `[${about.lane} ${Math.round(about.from)}]` };
      },
    });

    await meetings.start({ title: "spotkanie z przerwą w sieci" });

    // 1. Zwykła rozmowa przy działającej sieci (2 odcinki)
    talk(4);
    await new Promise((r) => setTimeout(r, 100));

    // 2. Padła sieć
    online = false;
    // Puszczamy dźwięk na kolejne 8 sekund (kilka odcinków)
    talk(8);
    await new Promise((r) => setTimeout(r, 200));

    check("Błąd sieci jest meldowany użytkownikowi", errors.some((e) => /Utrata połączenia/.test(e)));

    // 3. Sieć wraca
    online = true;
    // Czekamy na prober i opróżnienie kolejki
    await new Promise((r) => setTimeout(r, 400));

    check("Powrót sieci jest meldowany", errors.some((e) => /Połączenie z siecią przywrócone/.test(e)));

    // 4. Kolejne sekundy rozmowy już online
    talk(4);
    await new Promise((r) => setTimeout(r, 100));

    const { meeting, coverage } = await meetings.stop();

    check("Zapis rozmowy zawiera chronologicznie posortowane odcinki", meeting.transcript.length > 0);
    const times = meeting.transcript.map((line) => line.at);
    const sorted = [...times].sort((a, b) => a - b);
    check("Znaczniki czasu w transkrypcie rosną po uzdrowieniu", JSON.stringify(times) === JSON.stringify(sorted));
    check("Pokrycie po uzdrowieniu jest pełne", coverage.complete === true);
    check("Brak utraconych odcinków po przywróceniu", coverage.failed === 0);
  }

  /* ── 2. Utrata sieci aż do końca spotkania — zachowanie dźwięku ── */
  {
    const store = fakeStore(path.join(work, "brak-sieci-do-konca"));
    const errors = [];
    const meetings = new Meetings(store, {
      slice: { span: 2, overlap: 0.2 },
      backoff: 10,
      patience: 300,
      drain: 500,
      probeInterval: 50,
      onError: (msg) => errors.push(msg),
      transcribe: async () => {
        throw new Error("network down");
      },
    });

    await meetings.start({ title: "brak sieci" });
    talk(6);
    await new Promise((r) => setTimeout(r, 200));

    const { meeting, coverage } = await meetings.stop();

    check("Przy braku sieci nagranie nie udaje kompletnego", coverage.complete === false);
    check("Niedokończone odcinki są oznaczone jako failed", coverage.failed > 0);
    check("Pliki audio zostały zachowane na dysku dla retranskrypcji", meeting.tracks !== null);
    check("Wpis zawiera czytelną informację dla człowieka", /Zapis obejmuje/i.test(meeting.transcriptError));
  }

  /* ── 3. Rozpoznawanie rate limitu (429) ── */
  {
    const { isRateLimit } = require("../src/main/stt");
    check("isRateLimit rozpoznaje HTTP 429", isRateLimit(new Error("Gemini: przekroczony limit zapytań (429).")));
    check("isRateLimit rozpoznaje kod 429", isRateLimit(new Error("OpenAI zwrócił błąd 429: Rate limit reached")));
    check("isRateLimit rozpoznaje RESOURCE_EXHAUSTED", isRateLimit(new Error("RESOURCE_EXHAUSTED: quota exceeded")));
    check("isRateLimit nie myli zwykłych błędów sieciowych z 429", !isRateLimit(new Error("fetch failed: ECONNRESET")));
    check("Meetings.isRateLimit działa tak samo", Meetings.isRateLimit(new Error("429 Too Many Requests")));
    check("Meetings.CONCURRENT jest domyślnie równe 2", Meetings.CONCURRENT === 2);
    check("Meetings.RATE_LIMIT_BACKOFF wynosi 15 sekund", Meetings.RATE_LIMIT_BACKOFF === 15000);
  }

  /* ── 4. Limit współbieżności zapytań STT (semafor) ── */
  {
    const store = fakeStore(path.join(work, "semafor"));
    let inFlight = 0;
    let maxInFlight = 0;
    const meetings = new Meetings(store, {
      slice: { span: 1, overlap: 0.1 },
      backoff: 10,
      concurrent: 2,
      transcribe: async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 60));
        inFlight -= 1;
        return { text: "odcinek" };
      },
    });

    await meetings.start({ title: "test semafora" });
    talk(6);
    await new Promise((r) => setTimeout(r, 300));
    await meetings.stop();

    check("Maksymalna liczba równoległych zapytań nie przekracza limitu (2)", maxInFlight <= 2 && maxInFlight > 0);
  }

  /* ── 5. Adaptacyjny backoff po 429 ── */
  {
    const store = fakeStore(path.join(work, "backoff-429"));
    let attempts = 0;
    const timestampsByLane = { mic: [], system: [] };
    const meetings = new Meetings(store, {
      slice: { span: 1, overlap: 0.1 },
      backoff: 10,
      rateLimitBackoff: 80,
      transcribe: async (_wav, _settings, about) => {
        attempts += 1;
        if (about?.lane && timestampsByLane[about.lane]) {
          timestampsByLane[about.lane].push(Date.now());
        }
        if (attempts <= 2) {
          throw new Error("Gemini: przekroczony limit zapytań (429).");
        }
        return { text: "udało się po odczekaniu" };
      },
    });

    await meetings.start({ title: "test 429" });
    talk(6);
    await new Promise((r) => setTimeout(r, 250));
    const { meeting, discarded } = await meetings.stop();

    check("Spotkanie nie zostało odrzucone", discarded === false && meeting !== null);
    check("Odcinek po 429 został ponowiony", attempts >= 2);
    const micTimes = timestampsByLane.mic;
    check("Odcinek ma co najmniej dwie próby w tym samym torze", micTimes.length >= 2);
    const delay = micTimes[1] - micTimes[0];
    check("Odstęp po 429 uwzględnia dłuższy rateLimitBackoff (>= 60 ms)", delay >= 60);
    check("Zapis zawiera odzyskany odcinek", meeting.transcript.some((t) => t.text.includes("udało się")));
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${passed} sprawdzeń testu recovery przeszło pomyślnie.`);
})().catch((err) => {
  fs.rmSync(work, { recursive: true, force: true });
  console.error(`\n✗ Błąd testu recovery:`, err);
  process.exit(1);
});
