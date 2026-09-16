"use strict";

const fs = require("fs");
const path = require("path");
const { record, wavHeader } = require("./tap");
const { keyFor } = require("./providers");
const {
  createManifest,
  saveManifestAtomically,
  loadManifest,
  repairWavHeaderIfNeeded,
} = require("./meeting-manifest");
const { MeetingMetrics } = require("./meeting-metrics");
const { DeepgramMeetingProvider } = require("./meeting-provider");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Przebudowany moduł spotkań (meeting path).
 *
 * Zgodnie ze specyfikacją:
 * 1. Nagrywanie lokalne WAV ma bezwzględny priorytet i jest jedynym źródłem prawdy.
 * 2. Brak cięcia na odcinki 10-25s i brak serii zapytań HTTP w biegu.
 * 3. Jeden WebSocket Deepgram na torze systemowym tworzy roboczy szkic kursanta (live student draft).
 * 4. Całkowity brak Gemini w meeting path — Deepgram jest jedynym providerem STT.
 * 5. Quick Feedback operuje na ostatnich 10 minutach wypowiedzi kursanta.
 * 6. Po Stop następuje batch transcription Deepgram na pełnych plikach obu torów
 *    i scalenie ściśle po timestampach (start).
 * 7. W razie błędu STT audio pozostaje na dysku ze stanem audio_saved_transcript_failed
 *    i możliwością ponowienia (retranscribe).
 */
class Meetings {
  #flushTimer = null;

  constructor(
    store,
    {
      onChange,
      onLevel,
      onError,
      onTranscript,
      onSilence,
      onIdle,
      onDone,
      transcribe, // opcjonalna atrapa w testach jednostkowych
      provider,   // opcjonalny wstrzyknięty provider
    } = {},
  ) {
    this.store = store;
    this.onChange = onChange ?? (() => {});
    this.onLevel = onLevel ?? (() => {});
    this.onError = onError ?? (() => {});
    this.onTranscript = onTranscript ?? (() => {});
    this.onSilence = onSilence ?? (() => {});
    this.onIdle = onIdle ?? (() => {});
    this.onDone = onDone ?? (() => {});
    this.customTranscribe = transcribe ?? null;
    this.customProvider = provider ?? null;

    this.live = null;
  }

  static session(id, dir) {
    return {
      id,
      dir,
      tap: null,
      startedAt: Date.now(),
      provider: null,
      liveSession: null,
      metrics: null,
      manifest: null,
      liveDraft: [],
      liveGaps: [],
      feedbacks: [],
      quiet: { mic: 0, system: 0 },
      toldSilence: { mic: false, system: false },
      heardAt: Date.now(),
      closed: false,
      sampleRate: 16000,
    };
  }

