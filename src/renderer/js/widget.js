"use strict";

/**
 * Widget — jedyne, co Cribro pokazuje poza swoimi oknami.
 *
 * Dwa stany, jedno okno: znaczek i menu po łuku. Rozmiar okna zmienia proces
 * główny (patrz placeWidget w main/main.js), a tutaj jest to, czego on nie
 * widzi: kursor, nacisk i przeciąganie.
 *
 * MENU PO ŁUKU to cztery przejścia — Poranek, nowa karteczka, Notatnik,
 * okno aplikacji — i dwa nieaktywne miejsca na przyszłość. Rozkłada je
 * najechanie kursorem, zwija zejście z niego, z chwilą zwłoki, żeby nie
 * uciekało spod ręki w drodze między kółkami.
 *
 * Notatki na wierzchu leżą wyłącznie na pulpicie, każda jako własna kartka
 * (patrz renderer/sticky.html) — znaczek samych notatek nie rysuje. Jego
 * gesty są trzy i tylko trzy:
 *
 *   POJEDYNCZE KLIKNIĘCIE   wciska znaczek albo go odklika — czysto
 *                           wizualny stan, bez żadnej akcji.
 *   PODWÓJNE KLIKNIĘCIE     chowa i pokazuje całą talię kartek naraz.
 *   PRZECIĄGNIĘCIE          przenosi znaczek (a razem z nim talię — patrz
 *                           reflowDeck w main/main.js).
 *
 * ŻELAZNA ZASADA: żaden z tych trzech gestów nie otwiera okna aplikacji.
 * Jedyna droga do niego to gniazdo „Główna aplikacja" w rozłożonym menu —
 * patrz runAction niżej i action === "app" w main/main.js.
 *
 * Dwie rzeczy dzieją się wyłącznie tutaj, bo tylko tutaj widać kursor:
 *
 *   1. PRZEPUSZCZANIE KLIKNIĘĆ. Okno rozwiniętego widgetu jest większe niż
 *      to, co widać — a leży nad cudzą pracą. Kliknięcia idą więc na wylot
 *      wszędzie poza znaczkiem i menu.
 *
 *   2. PRZECIĄGANIE. Okno jest bez ramki, więc systemowego przeciągania nie
 *      ma. Liczymy KOTWICĘ — miejsce dla środka znaczka na ekranie — i to ją
 *      wysyłamy; rachunek, gdzie wobec tego postawić róg okna, należy do
 *      procesu głównego, bo zależy od tego, w którą ćwiartkę wychodzi łuk.
 */

