"use strict";

const fs = require("fs");
const path = require("path");
const { record, wavHeader } = require("./tap");
const { cutter } = require("./segments");
const { splice } = require("./merge");
const { shrink, expand } = require("./audio");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * można wtedy zrobić. Mikrofon otwierają osobno (Core Audio w cribro-tap
 * kontra getUserMedia w oknie HUD-a), więc nie wchodzą sobie w drogę.
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
  constructor(
    store,
    {
      onChange,
      onLevel,
      onError,
      onTranscript,
      onSilence,
      onIdle,
      transcribe,
      slice,
      backoff,
    } = {},
  ) {
    this.store = store;
    this.onChange = onChange ?? (() => {});
    this.onLevel = onLevel ?? (() => {});
    this.onError = onError ?? (() => {});
    /* Tor, w którym od dłuższego czasu nic nie słychać. Najkosztowniejsza
       cicha awaria w tym module: nagranie wychodzi, transkrypcja wychodzi,
       tylko rozmowa jest w nim jednostronna — i widać to dopiero na końcu. */
    this.onSilence = onSilence ?? (() => {});
    /* OBA tory milczą od kwadransa. To jest inna wiadomość niż onSilence:
       tam jedna strona zamilkła i to jest usterka, tutaj zamilkły obie
       i to nie jest usterka, tylko koniec rozmowy. Sam moduł go nie
       kończy — nagranie ucina wyłącznie ten, kto wie o oknach i o tym,
       czego chciał człowiek (patrz main/main.js). */
    this.onIdle = onIdle ?? (() => {});
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
    /* Odstęp przed powtórką. Podawany z zewnątrz wyłącznie w teście: żeby
       sprawdzić trzy podejścia do dwunastu odcinków, nie da się czekać
       po półtorej sekundy przed każdym. Nagranie prawdziwe zostaje przy
       swoim — mrugnięcie sieci mija w sekundę, a nie w milisekundę. */
    this.backoff = backoff ?? Meetings.BACKOFF;
    this.tap = null;
    this.id = null;
    this.startedAt = 0;
    /* Krajalnice (po jednej na tor), przepisane odcinki i obietnice tych,
       które są jeszcze w drodze. Wszystko trzy żyje jedno nagranie. */
    this.cutters = null;
    this.pieces = [];
    this.jobs = [];
    this.misses = 0;
    /* Ogon ostatniego odcinka każdego toru i słowniczek nazw własnych —
       jedno i drugie idzie do modelu razem z następnym odcinkiem. */
    this.tails = { mic: "", system: "" };
    this.glossary = [];
    this.speakers = null;
    /* Ile ciszy z rzędu w każdym torze — liczone odcinkami, nie sekundami. */
    this.quiet = { mic: 0, system: 0 };
    this.told = { mic: false, system: false };
    this.toldIdle = false;
    /* ══ REJESTR ODCINKÓW ══

       Co się stało z każdym kawałkiem rozmowy: przepisany, cichy, pusty,
       stracony. Bez tego spisu nie da się odpowiedzieć na jedyne pytanie,
       które przy transkrypcji naprawdę się zadaje — CZY TO JEST CAŁOŚĆ.
       Godzinne zajęcia zapisały się dwiema linijkami i nic w aplikacji nie
       wiedziało, że czegoś brakuje: nagranie skasowało się jak po udanej
       transkrypcji, bo „transkrypt niepusty" uchodziło za „transkrypt
       gotowy". Spis jest po to, żeby te dwie rzeczy przestały być tym
       samym. */
    this.ledger = [];
  }

  /**
   * Po ilu cichych odcinkach z rzędu mówimy, że tor milczy.
   *
   * Odcinek to dwie minuty, więc dwa i pół odcinka to pięć minut. Mniej
   * byłoby fałszywym alarmem przy każdym dłuższym monologu drugiej strony;
   * więcej znaczyłoby, że o zepsutym nagraniu dowiadujesz się po kwadransie.
   */
  static get QUIET_LIMIT() {
    return 3;
  }

  /**
   * Po ilu cichych odcinkach W OBU TORACH rozmowa jest skończona.
   *
   * Pięć odcinków to blisko dziesięć minut, w których nie padło ani jedno
   * słowo po żadnej stronie. Nie ma takiej rozmowy — jest za to spotkanie,
   * z którego wszyscy wyszli, i okno, które komuś zostało otwarte.
   *
   * Więcej niż QUIET_LIMIT i nie jest to przeoczenie: jedna strona milcząca
   * pięć minut to usterka nagrania, o której trzeba powiedzieć w trakcie;
   * obie strony milczące dziesięć minut to koniec, po którym trzeba
   * przestać nagrywać. Inne progi, bo inne pytania.
   */
  static get IDLE_LIMIT() {
    return 5;
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

  /**
   * Ile razy próbujemy przepisać JEDEN odcinek, zanim uznamy go za stracony.
   *
   * Wcześniej próba była jedna i to jest ta różnica, o którą rozbiła się
   * godzina zajęć: jedno mrugnięcie sieci albo jedna pusta odpowiedź
   * dostawcy kasowała dwie minuty rozmowy bez śladu — bez błędu, bez wpisu,
   * bez niczego, po czym dałoby się poznać, że czegoś brakuje.
   */
  static get TRIES() {
    return 3;
  }

  /** Odstęp przed kolejną próbą, w milisekundach. Rośnie z każdą. */
  static get BACKOFF() {
    return 1500;
  }

  /**
   * Ile mowy musi być w odcinku, żeby pusta odpowiedź była podejrzana.
   *
   * Poniżej tego pusta odpowiedź jest po prostu prawdą: w odcinku brzęknął
   * kubek i tyle. Powyżej — padły zdania, a wróciło nic, i to jest awaria,
   * którą trzeba powtórzyć, a nie wynik, który wolno przyjąć.
   */
  static get SUSPECT_SECONDS() {
    return 2;
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
      // Skąd nazwa: z okna rozmowy, z kalendarza albo znikąd. Rozstrzyga
      // to potem, czy podsumowanie ma prawo ją zmienić.
      titleFrom: about?.titleFrom ?? null,
      where: about?.where ?? null,
      /* Kto był zaproszony i jak podpisać drugi tor. Jedno i drugie
         przychodzi z kalendarza (main/agenda.js) i jest jedyną drogą,
         którą zapis rozmowy dowiaduje się, że po drugiej stronie jest
         Ania, a nie „Rozmówcy". */
      people: about?.people ?? [],
      speakers: about?.speakers ?? null,
    });
    this.speakers = about?.speakers ?? null;
    const dir = this.store.meetingDir(meeting.id);

    this.cutters = {
      mic: cutter({ lane: "mic", ...this.slice }),
      system: cutter({ lane: "system", ...this.slice }),
    };
    this.pieces = [];
    this.jobs = [];
    this.misses = 0;
    this.tails = { mic: "", system: "" };
    this.glossary = about?.people ?? [];
    this.quiet = { mic: 0, system: 0 };
    this.told = { mic: false, system: false };
    this.toldIdle = false;
    this.ledger = [];

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
   *
   * KAŻDY ODCINEK ZOSTAWIA ŚLAD W REJESTRZE — także ten, który przepadł.
   * To jest cała różnica między zapisem niepełnym a zapisem niepełnym,
   * o którym wiadomo.
   */
  #write(piece) {
    /* Cisza nie jedzie nigdzie. W godzinnym spotkaniu jest jej więcej niż
       mowy, a płaci się za nią tyle samo. Liczymy ją jednak — bo tor, który
       milczy CAŁY CZAS, to nie cisza w rozmowie, tylko zepsute nagranie. */
    if (piece.silent) {
      this.#note(piece, "silent");
      this.quiet[piece.lane] = (this.quiet[piece.lane] ?? 0) + 1;
      if (this.quiet[piece.lane] >= Meetings.QUIET_LIMIT && !this.told[piece.lane]) {
        this.told[piece.lane] = true;
        this.onSilence(piece.lane);
      }
      /* Cisza w OBU torach naraz to nie usterka, tylko pusty pokój.
         Mówimy o tym raz — kto tę wiadomość dostaje, ten decyduje, czy
         kończyć nagranie. */
      if (
        !this.toldIdle &&
        this.quiet.mic >= Meetings.IDLE_LIMIT &&
        this.quiet.system >= Meetings.IDLE_LIMIT
      ) {
        this.toldIdle = true;
        this.onIdle();
      }
      return;
    }
    this.quiet[piece.lane] = 0;
    this.toldIdle = false; // ktoś się odezwał — pokój znowu nie jest pusty
    if (this.misses >= Meetings.GIVE_UP) {
      /* Bezpiecznik przestał kasować rozmowę. Odcinek zostaje w rejestrze
         jako stracony, nagranie z tego powodu NIE ZGINIE (patrz stop), a po
         zakończeniu rusza przebieg naprawczy z pliku — więc „poddajemy się"
         znaczy dziś „nie dobijamy dostawcy w trakcie", a nie „ta część
         rozmowy przepada". */
      this.#note(piece, "skipped");
      return;
    }

    const id = this.id;
    const job = (async () => {
      try {
        const wav = Buffer.concat([wavHeader(piece.pcm.length), piece.pcm]);
        /* Trzeci argument mówi, CZYJ to odcinek i kiedy padł. Dostawcy
           w main/stt.js go nie czytają, a przydaje się dwóm rzeczom:
           testowi, który po nim rozpoznaje tor, i przyszłemu dostawcy,
           któremu można będzie powiedzieć, że słucha jednej osoby. */
        /* CIĄGŁOŚĆ MIĘDZY ODCINKAMI. Każdy odcinek jedzie do modelu osobno
           i bez tego nie wie nic o poprzednim — a wtedy imiona i nazwy
           własne dryfują z odcinka na odcinek („Ania → Hania → Anna").
           Dostaje więc ogon poprzedniego odcinka TEGO SAMEGO toru i listę
           imion z kalendarza. Jedno i drugie jest podpowiedzią, nie
           treścią: model ma z nich skorzystać przy zapisie tego, co
           naprawdę słychać. */
        const said = await this.#say(wav, {
          lane: piece.lane,
          from: piece.from,
          to: piece.to,
          context: this.tails?.[piece.lane] ?? "",
          glossary: this.glossary ?? [],
        }, piece.voiced);

        this.misses = 0;
        if (!said) {
          // Nic nie padło — i tyle. Odcinek jest opisany, a nie zgubiony.
          this.#note(piece, "empty");
          return;
        }
        this.#note(piece, "done");
        this.pieces.push({ lane: piece.lane, from: piece.from, to: piece.to, text: said });
        // Ogon dla następnego odcinka tego toru — tyle, ile wystarczy na
        // kontekst, a nie tyle, żeby model zaczął go przepisywać.
        this.tails[piece.lane] = said.slice(-320);
        this.#stitch(id);
      } catch (problem) {
        this.misses += 1;
        this.#note(piece, "failed", problem.message);
        // Mówimy o pierwszej pomyłce i o tej, po której się poddajemy.
        // O każdej z osobna znaczyłoby komunikat co dwie minuty przez
        // godzinę — przy braku klucza API zawsze ten sam.
        if (this.misses === 1) {
          this.onError(`Nie udało się przepisać fragmentu: ${problem.message}`);
        } else if (this.misses === Meetings.GIVE_UP) {
          this.onError(
            "Przepisywanie w biegu wyłączone do końca tego spotkania — nagranie leci dalej " +
              "i zostanie przepisane z pliku po zakończeniu.",
          );
        }
      }
    })();
    this.jobs.push(job);
  }

  /**
   * Odcinek na tekst, z powtórkami.
   *
   * DWA RODZAJE NIEPOWODZENIA, JEDNA ODPOWIEDŹ. Błąd sieci jest oczywisty.
   * Pusta odpowiedź na odcinek, w którym słychać zdania, jest gorsza, bo
   * wygląda jak wynik — a wcześniej właśnie tak wyglądała i tak była
   * przyjmowana: `if (!said) return`, bez śladu. Odcinek, w którym było
   * czym mówić, dostaje więc drugą i trzecią próbę tak samo jak odcinek,
   * który się wywrócił.
   *
   * @param {number} voiced  ile w odcinku sekund mowy
   * @returns {Promise<string>} tekst albo pusty ciąg, gdy naprawdę nic nie padło
   */
  async #say(wav, about, voiced = 0) {
    const suspicious = (voiced ?? 0) >= Meetings.SUSPECT_SECONDS;
    let last = null;

    for (let attempt = 1; attempt <= Meetings.TRIES; attempt += 1) {
      try {
        const { text } = await this.transcribe(wav, this.store.getSettings(), about);
        const said = String(text ?? "").trim();
        if (said) return said;
        // Cisza w odcinku bez mowy jest prawdą; w odcinku z mową — awarią.
        if (!suspicious) return "";
        last = new Error("dostawca oddał pusty tekst mimo mowy w odcinku");
      } catch (problem) {
        last = problem;
      }
      if (attempt < Meetings.TRIES) await wait(this.backoff * attempt);
    }

    throw last ?? new Error("nie udało się przepisać odcinka");
  }

  /** Wpis do rejestru odcinków. Jedno miejsce, żeby żaden nie wyszedł bokiem. */
  #note(piece, state, detail = null) {
    /* ══ ŚLAD NA DYSKU, NIE TYLKO W PAMIĘCI ══

       Rejestr żyje w polu obiektu i ginie razem z nim — a razem z nim
       ginie jedyna odpowiedź na pytanie „co się stało z tą godziną".
       2 września 2026 godzinne spotkanie zamknęło się rejestrem o jednym
       odcinku i nie dało się po fakcie rozstrzygnąć, czy odcinki nie
       powstały, czy powstały i przepadły: nagranie skasowano, logów nie
       było, a pamięć procesu dawno zniknęła.

       Dopisujemy więc każdy odcinek linijką do pliku obok nagrania.
       Jedna linijka to około stu bajtów, godzina rozmowy to sześćdziesiąt
       linijek — koszt żaden, a następnym razem będzie z czego czytać.
       Zapis nie ma prawa przewrócić nagrywania, więc idzie w try/catch
       i po cichu: brak śladu jest gorszy od braku nagrania tylko dla mnie,
       nie dla człowieka. */
    try {
      if (this.id) {
        fs.appendFileSync(
          path.join(this.store.meetingDir(this.id), "odcinki.jsonl"),
          JSON.stringify({
            t: new Date().toISOString(),
            lane: piece.lane,
            i: piece.index,
            from: Math.round(piece.from ?? 0),
            to: Math.round(piece.to ?? 0),
            voiced: Math.round(piece.voiced ?? 0),
            state,
            detail: detail ? String(detail).slice(0, 120) : undefined,
          }) + "\n",
        );
      }
    } catch {
      /* Dysk pełny albo katalog zniknął — nagranie leci dalej. */
    }
    this.ledger.push({
      lane: piece.lane,
      index: piece.index,
      from: piece.from,
      to: piece.to,
      seconds: Math.max(0, (piece.to ?? 0) - (piece.from ?? 0)),
      voiced: piece.voiced ?? 0,
      state,
      detail,
    });
  }

  /**
   * Ile z rozmowy naprawdę weszło do zapisu.
   *
   * To jest odpowiedź na pytanie „czy to jest cała transkrypcja" i jedyny
   * powód, dla którego rejestr odcinków w ogóle istnieje. Liczymy w SEKUNDACH
   * MOWY, nie w odcinkach: odcinek, w którym padło jedno zdanie, i odcinek
   * gadany bez przerwy są w spisie tym samym, a w rozmowie nie są.
   *
   * `complete` znaczy dokładnie tyle: nie ma odcinka, w którym coś mówiono,
   * a nie wiadomo co. Tylko przy `complete` wolno skasować nagranie.
   *
   * @param {Array} ledger
   * @returns {{segments, done, empty, failed, skipped, silent,
   *            spokenSeconds, writtenSeconds, complete}}
   */
  static tally(ledger = [], recordedSeconds = 0) {
    const count = (state) => ledger.filter((item) => item.state === state).length;
    const voiced = (test) =>
      ledger.filter(test).reduce((total, item) => total + (item.voiced || 0), 0);

    const lost = (item) => item.state === "failed" || item.state === "skipped";
    /* Pusta odpowiedź na odcinek z mową liczy się do strat tak samo jak
       błąd — bo z punktu widzenia notatki jest tym samym: minutami, które
       padły, a których nie ma. */
    const hollow = (item) => item.state === "empty" && item.voiced >= Meetings.SUSPECT_SECONDS;

    const spoken = voiced((item) => item.state !== "silent");
    const written = voiced((item) => item.state === "done");

    /* ══ ILE NAGRANIA W OGÓLE PRZESZŁO PRZEZ KRAJALNICĘ ══

       Rejestr odpowiada na pytanie „czy odcinki, KTÓRE PRZYSZŁY, doszły
       do tekstu". Nie odpowiada na pytanie, czy przyszły wszystkie —
       a to jest inne pytanie i to na nim ta funkcja dotąd milczała.

       2 września 2026 godzinne spotkanie (3808 s) zamknęło się rejestrem
       o JEDNYM odcinku: dwadzieścia sekund mowy z ostatniej minuty.
       Rejestr nie miał w sobie ani jednej straty, więc `complete` wyszło
       PRAWDĄ — a skoro prawdą, to nagranie skasowano. Zapis rozmowy
       z godziny zajęć to jeden akapit, którego nie da się już uzupełnić,
       bo dźwięku nie ma. Ten sam kształt miało spotkanie z 31 sierpnia:
       58 minut, dwa wpisy.

       Zamykamy więc pytanie „czy to jest całość" od drugiej strony:
       ostatni odcinek rejestru musi kończyć się mniej więcej tam, gdzie
       kończy się nagranie. Jeżeli rejestr urywa się kwadrans przed końcem,
       to nie jest zapis niepełny — to jest zapis, o którym nie wiadomo,
       czego w nim nie ma. */
    /* Mierzymy SUMĘ odcinków w torze, a nie to, dokąd sięga ostatni.

       Pierwsza wersja tej poprawki patrzyła na `max(to)` i nie złapała
       niczego: w straconym spotkaniu ostatni odcinek kończył się na 3864
       sekundzie przy nagraniu 3808-sekundowym, czyli SIĘGAŁ SAMEGO KOŃCA.
       Brakowało nie końca, tylko wszystkiego przed nim — jednego odcinka
       zamiast trzydziestu trzech. Dziura była w środku, a miara patrzyła
       na brzeg.

       Liczymy więc osobno w każdym torze, ile sekund nagrania w ogóle
       przeszło przez krajalnicę, i bierzemy tor LEPSZY. Gorszy bywa
       martwy z powodów, które nie są utratą zapisu: druga strona
       z wyciszonym mikrofonem daje tor systemu pusty przez całe spotkanie,
       a rozmowa jest mimo to zapisana w całości tym drugim. */
    const perLane = new Map();
    for (const item of ledger) {
      const span = Math.max(0, (item.to ?? 0) - (item.from ?? 0));
      perLane.set(item.lane, (perLane.get(item.lane) ?? 0) + span);
    }
    const reached = perLane.size ? Math.max(...perLane.values()) : 0;
    /* Pół minuty luzu: zakładka między odcinkami liczy się podwójnie
       w jedną stronę, a resztka poniżej progu wypada z krojenia
       (patrz flush w main/segments.js) — w drugą. */
    const SLACK = 30;
    const covered = recordedSeconds > 0 ? Math.min(1, reached / recordedSeconds) : 1;
    const truncated = recordedSeconds > 0 && reached + SLACK < recordedSeconds;

    return {
      segments: ledger.length,
      /* Do ilu sekundy nagrania sięga rejestr i jaka to część całości.
         Stoi we wpisie, bo bez tego „zapis obejmuje X z Y minut" nie ma
         z czego powstać, a to jest pierwsza rzecz do powiedzenia
         człowiekowi o niepełnym zapisie. */
      recordedSeconds: Math.round(recordedSeconds),
      reachedSeconds: Math.round(reached),
      covered: Math.round(covered * 100) / 100,
      truncated,
      done: count("done"),
      empty: count("empty"),
      failed: count("failed"),
      skipped: count("skipped"),
      silent: count("silent"),
      spokenSeconds: Math.round(spoken),
      writtenSeconds: Math.round(written),
      /* Trzy warunki, wszystkie o jedno i to samo: czy wolno skasować
         nagranie.

           — pusty rejestr znaczy, że dźwięk NIE PRZESZEDŁ przez ten obieg
             w ogóle; nie wiemy o nim nic, więc nie wolno go wyrzucić;
           — mowa bez ani jednego zapisanego słowa to awaria, choćby
             wszystkie odcinki wróciły „grzecznie" puste;
           — no i zwykłe straty: odcinek stracony albo pusty mimo mowy. */
      complete:
        ledger.length > 0 &&
        !(spoken > 0 && written === 0) &&
        /* Czwarty warunek, dopisany po utracie godziny zajęć: rejestr, który
           nie dosięga końca nagrania, NIE JEST całością — choćby wszystko,
           co w nim stoi, było przepisane bez jednej straty. */
        !truncated &&
        !ledger.some((item) => lost(item) || hollow(item)),
    };
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
    this.store.updateMeeting(id, { transcript: splice(this.pieces, { speakers: this.speakers }) });
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
      this.ledger = [];
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

    const transcript = splice(this.pieces, { speakers: this.speakers });
    this.pieces = [];
    /* Rejestr sprawdzamy WZGLĘDEM długości nagrania — patrz `truncated`
       w tally. Bez tej liczby „całość" znaczyłoby tylko tyle, że nie
       zgubiono nic z tego, co przyszło. */
    const coverage = Meetings.tally(this.ledger, seconds);
    this.ledger = [];

    /* ══ KIEDY WOLNO SKASOWAĆ NAGRANIE ══

       Nagranie ginie po przepisaniu — tak mówi ustawienie i tak samo dzieje
       się przy dyktowaniu. ALE TYLKO WTEDY, GDY JEST CZYM JE ZASTĄPIĆ.

       Tu był najdroższy błąd w tym pliku. Warunkiem było „transcript.length
       === 0", czyli: WYSTARCZYŁA JEDNA LINIJKA, żeby uznać godzinę rozmowy
       za przepisaną i skasować dźwięk. Godzinne zajęcia zapisały się dwiema
       linijkami z ostatnich stu sekund — i te dwie linijki wystarczyły,
       żeby pięćdziesiąt sześć minut nagrania zniknęło bezpowrotnie.
       Transkrypcję da się powtórzyć, dźwięku nie da się nagrać drugi raz.

       Dziś decyduje POKRYCIE, a nie długość: nagranie zostaje, dopóki
       istnieje choć jeden odcinek, w którym coś mówiono, a nie wiadomo co. */
    const keepAudio = settings.meetings?.keepAudio === true || !coverage.complete;
    let tracks = null;
    if (keepAudio) {
      /* ══ CO ŚCISKAMY, A CZEGO NIE ══

         Nagranie zachowane NA ŻYCZENIE ściskamy: godzina surowego WAV-a to
         sto piętnaście megabajtów na tor, ta sama godzina w AAC —
         czternaście, a mowa przy szesnastu kilohercach nie ma czego na tym
         stracić. Dopiero to sprawia, że zachowywanie nagrań przestaje być
         kosztowne (patrz main/audio.js).

         Nagranie zachowane DLATEGO, ŻE PRZEPISYWANIE ZAWIODŁO, zostaje
         surowe. Trzymamy je po to, żeby przepisać je jeszcze raz — i ten
         jeden raz zasługuje na materiał bez strat. Ściśniemy je, kiedy
         przepisywanie się uda. */
      const forKeeps = settings.meetings?.keepAudio === true;
      tracks = forKeeps
        ? { mic: await shrink(result.files.mic), system: await shrink(result.files.system) }
        : result.files;
    } else {
      for (const file of Object.values(result.files)) fs.rmSync(file, { force: true });
    }

    const meeting = this.store.updateMeeting(id, {
      endedAt: new Date().toISOString(),
      seconds,
      state: "done",
      tracks,
      transcript,
      coverage,
      /* Zdanie dla człowieka, nie liczba dla programu. Stoi we wpisie, bo
         to jest pierwsza rzecz, którą trzeba wiedzieć o zapisie rozmowy —
         przed jego treścią. */
      /* Dwa różne zdania, bo to są dwie różne awarie i różnią się tym, co
         z nimi zrobić. Zapis URWANY znaczy, że do przepisywania nie doszła
         część nagrania — wtedy liczy się, ILE godziny w ogóle widziano.
         Zapis NIEPEŁNY znaczy, że odcinki doszły, ale część nie wróciła
         tekstem — wtedy liczą się minuty mowy. */
      transcriptError: coverage.complete
        ? null
        : coverage.truncated
          ? `Do zapisu doszło ${Math.round(coverage.reachedSeconds / 60)} z ${Math.round(coverage.recordedSeconds / 60)} minut nagrania — reszta nie przeszła przez przepisywanie w biegu. Nagranie zostało zachowane; „Przepisz jeszcze raz" odtworzy je z pliku.`
          : `Zapis obejmuje ${Math.round(coverage.writtenSeconds / 60)} z ${Math.round(coverage.spokenSeconds / 60)} minut rozmowy. Nagranie zostało zachowane, żeby dało się przepisać resztę.`,
    });
    this.onChange();
    return { discarded: false, meeting, coverage };
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

  /**
   * Przepisanie NAGRANIA Z DYSKU, jeszcze raz i od zera.
   *
   * Bez tego nagranie, przy którym przepisywanie odpadło — bo nie było
   * klucza API albo sieci — zostaje martwym plikiem: godzina dźwięku,
   * której nic już nie tknie. A jest to jedyny krok w całym module, który
   * DA SIĘ powtórzyć: pliki leżą, model można zmienić, wytyczne poprawić.
   *
   * Czytamy strumieniem, porcjami. Godzina rozmowy to sto piętnaście
   * megabajtów na tor i wczytanie tego w całości byłoby dwustu trzydziestoma
   * megabajtami w pamięci po to, żeby przepuścić je przez krajalnicę,
   * która i tak bierze po kawałku.
   */
  async retranscribe(id) {
    const meeting = this.store.getMeetings().find((item) => item.id === id);
    if (!meeting) throw new Error("Nie ma takiego spotkania.");
    const files = meeting.tracks;
    if (!files?.mic || !fs.existsSync(files.mic)) {
      throw new Error(
        "Nagranie zostało skasowane po pierwszej transkrypcji — nie ma już z czego przepisywać.",
      );
    }

    this.store.updateMeeting(id, { transcribing: true, transcriptError: null });
    this.onChange();

    const pieces = [];
    const tails = { mic: "", system: "" };
    const glossary = meeting.people ?? [];
    const settings = this.store.getSettings();
    /* Przebieg z pliku prowadzi własny rejestr — z tego samego powodu,
       z którego prowadzi go przepisywanie w biegu: żeby na końcu dało się
       powiedzieć, czy to już jest całość. */
    const ledger = [];
    const note = (piece, state, detail = null) =>
      ledger.push({
        lane: piece.lane,
        index: piece.index,
        from: piece.from,
        to: piece.to,
        seconds: Math.max(0, piece.to - piece.from),
        voiced: piece.voiced ?? 0,
        state,
        detail,
      });

    try {
      for (const [lane, kept] of Object.entries(files)) {
        if (!kept || !fs.existsSync(kept)) continue;
        /* Krajalnica tnie surowe próbki i nie umie czytać skompresowanego
           strumienia. Rozpakowujemy więc na czas przepisywania — i tylko
           na ten czas. */
        const opened = await expand(kept);
        const file = opened.file;
        const cut = cutter({ lane, ...this.slice });
        const chew = async (segments) => {
          for (const piece of segments) {
            if (piece.silent) {
              note({ ...piece, lane }, "silent");
              continue;
            }
            const wav = Buffer.concat([wavHeader(piece.pcm.length), piece.pcm]);
            /* Z powtórkami, tak samo jak w biegu. Ten przebieg jest ostatnią
               drogą do tekstu — po nim nagranie wolno skasować — więc jest
               ostatnim miejscem, w którym wolno odpuścić odcinek po jednej
               nieudanej próbie. */
            let said = "";
            try {
              said = await this.#say(
                wav,
                { lane, from: piece.from, to: piece.to, context: tails[lane], glossary },
                piece.voiced,
              );
            } catch (problem) {
              /* Jeden stracony odcinek NIE PRZERYWA przebiegu. Wcześniej
                 wyjątek leciał w górę i zabierał ze sobą całą resztę
                 godziny — z powodu dwóch minut, które się nie udały. */
              note({ ...piece, lane }, "failed", problem.message);
              continue;
            }
            if (!said) {
              note({ ...piece, lane }, "empty");
              continue;
            }
            note({ ...piece, lane }, "done");
            tails[lane] = said.slice(-320);
            pieces.push({ lane, from: piece.from, to: piece.to, text: said });
            /* Zapisujemy po każdym odcinku. Przepisanie godziny trwa
               kilka minut i przez ten czas ma być WIDAĆ, że coś rośnie —
               a przerwane w połowie ma zostawić tę połowę. */
            this.store.updateMeeting(id, {
              transcript: splice(pieces, { speakers: meeting.speakers }),
            });
            this.onTranscript();
          }
        };

        // 4 MB na porcję: dwie minuty dźwięku, czyli mniej więcej jeden
        // odcinek — krajalnica nie czeka dłużej, niż musi.
        try {
          await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(file, { start: 44, highWaterMark: 4 << 20 });
            let queue = Promise.resolve();
            stream.on("data", (chunk) => {
              stream.pause();
              queue = queue
                .then(() => chew(cut.push(chunk)))
                .then(() => stream.resume())
                .catch(reject);
            });
            stream.on("end", () => queue.then(() => chew(cut.flush())).then(resolve, reject));
            stream.on("error", reject);
          });
        } finally {
          if (opened.temporary) fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
      }

      const transcript = splice(pieces, { speakers: meeting.speakers });
      /* Ta sama miara co w stop(): rejestr ma dosięgnąć końca nagrania,
         a nie tylko nie mieć w sobie strat. Przebieg z pliku jest ostatnią
         drogą do tekstu — po nim wolno skasować dźwięk — więc to właśnie
         tutaj pomyłka kosztuje najwięcej. */
      const coverage = Meetings.tally(ledger, meeting.seconds ?? 0);
      /* Teraz, gdy tekst jest, nagranie przestaje być jedynym egzemplarzem
         rozmowy — i dopiero teraz wolno je ścisnąć albo skasować, zgodnie
         z ustawieniem. Wcześniej byłoby to niszczeniem czegoś, czego nie
         było czym zastąpić.

         Warunkiem jest POKRYCIE, a nie „transcript.length" — z tego samego
         powodu co w stop(): jedna linijka z godziny rozmowy nie jest
         przepisaną rozmową i nie wolno jej kupić za nagranie. */
      let tracks = meeting.tracks;
      if (coverage.complete) {
        if (settings.meetings?.keepAudio === true) {
          tracks = { mic: await shrink(files.mic), system: await shrink(files.system) };
        } else {
          for (const file of Object.values(files)) fs.rmSync(file, { force: true });
          tracks = null;
        }
      }
      this.store.updateMeeting(id, {
        transcript,
        tracks,
        coverage,
        transcribing: false,
        transcriptError: coverage.complete
          ? null
          : `Zapis obejmuje ${Math.round(coverage.writtenSeconds / 60)} z ${Math.round(coverage.spokenSeconds / 60)} minut rozmowy. Nagranie zostało zachowane.`,
      });
      this.onChange();
      return transcript;
    } catch (problem) {
      this.store.updateMeeting(id, { transcribing: false, transcriptError: problem.message });
      this.onChange();
      throw problem;
    }
  }

  /**
   * Sprzątanie po nagraniu, które nie miało jak się skończyć.
   *
   * Aplikacja ubita w połowie rozmowy zostawia wpis w stanie „recording"
   * i dwa pliki bez nagłówka. Wpis taki wisi potem w spisie na zawsze,
   * bo nic już go nie zamknie — a leży pod nim godzina dźwięku, z której
   * da się zrobić wszystko. Domykamy go więc przy starcie: czas liczymy
   * z rozmiaru pliku, nagłówek WAV dopisujemy, stan ustawiamy na „failed",
   * bo przerwane to jest.
   */
  recover() {
    const stuck = this.store
      .getMeetings()
      .filter((item) => item.state === "recording" && item.id !== this.id);
    for (const meeting of stuck) {
      const dir = this.store.meetingDir(meeting.id);
      // Po ubiciu aplikacji pliki są zawsze surowe: kompresja dzieje się
      // dopiero po udanym zakończeniu nagrania.
      const files = {
        mic: path.join(dir, "tor-a-mikrofon.wav"),
        system: path.join(dir, "tor-b-system.wav"),
      };
      if (!fs.existsSync(files.mic)) {
        this.store.deleteMeeting(meeting.id);
        continue;
      }
      const bytes = Math.max(0, fs.statSync(files.mic).size - 44);
      // Nagłówek pisze się na końcu nagrania (patrz main/tap.js) — po ubiciu
      // aplikacji nie zdążył powstać i bez niego pliku nic nie otworzy.
      const handle = fs.openSync(files.mic, "r+");
      fs.writeSync(handle, wavHeader(bytes), 0, 44, 0);
      fs.closeSync(handle);
      if (fs.existsSync(files.system)) {
        const other = Math.max(0, fs.statSync(files.system).size - 44);
        const second = fs.openSync(files.system, "r+");
        fs.writeSync(second, wavHeader(other), 0, 44, 0);
        fs.closeSync(second);
      }
      this.store.updateMeeting(meeting.id, {
        state: "failed",
        error: "Aplikacja zamknęła się w trakcie nagrywania.",
        seconds: bytes / 2 / 16000,
        endedAt: new Date().toISOString(),
        tracks: files,
      });
    }
    if (stuck.length) this.onChange();
    return stuck.length;
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
