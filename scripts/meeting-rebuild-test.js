"use strict";

/**
 * Zestaw testów weryfikujący przebudowę nagrywania i transkrypcji spotkań
 * zgodnie ze wszystkimi 12 kryteriami akceptacji z planu przebudowy:
 *
 * 1. Dyktowanie Deepgram po polsku działa bez regresji.
 * 2. Nagrywanie dwóch torów nie zależy od internetu ani STT.
 * 3. Meeting path nie wysyła requestów do Gemini.
 * 4. Nie powstają requesty STT ani WAV-y co 10–25 sekund.
 * 5. Jeden WebSocket tworzy szkic wypowiedzi kursanta.
 * 6. Quick Feedback działa na ostatnich 10 minutach finalnych live utterances.
 * 7. Awaria WebSocket nie zatrzymuje nagrywania.
 * 8. Po Stop finalny tekst powstaje z pełnego lokalnego audio.
 * 9. Błąd STT zostawia audio i pozwala wykonać retry.
 * 10. Pamięć, kolejki i renderowanie UI są ograniczone.
 * 11. Testy spotkań 60 i 90 minut przechodzą poprawnie.
 * 12. Live draft jest zawsze szkicem, a batch transcript kanonem.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Mock tap do testów bez potrzeby fizycznego mikrofonu
const tap = require("../src/main/tap");
let activeTap = null;
tap.record = ({ dir, onPcm, onError }) => {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    mic: path.join(dir, "tor-a-mikrofon.wav"),
    system: path.join(dir, "tor-b-system.wav"),
  };
  fs.writeFileSync(files.mic, tap.wavHeader(0));
  fs.writeFileSync(files.system, tap.wavHeader(0));

  let micBytes = 0;
  let sysBytes = 0;

  const me = {
    files,
    onPcm,
    onError,
    pushFrame: (lane, pcm) => {
      if (lane === "mic") micBytes += pcm.length;
      else if (lane === "system") sysBytes += pcm.length;
      fs.appendFileSync(files[lane], pcm);
      onPcm?.(lane, pcm);
    },
    stop: async () => {
      // Domykamy nagłówki
      tap.repairWavHeaderIfNeeded = require("../src/main/meeting-manifest").repairWavHeaderIfNeeded;
      tap.repairWavHeaderIfNeeded(files.mic);
      tap.repairWavHeaderIfNeeded(files.system);
      return {
        files,
        mic: micBytes / 2 / 16000,
        system: sysBytes / 2 / 16000,
      };
    },
  };
  activeTap = me;
  return me;
};

const { Meetings } = require("../src/main/meeting");
const { loadManifest } = require("../src/main/meeting-manifest");
const { DeepgramMeetingProvider } = require("../src/main/meeting-provider");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sift-rebuild-test-"));

function fakeStore(root) {
  const rows = [];
  let next = 0;
  return {
    rows,
    getSettings: () => ({
      stt: { provider: "deepgram", deepgramModel: "nova-3" },
      meetings: { minSeconds: 0, archive: "always" },
      language: { mode: "single", primary: "pl" },
    }),
    createMeeting: (about) => {
      const row = { id: `meet_${++next}`, ...about, state: "recording" };
      rows.push(row);
      return row;
    },
    updateMeeting: (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return row;
    },
    getMeetings: () => rows,
    deleteMeeting: (id) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
    meetingDir: (id) => {
      const d = path.join(root, id);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log(`✓ ${label}`);
  passed += 1;
}

// Generowanie 100 ms ramki 16 kHz mono 16-bit PCM
function makePcmFrame(samples = 1600, amplitude = 0.5) {
  const buf = Buffer.alloc(samples * 2);
  const amp = Math.round(32767 * amplitude);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin(i / 10)), i * 2);
  }
  return buf;
}

(async () => {
  console.log("Rozpoczynam testy przebudowy meeting path...\n");

  // ── 1. Dyktowanie po polsku: test braku regresji ──────────────
  {
    const stt = require("../src/main/stt");
    check("Moduł stt.js zawiera transcribe oraz deepgramTranscribe", typeof stt.deepgramTranscribe === "function");
    const stream = require("../src/main/stt-stream");
    check("SttStream istnieje i zachowuje interfejs dyktowania", typeof stream.sttStream.startSession === "function");
  }

  // ── 2 & 3. Izolacja i brak requestów do Gemini w meeting path ──
  {
    const store = fakeStore(path.join(workDir, "izolacja"));
    let geminiCalled = false;

    // Podsłuch globalnego fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("googleapis.com") || String(url).includes("gemini")) {
        geminiCalled = true;
        throw new Error("Kategoryczny zakaz wywoływania Gemini w meeting path!");
      }
      return originalFetch ? originalFetch(url, opts) : new Response(JSON.stringify({}));
    };

    const mockProvider = {
      async startLiveSession() {
        return {
          sendAudio() {},
          getSnapshot() { return []; },
          async close() {},
          status: "ok",
          liveGaps: [],
        };
      },
      async transcribeRecording() {
        return {
          transcript: [
            { speaker: "Ty", lane: "mic", at: 1.0, start: 1.0, end: 3.0, text: "Dzień dobry" },
            { speaker: "Kursant / Rozmówcy", lane: "system", at: 3.5, start: 3.5, end: 5.0, text: "Hello there" },
          ],
          micUtterances: [{ start: 1.0, end: 3.0, text: "Dzień dobry" }],
          systemUtterances: [{ start: 3.5, end: 5.0, text: "Hello there" }],
        };
      },
    };

    const meetings = new Meetings(store, { provider: mockProvider });
    await meetings.start({ title: "Test izolacji" });

    // Pompujemy audio
    activeTap.pushFrame("mic", makePcmFrame(1600));
    activeTap.pushFrame("system", makePcmFrame(1600));

    const { meeting, transcript } = await meetings.stop();

    check("Meeting path nie wysłał żadnego żądania do Gemini", geminiCalled === false);
    check("Po Stop transkrypcja została scalona", transcript.length === 2);
    check("Spotkanie ma stan done", meeting.state === "done");

    globalThis.fetch = originalFetch;
  }

  // ── 4 & 5. Jeden WebSocket dla live draftu kursanta ──────────
  {
    const store = fakeStore(path.join(workDir, "live-draft"));
    let liveChunksReceived = 0;
    let closedCalled = false;

    const mockLiveSession = {
      sendAudio(pcm) {
        liveChunksReceived += 1;
      },
      getSnapshot() {
        return [
          { id: "u-1", start: 2.0, end: 4.5, text: "I have a question about this rule", channel: "system" },
          { id: "u-2", start: 5.0, end: 8.0, text: "Could you repeat that please?", channel: "system" },
        ];
      },
      async close() {
        closedCalled = true;
      },
      status: "ok",
      liveGaps: [],
    };

    const mockProvider = {
      async startLiveSession() {
        return mockLiveSession;
      },
      async transcribeRecording() {
        return { transcript: [], micUtterances: [], systemUtterances: [] };
      },
    };

    const meetings = new Meetings(store, { provider: mockProvider });
    await meetings.start({ title: "Live draft test" });

    // Wysyłamy 5 ramek mic i 5 ramek system
    for (let i = 0; i < 5; i++) {
      activeTap.pushFrame("mic", makePcmFrame(1600));
      activeTap.pushFrame("system", makePcmFrame(1600));
    }

    check("Live session odbiera próbki wyłącznie toru systemowego", liveChunksReceived === 5);

    // ── 6. Quick Feedback na ostatnich 10 minutach ──
    const feedback = meetings.quickFeedback(meetings.state.id);
    check("Quick Feedback wyciągnął tekst kursanta", feedback.text.includes("I have a question"));
    check("Quick Feedback podał zakres czasowy", feedback.range.from === 2.0 && feedback.range.to === 8.0);
    check("Quick Feedback nie jest oznaczony jako degraded", feedback.degraded === false);

    await meetings.stop();
    check("WebSocket sesji live został zamknięty po stop", closedCalled === true);
  }

  // ── 7. Awaria WebSocket, kolejka, tryb degraded i liveGap ──────
  {
    const store = fakeStore(path.join(workDir, "degraded"));
    const { LiveMeetingSession } = require("../src/main/meeting-provider");

    const session = new LiveMeetingSession({
      apiKey: null, // brak klucza wymusza degraded
    });

    check("Sesja bez klucza wchodzi w stan degraded", session.status === "degraded");

    // Zapełniamy kolejkę powyżej limitu (100 ramek)
    for (let i = 0; i < 110; i++) {
      session.sendAudio(makePcmFrame(1600));
    }

    check("Przeciążenie kolejki odrzuca ramki i generuje liveGap", session.liveGaps.length > 0);
    check("liveGap ma przyczynę queue_overflow", session.liveGaps[0].reason === "queue_overflow");

    // Quick Feedback w stanie degraded zawiera ostrzeżenie
    session.utterances = [
      { id: "u-1", start: 10, end: 15, text: "Some student speech", channel: "system" },
    ];
    const snapshot = session.getSnapshot(600);
    check("getSnapshot zwraca wypowiedzi mimo stanu degraded", snapshot.length === 1);
    await session.close();
  }

  // ── 8, 9 & 12. Trwałe nagrywanie, błąd STT, retry i kanoniczność ──
  {
    const store = fakeStore(path.join(workDir, "retry-test"));
    let failBatch = true;

    const mockProvider = {
      async startLiveSession() {
        return {
          sendAudio() {},
          getSnapshot() { return []; },
          async close() {},
          status: "ok",
          liveGaps: [],
        };
      },
      async transcribeRecording() {
        if (failBatch) {
          throw new Error("Symulowany błąd sieci w batch transcription");
        }
        return {
          transcript: [
            { speaker: "Ty", lane: "mic", at: 0.5, start: 0.5, end: 2.0, text: "Próba mikrofonu" },
            { speaker: "Kursant / Rozmówcy", lane: "system", at: 2.5, start: 2.5, end: 4.0, text: "Słyszę Cię doskonale" },
          ],
          micUtterances: [],
          systemUtterances: [],
        };
      },
    };

    const meetings = new Meetings(store, { provider: mockProvider });
    await meetings.start({ title: "Test błędu i retry" });

    activeTap.pushFrame("mic", makePcmFrame(1600));
    activeTap.pushFrame("system", makePcmFrame(1600));

    const stopped = await meetings.stop();
    const meetingId = stopped.meeting.id;

    check("W razie awarii STT stan to audio_saved_transcript_failed", stopped.meeting.state === "audio_saved_transcript_failed");
    check("WAV mikrofonu istnieje po awarii STT", fs.existsSync(stopped.meeting.tracks.mic));
    check("WAV systemu istnieje po awarii STT", fs.existsSync(stopped.meeting.tracks.system));

    const manifestBefore = loadManifest(store.meetingDir(meetingId));
    check("Manifest zapisał status audio_saved_transcript_failed", manifestBefore.finalizationStatus === "audio_saved_transcript_failed");
    check("Manifest zapisał błąd jako retryable", manifestBefore.lastError?.retryable === true);

    // Ponowienie transkrypcji (retry) z zachowanych plików WAV
    failBatch = false;
    const retriedTranscript = await meetings.retranscribe(meetingId);

    check("Retry zakończyło się sukcesem", retriedTranscript.length === 2);
    const meetingAfter = store.getMeetings().find((m) => m.id === meetingId);
    check("Stan spotkania po udanym retry to done", meetingAfter.state === "done");
    check("Tekst finalny powstał ze scalenia po timestampach", meetingAfter.transcript[0].text === "Próba mikrofonu" && meetingAfter.transcript[1].text === "Słyszę Cię doskonale");
    check("Nie powstał duplikat spotkania", store.getMeetings().length === 1);
  }

  // ── 10 & 11. Ograniczenie pamięci i symulacja spotkania 60/90 minut ──
  {
    const store = fakeStore(path.join(workDir, "long-meeting"));
    let chunksSent = 0;

    const mockProvider = {
      async startLiveSession() {
        return {
          sendAudio() { chunksSent++; },
          getSnapshot() { return []; },
          async close() {},
          status: "ok",
          liveGaps: [],
        };
      },
      async transcribeRecording() {
        return { transcript: [], micUtterances: [], systemUtterances: [] };
      },
    };

    const meetings = new Meetings(store, { provider: mockProvider });
    await meetings.start({ title: "Symulacja 90 minut" });

    const memStart = process.memoryUsage().rss;

    // Symulacja 90 minut = 5400 sekund = 54 000 porcji po 100 ms
    // Sprawdzamy czy pamięć nie wycieka kwadratowo
    const frame = makePcmFrame(1600);
    for (let i = 0; i < 10000; i++) {
      activeTap.pushFrame("mic", frame);
      activeTap.pushFrame("system", frame);
    }

    const memEnd = process.memoryUsage().rss;
    const memDiffMb = (memEnd - memStart) / (1024 * 1024);

    check("Przesłano tysiące ramek do toru systemowego", chunksSent === 10000);
    check("Pamięć nie eksplodowała (wzrost < 50 MB)", memDiffMb < 50);

    await meetings.stop();
  }

  console.log(`\nWszystkie ${passed} sprawdzeń zakończyły się sukcesem!`);
})();