(function () {
  const api = window.cribro;
  const $ = (selector) => document.querySelector(selector);

  const stage = $("#stage");
  const badge = $("#badge");
  const slots = [...document.querySelectorAll(".slot")];

  const HOVER_PAD = 8;
  /* Chwila zwłoki przed zwinięciem menu. Bez niej uciekałoby spod kursora
     przy przejściu między kółkami i przy czytaniu dymków. */
  const COLLAPSE_DELAY = 900;

  let view = "badge"; // badge | tray
  let deck = false;
  let geom = { ax: 38, ay: 38, badge: 60 };
  let runtime = "idle";
  /* Spotkanie: czy nagranie trwa i czy na ekranie stoi rozmowa, o którą
     jeszcze nie zapytano. Oba stany przychodzą jedną wiadomością z procesu
     głównego, bo znaczek rysuje z nich jeden stan. */
  let meeting = { recording: false, spotted: null };

  /* ── Układ ──────────────────────────────────────────────────── */

  function applyGeometry(next) {
    if (!next) return;
    geom = next;
    stage.style.setProperty("--ax", `${next.ax}px`);
    stage.style.setProperty("--ay", `${next.ay}px`);
    stage.style.setProperty("--badge", `${next.badge}px`);
    if (next.tray) {
      stage.dataset.trayDir = next.tray.dir;
      stage.dataset.traySide = next.tray.side;
    }
    applyArc(next.arc);
  }

  /* Przesunięcie każdego kółka menu liczy proces główny (patrz arcSlots
     w main/main.js) — trygonometrii CSS nie zna, więc gotowe dx/dy idą tu
     wprost na kółka, po kolei, w tej samej kolejności, w której stoją
     w dokumencie (patrz #tray w widget.html). */
  function applyArc(arc) {
    if (!Array.isArray(arc)) return;
    slots.forEach((slot, i) => {
      const at = arc[i];
      if (!at) return;
      slot.style.setProperty("--dx", `${at.dx}px`);
      slot.style.setProperty("--dy", `${at.dy}px`);
    });
  }

  /* ══ ZNACZEK NIE PRZESKAKUJE PRZY ZMIANIE ROZMIARU OKNA ══

     Zmiana widoku to dwie rzeczy naraz: proces główny przestawia okno
     (rozmiar i róg), a renderer przesuwa znaczek wewnątrz okna o tyle samo
     w drugą stronę. Na ekranie znaczek ma przez to stać w miejscu.

     Tyle że te dwie rzeczy przychodzą osobno. Okno zmienia się natychmiast,
     a nowa kotwica dopiero odpowiedzią na IPC — i przez klatkę albo dwie
     znaczek jest narysowany tam, gdzie stał WZGLĘDEM STAREGO okna, czyli
     kilkadziesiąt pikseli obok. To był ten przeskok.

     Zdarzenie „resize" przychodzi w rendererze w tej samej klatce, w której
     okno naprawdę urosło, i jeszcze przed rysowaniem. Skoro znamy kotwicę
     w układzie EKRANU (sx, sy — liczy ją proces główny), to wystarczy odjąć
     od niej bieżące położenie okna i znaczek siada tam, gdzie ma stać,
     nie czekając na odpowiedź. */
  window.addEventListener("resize", () => {
    if (!Number.isFinite(geom.sx) || !Number.isFinite(geom.sy)) return;
    const inside = (value, span) => Math.min(Math.max(value, 0), span);
    stage.style.setProperty("--ax", `${inside(geom.sx - window.screenX, window.innerWidth)}px`);
    stage.style.setProperty("--ay", `${inside(geom.sy - window.screenY, window.innerHeight)}px`);
  });

  /* ── Przejścia między stanami ───────────────────────────────── */

  function setView(next) {
    view = next;
    stage.dataset.view = next;
  }

  /* Stan okna, o który prosimy proces główny. Widoków są dwa, rozmiarów
     okna też dwa: znaczek sam i znaczek z rozłożonym menu. */
  const layout = async (next) => applyGeometry(await api.widget.layout(next));

  /** Menu. Okno jest już na nie gotowe (patrz placeWidget w main/main.js),
      więc rozłożenie kółek jest samym atrybutem — bez pytania procesu
      głównego i bez ani jednej klatki, w której znaczek stoi obok siebie. */
  function toTray() {
    if (view !== "badge") return;
    setView("tray");
  }

  function toBadge() {
    if (view !== "tray") return;
    setView("badge");
  }

  /* Czynność z menu. Wszystkie robi proces główny — tutaj zostaje decyzja,
     żeby menu zwinęło się po kliknięciu, bo to, co się dzieje dalej, dzieje
     się gdzie indziej (inne okno albo pulpit). */
  async function runAction(action) {
    await api.widget.run(action);
    hovering = false;
    toBadge();
  }

  /* ── Nowa karteczka ─────────────────────────────────────────────
     ZWYKŁA notatka, od razu na pulpicie, z kursorem w środku. To ta sama
     notatka, którą widać w oknie głównym w zakładce Notatki — `widget: true`
     tylko mówi, że leży na wierzchu. */
  async function newDeskNote() {
    const note = await api.notes.create({ widget: true });
    deck = await api.deck.reveal(note.id);
    renderDeck();
    hovering = false;
    toBadge();
  }

  /* ── Widok „pulpit" ─────────────────────────────────────────────
     Kartek na pulpicie widget nie rysuje i nie wie, gdzie leżą — to osobne
     okna, każde z własną notatką (renderer/sticky.html). Stąd tak mało
     kodu: znaczek prosi o wyłożenie albo zebranie talii, a resztę robi
     proces główny, bo tylko on widzi wszystkie monitory. */

  function renderDeck() {
    stage.dataset.deck = deck ? "open" : "closed";
  }

  async function toggleDeck() {
    deck = await api.deck.toggle();
    renderDeck();
  }

  async function hideDeck() {
    deck = await api.deck.show(false);
    renderDeck();
  }

  /* ── Wciśnięcie znaczka ─────────────────────────────────────────
     Czysto wizualny stan „wciśnięty" — bez żadnego skutku poza samym
     wyglądem. Drugie kliknięcie odklika, a klik gdziekolwiek indziej,
     zejście z niego kursorem albo utrata fokusu okna robią to samo:
     znaczek nie ma zostawać wciśnięty, kiedy uwaga poszła gdzie indziej. */
  function setPressed(value) {
    if (badge.dataset.pressed === String(value)) return;
    badge.dataset.pressed = String(value);
  }

  /* ── Spotkanie ──────────────────────────────────────────────────
     Znaczek ma o spotkaniu dwie rzeczy do powiedzenia i obie są dla kogoś,
     kto akurat patrzy gdzie indziej: „na ekranie stoi rozmowa, notować?"
     i „nagrywam". Druga jest znakiem ze studia radiowego, bo mówi o cudzych
     słowach, a nie o twoich — patrz --air w css/tokens.css. */

  function applyMeeting(next) {
    meeting = {
      recording: !!next?.recording,
      // Pytanie ma sens tylko wtedy, gdy nic jeszcze nie nagrywamy.
      spotted: next?.recording ? null : (next?.spotted ?? null),
    };

    stage.dataset.meet = meeting.recording ? "live" : meeting.spotted ? "ask" : "";
    badge.title = meeting.recording
      ? window.t("Nagrywam spotkanie — kliknij dwa razy, żeby zobaczyć notatki")
      : "Cribro Sift";

    const ask = $("#ask");
    ask.hidden = !meeting.spotted;
    if (meeting.spotted) {
      // Nazwa rozmowy, a gdy jej nie ma — nazwa miejsca, w którym stoi.
      $("#askWhere").textContent =
        meeting.spotted.title || meeting.spotted.where || window.t("Spotkanie");
    }
  }

  /* ── Kursor i przepuszczanie kliknięć ───────────────────────── */

  let passing = true;

  function setPassthrough(ignore) {
    if (passing === ignore) return;
    passing = ignore;
    api.widget.passthrough(ignore);
  }

  /* Co liczy się jako „kursor na nas". Prostokąty, nie :hover — przy
     włączonym przepuszczaniu kliknięć elementy nie dostają zdarzeń wejścia,
     a to właśnie wtedy trzeba wiedzieć, że kursor już tu jest. */
  const inBox = (r, x, y) =>
    x >= r.left - HOVER_PAD &&
    x <= r.right + HOVER_PAD &&
    y >= r.top - HOVER_PAD &&
    y <= r.bottom + HOVER_PAD;

  function overUs(x, y) {
    const boxes = [badge.getBoundingClientRect()];
    if (view === "tray") {
      for (const slot of slots) boxes.push(slot.getBoundingClientRect());
    }
    return boxes.some((r) => inBox(r, x, y));
  }

  /* Dymek z pytaniem osobno od reszty i to nie jest drobiazg: kliknięcia
     musi łapać (są w nim dwa przyciski), ale menu rozkładać NIE ma. Ręka
     idzie tam po „Notuj", a nie po nic więcej — a kółka wyjeżdżające spod
     znaczka w chwili, gdy się celuje w przycisk, są dokładnie tym rodzajem
     ruchu, przez który się w niego nie trafia. */
  function overAsk(x, y) {
    const ask = $("#ask");
    return !ask.hidden && inBox(ask.getBoundingClientRect(), x, y);
  }

  /* ══ PODNIESIENIE ZNACZKA LICZYMY SAMI, NIE Z :hover ══

     Znaczek rośnie pod kursorem — i to powiększenie też potrafiło szarpać.
     Powód: przepuszczanie kliknięć włącza się i wyłącza w trakcie ruchu
     ręki, a razem z nim okno raz po raz przestaje dostawać zdarzenia myszy.
     Przeglądarka gubi wtedy stan najechania i zakłada go z powrotem —
     a przejście z odbiciem (--t-lift) startuje przy każdym takim zgubieniu
     od nowa, w połowie poprzedniego ruchu.

     Ten sam rachunek co przy menu daje stan, który się nie miga. Sam
     znaczek, nie całe menu: kursor stojący na kółku menu nie jest powodem,
     żeby podnosić znaczek. */
  function nearBadge(x, y) {
    return inBox(badge.getBoundingClientRect(), x, y);
  }

  function setNear(near) {
    const value = near ? "true" : "false";
    if (stage.dataset.near !== value) stage.dataset.near = value;
  }

  /* ── Menu pod kursorem ──────────────────────────────────────────
     „Czy kursor jest na nas" trzymamy osobno od tego, co widać, i po każdym
     przejściu pytamy jeszcze raz. Powód jest praktyczny: zwijanie menu trwa
     jedną trzecią sekundy, a w tym czasie ręka zdąży wrócić — bez tego
     ostatniego sprawdzenia menu zostałoby schowane pod nieruchomym już
     kursorem i nie miałoby go co otworzyć. */

  let hovering = false;
  let leaveTimer = null;

  function settleHover() {
    if (hovering && view === "badge") return void toTray();
    if (!hovering && view === "tray") return void toBadge();
  }

  /* W trakcie przeciągania widget trzyma mysz bez pytania — inaczej
     przepuszczenie kliknięć w połowie ruchu odbierałoby oknu mysz. */
  document.addEventListener("mousemove", (event) => {
    if (grab) return;
    const onAsk = overAsk(event.clientX, event.clientY);
    const over = onAsk || overUs(event.clientX, event.clientY);
    setPassthrough(!over);
    setNear(nearBadge(event.clientX, event.clientY));

    if (over && !onAsk) {
      clearTimeout(leaveTimer);
      hovering = true;
      settleHover();
    } else if (hovering) {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        hovering = false;
        settleHover();
      }, COLLAPSE_DELAY);
    }
  });

  /* Kursor potrafi opuścić okno bez ostatniego ruchu w środku — wtedy zostaje
     tylko to zdarzenie. Bez niego menu zostałoby rozłożone i dalej łapałoby
     kliknięcia należne temu, co pod nim leży. */
  document.addEventListener("mouseleave", () => {
    if (grab) return;
    setPassthrough(true);
    setNear(false);
    clearTimeout(leaveTimer);
    hovering = false;
    settleHover();
  });

  /* ── Przeciąganie ───────────────────────────────────────────── */

  const DRAG_MIN = 5;
  let grab = null;
  let moved = false;
  let swallowClick = false;

  /* Chwyt zapamiętujemy jako KOTWICĘ EKRANOWĄ i przesunięcie od niej —
     nie jako odstęp od środka znaczka wewnątrz okna. Patrz analogiczny
     komentarz przy widget:grab w main/main.js po pełne uzasadnienie:
     odstęp liczony w oknie skacze w chwili, w której menu się zwija i okno
     kurczy się do samego znaczka. */
  badge.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0) return;
    grab = { sx: event.screenX, sy: event.screenY };
    moved = false;
    badge.setPointerCapture(event.pointerId);
    await api.widget.dragStart();
  });

  /* Ruch służy tu WYŁĄCZNIE do tego, żeby wiedzieć, że przeciąganie się
     zaczęło — okno przesuwa proces główny, klatka po klatce, z prawdziwego
     położenia kursora. */
  badge.addEventListener("pointermove", (event) => {
    if (!grab || moved) return;
    if (Math.hypot(event.screenX - grab.sx, event.screenY - grab.sy) < DRAG_MIN) return;
    moved = true;
    badge.dataset.drag = stage.dataset.drag = "true";
    // Menu znika na czas przeciągania. W nowym miejscu może wychodzić
    // w inną ćwiartkę niż w starym, a przeliczanie tego co klatkę byłoby
    // migotaniem sześciu kółek wokół ręki.
    hovering = false;
    if (view === "tray") setView("badge");
  });

  badge.addEventListener("pointerup", async (event) => {
    if (!grab) return;
    grab = null;
    delete badge.dataset.drag;
    delete stage.dataset.drag;
    try {
      badge.releasePointerCapture(event.pointerId);
    } catch {
      /* przechwycenia już nie ma — nic do zwalniania */
    }

    /* O tym, czy to było przeciągnięcie, rozstrzyga proces główny — on
       widział cały ruch kursora, a nie tylko te zdarzenia, które doszły
       do okna. Wraca stąd też gotowa geometria: przy krawędzi ekranu
       kotwica bywa przycięta i znaczek siedzi w oknie gdzie indziej. */
    const done = await api.widget.dragEnd();
    if (!done?.moved) return;

    // Puszczenie po przeciągnięciu nie może wciskać znaczka — kliknięcie
    // przychodzi zaraz po tym zdarzeniu.
    swallowClick = true;
    hovering = false;
    if (view === "tray") setView("badge");
    applyGeometry(done.spot);
  });

  badge.addEventListener("pointercancel", async () => {
    if (!grab) return;
    grab = null;
    delete badge.dataset.drag;
    delete stage.dataset.drag;
    applyGeometry((await api.widget.dragEnd())?.spot);
  });

  /* ── Kliknięcia ─────────────────────────────────────────────── */

  document.addEventListener("click", async (event) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }

    /* Pytanie o notatki ze spotkania. Przed znaczkiem, bo dymek leży
       tuż obok niego i kliknięcie w przycisk nie ma prawa być przy okazji
       kliknięciem w znaczek. */
    if (event.target.closest("#askYes")) return void api.meetings.answer(true);
    if (event.target.closest("#askNo")) return void api.meetings.answer(false);

    /* ══ ZNACZEK NIE OTWIERA OKNA APLIKACJI — NIGDY, ŻADNYM STANEM ══

       Pojedyncze kliknięcie w znaczek jest odtąd czysto wizualne: wciska
       go i tyle. Nic więcej się nie dzieje — ani otwarcie talii (od tego
       jest podwójne kliknięcie, patrz dblclick niżej), ani żadne okno.
       Jedyna droga do okna aplikacji to gniazdo „Główna aplikacja"
       w rozłożonym menu (patrz runAction i action === "app"
       w main/main.js, ipcMain.handle("widget:run", …)). */
    if (event.target.closest("#badge")) {
      setPressed(badge.dataset.pressed !== "true");
      return;
    }

    const slot = event.target.closest(".slot[data-do]");
    if (slot) return void runAction(slot.dataset.do);
  });

  /* Podwójne kliknięcie w znaczek — jedyny gest, który rusza talię kartek
     na pulpicie, i to jest teraz CAŁA jego treść. */
  badge.addEventListener("dblclick", () => void toggleDeck());

  /* ── Prawy przycisk myszy na widżet → główne okno ───────────────────────
     Kontekstowe menu przeglądarki nie ma tu sensu (okno jest bez ramki,
     bez wyboru tekstu), więc prawy klik w znaczek staje się skrótem do
     głównego okna aplikacji. Klik poza znaczkiem nie jest obsługiwany —
     tam przepuszczamy zdarzenia na wylot i contextmenu i tak nie dochodzi. */
  badge.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void api.widget.run("app");
  });

  /* Klik gdziekolwiek indziej na pulpicie odklika znaczek — a to samo robi
     utrata fokusu okna i zejście kursorem, patrz mousemove/mouseleave
     wyżej. Bez tego wciśnięty znaczek zostawałby wciśnięty, kiedy uwaga
     poszła w zupełnie inne miejsce. */
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#badge")) setPressed(false);
  });
  window.addEventListener("blur", () => setPressed(false));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (runtime === "listening") return void api.system.cancelCapture?.();
    // Pytanie o spotkanie zdejmuje się jak każde inne — i jest wierzchnią
    // warstwą, bo przyszło samo, bez pytania.
    if (meeting.spotted) return void api.meetings.answer(false);
    if (deck) return void hideDeck();
    if (view === "tray") {
      hovering = false;
      return void toBadge();
    }
  });

  /* ── Wiadomości z procesu głównego ──────────────────────────── */

  /* Talia bywa chowana bez udziału znaczka: Escape'em na kartce albo
     Escape'em wciśniętym w cudzej aplikacji. Bez tej wiadomości znaczek
     zostawałby z pamięcią o rozłożonej talii i pierwsze podwójne kliknięcie
     w niego szłoby na nic — chowałby coś, czego już nie ma. */
  api.deck.onChange?.(({ open } = {}) => {
    deck = !!open;
    renderDeck();
  });

  api.onState?.(({ state }) => {
    runtime = state;
    badge.dataset.state = state;
    if (state !== "listening") stage.style.setProperty("--level", "0");
  });

  /* Poranek zbiera pocztę i plan dnia w tle — kółko pulsuje, dopóki
     proces główny nie skończy (patrz broadcast("briefing:busy", …)
     w showBriefing w main/main.js). */
  api.briefing?.onBusy?.((busy) => {
    const slot = $("#slotBriefing");
    if (slot) slot.dataset.state = busy ? "loading" : "";
  });

  /* Geometria, o którą nie prosiliśmy.

     Oknem rusza czasem sam proces główny — po odłączeniu monitora albo po
     „Przywróć na miejsce" w ustawieniach. Nie ma wtedy żądania, w którego
     odpowiedzi przyszłaby nowa kotwica, a stara wskazuje miejsce POZA
     oknem: znaczek jest wtedy rysowany za jego krawędzią i po prostu go
     nie widać, choć okno stoi na wierzchu, tam gdzie trzeba. */
  api.widget.onGeometry?.((spot) => applyGeometry(spot));

  /* Poziom głosu przychodzi z HUD-a (tylko on ma dostęp do mikrofonu), przez
     proces główny. Po trzech sekundach pigułka HUD-a znika i znaczek jest
     jedynym, co mówi, że mikrofon nadal słucha — bez tej jednej liczby
     pulsowałby w próżni, nie wiedząc, czy ktokolwiek mówi. */
  api.widget.onLevel?.((level) => {
    const value = Math.max(0, Math.min(1, Number(level) || 0));
    stage.style.setProperty("--level", value.toFixed(3));
  });

  /* Spotkanie: pytanie i nagrywanie jedną wiadomością — patrz meetingState
     w main/main.js. */
  api.meetings?.onChange?.((live) => applyMeeting(live));

  function applySettings(settings) {
    const w = settings?.widget ?? {};
    const briefingSlot = $("#slotBriefing");
    const newNoteSlot = $("#slotNewNote");
    const quickNoteSlot = $("#slotQuickNote");

    if (briefingSlot) briefingSlot.style.display = w.showWeatherRates !== false ? "" : "none";
    if (newNoteSlot) newNoteSlot.style.display = w.showRecentNotes !== false ? "" : "none";
    if (quickNoteSlot) quickNoteSlot.style.display = w.showQuickTasks !== false ? "" : "none";
  }

  api.settings.onChange?.((settings) => {
    setLanguage(settings.uiLanguage ?? "pl");
    applySettings(settings);
    translateTree();
  });

  /* ── Start ──────────────────────────────────────────────────── */

  (async function boot() {
    const settings = await api.settings.get();
    setLanguage(settings.uiLanguage ?? "pl");
    applySettings(settings);
    await layout("badge");
    // Talia mogła zostać rozłożona przed przeładowaniem widgetu — znaczek
    // pyta o stan, zamiast zakładać, że wszystko jest schowane.
    deck = (await api.deck.state()).open;
    renderDeck();
    // Spotkanie mogło się zacząć, zanim widget wstał — pytamy o stan,
    // zamiast zakładać, że nic się nie dzieje.
    applyMeeting(await api.meetings?.state?.());
    translateTree();
  })();
})();
