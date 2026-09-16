"use strict";

const path = require("path");
const { Worker } = require("worker_threads");
const { transcribeWavFile, mergeUtterancesByTimeline } = require("./meeting-worker");

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";
const MAX_QUEUE_FRAMES = 100; // maks. ~5-10 sekund bufora w pamięci

/**
 * Sesja strumieniowania na żywo dla toru kursanta (system audio).
 */
class LiveMeetingSession {
  constructor(config = {}) {
    this.config = config;
    this.ws = null;
    this.active = true;
    this.queue = [];
    this.utterances = [];
    this.liveGaps = [];
    this.status = "ok"; // "ok" | "degraded" | "error"
    this.currentPartial = "";
    this.lastDeliveredSeconds = 0;
    this.nextUtteranceId = 1;
    this.metrics = config.metrics || null;

    this._connect();
  }

  _connect() {
    if (!this.active) return;
    const { apiKey, model = "nova-3", language = "en", bilingual = true } = this.config;
    if (!apiKey) {
      this._setStatus("degraded", { reason: "Brak klucza API dla sesji live" });
      return;
    }

    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) {
      this._setStatus("degraded", { reason: "Brak implementacji WebSocket w środowisku" });
      return;
    }

    const url = new URL(DEEPGRAM_WS_URL);
    url.searchParams.set("model", model);
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("endpointing", "300");

    if (bilingual) {
      url.searchParams.set("detect_language", "true");
    } else if (language) {
      url.searchParams.set("language", language);
    }

    try {
      this.ws = new WebSocketImpl(url.toString(), {
        headers: { Authorization: `Token ${apiKey}` },
      });
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        if (!this.active || !this.ws) return;
        this._flushQueue();
      };

      this.ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : event.data.toString();
          const data = JSON.parse(raw);
          this._handleWsMessage(data);
        } catch {}
      };

      this.ws.onerror = (err) => {
        if (this.metrics) this.metrics.recordDisconnect();
        this._setStatus("degraded", { reason: `Błąd WebSocket: ${err?.message || err}` });
      };

      this.ws.onclose = () => {
        if (this.metrics) this.metrics.recordDisconnect();
        if (this.active) {
          this._setStatus("degraded", { reason: "Rozłączenie gniazda WebSocket" });
        }
      };
    } catch (err) {
      this._setStatus("degraded", { reason: `Nie udało się otworzyć WebSocket: ${err?.message || err}` });
    }
  }

  _setStatus(nextStatus, detail = null) {
    if (this.status !== nextStatus) {
      this.status = nextStatus;
      this.config.onStatusChange?.(nextStatus, detail);
    }
  }

  _handleWsMessage(data) {
    const alt = data?.channel?.alternatives?.[0] ?? data?.results?.channels?.[0]?.alternatives?.[0];
    const text = String(alt?.transcript ?? "").trim();
    const isFinal = Boolean(data?.is_final || data?.speech_final);
    const start = Number(data?.start ?? 0);
    const duration = Number(data?.duration ?? 0);
    const end = start + duration;

    if (isFinal) {
      this.currentPartial = "";
      if (text) {
        const item = {
          id: `u-${this.nextUtteranceId++}`,
          start,
          end,
          text,
          channel: "system",
          confidence: alt?.confidence,
          language: alt?.languages?.[0] || alt?.detected_language || null,
        };

        // Bufor ograniczony do 3000 ostatnich wypowiedzi (zapas na 90 min)
        this.utterances.push(item);
        if (this.utterances.length > 3000) {
          this.utterances.shift();
        }

        this.config.onUtterance?.(item);
      }
    } else {
      this.currentPartial = text;
      this.config.onPartial?.(text);
    }
  }

  _flushQueue() {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return;
    while (this.queue.length > 0) {
      const chunk = this.queue.shift();
      try {
        this.ws.send(chunk);
      } catch {
        this.queue.unshift(chunk);
        break;
      }
    }
    if (this.metrics) this.metrics.recordQueueState(this.queue.length);
  }

  /**
   * Przekazuje próbkę audio (16 kHz mono 16-bit PCM, 50–100 ms).
   *
   * @param {Buffer} pcm
   */
  sendAudio(pcm) {
    if (!this.active || !pcm || !pcm.length) return;
    const chunkSeconds = pcm.length / 2 / 16000;
    const fromTime = this.lastDeliveredSeconds;
    this.lastDeliveredSeconds += chunkSeconds;
    const toTime = this.lastDeliveredSeconds;

    const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);

    if (this.ws && this.ws.readyState === 1 /* OPEN */ && this.queue.length === 0) {
      try {
        this.ws.send(buf);
        return;
      } catch {
        // Przy potknięciu odkładamy do kolejki
      }
    }

    // Kolejkowanie przy łączeniu lub opóźnieniu
    if (this.queue.length >= MAX_QUEUE_FRAMES) {
      // Przeciążenie: odrzucamy najstarsze ramki i odnotowujemy lukę
      const dropped = this.queue.shift();
      const droppedSeconds = dropped ? dropped.length / 2 / 16000 : 0.1;
      const gap = {
        start: Math.max(0, fromTime - (this.queue.length * droppedSeconds)),
        end: fromTime,
        reason: "queue_overflow",
      };
      this.liveGaps.push(gap);
      this._setStatus("degraded", gap);
      this.config.onGap?.(gap);
      if (this.metrics) this.metrics.recordQueueState(this.queue.length, 1);
    }

    this.queue.push(buf);
    if (this.metrics) this.metrics.recordQueueState(this.queue.length);
  }

  /**
   * Zwraca wypowiedzi z ostatnich `windowSeconds` (domyślnie 10 minut = 600 s) dla Quick Feedback.
   *
   * @param {number} windowSeconds
   * @param {number} [sinceTimestamp]
   * @returns {Array}
   */
  getSnapshot(windowSeconds = 600, sinceTimestamp = null) {
    const list = [...this.utterances];
    if (!list.length) return [];

    const latest = list[list.length - 1].end || this.lastDeliveredSeconds;
    const cutoff = sinceTimestamp != null
      ? sinceTimestamp
      : Math.max(0, latest - windowSeconds);

    return list.filter((u) => u.start >= cutoff);
  }

  async close() {
    this.active = false;
    this.queue = [];
    if (this.ws) {
      try {
        if (this.ws.readyState === 1 /* OPEN */) {
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
          this.ws.close(1000);
        } else if (this.ws.readyState === 0 /* CONNECTING */) {
          this.ws.close();
        }
      } catch {}
      this.ws = null;
    }
  }
}

