"use strict";

/**
 * Widget — jedyne, co Cribro pokazuje poza swoimi oknami.
 *
 * Cztery stany i jedno okno: znaczek, taca, lista, kartka. Rozmiar okna
 * zmienia proces główny (patrz placeWidget w main/main.js), a tutaj jest to,
 * czego on nie widzi: kursor, zawartość i ruch.
 *
 * TACA to cztery czynności robione w biegu — dyktowanie, szybka notatka,
 * gęstość sita, język — i przejście do notatek. Rozkłada ją najechanie
 * kursorem, zwija zejście z niego, z chwilą zwłoki, żeby nie uciekała spod
 * ręki w drodze między kółkami. Znaczek zostaje wtedy tym, czym był: jednym
 * kliknięciem do notatek i jednym kliknięciem z powrotem.
 *
 * DWA WIDOKI. Wszystko powyżej opisuje widok kompaktowy — ten, w którym
 * notatki siedzą w szybie przy znaczku. W widoku „pulpit" (ustawienie
 * widget.mode) ta szyba się nie otwiera wcale: kliknięcie w znaczek wykłada
 * notatki na pulpit osobnymi okienkami i drugim kliknięciem je zbiera.
 * Znaczek jest w obu widokach tym samym: jedyną rzeczą, którą chowa się
 * wszystko naraz.
 *
 * Dwie rzeczy dzieją się wyłącznie tutaj, bo tylko tutaj widać kursor:
 *
 *   1. PRZEPUSZCZANIE KLIKNIĘĆ. Okno rozwiniętego widgetu jest większe niż
 *      to, co widać — a leży nad cudzą pracą. Kliknięcia idą więc na wylot
 *      wszędzie poza znaczkiem i panelem.
 *
 *   2. PRZECIĄGANIE. Okno jest bez ramki, więc systemowego przeciągania nie
 *      ma. Liczymy KOTWICĘ — miejsce dla środka znaczka na ekranie — i to ją
 *      wysyłamy; rachunek, gdzie wobec tego postawić róg okna, należy do
 *      procesu głównego, bo zależy od kierunku rozwinięcia panelu.
 */

