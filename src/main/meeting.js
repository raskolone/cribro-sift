"use strict";

const fs = require("fs");
const { record, wavHeader } = require("./tap");
const { cutter } = require("./segments");
const { splice } = require("./merge");

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
 * TRANSKRYPCJA IDZIE W BIEGU, nie po zakończeniu. Próbki lecą przez
 * krajalnicę (main/segments.js) i każdy odcinek, w którym coś słychać,
 * rusza do przepisania od razu. Po naciśnięciu „Koniec" zostaje do
 * dokończenia jeden odcinek na tor, a nie godzina dźwięku — i przez cały
 * czas rozmowy widać w oknie, co już zostało zapisane. Splot dwóch torów
 * w jeden zapis (main/merge.js) liczy się na końcu, bo dopiero wtedy widać
 * całość: przesłuch wycina się porównaniem torów, a nie po kolei.
 *
 * AWARIA PRZEPISYWANIA NIE PRZERYWA NAGRANIA i to jest ważniejsze, niż
 * wygląda: dźwięku nie da się powtórzyć, tekst da się zrobić z niego
 * jeszcze raz. Dziura w zapisie jest stratą odwracalną, przerwane nagranie
 * — nie.
 */

class Meetings {
  /**
   * @param {object} store  main/store.js
   * @param {{onChange?: Function, onLevel?: Function, onError?: Function}} hooks
   */
  /**
   * @param {object} store  main/store.js
   * @param {object} hooks
   * @param {Function} [hooks.transcribe]  głos na tekst; wstrzykiwany, żeby
   *        test mógł przepuścić przez ten obieg wymyślony tekst zamiast
   *        wołać cudzy serwer
   */
  constructor(store, { onChange, onLevel, onError, onTranscript, transcribe, slice } = {}) {
    this.store = store;
    this.onChange = onChange ?? (() => {});
    this.onLevel = onLevel ?? (() => {});
    this.onError = onError ?? (() => {});
    /* Osobno od onChange, bo to jest inna wiadomość. Zmiana STANU
       (zaczęło się, skończyło) przestawia znak w pasku menu i przebudowuje
       menu aplikacji; przybycie odcinka zapisu nie zmienia ani jednego,
       ani drugiego — a przychodzi co dwie minuty przez całą rozmowę. */
    this.onTranscript = onTranscript ?? (() => {});
    this.transcribe = transcribe ?? require("./stt").transcribe;
    /* Jak kroimy tor — domyślnie tak, jak mówi main/segments.js. Podawane
       z zewnątrz wyłącznie w teście: żeby sprawdzić przepisywanie w biegu
       na trzysekundowym nagraniu, odcinek musi trwać sekundę, a nie dwie
       minuty. Nagranie prawdziwe zostaje przy swoim. */
    this.slice = slice ?? {};
    this.tap = null;
    this.id = null;
    this.startedAt = 0;
    /* Krajalnice (po jednej na tor), przepisane odcinki i obietnice tych,
       które są jeszcze w drodze. Wszystko trzy żyje jedno nagranie. */
    this.cutters = null;
    this.pieces = [];
    this.jobs = [];
    this.misses = 0;
  }