  #tell(hook, ...args) {
    try {
      hook.apply(this, args);
    } catch (err) {
      /* Meldunek przepadł — proces nagrywania jest ważniejszy */
    }
  }

  get recording() {
    return !!this.live;
  }

  get state() {
    const isRec = this.recording;
    const currentState = this.live
      ? (this.live.manifest?.recordingStatus || "recording")
      : "idle";

    return {
      recording: isRec,
      id: this.live?.id ?? null,
      seconds: this.live ? (Date.now() - this.live.startedAt) / 1000 : 0,
      state: currentState,
      liveStatus: this.live?.manifest?.liveStatus || "ok",
      liveGaps: this.live?.liveGaps ?? [],
      quietSeconds: this.quietSeconds,
    };
  }

  get quietSeconds() {
    return this.live ? (Date.now() - this.live.heardAt) / 1000 : 0;
  }

  /**
   * Start nagrywania spotkania.
   */
  async start(about = null) {
    if (this.recording) return this.state;

    const settings = this.store.getSettings();
    const meeting = this.store.createMeeting({
      title: about?.title ?? null,
      titleFrom: about?.titleFrom ?? null,
      where: about?.where ?? null,
      people: about?.people ?? [],
      speakers: about?.speakers ?? null,
      state: "recording",
    });

    const dir = this.store.meetingDir(meeting.id);
    const session = Meetings.session(meeting.id, dir);

    const micPath = path.join(dir, "tor-a-mikrofon.wav");
    const sysPath = path.join(dir, "tor-b-system.wav");

    // Atomowy manifest sesji
    session.manifest = createManifest({
      meetingId: meeting.id,
      dir,
      micAudioPath: micPath,
      systemAudioPath: sysPath,
    });

    session.metrics = new MeetingMetrics();
    session.provider = this.customProvider || new DeepgramMeetingProvider();

    // Uruchomienie sesji WebSocket dla kursanta (tor systemowy)
    const apiKey = keyFor("deepgram", settings);
    let uiThrottleTimer = null;

    const scheduleUiUpdate = () => {
      if (uiThrottleTimer) return;
      uiThrottleTimer = setTimeout(() => {
        uiThrottleTimer = null;
        if (!session.closed) {
          this.store.updateMeeting(
            session.id,
            { draft: [...session.liveDraft] },
            { persist: false },
          );
          this.#tell(this.onTranscript);
        }
      }, 750); // throttlowanie aktualizacji UI raz na 750 ms
      if (uiThrottleTimer?.unref) uiThrottleTimer.unref();
    };

    try {
      session.liveSession = await session.provider.startLiveSession({
        apiKey,
        model: settings.stt?.deepgramModel || "nova-3",
        language: "en", // szkic angielskich wypowiedzi kursanta
        bilingual: settings.language?.mode === "bilingual",
        metrics: session.metrics,
        onUtterance: (u) => {
          session.liveDraft.push(u);
          scheduleUiUpdate();
        },
        onStatusChange: (status, detail) => {
          session.manifest.liveStatus = status;
          if (status === "degraded") {
            session.manifest.recordingStatus = "recording_live_degraded";
            this.store.updateMeeting(session.id, { state: "recording_live_degraded" }, { persist: false });
          } else if (status === "ok" && session.manifest.recordingStatus === "recording_live_degraded") {
            session.manifest.recordingStatus = "recording";
            this.store.updateMeeting(session.id, { state: "recording" }, { persist: false });
          }
          saveManifestAtomically(session.dir, session.manifest);
          this.#tell(this.onChange);
        },
        onGap: (gap) => {
          session.liveGaps.push(gap);
          session.manifest.liveGaps = session.liveGaps;
          saveManifestAtomically(session.dir, session.manifest);
        },
      });
    } catch (err) {
      session.manifest.liveStatus = "degraded";
      saveManifestAtomically(session.dir, session.manifest);
    }

    // Uruchomienie natywnego nagrywania (Core Audio tap)
    try {
      session.tap = record({
        dir,
        exclude: settings.meetings?.exclude ?? [],
        onLevel: (level) => this.#tell(this.onLevel, level),
        onPcm: (lane, pcm) => {
          if (session.closed) return;
          session.heardAt = Date.now();

          // Aktualizacja liczby zapisanych próbek w manifeście
          const samples = pcm.length / 2;
          if (lane === "mic") {
            session.manifest.writtenMicSamples += samples;
          } else if (lane === "system") {
            session.manifest.writtenSystemSamples += samples;
            // Przesyłamy wyłącznie tor systemowy do sesji live
            session.liveSession?.sendAudio(pcm);
          }
        },
        onError: (message) => this.#fail(session, message),
      });
    } catch (problem) {
      session.liveSession?.close();
      this.store.deleteMeeting(meeting.id);
      this.#tell(this.onChange);
      throw problem;
    }

    this.live = session;
    this.#tell(this.onChange);
    return this.state;
  }

  /**
   * Zakończenie nagrywania spotkania (Stop).
   */
  async stop() {
    if (!this.live) return { discarded: false, meeting: null };

    const session = this.live;
    this.live = null;
    session.closed = true;

    session.manifest.recordingStatus = "stopping";
    saveManifestAtomically(session.dir, session.manifest);

    this.store.updateMeeting(session.id, { state: "stopping" }, { persist: false });
    this.#tell(this.onChange);

    // 1. Zatrzymanie cribro-tap i domknięcie plików WAV
    const result = await session.tap.stop();
    const seconds = Math.max(result.mic, result.system);

    // 2. Zamknięcie WebSocket sesji live
    await session.liveSession?.close();

    // 3. Weryfikacja plików i ewentualna naprawa nagłówków WAV
    repairWavHeaderIfNeeded(result.files.mic, session.manifest.writtenMicSamples);
    repairWavHeaderIfNeeded(result.files.system, session.manifest.writtenSystemSamples);

    const settings = this.store.getSettings();
    const floor = settings.meetings?.minSeconds ?? 90;

    // Zbyt krótkie nagranie odrzucamy bez śladu
    if (seconds < floor) {
      session.manifest.recordingStatus = "idle";
      session.manifest.finalizationStatus = "complete";
      saveManifestAtomically(session.dir, session.manifest);

      for (const file of Object.values(result.files)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      }
      this.store.deleteMeeting(session.id);
      this.#tell(this.onChange);
      return { discarded: true, meeting: null, seconds };
    }

    // 4. Zapisujemy szkic na żywo (live student draft)
    const draft = [...session.liveDraft];
    session.manifest.stoppedAt = new Date().toISOString();
    session.manifest.recordingStatus = "idle";
    session.manifest.finalizationStatus = "finalizing";
    saveManifestAtomically(session.dir, session.manifest);

    this.store.updateMeeting(session.id, {
      state: "finalizing",
      draft,
      seconds,
      tracks: result.files,
    });
    this.#tell(this.onChange);

    // 5. Finalizacja: Batch transcription obu torów i scalenie po timestampach
    const t0 = Date.now();
    try {
      const apiKey = keyFor("deepgram", settings);
      const batchResult = await session.provider.transcribeRecording(
        {
          micAudioPath: result.files.mic,
          systemAudioPath: result.files.system,
        },
        {
          apiKey,
          model: settings.stt?.deepgramModel || "nova-3",
          language: settings.language?.primary || "pl",
          bilingual: settings.language?.mode === "bilingual",
          mockTranscribe: this.customTranscribe
            ? async () => {
                const text = await this.customTranscribe(
                  fs.readFileSync(result.files.system),
                  settings,
                  { lane: "system" },
                );
                const transcript = [
                  { speaker: "Kursant / Rozmówcy", lane: "system", at: 0, start: 0, end: seconds, text: text?.text || text || "" },
                ];
                return { transcript, micUtterances: [], systemUtterances: [] };
              }
            : null,
        },
      );

      const durationMs = Date.now() - t0;
      session.metrics.recordFinalizationTime(durationMs);

      const finalTranscript = batchResult.transcript || [];
      const metricsSnapshot = session.metrics.snapshot({
        micAudioPath: result.files.mic,
        systemAudioPath: result.files.system,
      });

      session.manifest.finalizationStatus = "complete";
      session.manifest.metrics = metricsSnapshot;
      saveManifestAtomically(session.dir, session.manifest);

      const finalMeeting = this.store.updateMeeting(session.id, {
        state: "done",
        transcript: finalTranscript,
        draft,
        metrics: metricsSnapshot,
        endedAt: new Date().toISOString(),
      });

      session.metrics.destroy();
      this.#tell(this.onChange);
      this.#tell(this.onDone, finalMeeting);

      return { discarded: false, meeting: finalMeeting, transcript: finalTranscript, seconds, coverage: null };
    } catch (err) {
      // Awaria batch STT: audio ZOSTAJE na dysku, stan audio_saved_transcript_failed
      session.manifest.finalizationStatus = "audio_saved_transcript_failed";
      session.manifest.lastError = {
        code: "BATCH_STT_FAILED",
        message: err?.message || String(err),
        retryable: true,
      };
      saveManifestAtomically(session.dir, session.manifest);

      const failedMeeting = this.store.updateMeeting(session.id, {
        state: "audio_saved_transcript_failed",
        draft,
        tracks: result.files,
        transcriptError: `Transkrypcja nie powiodła się: ${err.message}. Audio zostało zachowane.`,
      });

      session.metrics.destroy();
      this.#tell(this.onChange);
      this.#tell(this.onError, `Błąd transkrypcji spotkania: ${err.message}. Audio zachowane na dysku.`);

      return { discarded: false, meeting: failedMeeting, transcript: [], seconds, coverage: null };
    }
  }

  /**
   * Quick Feedback — snapshot wypowiedzi kursanta z ostatnich 10 minut.
   *
   * @param {string} meetingId
   * @returns {object} { text, utterances, range, degraded, message }
   */
  quickFeedback(meetingId) {
    const isLive = this.live && this.live.id === meetingId;
    let list = [];
    let isDegraded = false;

    if (isLive) {
      list = this.live.liveSession ? this.live.liveSession.getSnapshot(600) : [...this.live.liveDraft];
      isDegraded = (this.live.liveGaps && this.live.liveGaps.length > 0) || this.live.manifest?.liveStatus === "degraded";
    } else {
      const meeting = this.store.getMeetings().find((m) => m.id === meetingId);
      list = meeting?.draft || [];
    }

    // Pomijamy ewentualną otwartą, częściową wypowiedź (bierzemy tylko domknięte utterances)
    const finalized = list.filter((u) => u.text && u.end != null);
    const text = finalized.map((u) => u.text).join(" ").trim();
    const from = finalized.length ? finalized[0].start : 0;
    const to = finalized.length ? finalized[finalized.length - 1].end : 0;

    const warningMessage = isDegraded ? "Feedback opiera się na niepełnym szkicu transkrypcji." : null;
    const feedbackEntry = {
      id: `fb-${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      text,
      range: { from, to },
      degraded: isDegraded,
      message: warningMessage,
    };

    if (meetingId) {
      const meeting = this.store.getMeetings().find((m) => m.id === meetingId);
      if (meeting) {
        const existing = meeting.feedbacks || [];
        this.store.updateMeeting(meetingId, { feedbacks: [...existing, feedbackEntry] });
      }
    }

    return {
      text,
      utterances: finalized,
      range: { from, to },
      degraded: isDegraded,
      message: warningMessage,
    };
  }

  /**
   * Ponowienie transkrypcji z zachowanych plików WAV (idempotentne retry).
   *
   * @param {string} id
   */
  async retranscribe(id) {
    const meeting = this.store.getMeetings().find((m) => m.id === id);
    if (!meeting) throw new Error("Nie ma takiego spotkania.");

    const tracks = meeting.tracks;
    if (!tracks?.mic || !tracks?.system || !fs.existsSync(tracks.mic) || !fs.existsSync(tracks.system)) {
      throw new Error("Brak kompletnych plików audio WAV dla tego spotkania.");
    }

    this.store.updateMeeting(id, { state: "finalizing", transcribing: true, transcriptError: null });
    this.#tell(this.onChange);

    const dir = this.store.meetingDir(id);
    const manifest = loadManifest(dir) || createManifest({
      meetingId: id,
      dir,
      micAudioPath: tracks.mic,
      systemAudioPath: tracks.system,
    });

    manifest.finalizationStatus = "finalizing";
    saveManifestAtomically(dir, manifest);

    try {
      const settings = this.store.getSettings();
      const apiKey = keyFor("deepgram", settings);
      const provider = this.customProvider || new DeepgramMeetingProvider();

      const batchResult = await provider.transcribeRecording(
        { micAudioPath: tracks.mic, systemAudioPath: tracks.system },
        {
          apiKey,
          model: settings.stt?.deepgramModel || "nova-3",
          language: settings.language?.primary || "pl",
          bilingual: settings.language?.mode === "bilingual",
        },
      );

      const transcript = batchResult.transcript || [];
      manifest.finalizationStatus = "complete";
      manifest.lastError = null;
      saveManifestAtomically(dir, manifest);

      this.store.updateMeeting(id, {
        state: "done",
        transcript,
        transcribing: false,
        transcriptError: null,
      });

      this.#tell(this.onChange);
      return transcript;
    } catch (err) {
      manifest.finalizationStatus = "audio_saved_transcript_failed";
      manifest.lastError = { code: "RETRY_FAILED", message: err.message, retryable: true };
      saveManifestAtomically(dir, manifest);

      this.store.updateMeeting(id, {
        state: "audio_saved_transcript_failed",
        transcribing: false,
        transcriptError: `Ponowna próba nie powiodła się: ${err.message}`,
      });

      this.#tell(this.onChange);
      throw err;
    }
  }

  /**
   * Odzyskiwanie przerwanych sesji spotkań (crash/force quit).
   */
  recover() {
    const stuck = this.store
      .getMeetings()
      .filter((item) => item.state === "recording" || item.state === "recording_live_degraded");

    for (const meeting of stuck) {
      const dir = this.store.meetingDir(meeting.id);
      const files = {
        mic: path.join(dir, "tor-a-mikrofon.wav"),
        system: path.join(dir, "tor-b-system.wav"),
      };

      if (!fs.existsSync(files.mic)) {
        this.store.deleteMeeting(meeting.id);
        continue;
      }

      // Naprawa nagłówków WAV na podstawie fizycznego rozmiaru
      repairWavHeaderIfNeeded(files.mic);
      if (fs.existsSync(files.system)) {
        repairWavHeaderIfNeeded(files.system);
      }

      const stat = fs.statSync(files.mic);
      const seconds = Math.max(0, (stat.size - 44) / 2 / 16000);

      const manifest = loadManifest(dir) || createManifest({
        meetingId: meeting.id,
        dir,
        micAudioPath: files.mic,
        systemAudioPath: files.system,
      });

      manifest.recordingStatus = "recording_interrupted";
      manifest.finalizationStatus = "audio_saved_transcript_failed";
      manifest.lastError = { code: "INTERRUPTED", message: "Aplikacja została zamknięta w trakcie nagrywania", retryable: true };
      saveManifestAtomically(dir, manifest);

      this.store.updateMeeting(meeting.id, {
        state: "audio_saved_transcript_failed",
        error: "Aplikacja została przerwana w trakcie nagrywania. Audio zachowane.",
        seconds,
        endedAt: new Date().toISOString(),
        tracks: files,
      });
    }

    if (stuck.length) this.#tell(this.onChange);
    return stuck.length;
  }

  async toggle() {
    return this.recording ? this.stop() : this.start();
  }

  #fail(session, message) {
    if (this.live !== session) return;
    this.live = null;
    session.closed = true;

    session.manifest.recordingStatus = "recording_interrupted";
    session.manifest.lastError = { code: "TAP_FAILED", message, retryable: true };
    saveManifestAtomically(session.dir, session.manifest);

    this.store.updateMeeting(session.id, { state: "audio_saved_transcript_failed", error: message });
    this.#tell(this.onError, message);

    session.tap
      ?.stop()
      .then((result) => {
        repairWavHeaderIfNeeded(result?.files?.mic);
        repairWavHeaderIfNeeded(result?.files?.system);
        this.store.updateMeeting(session.id, {
          endedAt: new Date().toISOString(),
          seconds: Math.max(result?.mic ?? 0, result?.system ?? 0),
          tracks: result?.files ?? null,
        });
      })
      .catch(() => {})
      .finally(() => this.#tell(this.onChange));
  }

  async shutdown() {
    if (!this.recording) return;
    await this.stop().catch(() => {});
  }

  list() {
    return this.store.getMeetings().filter((meeting) => {
      if (meeting.state === "recording" || meeting.state === "recording_live_degraded") return true;
      if (meeting.transcript?.length || meeting.draft?.length) return true;
      return !meeting.tracks || fs.existsSync(meeting.tracks.mic);
    });
  }
}

module.exports = { Meetings };
