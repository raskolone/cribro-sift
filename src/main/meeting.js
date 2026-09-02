"use strict";

const fs = require("fs");
const path = require("path");
const { record, wavHeader } = require("./tap");
const { cutter, FLOOR } = require("./segments");
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
      patience,
      drain,
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
    /* Ile czekamy na JEDNO podejście do dostawcy i ile na wszystkie odcinki
       naraz przy zamykaniu. Podawane z zewnątrz wyłącznie w teście —
       powody obu liczb stoją przy PATIENCE i DRAIN niżej. */
    this.patience = patience ?? Meetings.PATIENCE;
    this.drain = drain ?? Meetings.DRAIN;

    /* ══ NAGRANIE JEST PUDEŁKIEM, A NIE POLAMI OBIEKTU ══

       Wszystko, co należy do jednego nagrania — krajalnice, odcinki
       w drodze, rejestr, ogony, licznik ciszy — leży w JEDNYM obiekcie,
       który powstaje w `start` i ginie po `stop`. Nie w polach `this`.

       Powód jest konkretny i kosztował godzinę zajęć. `stop` czeka na
       odcinki, które są jeszcze u dostawcy — a to potrafi trwać minutami,
       gdy sieć stanie. Dopóki stan nagrania leżał w polach obiektu,
       w ten czas wchodziło NASTĘPNE nagranie: `start` podstawiał świeże
       krajalnice i pusty rejestr, po czym kończący się `stop` zerował
       je z powrotem — już nie swoje. Sprawdzone wprost, na tym module:
       druga rozmowa kończyła się WTEDY ZEREM ODCINKÓW przy pełnym pliku
       WAV, bo od chwili tamtego zerowania jej dźwięk nie miał już przez
       co przejść. Wpis wyglądał dokładnie tak, jak wygląda po godzinie,
       z której zostało ostatnie zdanie.

       Z pudełkiem takie spotkanie jest niemożliwe: `stop` trzyma swoje,
       `start` zakłada nowe, a jedno o drugim nie wie. */
    this.live = null;
  }

  /**
   * Nowe pudełko na jedno nagranie.
   *
   * @param {string} id   identyfikator wpisu w spisie
   * @param {string} dir  katalog tego spotkania — po nim, a NIE po
   *   `this.id`, trafia na dysk rejestr odcinków. Odcinek kończony
   *   w trakcie zamykania nagrania nie miał już czego pytać o `this.id`
   *   (zerowany na wejściu do `stop`) i przez to nie zostawiał śladu
   *   dokładnie tam, gdzie ślad jest najbardziej potrzebny.
   */
  static session(id, dir) {
    return {
      id,
      dir,
      tap: null,
      startedAt: Date.now(),
      /* Krajalnice (po jednej na tor), przepisane odcinki i obietnice tych,
         które są jeszcze w drodze. Wszystko trzy żyje jedno nagranie. */
      cutters: null,
      pieces: [],
      jobs: [],
      misses: 0,
      /* Ogon ostatniego odcinka każdego toru i słowniczek nazw własnych —
         jedno i drugie idzie do modelu razem z następnym odcinkiem. */
      tails: { mic: "", system: "" },
      glossary: [],
      speakers: null,
      /* Ile ciszy z rzędu w każdym torze — liczone odcinkami, nie sekundami. */
      quiet: { mic: 0, system: 0 },
      told: { mic: false, system: false },
      toldIdle: false,
      /* Kiedy ostatnio było cokolwiek słychać — w którymkolwiek torze.
         Po tym poznaje się, że rozmowa się skończyła, a nie że zniknęło
         okno przeglądarki (patrz `quietSeconds` niżej i main/main.js). */
      heardAt: Date.now(),
      /* Zamknięte znaczy: wpis został już policzony i podsumowany.
         Odcinek, który wróci po tym czasie, nie ma prawa dopisywać się
         do wpisu — zostawia po sobie linijkę w rejestrze na dysku i tyle. */
      closed: false,
      /* ══ REJESTR ODCINKÓW ══

         Co się stało z każdym kawałkiem rozmowy: przepisany, cichy, pusty,
         stracony. Bez tego spisu nie da się odpowiedzieć na jedyne pytanie,
         które przy transkrypcji naprawdę się zadaje — CZY TO JEST CAŁOŚĆ.
         Godzinne zajęcia zapisały się dwiema linijkami i nic w aplikacji nie
         wiedziało, że czegoś brakuje: nagranie skasowało się jak po udanej
         transkrypcji, bo „transkrypt niepusty" uchodziło za „transkrypt
         gotowy". Spis jest po to, żeby te dwie rzeczy przestały być tym
         samym. */
      ledger: [],
    };
  }

  /**
   * Meldunek na zewnątrz, który NIE MA PRAWA wywrócić nagrania.
   *
   * Każdy z tych uchwytów prowadzi do okien: rozgłoszenie, przebudowa
   * menu, znak w pasku. Okno bywa zamknięte w chwili, w której coś do
   * niego mówimy, i wtedy Electron rzuca wyjątkiem — a te uchwyty wołane
   * są ze ŚRODKA obiegu dźwięku, z pętli po odcinkach w `#chew`.
   * Wyjątek stamtąd zabierał ze sobą wszystkie pozostałe odcinki tej
   * porcji (sprawdzone wprost: godzina rozmowy schodziła wtedy do czterech
   * zapisanych odcinków, pierwszy ze znacznikiem 60. minuty) i leciał
   * dalej, do obsługi strumienia, gdzie nie łapie go już nic.
   */
  #tell(hook, ...args) {
    try {
      hook.apply(this, args);
    } catch {
      /* Meldunek przepadł. Nagranie leci dalej — ono jest ważniejsze. */
    }
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
   * Ile czekamy na JEDNO podejście do dostawcy, w milisekundach.
   *
   * ══ ŻĄDANIE BEZ KOŃCA JEST GORSZE NIŻ ŻĄDANIE NIEUDANE ══
   *
   * `fetch` nie ma własnego limitu czasu. Połączenie, które nawiązało się
   * i zamilkło — komputer uśpiony w połowie wysyłki, sieć przełączona
   * z Wi-Fi na komórkową, serwer trzymający otwarte gniazdo — wisi wtedy
   * DOPÓKI ktoś go nie zamknie, czyli w praktyce bez końca.
   *
   * Kosztuje to więcej, niż wygląda: na taki odcinek czeka `stop`, a na
   * `stop` czeka wszystko po nim — wpis w spisie, notatka, podsumowanie
   * i zamknięcie aplikacji. Sprawdzone wprost na tym module: przy
   * dostawcy, który nie odpowiada, `stop` NIE WRACAŁ WCALE.
   *
   * Dwie minuty, bo tyle trwa odcinek: żądanie dłuższe niż dźwięk, który
   * wiezie, i tak nie ma jak nadążyć za rozmową.
   */
  static get PATIENCE() {
    return 120_000;
  }

  /**
   * Ile czekamy przy zamykaniu na WSZYSTKIE odcinki w drodze.
   *
   * Limit na pojedyncze podejście nie wystarcza: podejścia są trzy,
   * a odcinków w drodze bywa kilka. Zamknięcie rozmowy nie ma prawa
   * trwać kwadransa tylko dlatego, że sieć akurat stanęła.
   *
   * Odcinek, który nie zdążył, NIE GINIE PO CICHU — zostaje w rejestrze
   * jako niedokończony, przez co pokrycie nie jest pełne, przez co
   * nagranie zostaje na dysku, przez co przebieg z pliku ma z czego
   * dopisać resztę. Cała ta droga jest już zbudowana; tutaj wystarczy
   * z niej skorzystać, zamiast czekać.
   */
  static get DRAIN() {
    return 240_000;
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
    return !!this.live;
  }

  /** Metryka bieżącego spotkania — do paska, tacy i okna. */
  get state() {
    return {
      recording: this.recording,
      id: this.live?.id ?? null,
      seconds: this.live ? (Date.now() - this.live.startedAt) / 1000 : 0,
      /* Od ilu sekund nie słychać NIKOGO — ani mnie, ani drugiej strony.

         Jedyna rzecz w tym module, która mówi coś o tym, czy rozmowa
         jeszcze trwa. Kto decyduje o zakończeniu nagrania po zniknięciu
         okna (main/main.js), pyta o to zanim utnie: tytuł okna zmienia
         się także wtedy, gdy ktoś w przeglądarce przeskoczył na inną
         kartę, a rozmowa leci dalej i słychać ją tak samo. */
      quietSeconds: this.quietSeconds,
    };
  }

  /** Ile sekund ciszy w OBU torach naraz. Bez nagrania — zero. */
  get quietSeconds() {
    return this.live ? (Date.now() - this.live.heardAt) / 1000 : 0;
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
    const dir = this.store.meetingDir(meeting.id);
    const session = Meetings.session(meeting.id, dir);
    session.speakers = about?.speakers ?? null;
    session.glossary = about?.people ?? [];
    session.cutters = {
      mic: cutter({ lane: "mic", ...this.slice }),
      system: cutter({ lane: "system", ...this.slice }),
    };

    try {
      session.tap = record({
        dir,
        exclude: settings.meetings?.exclude ?? [],
        onLevel: (level) => this.#tell(this.onLevel, level),
        onPcm: (lane, pcm) => this.#chew(session, lane, pcm),
        onError: (message) => this.#fail(session, message),
      });
    } catch (problem) {
      // Brak programu pomocniczego albo odmowa uruchomienia. Wpis nie ma po
      // czym zostać — kasujemy go razem z pustym katalogiem.
      this.store.deleteMeeting(meeting.id);
      this.#tell(this.onChange);
      throw problem;
    }

    this.live = session;
    this.#tell(this.onChange);
    return this.state;
  }

  /* ── Przepisywanie w biegu ──────────────────────────────────── */

  /**
   * Próbki z toru → krajalnica → odcinki do przepisania.
   *
   * ══ JEDEN ODCINEK NIE MA PRAWA ZABRAĆ POZOSTAŁYCH ══
   *
   * Krajalnica oddaje odcinki PORCJAMI — zwykle jeden, ale po zaległości
   * (łata ciszy w torze systemu, komputer wybudzony ze snu) potrafi oddać
   * naraz kilkanaście. Pętla bez zabezpieczenia gubiła wtedy całą resztę
   * porcji przy pierwszym wyjątku, a krajalnica miała już swój zegar
   * przesunięty za nie wszystkie — odcinki znikały BEZ ŚLADU, bo do
   * rejestru nie zdążyły nawet wejść. Tak wygląda w danych zapis, w którym
   * z godziny zostało ostatnie zdanie: ostatni odcinek z właściwym czasem
   * i nic przed nim.
   */
  #chew(session, lane, pcm) {
    const cut = session.cutters?.[lane];
    if (!cut) return;
    if (this.#alive(pcm)) session.heardAt = Date.now();
    let batch;
    try {
      batch = cut.push(pcm);
    } catch (problem) {
      /* Krajalnica padła na tej porcji — najczęściej brakiem pamięci przy
         sklejaniu. Dźwięk leci dalej na dysk, więc jest z czego przepisać
         rozmowę po jej końcu. */
      this.#tell(this.onError, `Krojenie toru się wywróciło: ${problem.message}`);
      return;
    }
    for (const piece of batch) {
      try {
        this.#write(session, piece);
      } catch (problem) {
        /* Nie powinno się zdarzyć — ale gdyby, ten jeden odcinek zostaje
           w rejestrze jako stracony, a następne idą swoją drogą. */
        this.#note(session, piece, "failed", problem.message);
      }
    }
  }

  /**
   * Czy w tej porcji COKOLWIEK słychać.
   *
   * Co trzydziesta druga próbka, bo to pytanie zadaje się kilkadziesiąt
   * razy na sekundę i ma kosztować tyle co nic. Do rozstrzygnięcia „czy
   * ktoś mówi" taka zgrubność wystarcza — dokładny pomiar robi się i tak
   * osobno, przy krojeniu (patrz survey w main/segments.js).
   */
  #alive(pcm) {
    if (!pcm?.length) return false;
    const step = 32 * 2;
    let sum = 0;
    let count = 0;
    for (let at = 0; at + 1 < pcm.length; at += step) {
      const value = pcm.readInt16LE(at) / 32768;
      sum += value * value;
      count += 1;
    }
    if (!count) return false;
    const rms = Math.sqrt(sum / count);
    return rms > 0 && 20 * Math.log10(rms) >= FLOOR;
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
   *
   * ══ ŚLAD POWSTAJE PRZY POCIĘCIU, A NIE PO POWROCIE OD DOSTAWCY ══
   *
   * Wcześniej wpis do rejestru robił się DOPIERO wtedy, gdy odcinek wrócił
   * z tekstem albo z błędem. Odcinek, który nie wrócił wcale — bo żądanie
   * wisiało, bo proces zamknięto, bo cokolwiek — nie zostawiał po sobie ani
   * jednej linijki. W rejestrze wyglądało to jak odcinek, którego nigdy nie
   * było, a pokrycie liczone z takiego rejestru wychodziło PEŁNE: „nic nie
   * zginęło", bo nie było czemu zginąć. Dokładnie tak wygląda wpis po
   * godzinie zajęć, z której został jeden akapit.
   *
   * Dziś linijka powstaje w chwili, w której odcinek wychodzi z krajalnicy,
   * i ma wtedy stan „w drodze". Dopiero odpowiedź ją domyka. Rejestr mówi
   * więc o tym, ILE ROZMOWY W OGÓLE POCIĘTO, a nie tylko o tym, co wróciło.
   */
  #write(session, piece) {
    /* Cisza nie jedzie nigdzie. W godzinnym spotkaniu jest jej więcej niż
       mowy, a płaci się za nią tyle samo. Liczymy ją jednak — bo tor, który
       milczy CAŁY CZAS, to nie cisza w rozmowie, tylko zepsute nagranie. */
    if (piece.silent) {
      this.#note(session, piece, "silent");
      session.quiet[piece.lane] = (session.quiet[piece.lane] ?? 0) + 1;
      if (session.quiet[piece.lane] >= Meetings.QUIET_LIMIT && !session.told[piece.lane]) {
        session.told[piece.lane] = true;
        this.#tell(this.onSilence, piece.lane);
      }
      /* Cisza w OBU torach naraz to nie usterka, tylko pusty pokój.
         Mówimy o tym raz — kto tę wiadomość dostaje, ten decyduje, czy
         kończyć nagranie. */
      if (
        !session.toldIdle &&
        session.quiet.mic >= Meetings.IDLE_LIMIT &&
        session.quiet.system >= Meetings.IDLE_LIMIT
      ) {
        session.toldIdle = true;
        this.#tell(this.onIdle);
      }
      return;
    }
    session.quiet[piece.lane] = 0;
    session.toldIdle = false; // ktoś się odezwał — pokój znowu nie jest pusty
    if (session.misses >= Meetings.GIVE_UP) {
      /* Bezpiecznik przestał kasować rozmowę. Odcinek zostaje w rejestrze
         jako stracony, nagranie z tego powodu NIE ZGINIE (patrz stop), a po
         zakończeniu rusza przebieg naprawczy z pliku — więc „poddajemy się"
         znaczy dziś „nie dobijamy dostawcy w trakcie", a nie „ta część
         rozmowy przepada". */
      this.#note(session, piece, "skipped");
      return;
    }

    const row = this.#note(session, piece, "sent");
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
          context: session.tails?.[piece.lane] ?? "",
          glossary: session.glossary ?? [],
        }, piece.voiced);

        session.misses = 0;
        if (!said) {
          // Nic nie padło — i tyle. Odcinek jest opisany, a nie zgubiony.
          this.#settle(session, row, "empty");
          return;
        }
        this.#settle(session, row, "done");
        /* Wpis jest już policzony i podsumowany — odcinek, który wrócił po
           tym czasie, zostawia ślad w rejestrze na dysku i nic więcej.
           Dopisanie go teraz biłoby się z przebiegiem naprawczym z pliku,
           który w tej chwili może właśnie przepisywać tę samą rozmowę. */
        if (session.closed) return;
        session.pieces.push({ lane: piece.lane, from: piece.from, to: piece.to, text: said });
        // Ogon dla następnego odcinka tego toru — tyle, ile wystarczy na
        // kontekst, a nie tyle, żeby model zaczął go przepisywać.
        session.tails[piece.lane] = said.slice(-320);
        this.#stitch(session);
      } catch (problem) {
        session.misses += 1;
        this.#settle(session, row, "failed", problem.message);
        // Mówimy o pierwszej pomyłce i o tej, po której się poddajemy.
        // O każdej z osobna znaczyłoby komunikat co dwie minuty przez
        // godzinę — przy braku klucza API zawsze ten sam.
        if (session.misses === 1) {
          this.#tell(this.onError, `Nie udało się przepisać fragmentu: ${problem.message}`);
        } else if (session.misses === Meetings.GIVE_UP) {
          this.#tell(
            this.onError,
            "Przepisywanie w biegu wyłączone do końca tego spotkania — nagranie leci dalej " +
              "i zostanie przepisane z pliku po zakończeniu.",
          );
        }
      }
    })();
    session.jobs.push(job);
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
        /* ══ KAŻDE PODEJŚCIE MA KONIEC ══

           Nie tylko to udane i nie tylko to, które oddało błąd. Żądanie,
           które zawisło, jest trzecim rodzajem niepowodzenia i było dotąd
           jedynym, który potrafił zatrzymać całą aplikację: czekał na nie
           `stop`, a na `stop` czekało zamknięcie wpisu i zamknięcie okna.

           Zegar jest TUTAJ, a nie tylko u dostawcy, bo tylko tutaj wiadomo,
           że po drugiej stronie tego czekania stoi człowiek, który właśnie
           nacisnął „Koniec". Limit u dostawcy (main/stt.js) przerywa samo
           połączenie i to jest robota dla niego; ten tu jest ostatnią
           deską i łapie także dostawcę podstawionego w teście. */
        const { text } = await this.#within(
          this.transcribe(wav, this.store.getSettings(), about),
        );
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

  /**
   * Obietnica z terminem. Po nim — błąd, a nie czekanie bez końca.
   *
   * Samo żądanie leci dalej i nikt go nie zatrzyma (przerwać połączenie
   * umie tylko ten, kto je nawiązał — patrz main/stt.js). Tutaj chodzi
   * o coś innego: żeby CZEKANIE miało koniec. Odcinek, na który przestano
   * czekać, jest w rejestrze stratą i wraca przebiegiem z pliku.
   */
  #within(promise, ms = this.patience) {
    let timer = null;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`dostawca nie odpowiedział w ${Math.round(ms / 1000)} s`)),
          ms,
        );
      }),
    ]);
  }

  /** Wpis do rejestru odcinków. Jedno miejsce, żeby żaden nie wyszedł bokiem. */
  #note(session, piece, state, detail = null) {
    const row = {
      lane: piece.lane,
      index: piece.index,
      from: piece.from,
      to: piece.to,
      seconds: Math.max(0, (piece.to ?? 0) - (piece.from ?? 0)),
      voiced: piece.voiced ?? 0,
      state,
      detail,
    };
    session.ledger.push(row);
    this.#jot(session, row);
    return row;
  }

  /** Odcinek wrócił — ta sama linijka dostaje swój koniec. */
  #settle(session, row, state, detail = null) {
    if (!row) return;
    row.state = state;
    row.detail = detail;
    this.#jot(session, row);
  }

  /**
   * Linijka do „odcinki.jsonl" obok nagrania.
   *
   * ══ ŚLAD NA DYSKU, NIE TYLKO W PAMIĘCI ══
   *
   * Rejestr żyje w pamięci i ginie razem z nią — a razem z nim ginie
   * jedyna odpowiedź na pytanie „co się stało z tą godziną".
   * 2 września 2026 godzinne spotkanie zamknęło się rejestrem o jednym
   * odcinku i nie dało się po fakcie rozstrzygnąć, czy odcinki nie
   * powstały, czy powstały i przepadły: nagranie skasowano, logów nie
   * było, a pamięć procesu dawno zniknęła.
   *
   * Dopisujemy więc każdy odcinek linijką do pliku obok nagrania — raz przy
   * wyjściu z krajalnicy, drugi raz po powrocie od dostawcy. Jedna linijka
   * to około stu bajtów, godzina rozmowy to sto trzydzieści linijek — koszt
   * żaden, a następnym razem będzie z czego czytać.
   *
   * KATALOG BIERZEMY Z PUDEŁKA, a nie z `this.id`. Wcześniej brał się
   * z pola, które `stop` zerował NA WEJŚCIU — więc odcinki kończone przy
   * zamykaniu nagrania, czyli te ostatnie i te, o które najczęściej chodzi,
   * nie zostawiały śladu w ogóle.
   *
   * Zapis nie ma prawa przewrócić nagrywania, więc idzie w try/catch
   * i po cichu: brak śladu jest gorszy od braku nagrania tylko dla mnie,
   * nie dla człowieka.
   */
  #jot(session, row) {
    try {
      fs.appendFileSync(
        path.join(session.dir, "odcinki.jsonl"),
        JSON.stringify({
          t: new Date().toISOString(),
          lane: row.lane,
          i: row.index,
          from: Math.round(row.from ?? 0),
          to: Math.round(row.to ?? 0),
          voiced: Math.round(row.voiced ?? 0),
          state: row.state,
          detail: row.detail ? String(row.detail).slice(0, 120) : undefined,
        }) + "\n",
      );
    } catch {
      /* Dysk pełny albo katalog zniknął — nagranie leci dalej. */
    }
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

    /* „sent" znaczy: odcinek pojechał do dostawcy i nigdy nie wrócił.
       Nie wiadomo o nim nic — więc jest stratą tak samo jak błąd, a nie
       odcinkiem, o którym można milczeć. Ten jeden stan istnieje właśnie
       po to, żeby zapis urwany na czekaniu przestał wyglądać jak pełny. */
    const lost = (item) =>
      item.state === "failed" || item.state === "skipped" || item.state === "sent";
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
      /* Odcinki, na które przestano czekać. Osobno od `failed`, bo to inna
         historia i inna rada dla człowieka: tamte oddały błąd, te nie
         oddały nic. */
      pending: count("sent"),
      spokenSeconds: Math.round(spoken),
      writtenSeconds: Math.round(written),
      /* Warunki, wszystkie o jedno i to samo: czy wolno skasować nagranie.

           — pusty rejestr znaczy, że dźwięk NIE PRZESZEDŁ przez ten obieg
             w ogóle; nie wiemy o nim nic, więc nie wolno go wyrzucić;
           — mowa bez ani jednego zapisanego słowa to awaria, choćby
             wszystkie odcinki wróciły „grzecznie" puste;
           — no i zwykłe straty: odcinek stracony, niedokończony albo pusty
             mimo mowy. */
      complete:
        ledger.length > 0 &&
        !(spoken > 0 && written === 0) &&
        /* Rejestr, który nie dosięga końca nagrania, NIE JEST całością —
           choćby wszystko, co w nim stoi, było przepisane bez jednej straty.
           Dopisane po utracie godziny zajęć. */
        !truncated &&
        /* ══ DŁUGIE NAGRANIE, W KTÓRYM NIE PADŁO ANI JEDNO SŁOWO ══

           Godzina samej ciszy nie jest „rozmową bez treści" — jest
           nagraniem, które się nie udało: program pomocniczy padł, mikrofon
           trafił na wyciszone urządzenie, dźwięk poszedł do słuchawek,
           których nikt nie słuchał. Wszystkie te przypadki wyglądają
           w rejestrze identycznie: same odcinki „cichy" i zero mowy.

           Kasowanie takiego nagrania jest kasowaniem JEDYNEGO DOWODU na to,
           co się stało. Kwadrans jest granicą, bo krótsza cisza bywa
           prawdziwa — dyktafon położony na stole, spotkanie, które się nie
           odbyło — i takiego nagrania nie ma powodu trzymać. */
        !(recordedSeconds >= 900 && spoken === 0) &&
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
  #stitch(session) {
    if (!session?.id) return;
    this.store.updateMeeting(session.id, {
      transcript: splice(session.pieces, { speakers: session.speakers }),
    });
    this.#tell(this.onTranscript);
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
    if (!this.live) return { discarded: false, meeting: null };

    /* ══ OD TEJ LINIJKI NAGRANIE JEST NASZE, A NIE OBIEKTU ══

       Wszystko dalej dzieje się na `session`, nie na `this`. Zamykanie
       potrafi trwać minutami (czekamy na odcinki u dostawcy), a w ten czas
       wchodzi następne nagranie — i dopóki jedno i drugie mieszkało w tych
       samych polach, to drugie kończyło się rejestrem pustym, transkryptem
       pustym i pełnym plikiem WAV, o którym nikt już nie wiedział, że jest
       jedynym egzemplarzem rozmowy. */
    const session = this.live;
    this.live = null;
    const tap = session.tap;
    const id = session.id;

    const result = await tap.stop();
    const seconds = Math.max(result.mic, result.system);
    const settings = this.store.getSettings();
    const floor = settings.meetings?.minSeconds ?? 90;

    if (seconds < floor) {
      session.closed = true;
      this.store.deleteMeeting(id);
      this.#tell(this.onChange);
      return { discarded: true, meeting: null, seconds };
    }

    /* Resztki z obu torów. Ostatnie zdanie spotkania pada zwykle
       w ostatnich sekundach — a te siedzą jeszcze w krajalnicy. */
    for (const cut of Object.values(session.cutters ?? {})) {
      for (const piece of cut.flush()) this.#write(session, { ...piece, lane: piece.lane });
    }
    session.cutters = null;

    // Czekamy na to, co w drodze. Wpis zamknięty bez ostatnich odcinków
    // byłby zapisem rozmowy bez jej końca — ale czekamy Z TERMINEM, bo
    // wpis niezamknięty w ogóle jest jeszcze gorszy (patrz DRAIN).
    await this.#drain(session);
    session.closed = true;

    const transcript = splice(session.pieces, { speakers: session.speakers });
    /* Rejestr sprawdzamy WZGLĘDEM długości nagrania — patrz `truncated`
       w tally. Bez tej liczby „całość" znaczyłoby tylko tyle, że nie
       zgubiono nic z tego, co przyszło. */
    const coverage = Meetings.tally(session.ledger, seconds);

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
    this.#tell(this.onChange);
    return { discarded: false, meeting, coverage };
  }

  /**
   * Czekanie na odcinki w drodze — z terminem.
   *
   * ══ WPIS NIEZAMKNIĘTY JEST GORSZY NIŻ WPIS NIEPEŁNY ══
   *
   * Bez terminu jeden odcinek, który nie wraca, zatrzymywał WSZYSTKO po
   * sobie: wpis nie dostawał stanu „done", notatka nie powstawała,
   * podsumowanie nie ruszało, a przy zamykaniu aplikacji `shutdown`
   * czekał w nieskończoność na to samo. Sprawdzone wprost na tym module:
   * przy dostawcy, który nie odpowiada, `stop` nie wracał wcale.
   *
   * Po terminie odcinki niedokończone zostają w rejestrze jako straty —
   * przez co pokrycie nie jest pełne, przez co NAGRANIE ZOSTAJE na dysku,
   * przez co przebieg z pliku ma z czego dopisać resztę. Czekanie zamieniamy
   * więc na drogę, która i tak istnieje i jest lepsza od czekania.
   */
  async #drain(session) {
    const waiting = session.jobs;
    session.jobs = [];
    if (!waiting.length) return;

    let timer = null;
    const patience = new Promise((resolve) => {
      timer = setTimeout(() => resolve("termin"), this.drain);
    });
    const done = await Promise.race([Promise.allSettled(waiting).then(() => "wszystkie"), patience]);
    clearTimeout(timer);
    if (done === "wszystkie") return;

    /* Które nie zdążyły — po rejestrze, bo tylko on wie o każdym odcinku
       z osobna. Linijka „sent" bez domknięcia to dokładnie ten przypadek. */
    const late = session.ledger.filter((row) => row.state === "sent");
    for (const row of late) {
      this.#settle(session, row, "failed", `nie wróciło w ${Math.round(this.drain / 1000)} s`);
    }
    if (late.length) {
      this.#tell(
        this.onError,
        `${late.length} ${late.length === 1 ? "fragment nie wrócił" : "fragmentów nie wróciło"} ` +
          "z przepisywania na czas. Nagranie zostało zachowane i zostanie przepisane z pliku.",
      );
    }
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
  #fail(session, message) {
    /* Awaria dotyczy TEGO nagrania, a nie „bieżącego". Program pomocniczy
       potrafi zameldować o sobie już po tym, jak jego nagranie zamknięto
       — a wtedy wpis, który akurat trwa, nie ma z tym nic wspólnego. */
    if (this.live !== session) return;
    this.live = null;
    session.closed = true;
    this.store.updateMeeting(session.id, { state: "failed", error: message });
    this.#tell(this.onError, message);

    /* ══ WPIS MA WIEDZIEĆ, GDZIE LEŻY JEGO DŹWIĘK ══

       Nagranie przerwane w połowie zostawia na dysku dwa pliki WAV i to
       zwykle jest cała rozmowa bez ostatniej minuty. Bez `tracks` we wpisie
       nie prowadzi do nich NIC: „Przepisz jeszcze raz" odpowiada wtedy, że
       nagranie skasowano po transkrypcji, choć leży na dysku nietknięte.

       Dopisujemy je więc po zamknięciu plików — dopiero wtedy mają
       nagłówek WAV i dopiero wtedy da się je otworzyć (patrz finish
       w main/tap.js). */
    session.tap
      ?.stop()
      .then((result) => {
        const seconds = Math.max(result?.mic ?? 0, result?.system ?? 0);
        this.store.updateMeeting(session.id, {
          endedAt: new Date().toISOString(),
          seconds,
          tracks: result?.files ?? null,
        });
      })
      .catch(() => {
        /* Nawet domknięcie plików się nie udało — wpis zostaje ze swoim
           błędem, a to i tak więcej, niż było wcześniej. */
      })
      .finally(() => this.#tell(this.onChange));
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
    this.#tell(this.onChange);

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
            this.#tell(this.onTranscript);
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
      this.#tell(this.onChange);
      return transcript;
    } catch (problem) {
      this.store.updateMeeting(id, { transcribing: false, transcriptError: problem.message });
      this.#tell(this.onChange);
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
      .filter((item) => item.state === "recording" && item.id !== this.live?.id);
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
    if (stuck.length) this.#tell(this.onChange);
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