  /**
   * Ile pomyłek z rzędu, zanim przestaniemy próbować.
   *
   * Nie jedna, bo sieć potrafi mrugnąć. I nie w nieskończoność, bo przy
   * braku klucza API każdy odcinek wracałby tym samym błędem co dwie
   * minuty przez całą godzinę rozmowy.
   */
  static get GIVE_UP() {
    return 3;
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
  async start(about = null) {
    if (this.recording) return this.state;

    const settings = this.store.getSettings();
    // Nazwa i miejsce przychodzą z wykrywania (main/detect.js), o ile było
    // co wykryć. Nagranie z menu zaczyna się bez nazwy i tak zostaje.
    const meeting = this.store.createMeeting({
      title: about?.title ?? null,
      where: about?.where ?? null,
    });
    const dir = this.store.meetingDir(meeting.id);

    this.cutters = {
      mic: cutter({ lane: "mic", ...this.slice }),
      system: cutter({ lane: "system", ...this.slice }),
    };
    this.pieces = [];
    this.jobs = [];
    this.misses = 0;

    try {
      this.tap = record({
        dir,
        exclude: settings.meetings?.exclude ?? [],
        onLevel: (level) => this.onLevel(level),
        onPcm: (lane, pcm) => this.#chew(lane, pcm),
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

  /* ── Przepisywanie w biegu ──────────────────────────────────── */

  /** Próbki z toru → krajalnica → odcinki do przepisania. */
  #chew(lane, pcm) {
    const cut = this.cutters?.[lane];
    if (!cut) return;
    for (const piece of cut.push(pcm)) this.#write(piece);
  }

  /**
   * Jeden odcinek na tekst.
   *
   * Obietnicę odkładamy do `jobs`, bo koniec nagrywania musi na nią
   * poczekać: bez tego ostatnie dwie minuty rozmowy zostałyby w powietrzu,
   * a wpis zamknąłby się bez nich.
   */
  #write(piece) {
    // Cisza nie jedzie nigdzie. W godzinnym spotkaniu jest jej więcej niż
    // mowy, a płaci się za nią tyle samo.
    if (piece.silent) return;
    if (this.misses >= Meetings.GIVE_UP) return;

    const id = this.id;
    const job = (async () => {
      try {
        const wav = Buffer.concat([wavHeader(piece.pcm.length), piece.pcm]);
        /* Trzeci argument mówi, CZYJ to odcinek i kiedy padł. Dostawcy
           w main/stt.js go nie czytają, a przydaje się dwóm rzeczom:
           testowi, który po nim rozpoznaje tor, i przyszłemu dostawcy,
           któremu można będzie powiedzieć, że słucha jednej osoby. */
        const { text } = await this.transcribe(wav, this.store.getSettings(), {
          lane: piece.lane,
          from: piece.from,
          to: piece.to,
        });
        this.misses = 0;
        const said = String(text ?? "").trim();
        if (!said) return;
        this.pieces.push({ lane: piece.lane, from: piece.from, to: piece.to, text: said });
        this.#stitch(id);
      } catch (problem) {
        this.misses += 1;
        // Mówimy o pierwszej pomyłce i o tej, po której się poddajemy.
        // O każdej z osobna znaczyłoby komunikat co dwie minuty przez
        // godzinę — przy braku klucza API zawsze ten sam.
        if (this.misses === 1) {
          this.onError(`Nie udało się przepisać fragmentu: ${problem.message}`);
        } else if (this.misses === Meetings.GIVE_UP) {
          this.onError(
            "Przepisywanie w biegu wyłączone do końca tego spotkania — nagranie leci dalej.",
          );
        }
      }
    })();
    this.jobs.push(job);
  }

  /**
   * Zapis rozmowy z tego, co już przepisane.
   *
   * Liczymy go za każdym razem od nowa, z wszystkich odcinków — a nie
   * doklejamy po jednym. Splot (main/merge.js) porównuje tory ze sobą,
   * więc odcinek dopisany na końcu potrafi zmienić to, co stoi wcześniej:
   * cudze zdanie złapane mikrofonem wypada dopiero wtedy, gdy przyjedzie
   * odpowiadający mu odcinek toru systemu.
   */
  #stitch(id) {
    if (!id) return;
    this.store.updateMeeting(id, { transcript: splice(this.pieces) });
    this.onTranscript();
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
      this.cutters = null;
      this.jobs = [];
      this.pieces = [];
      this.onChange();
      return { discarded: true, meeting: null, seconds };
    }

    /* Resztki z obu torów. Ostatnie zdanie spotkania pada zwykle
       w ostatnich sekundach — a te siedzą jeszcze w krajalnicy. */
    for (const cut of Object.values(this.cutters ?? {})) {
      for (const piece of cut.flush()) this.#write({ ...piece, lane: piece.lane });
    }
    this.cutters = null;

    // Czekamy na to, co w drodze. Wpis zamknięty bez ostatnich odcinków
    // byłby zapisem rozmowy bez jej końca.
    await Promise.allSettled(this.jobs);
    this.jobs = [];

    const transcript = splice(this.pieces);
    this.pieces = [];

    /* Nagranie ginie po przepisaniu — tak mówi ustawienie i tak samo dzieje
       się przy dyktowaniu. ALE TYLKO WTEDY, GDY JEST CZYM JE ZASTĄPIĆ.
       Spotkanie bez transkryptu i bez plików nie zostawiłoby po sobie nic,
       a dźwięku nie da się nagrać drugi raz — więc gdy przepisywanie
       zawiodło (brak klucza, brak sieci), pliki zostają niezależnie od
       ustawienia. Kasuje się to, co da się odtworzyć. */
    const keepAudio = settings.meetings?.keepAudio === true || transcript.length === 0;
    if (!keepAudio) {
      for (const file of Object.values(result.files)) fs.rmSync(file, { force: true });
    }

    const meeting = this.store.updateMeeting(id, {
      endedAt: new Date().toISOString(),
      seconds,
      state: "done",
      tracks: keepAudio ? result.files : null,
      transcript,
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

  /** Spis do pokazania: bez wpisów, po których nie zostało już nic. */
  list() {
    return this.store.getMeetings().filter((meeting) => {
      if (meeting.state === "recording") return true;
      // Wpis bez plików jest w porządku, o ile został po nim tekst —
      // nagranie ginie po przepisaniu, gdy tak mówi ustawienie.
      if (meeting.transcript?.length) return true;
      return !meeting.tracks || fs.existsSync(meeting.tracks.mic);
    });
  }
}

module.exports = { Meetings };
