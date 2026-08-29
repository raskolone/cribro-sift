"use strict";

const fs = require("fs");
const { record } = require("./tap");

/**
 * Przebieg spotkania — start, koniec i to, co zostaje.
 *
 * Nagrywanie spotkania jest czymś innym niż dyktowanie i nie da się go
 * na nie naciągnąć. Dyktowanie trwa kilkanaście sekund, słucha jednego
 * mikrofonu i kończy się tekstem pod kursorem. Spotkanie trwa godzinę,
 * słucha dwóch źródeł naraz i kończy się dokumentem. Stąd osobny stan,
 * osobne pliki i osobny wpis w spisie — a nie kolejna gałąź w toggleCapture.
 *
 * Te dwie rzeczy mogą chodzić RÓWNOLEGLE i to jest zamierzone: dyktowanie
 * notatki w trakcie spotkania jest jedną z sensowniejszych rzeczy, jakie
 * można wtedy zrobić. Mikrofon otwierają osobno (ScreenCaptureKit kontra
 * getUserMedia), więc nie wchodzą sobie w drogę.
 *
 * Na tym etapie modułu spotkanie kończy się dwoma plikami WAV i wpisem.
 * Transkrypcja i podsumowanie dochodzą osobno — i to jest celowa kolejność:
 * najpierw ma działać nagrywanie, którego nie da się powtórzyć, potem
 * przetwarzanie, które da się powtórzyć w nieskończoność z tych plików.
 */

class Meetings {
  /**
   * @param {object} store  main/store.js
   * @param {{onChange?: Function, onLevel?: Function, onError?: Function}} hooks
   */
  constructor(store, { onChange, onLevel, onError } = {}) {
    this.store = store;
    this.onChange = onChange ?? (() => {});
    this.onLevel = onLevel ?? (() => {});
    this.onError = onError ?? (() => {});
    this.tap = null;
    this.id = null;
    this.startedAt = 0;
  }

  get recording() {
    return !!this.tap;
  }

  /** Metryka bieżącego spotkania — do paska, tacy i okna. */
  get state() {
    return {
      recording: this.recording,
      id: this.id,
      seconds: this.recording ? (Date.now() - this.startedAt) / 1000 : 0,
    };
  }

  /**
   * Początek nagrywania.
   *
   * Wpis w spisie powstaje OD RAZU, przed pierwszą próbką, i od razu ze
   * stanem „recording". Gdyby aplikacja zginęła w połowie rozmowy, zostaje
   * po niej ślad z katalogiem plików — zamiast godziny dźwięku, o której
   * nikt już nie wie, że istnieje.
   */
  async start() {
    if (this.recording) return this.state;

    const settings = this.store.getSettings();
    const meeting = this.store.createMeeting();
    const dir = this.store.meetingDir(meeting.id);

    try {
      this.tap = record({
        dir,
        exclude: settings.meetings?.exclude ?? [],
        onLevel: (level) => this.onLevel(level),
        onError: (message) => this.#fail(message),
      });
    } catch (problem) {
      // Brak programu pomocniczego albo odmowa uruchomienia. Wpis nie ma po
      // czym zostać — kasujemy go razem z pustym katalogiem.
      this.store.deleteMeeting(meeting.id);
      this.onChange();
      throw problem;
    }

    this.id = meeting.id;
    this.startedAt = Date.now();
    this.onChange();
    return this.state;
  }

  /**
   * Koniec nagrywania.
   *
   * Spotkanie krótsze niż `minSeconds` ginie bez śladu. To nie jest
   * oszczędzanie miejsca: menu kliknięte przez pomyłkę zostawiałoby w spisie
   * wpisy, których nikt nie zamawiał, a spis ma być listą rozmów, nie listą
   * pomyłek. Granica jest w ustawieniach, więc da się ją przesunąć.
   */
  async stop() {
    if (!this.recording) return { discarded: false, meeting: null };

    const tap = this.tap;
    const id = this.id;
    this.tap = null;
    this.id = null;

    const result = await tap.stop();
    const seconds = Math.max(result.mic, result.system);
    const settings = this.store.getSettings();
    const floor = settings.meetings?.minSeconds ?? 90;

    if (seconds < floor) {
      this.store.deleteMeeting(id);
      this.onChange();
      return { discarded: true, meeting: null, seconds };
    }

    const meeting = this.store.updateMeeting(id, {
      endedAt: new Date().toISOString(),
      seconds,
      state: "done",
      tracks: result.files,
    });
    this.onChange();
    return { discarded: false, meeting };
  }

  /** Przełącznik dla menu i tacy — jedna pozycja, dwa znaczenia. */
  async toggle() {
    return this.recording ? this.stop() : this.start();
  }

  /**
   * Awaria w trakcie. Nagranie zatrzymujemy, ale wpisu NIE kasujemy:
   * to, co zdążyło wejść na dysk, bywa całą rozmową bez ostatniej minuty
   * — a o tym, czy to jeszcze coś warte, decyduje człowiek, nie ten kod.
   */
  #fail(message) {
    if (!this.id) return;
    this.store.updateMeeting(this.id, { state: "failed", error: message });
    this.onError(message);
    const tap = this.tap;
    this.tap = null;
    this.id = null;
    tap?.stop().finally(() => this.onChange());
  }

  /**
   * Domknięcie przy wyjściu z aplikacji.
   *
   * Bez tego program pomocniczy zostaje żywy po zamknięciu okna, a pliki
   * WAV zostają bez nagłówka — czyli jako bajty, których nic nie otworzy.
   */
  async shutdown() {
    if (!this.recording) return;
    await this.stop().catch(() => {});
  }

  /** Spis do pokazania: bez wpisów, po których nie ma już plików. */
  list() {
    return this.store.getMeetings().filter((meeting) => {
      if (meeting.state === "recording") return true;
      return !meeting.tracks || fs.existsSync(meeting.tracks.mic);
    });
  }
}

module.exports = { Meetings };