(function () {
  const api = window.cribro;
  const {
    titleOf,
    rawTitle,
    retitle,
    previewOf,
    countWords,
    when,
    sortNotes,
    escape,
    colorOf,
    NOTE_COLORS,
    renameInPlace,
  } = window.NotesCore;
  const $ = (selector) => document.querySelector(selector);

  const stage = $("#stage");
  const badge = $("#badge");
  const panel = $("#panel");
  const sticky = $("#sticky");
  const slots = [...document.querySelectorAll(".slot")];

  /* Kartka w widgecie ma pokazywać notatkę tak, jak pokazuje ją Notatnik —
     przez ten sam edytor i ten sam arkusz (js/editor.js, css/prose.css).
     Wcześniej było tu zwykłe pole tekstowe i to samo zdanie wyglądało
     inaczej w aplikacji, a inaczej na wierzchu. */
  const editor = window.CribroEditor.create($("#stickyText"), { onInput: () => scheduleSave() });

  const HOVER_PAD = 6;
  const SAVE_DELAY = 600;
  /* Chwila zwłoki przed zwinięciem tacy. Bez niej taca uciekałaby spod
     kursora przy przejściu między kółkami. */
  const COLLAPSE_DELAY = 420;

  let view = "badge"; // badge | tray | list | sticky
  /* "compact" — lista i kartka w szybie przy znaczku.
     "desk"    — notatki leżą na pulpicie, a znaczek je chowa i pokazuje. */
  let mode = "compact";
  let deck = false;
  let geom = {
    dir: "up",
    ax: 52,
    ay: 52,
    badge: 60,
    panelW: 320,
    panelH: 400,
    panelX: 22,
    panelY: 22,
  };
  let notes = [];
  let current = null;
  let saveTimer = null;
  let busy = false;
  let runtime = "idle";

  /* ── Układ ──────────────────────────────────────────────────── */

  /* Róg, w którym siada uchwyt rozmiaru: zawsze ten najdalszy od znaczka,
     bo tylko w tę stronę szyba ma dokąd rosnąć. Przy szybie nad znaczkiem
     jest u góry, pod znaczkiem u dołu, a przy szybie z boku po tej stronie,
     w którą się oddala. */
  const GRIP_CORNER = { up: "tr", down: "br", left: "bl", right: "br" };

  function applyGeometry(next) {
    if (!next) return;
    geom = next;
    stage.dataset.dir = next.dir;
    stage.dataset.grip = GRIP_CORNER[next.dir] ?? "br";
    if (next.tray) {
      // W którą stronę wychodzi taca i jak duże są jej kółka — liczy to
      // proces główny razem z rozmiarem okna, bo tylko on wie, gdzie kończy
      // się ekran. Tutaj zostaje podstawienie tego pod CSS.
      stage.dataset.trayDir = next.tray.dir;
      stage.dataset.traySide = next.tray.side;
      stage.style.setProperty("--tray-item", `${next.tray.item}px`);
      stage.style.setProperty("--tray-step", `${next.tray.step}px`);
      stage.style.setProperty("--tray-gap", `${next.tray.gap}px`);
    }
    stage.style.setProperty("--ax", `${next.ax}px`);
    stage.style.setProperty("--ay", `${next.ay}px`);
    stage.style.setProperty("--badge", `${next.badge}px`);
    stage.style.setProperty("--panel-x", `${next.panelX}px`);
    stage.style.setProperty("--panel-y", `${next.panelY}px`);
    stage.style.setProperty("--panel-w", `${next.panelW}px`);
    stage.style.setProperty("--panel-h", `${next.panelH}px`);
  }

  /* ── Genie ──────────────────────────────────────────────────────
     Sylwetkę liczy js/genie.js — osobno, bo to czysta geometria i da się
     ją sprawdzić bez przeglądarki (scripts/genie-test.js). Tutaj zostaje
     tylko podpięcie jej pod okno: gdzie stoi znaczek i jak szeroka jest
     w tym momencie kartka. */

  function genieOptions() {
    // W poprzek kartki — a to, która oś jest „w poprzek", zależy od strony,
    // w którą kartka wychodzi.
    const sideways = geom.dir === "left" || geom.dir === "right";
    const across = sideways ? geom.panelH : geom.panelW;
    const centre = sideways ? geom.ay - geom.panelY : geom.ax - geom.panelX;

    return {
      anchor: centre / across,
      neckHalf: (geom.badge * 0.4) / across,
      dir: geom.dir,
    };
  }

  function paintGenie(p) {
    sticky.style.clipPath = window.CribroGenie.path(p, genieOptions());
    sticky.style.opacity = String(Math.min(1, p * 1.8));
    // Kartka nie tylko wychodzi, ale i dojeżdża — bez tego wyglądałaby
    // jak odsłaniana zasłoną, a nie jak wyciągana ze znaczka. Dojeżdża
    // oczywiście od strony znaczka, więc kierunek jest tu ten sam co reszty.
    const slide = ((1 - p) * 16).toFixed(1);
    sticky.style.transform = {
      up: `translateY(${slide}px)`,
      down: `translateY(-${slide}px)`,
      left: `translateX(${slide}px)`,
      right: `translateX(-${slide}px)`,
    }[geom.dir];
  }

  const easeOut = (k) => 1 - Math.pow(1 - k, 3);
  const easeIn = (k) => k * k * k;

  function animate(from, to, ms, ease) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        paintGenie(from + (to - from) * ease(k));
        if (k < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  /* ── Przejścia między stanami ───────────────────────────────── */

  function setView(next) {
    view = next;
    stage.dataset.view = next;
  }

  /* Stan okna, o który prosimy proces główny. Widoków jest cztery, rozmiarów
     okna trzy: lista i kartka mieszczą się w tym samym. */
  const layout = async (next) => applyGeometry(await api.widget.layout(next));

  /**
   * Zwinięcie wszystkiego jednym ruchem — to robi kliknięcie w znaczek,
   * niezależnie od tego, co akurat jest otwarte.
   *
   * Z kartki idziemy PROSTO do znaczka, bez przystanku na liście. Wersja
   * z przystankiem pokazywała listę na jedną klatkę w środku zwijania
   * i wyglądało to jak mrugnięcie.
   *
   * KOLEJNOŚĆ JEST TU CAŁĄ TREŚCIĄ: najpierw znika to, co widać, dopiero
   * potem kurczy się okno. Odwrotnie okno ucięłoby własną animację w pół
   * ruchu — i to samo dotyczy tacy, tylko że jej zwijanie trwa krócej.
   */
  async function toBadge() {
    if (busy || view === "badge") return;
    busy = true;

    const fold = { list: 260, tray: 300, sticky: 0 }[view] ?? 0;
    if (view === "sticky") {
      await flushSave();
      await animate(1, 0, 260, easeIn);
    }
    setView("badge");
    if (fold) await new Promise((r) => setTimeout(r, fold));

    await layout("badge");
    api.widget.release();
    current = null;
    busy = false;
    void settleHover();
  }

  /** Taca. Okno rośnie PRZED rozłożeniem kółek — inaczej wyjeżdżałyby poza
      jego krawędź i widać by było tylko połowę ruchu. */
  async function toTray() {
    if (busy || view !== "badge") return;
    busy = true;
    await layout("tray");
    setView("tray");
    busy = false;
    void settleHover();
  }

  async function toList() {
    if (busy) return;
    busy = true;
    /* Od tej chwili nie śledzimy kursora: przy rozwiniętej szybie taca się
       nie rozkłada, więc „kursor jest na nas" nie ma czego przełączać.
       Wyzerowanie jest tu po to, żeby po zamknięciu listy taca nie wyskoczyła
       z pamięci o najechaniu sprzed jej otwarcia — pod kursorem, którego
       dawno tam nie ma. */
    hovering = false;
    if (view === "badge" || view === "tray") {
      // Taca chowa się PRZED zmianą rozmiaru okna, ale nie czekamy na koniec
      // jej zwijania: kółka wracają pod znaczek w tym samym czasie, w którym
      // wychodzi lista. Czekanie dokładałoby tu jedną trzecią sekundy do
      // ruchu, który ma być natychmiastowy.
      if (view === "tray") setView("badge");
      await layout("panel");
      await refresh();
      paintGenie(0);
      setView("list");
    } else if (view === "sticky") {
      await flushSave();
      await animate(1, 0, 260, easeIn);
      setView("list");
      current = null;
      await refresh();
    }
    busy = false;
  }

  /* Czynność z tacy. Wszystkie robi proces główny — tutaj zostaje decyzja,
     co dalej z tacą. Język zostaje rozłożony, bo po zmianie chce się
     zobaczyć wynik (a czasem kliknąć jeszcze raz); reszta otwiera okno albo
     zaczyna nagrywanie i taca nie ma tam czego szukać. */
  async function runAction(action) {
    await api.widget.run(action);
    if (action === "language") return;
    hovering = false;
    await toBadge();
  }

  async function toSticky(note) {
    if (busy || !note) return;
    busy = true;
    current = note;
    editor.setMarkdown(note.text ?? "");
    saved = editor.getMarkdown();
    $("#stickyTitle").textContent = titleOf(note);
    paintSticky();
    showPalette(false);
    setWords();
    setState(t("Zapisane"));
    setView("sticky");
    paintGenie(0);
    await animate(0, 1, 420, easeOut);
    api.widget.grabFocus();
    editor.focusEnd();
    busy = false;
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

  /**
   * Zmiana widoku w Ustawieniach. Widget musi po sobie posprzątać: szyba
   * otwarta w chwili przełączenia na „pulpit" zostałaby otwarta nad
   * kartkami, a kartki zebrał już proces główny przy zapisie ustawienia.
   */
  async function applyMode(next) {
    const wanted = next === "desk" ? "desk" : "compact";
    if (wanted === mode) return;
    mode = wanted;
    stage.dataset.mode = mode;
    if (mode === "desk") {
      await toBadge();
      deck = (await api.deck.state()).open;
    } else {
      deck = false;
    }
    renderDeck();
  }

  /* ── Język na tacy ──────────────────────────────────────────────
     Kółko języka mówi tekstem, nie ikoną: PL, PL·EN albo AUTO. Ten sam
     skrót co w pasku menu — na kółku nie mieści się nic dłuższego, a przy
     dwóch językach trzeba pokazać parę.

     Sam napis niesie też tryb rozpoznawania, więc dymek nie musi go
     powtarzać: para kodów to „dwujęzycznie", jeden kod to „jeden język",
     AUTO to rozpoznawanie. Kliknięcie krąży między tymi trzema. */

  function applyLanguage(settings) {
    const language = settings.language ?? {};
    const code = (value) => String(value ?? "").toUpperCase();
    $("#langLabel").textContent =
      language.mode === "auto"
        ? "AUTO"
        : language.mode === "bilingual"
          ? `${code(language.primary)}·${code(language.secondary)}`
          : code(language.primary);
  }

  /* ── Zawartość ──────────────────────────────────────────────── */

  /* Na wierzchu leży WYŁĄCZNIE to, co ktoś tam sam odłożył. Porównanie
     jest ścisłe — `note.widget` bywa nieustawione w notatkach sprzed tej
     funkcji i „prawdziwe inaczej" w niczyim pliku nie powinno decydować
     o tym, co widać nad wszystkimi aplikacjami. */
  async function refresh() {
    const all = await api.notes.get();
    notes = sortNotes(all.filter((note) => note.widget === true));
    renderBadge();
    renderList();
  }

  function renderBadge() {
    const count = $("#count");
    count.textContent = String(notes.length);
    count.dataset.on = notes.length ? "true" : "false";
  }

  function renderList() {
    const items = $("#items");
    const empty = $("#empty");

    if (!notes.length) {
      items.innerHTML = "";
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    items.innerHTML = notes
      .map(
        (note, index) => `
        <button class="item" data-id="${escape(note.id)}" style="--i: ${index}">
          <span class="item__head" data-color="${colorOf(note)}">
            <span class="swatch swatch--dot"></span>
            <span class="item__title">${escape(titleOf(note))}</span>
          </span>
          <span class="item__hint">${escape(previewOf(note, 40) || t("pusta"))} · ${escape(when(note.updatedAt ?? note.at))}</span>
        </button>`,
      )
      .join("");
  }

  const setState = (label) => ($("#stickyState").textContent = label);

  function setWords() {
    const n = countWords(current?.text ?? "");
    $("#stickyWords").textContent = n === 1 ? t("1 słowo") : t("{n} słów", { n });
  }

  function scheduleSave() {
    if (!current) return;
    // Na dysk notatka wraca Markdownem — patrz shared/richtext.js.
    current.text = editor.getMarkdown();
    setState(t("Piszę…"));
    setWords();
    // Tytuł kartki to pierwsza linia notatki, więc jedzie razem z pisaniem.
    $("#stickyTitle").textContent = titleOf(current);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), SAVE_DELAY);
  }

  /* Zapisany stan trzymamy osobno od `current.text`, bo to drugie zmienia
     się przy każdym znaku — inaczej porównanie „czy jest co zapisywać"
     zawsze wychodziłoby na „nie ma". */
  let saved = "";

  async function flushSave() {
    clearTimeout(saveTimer);
    if (!current) return;
    const body = editor.getMarkdown();
    if (body === saved) return;
    current.text = body;
    try {
      await api.notes.update(current.id, { text: body });
      saved = body;
      setState(t("Zapisane"));
    } catch (error) {
      setState(String(error.message || error).slice(0, 28));
    }
  }

  /* ── Kolor kartki ───────────────────────────────────────────────
     Paleta rysuje się raz i tylko zmienia zaznaczenie — siedem przycisków
     przebudowywanych przy każdym otwarciu to siedem elementów, które
     mrugają. */

  function buildPalette() {
    $("#palette").innerHTML = NOTE_COLORS.map(
      ([key, label]) => `
        <button data-color="${key}" title="${escape(label)}" aria-pressed="false">
          <span class="swatch"></span>
        </button>`,
    ).join("");
  }

  function paintSticky() {
    const color = colorOf(current);
    sticky.dataset.color = color;
    // Próbka na przycisku ma pokazywać kolor kartki, więc dziedziczy go
    // z tego samego atrybutu co ona.
    $("#paint").dataset.color = color;
    for (const button of $("#palette").querySelectorAll("[data-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.color === color));
    }
  }

  function showPalette(open) {
    $("#palette").hidden = !open;
    $("#paint").setAttribute("aria-expanded", String(!!open));
  }

  async function setColor(color) {
    if (!current) return;
    current.color = color;
    paintSticky();
    showPalette(false);
    await api.notes.update(current.id, { color });
    await refresh();
  }

  /* ── Tytuł ──────────────────────────────────────────────────────
     Tytuł notatki nie jest osobnym polem, tylko jej pierwszą niepustą
     linią — przepisanie go jest więc przepisaniem treści i wraca tą samą
     drogą co każda inna zmiana (patrz renameInPlace w notes-core.js). */

  function startRename() {
    if (!current) return;
    const note = current;
    renameInPlace($("#stickyTitle"), {
      text: rawTitle(note),
      onCommit: async (title) => {
        note.text = retitle(note.text, title);
        saved = note.text;
        editor.setMarkdown(note.text);
        await api.notes.update(note.id, { text: note.text });
        await refresh();
      },
      onEnd: () => {
        $("#stickyTitle").textContent = titleOf(note);
        setWords();
      },
    });
  }

  /* ── Rozmiar szyby ──────────────────────────────────────────────
     Ciągnięcie liczymy w pikselach EKRANU, nie okna: okno zmienia rozmiar
     w trakcie ruchu, więc współrzędne w nim uciekają spod kursora.

     Kierunek jest różny w każdym rogu i to nie jest kaprys układu. Szyba
     rozwinięta w pionie jest wyśrodkowana na znaczku, więc jej szerokość
     rośnie w OBIE strony naraz — ruch o piksel w prawo daje dwa piksele
     szerokości. Rozwinięta w bok jest wyśrodkowana w pionie i tak samo
     zachowuje się jej wysokość. */

  const GROW = {
    up: (dx, dy) => ({ w: dx * 2, h: -dy }),
    down: (dx, dy) => ({ w: dx * 2, h: dy }),
    left: (dx, dy) => ({ w: -dx, h: dy * 2 }),
    right: (dx, dy) => ({ w: dx, h: dy * 2 }),
  };

  const grip = $("#grip");
  let sizing = null;

  async function sendSize(event, commit, from = sizing) {
    if (!from) return;
    const grow = GROW[geom.dir](event.screenX - from.sx, event.screenY - from.sy);
    const limit = geom.min ?? { width: 200, height: 190 };
    const roof = geom.max ?? { width: 560, height: 760 };
    applyGeometry(
      await api.widget.resize({
        width: Math.min(roof.width, Math.max(limit.width, Math.round(from.w + grow.w))),
        height: Math.min(roof.height, Math.max(limit.height, Math.round(from.h + grow.h))),
        commit,
      }),
    );
  }

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sizing = { sx: event.screenX, sy: event.screenY, w: geom.panelW, h: geom.panelH };
    grip.dataset.drag = "true";
    grip.setPointerCapture(event.pointerId);
  });

  grip.addEventListener("pointermove", (event) => {
    if (sizing) void sendSize(event, false);
  });

  grip.addEventListener("pointerup", (event) => {
    if (!sizing) return;
    // Punkt startowy zapamiętujemy przed wyzerowaniem: ostatni rachunek ma
    // wyjść z tego samego miejsca co poprzednie, a ruch od tej chwili już
    // nie liczy.
    const from = sizing;
    sizing = null;
    delete grip.dataset.drag;
    try {
      grip.releasePointerCapture(event.pointerId);
    } catch {
      /* przechwycenia już nie ma */
    }
    void sendSize(event, true, from);
  });

  grip.addEventListener("pointercancel", () => {
    sizing = null;
    delete grip.dataset.drag;
  });

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
  function overUs(x, y) {
    const boxes = [badge.getBoundingClientRect()];
    if (view === "tray") for (const slot of slots) boxes.push(slot.getBoundingClientRect());
    if (view === "list" || view === "sticky") boxes.push(panel.getBoundingClientRect());
    return boxes.some(
      (r) =>
        x >= r.left - HOVER_PAD &&
        x <= r.right + HOVER_PAD &&
        y >= r.top - HOVER_PAD &&
        y <= r.bottom + HOVER_PAD,
    );
  }

  /* ── Taca pod kursorem ──────────────────────────────────────────
     „Czy kursor jest na nas" trzymamy osobno od tego, co widać, i po każdym
     przejściu pytamy jeszcze raz. Powód jest praktyczny: zwijanie tacy trwa
     jedną trzecią sekundy, a w tym czasie ręka zdąży wrócić — bez tego
     ostatniego sprawdzenia taca zostałaby schowana pod nieruchomym już
     kursorem i nie miałoby jej co otworzyć. */

  let hovering = false;
  let leaveTimer = null;

  function settleHover() {
    if (busy) return;
    if (hovering && view === "badge") return void toTray();
    if (!hovering && view === "tray") return void toBadge();
  }

  /* W trakcie przeciągania i rozciągania widget trzyma mysz bez pytania.
     Przy rozciąganiu to nie jest wygoda, tylko warunek działania: szyba
     kurczy się pod kursorem, więc kursor natychmiast znajduje się POZA nią
     — a przepuszczenie kliknięć w tym momencie odbiera oknu mysz w połowie
     ruchu i szyba zwija się zamiast zmienić rozmiar. */
  document.addEventListener("mousemove", (event) => {
    if (grab || sizing) return;
    const over = overUs(event.clientX, event.clientY);
    setPassthrough(!over);

    // Przy rozwiniętej szybie taca nie ma nic do roboty: notatki są już na
    // wierzchu, a kółka pod nimi byłyby drugim menu do tego samego.
    if (view === "list" || view === "sticky") return;

    if (over) {
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
     tylko to zdarzenie. Bez niego taca zostałaby rozłożona i dalej łapałaby
     kliknięcia należne temu, co pod nią leży. */
  document.addEventListener("mouseleave", () => {
    if (grab || sizing) return;
    setPassthrough(true);
    clearTimeout(leaveTimer);
    hovering = false;
    settleHover();
  });

  /* ── Przeciąganie ───────────────────────────────────────────── */

  const DRAG_MIN = 4;
  let grab = null;
  let moved = false;
  let swallowClick = false;

  /* Chwyt zapamiętujemy RAZ i jako odległość od środka znaczka, nie jako
     punkt w oknie. Okno w trakcie przeciągania zmienia rozmiar (taca się
     chowa, znaczek bywa przyklamrowany do krawędzi), więc punkt liczony
     z bieżącej kotwicy przeskakiwałby razem z nią — a przeskakuje wtedy
     to, co człowiek trzyma w ręce. */
  badge.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    grab = {
      dx: event.clientX - geom.ax,
      dy: event.clientY - geom.ay,
      sx: event.screenX,
      sy: event.screenY,
    };
    moved = false;
    badge.setPointerCapture(event.pointerId);
  });

  badge.addEventListener("pointermove", (event) => {
    if (!grab) return;
    // Ruch mierzymy na ekranie, nie w oknie: okno jedzie za kursorem, więc
    // współrzędne w oknie stoją w miejscu, choćby widget przejechał ekran.
    if (!moved && Math.hypot(event.screenX - grab.sx, event.screenY - grab.sy) < DRAG_MIN) return;
    if (!moved) {
      badge.dataset.drag = stage.dataset.drag = "true";
      // Taca znika na czas przeciągania. W nowym miejscu może wychodzić
      // w inną stronę niż w starym, a przeliczanie tego co klatkę byłoby
      // migotaniem czterech kółek wokół ręki.
      hovering = false;
      if (view === "tray") {
        setView("badge");
        void api.widget.layout("badge");
      }
    }
    moved = true;
    api.widget.move({
      anchor: {
        x: Math.round(event.screenX - grab.dx),
        y: Math.round(event.screenY - grab.dy),
      },
      dir: geom.dir,
    });
  });

  badge.addEventListener("pointerup", async (event) => {
    if (!grab) return;
    const held = grab;
    grab = null;
    delete badge.dataset.drag;
    delete stage.dataset.drag;
    try {
      badge.releasePointerCapture(event.pointerId);
    } catch {
      /* przechwycenia już nie ma — nic do zwalniania */
    }
    if (!moved) return;

    // Puszczenie po przeciągnięciu nie może rozwinąć listy — kliknięcie
    // przychodzi zaraz po tym zdarzeniu.
    swallowClick = true;
    api.widget.drop({
      anchor: {
        x: Math.round(event.screenX - held.dx),
        y: Math.round(event.screenY - held.dy),
      },
      dir: geom.dir,
    });
    // Przy krawędzi ekranu proces główny mógł przesunąć znaczek w oknie —
    // pytamy o świeżą geometrię, zamiast zgadywać. Przeciągnięty widget
    // wraca do samego znaczka: taca rozłożona w nowym miejscu wychodziłaby
    // w stronę policzoną dla starego.
    hovering = false;
    if (view === "tray") setView("badge");
    applyGeometry(await api.widget.layout(view === "list" || view === "sticky" ? "panel" : "badge"));
  });

  badge.addEventListener("pointercancel", () => {
    grab = null;
    delete badge.dataset.drag;
    delete stage.dataset.drag;
  });

  /* ── Kliknięcia ─────────────────────────────────────────────── */

  document.addEventListener("click", async (event) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }

    /* ══ ZNACZEK CHOWA WSZYSTKO, A POZA TYM OTWIERA NOTATKI ══

       Taca rozkłada się sama pod kursorem, więc kliknięcie w znaczek nie ma
       jej po co przełączać — zresztą kursor stoi wtedy na znaczku i taca
       rozłożyłaby się z powrotem w tej samej chwili. Zostaje mu więc to,
       po co widget powstał: notatki na wierzchu. Lista przy znaczku albo
       kartki na pulpicie — zależnie od widoku, ale gest jest jeden. */
    if (event.target.closest("#badge") || event.target.closest("#slotNotes")) {
      if (deck) return void hideDeck();
      if (view === "list" || view === "sticky") return void toBadge();
      return mode === "desk" ? toggleDeck() : toList();
    }

    const slot = event.target.closest(".slot[data-do]");
    if (slot) return void runAction(slot.dataset.do);

    if (event.target.closest("#closeList")) return toBadge();
    if (event.target.closest("#back")) return toList();

    if (event.target.closest("#add")) {
      const note = await api.notes.create({ kind: "quick", widget: true });
      await refresh();
      return toSticky(note);
    }

    if (event.target.closest("#dictate")) {
      if (current) await api.notes.dictate(current.id);
      return;
    }

    const swatch = event.target.closest("#palette [data-color]");
    if (swatch) return setColor(swatch.dataset.color);

    if (event.target.closest("#paint")) return showPalette($("#palette").hidden);
    // Klik gdziekolwiek indziej zamyka paletę — tak jak każde menu.
    showPalette(false);

    const item = event.target.closest(".item");
    if (item) return toSticky(notes.find((note) => note.id === item.dataset.id));
  });

  $("#stickyTitle").addEventListener("dblclick", () => startRename());

  /* Escape zdejmuje po jednej warstwie, od wierzchu — tak samo jak
     w Notatniku: najpierw trwające nagranie, potem kartka, potem lista,
     a w widoku „pulpit" cała talia. */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (runtime === "listening") return void api.system.cancelCapture?.();
    if (!$("#palette").hidden) return showPalette(false);
    if (mode === "desk" && deck) return void hideDeck();
    if (view === "sticky") return void toList();
    if (view === "list" || view === "tray") {
      hovering = false;
      return void toBadge();
    }
  });

  /* Lista jest menu i zamyka się tak jak menu — z chwilą, gdy uwaga idzie
     gdzie indziej. Kartka NIE: ona jest po to, żeby zostać na wierzchu,
     kiedy pracuje się w czymś innym. To cała różnica między nimi. */
  window.addEventListener("blur", () => {
    if (view !== "list" || grab || sizing) return;
    setTimeout(() => view === "list" && !sizing && toBadge(), 140);
  });

  /* ── Wiadomości z procesu głównego ──────────────────────────── */

  api.notes.onChanged?.(async () => {
    await refresh();
    if (!current) return;
    const fresh = notes.find((note) => note.id === current.id);
    // Notatka mogła zniknąć albo zejść z wierzchu w innym oknie.
    if (!fresh) return void toList();
    // Tekstu nie podmieniamy pod palcami piszącego.
    if (document.activeElement !== $("#stickyText")) {
      current = fresh;
      editor.setMarkdown(fresh.text ?? "");
      saved = editor.getMarkdown();
      setWords();
    }
  });

  api.notes.onAppended?.(async ({ id }) => {
    if (!current || id !== current.id) return;
    const fresh = (await api.notes.get()).find((note) => note.id === id);
    if (!fresh) return;
    current = fresh;
    editor.setMarkdown(fresh.text ?? "");
    saved = editor.getMarkdown();
    editor.focusEnd();
    setWords();
    setState(t("Zapisane"));
  });

  api.onState?.(({ state }) => {
    runtime = state;
    $("#dictate").dataset.state = state;
    $("#slotDictate").dataset.state = state;
    badge.dataset.state = state;
    if (state !== "listening") stage.style.setProperty("--level", "0");
  });

  /* Poziom głosu przychodzi z HUD-a (tylko on ma dostęp do mikrofonu), przez
     proces główny. Po trzech sekundach pigułka HUD-a znika i znaczek jest
     jedynym, co mówi, że mikrofon nadal słucha — bez tej jednej liczby
     pulsowałby w próżni, nie wiedząc, czy ktokolwiek mówi. */
  api.widget.onLevel?.((level) => {
    const value = Math.max(0, Math.min(1, Number(level) || 0));
    stage.style.setProperty("--level", value.toFixed(3));
  });

  api.settings.onChange?.(async (settings) => {
    setLanguage(settings.uiLanguage ?? "pl");
    await applyMode(settings.widget?.mode);
    applyLanguage(settings);
    renderList();
    translateTree();
  });

  /* ── Start ──────────────────────────────────────────────────── */

  (async function boot() {
    const settings = await api.settings.get();
    setLanguage(settings.uiLanguage ?? "pl");
    mode = settings.widget?.mode === "desk" ? "desk" : "compact";
    stage.dataset.mode = mode;
    buildPalette();
    applyLanguage(settings);
    await layout("badge");
    paintGenie(0);
    await refresh();
    // Talia mogła zostać rozłożona przed przeładowaniem widgetu — znaczek
    // pyta o stan, zamiast zakładać, że wszystko jest schowane.
    deck = mode === "desk" && (await api.deck.state()).open;
    renderDeck();
    translateTree();
  })();
})();