/**
 * Provider transkrypcji spotkań oparty wyłącznie na Deepgramie.
 */
class DeepgramMeetingProvider {
  /**
   * Otwiera sesję WebSocket na torze systemowym kursanta.
   *
   * @param {object} config
   * @returns {Promise<LiveMeetingSession>}
   */
  async startLiveSession(config) {
    return new LiveMeetingSession(config);
  }

  /**
   * Przeprowadza transkrypcję pełnych nagrań obu torów po zakończeniu spotkania.
   *
   * @param {{micAudioPath: string, systemAudioPath: string}} recording
   * @param {object} config
   * @returns {Promise<{transcript: Array, micUtterances: Array, systemUtterances: Array}>}
   */
  async transcribeRecording(recording, config = {}) {
    const { micAudioPath, systemAudioPath } = recording;
    const { apiKey, model = "nova-3", language = "pl", bilingual = true, mockTranscribe } = config;

    // Wsparcie dla atrap w testach jednostkowych bez sieci
    if (typeof mockTranscribe === "function") {
      return mockTranscribe(recording, config);
    }

    // Wykonanie przez worker_threads jeśli dostępne, lub wprost
    return new Promise((resolve, reject) => {
      try {
        const worker = new Worker(path.join(__dirname, "meeting-worker.js"));
        worker.postMessage({
          id: 1,
          type: "batch-meeting",
          payload: {
            micWav: micAudioPath,
            systemWav: systemAudioPath,
            options: { apiKey, model, language, bilingual },
          },
        });

        worker.on("message", (msg) => {
          worker.terminate();
          if (msg.success) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error || "Błąd transkrypcji batchowej w workerze"));
          }
        });

        worker.on("error", (err) => {
          worker.terminate();
          // Fallback w procesie głównym gdyby worker nie mógł wystartować
          this._transcribeDirect(micAudioPath, systemAudioPath, { apiKey, model, language, bilingual })
            .then(resolve)
            .catch(reject);
        });
      } catch {
        this._transcribeDirect(micAudioPath, systemAudioPath, { apiKey, model, language, bilingual })
          .then(resolve)
          .catch(reject);
      }
    });
  }

  async _transcribeDirect(micWav, systemWav, options) {
    const [micUtterances, systemUtterances] = await Promise.all([
      transcribeWavFile(micWav, options),
      transcribeWavFile(systemWav, options),
    ]);
    const transcript = mergeUtterancesByTimeline(micUtterances, systemUtterances);
    return { transcript, micUtterances, systemUtterances };
  }
}

module.exports = {
  LiveMeetingSession,
  DeepgramMeetingProvider,
};
