"use strict";

const { monitorEventLoopDelay } = require("perf_hooks");
const fs = require("fs");

/**
 * Lekkie metryki wykonawcze spotkań — bez zapisywania treści rozmów.
 *
 * Mierzone:
 * - event-loop delay (opóźnienie pętli zdarzeń Node'a)
 * - pamięć procesu (RSS w MB)
 * - stan kolejki live WebSocket i odrzucone ramki
 * - przerwy i błędy WebSocket
 * - rozmiary plików WAV
 * - czas trwania finalizacji (batch + merge)
 */
class MeetingMetrics {
  constructor() {
    this.histogram = null;
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
    } catch {
      this.histogram = null;
    }

    this.liveQueueLength = 0;
    this.droppedFrames = 0;
    this.wsDisconnects = 0;
    this.finalizationDurationMs = 0;
    this.createdAt = Date.now();
  }

  recordQueueState(queueLength, droppedDelta = 0) {
    this.liveQueueLength = queueLength;
    if (droppedDelta > 0) {
      this.droppedFrames += droppedDelta;
    }
  }

  recordDisconnect() {
    this.wsDisconnects += 1;
  }

  recordFinalizationTime(ms) {
    this.finalizationDurationMs = Math.round(ms);
  }

  /**
   * Zrzut aktualnych metryk bez treści rozmów.
   *
   * @param {{micAudioPath?: string, systemAudioPath?: string}} [files]
   * @returns {object}
   */
  snapshot(files = {}) {
    const memory = process.memoryUsage();
    const eventLoop = this.histogram
      ? {
          meanMs: Math.round((this.histogram.mean / 1e6) * 100) / 100,
          maxMs: Math.round((this.histogram.max / 1e6) * 100) / 100,
          p95Ms: Math.round((this.histogram.percentile(95) / 1e6) * 100) / 100,
        }
      : null;

    let micBytes = 0;
    let systemBytes = 0;
    try {
      if (files.micAudioPath && fs.existsSync(files.micAudioPath)) {
        micBytes = fs.statSync(files.micAudioPath).size;
      }
      if (files.systemAudioPath && fs.existsSync(files.systemAudioPath)) {
        systemBytes = fs.statSync(files.systemAudioPath).size;
      }
    } catch {}

    return {
      uptimeSeconds: Math.round((Date.now() - this.createdAt) / 1000),
      memoryRssMb: Math.round(memory.rss / (1024 * 1024)),
      eventLoop,
      liveQueueLength: this.liveQueueLength,
      droppedFrames: this.droppedFrames,
      wsDisconnects: this.wsDisconnects,
      finalizationDurationMs: this.finalizationDurationMs,
      wavSizes: {
        micBytes,
        systemBytes,
      },
    };
  }

  destroy() {
    if (this.histogram) {
      try {
        this.histogram.disable();
      } catch {}
      this.histogram = null;
    }
  }
}

module.exports = { MeetingMetrics };
