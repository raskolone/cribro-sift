"use strict";

const { keyFor } = require("./providers");
const { fixedCode } = require("./languages");
const logger = require("./logger");

/**
 * Strumieniowanie mowy na żywo przez WebSocket do Deepgramu.
 *
 * ══ ZASADA DZIAŁANIA ══
 *
 * Zamiast czekać na koniec dyktowania, pakować próbki w plik WAV i wysyłać
 * cały plik przez HTTP POST:
 *   1. W chwili naciśnięcia klawisza otwieramy połączenie WebSocket.
 *   2. Każda porcja 16-bitowego PCM (co ~100 ms) jest natychmiast
 *      wypychana do gniazda.
 *   3. Gdy użytkownik puszcza klawisz, wysyłamy sygnał CloseStream.
 *   4. Deepgram przesyła gotową transkrypcję w ułamku sekundy (~50-100 ms).
 *
 * W razie jakiegokolwiek potknięcia sieciowego lub braku klucza,
 * sesja zamyka się cicho, a potok automatycznie sięga po dotychczasowy
 * sprawdzony tor HTTP (pełny bufor WAV z nagrania).
 */

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

class SttStream {
  constructor() {
    this.ws = null;
    this.active = false;
    this.model = "nova-3";
    this.apiKey = null;
    this.queue = [];
    this.transcripts = [];
    this.finalResolve = null;
    this.finalReject = null;
    this.sessionTimer = null;
    this.startedAt = 0;
  }

  /**
   * Otwiera sesję strumieniowania dla nagrania.
   */
  startSession(settings, about = null) {
    this.abortSession();

    const provider = settings.stt?.provider || "deepgram";
    if (provider !== "deepgram" || settings.stt?.streaming === false) {
      return false;
    }

    const apiKey = keyFor("deepgram", settings);
    if (!apiKey) {
      return false;
    }

    this.apiKey = apiKey;
    this.model = settings.stt?.model || "nova-3";
    this.queue = [];
    this.transcripts = [];
    this.active = true;
    this.startedAt = Date.now();

    const code = fixedCode(settings.language) || "pl";
    const url = new URL(DEEPGRAM_WS_URL);
    url.searchParams.set("model", this.model);
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("endpointing", "300");

    if (settings.language?.mode === "bilingual") {
      url.searchParams.set("detect_language", "true");
    } else {
      url.searchParams.set("language", code);
    }

    const names = (about?.glossary ?? []).filter(Boolean);
    for (const name of names.slice(0, 30)) {
      url.searchParams.append("keywords", `${name}:2`);
    }

    try {
      const WebSocketImpl = globalThis.WebSocket;
      if (!WebSocketImpl) {
        this.active = false;
        return false;
      }

      this.ws = new WebSocketImpl(url.toString(), {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        if (!this.active || !this.ws) return;
        // Wypchnij zakolejkowane próbki audio
        while (this.queue.length > 0) {
          const chunk = this.queue.shift();
          try {
            this.ws.send(chunk);
          } catch {
            break;
          }
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = typeof event.data === "string" ? JSON.parse(event.data) : JSON.parse(event.data.toString());
          const text =
            data.channel?.alternatives?.[0]?.transcript ??
            data.results?.channels?.[0]?.alternatives?.[0]?.transcript ??
            "";

          if (text && text.trim()) {
            if (data.is_final || data.speech_final) {
              this.transcripts.push(text.trim());
            }
          }
        } catch {
          /* ignorujemy nie-JSONowe ramki */
        }
      };

      this.ws.onerror = (err) => {
        logger.logWarning("STREAM", "Usterka gniazda strumieniowania Deepgram", { error: String(err?.message || err) });
        if (this.finalReject) {
          this.finalReject(err);
          this.finalReject = null;
          this.finalResolve = null;
        }
      };

      this.ws.onclose = () => {
        this._settleFinal();
      };

      return true;
    } catch (err) {
      this.active = false;
      logger.logWarning("STREAM", "Nie udało się otworzyć WebSocket Deepgram", { error: String(err?.message || err) });
      return false;
    }
  }

  /**
   * Przesyła 16-bitową porcję PCM zebraną w trakcie mówienia.
   */
  sendChunk(chunk) {
    if (!this.active || !this.ws) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(buf);
      } catch {
        this.queue.push(buf);
      }
    } else if (this.ws.readyState === 0 /* CONNECTING */) {
      // Buforujemy maksymalnie ~10 sekund audio
      if (this.queue.length < 100) {
        this.queue.push(buf);
      }
    }
  }

  /**
   * Kończy sesję nagrywania i oczekuje na finalny transkrypt z Deepgramu.
   *
   * @param {number} timeoutMs
   * @returns {Promise<{text: string, provider: string, model: string}|null>}
   */
  async finishSession(timeoutMs = 2500) {
    if (!this.active || !this.ws) return null;

    return new Promise((resolve) => {
      this.finalResolve = resolve;

      this.sessionTimer = setTimeout(() => {
        this._settleFinal();
      }, timeoutMs);

      try {
        if (this.ws.readyState === 1 /* OPEN */) {
          // Protokół Deepgramu: pusty bufor lub ramka CloseStream
          this.ws.send(JSON.stringify({ type: "CloseStream" }));
        } else if (this.ws.readyState >= 2 /* CLOSING/CLOSED */) {
          this._settleFinal();
        }
      } catch {
        this._settleFinal();
      }
    });
  }

  _settleFinal() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;

    const fullText = this.transcripts.join(" ").replace(/\s+/g, " ").trim();
    const result = fullText
      ? { text: fullText, provider: "deepgram", model: this.model }
      : null;

    const res = this.finalResolve;
    this.finalResolve = null;
    this.finalReject = null;
    this.abortSession();

    if (res) res(result);
  }

  /**
   * Przerywa i czyści sesję strumieniowania.
   */
  abortSession() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    this.active = false;
    this.queue = [];
    this.transcripts = [];
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        if (this.ws.readyState === 0 || this.ws.readyState === 1) {
          this.ws.close(1000);
        }
      } catch {}
      this.ws = null;
    }
  }
}

const singleton = new SttStream();

module.exports = {
  SttStream,
  sttStream: singleton,
};
