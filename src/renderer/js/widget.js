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
  /* Spotkanie: czy nagranie trwa i czy na ekranie stoi rozmowa, o którą
     jeszcze nie zapytano. Oba stany przychodzą jedną wiadomością z procesu
     głównego, bo znaczek rysuje z nich jeden stan. */
  let meeting = { recording: false, spotted: null };

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
     nie czekając na odpowiedź.

     SKRÓT MA KLAMRĘ i to ona pilnuje, żeby nie zrobił szkody większej niż
     przeskok, przed którym broni. Działa przy założeniu, że znaczek stoi
     na ekranie tam, gdzie stał — a to nieprawda dokładnie wtedy, gdy oknem
     ruszył ktoś inny niż my: po odłączeniu monitora kotwica sprzed zmiany
     jest o pół pulpitu obok i różnica wypadałaby daleko POZA okno. Okno
     przycina zawartość, więc znaczek nie przeskoczyłby — po prostu by
     zniknął. Zaraz potem i tak przychodzi świeża geometria (onGeometry
     niżej); klamra ma tylko przetrwać te kilka klatek na ekranie. */
  window.addEventListener("resize", () => {
    if (!Number.isFinite(geom.sx) || !Number.isFinite(geom.sy)) return;
    const inside = (value, span) => Math.min(Math.max(value, 0), span);
    stage.style.setProperty("--ax", `${inside(geom.sx - window.screenX, window.innerWidth)}px`);
    stage.style.setProperty("--ay", `${inside(geom.sy - window.screenY, window.innerHeight)}px`);
  });

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
    /* Uchwyt do przenoszenia linii żyje w kartce, ale leży w <body> i stoi
       na współrzędnych ekranu — więc zwinięcie kartki go nie zabiera.
       Zostawiony wisi obok znaczka jako sześć kropek. */
    if (next !== "sticky") editor.parkGrip?.();
  }

  /* Stan okna, o który prosimy proces główny. Widoków jest cztery, rozmiarów
     okna DWA: znaczek dzieli okno ze zwiniętą tacą, a lista z kartką. */
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

    /* Taca mieszka w tym samym oknie co znaczek, więc jej zwinięcie jest
       samym zdjęciem atrybutu: nie ma czego kurczyć i nie ma na co czekać.
       Wcześniej stało tu trzysta milisekund zwłoki na animację i dopiero
       potem zmiana rozmiaru okna — przez ten czas widget był `busy`
       i ręka wracająca na znaczek nie miała czego otworzyć. */
    if (view === "tray") {
      setView("badge");
      api.widget.release();
      return void settleHover();
    }

    busy = true;
    const fold = view === "list" ? 260 : 0;
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

  /** Taca. Okno jest już na nią gotowe (patrz placeWidget w main/main.js),
      więc rozłożenie kółek jest samym atrybutem — bez pytania procesu
      głównego i bez ani jednej klatki, w której znaczek stoi obok siebie. */
  function toTray() {
    if (busy || view !== "badge") return;
    setView("tray");
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
    /* Pokrętła zostają rozłożone: po przestawieniu chce się zobaczyć wynik,
       a często kliknąć jeszcze raz. Reszta otwiera okno albo zaczyna
       nagrywanie i taca nie ma tam czego szukać. */
    if (action === "language" || action === "sieve") return;
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

  /* ── Gęstość sita na tacy ───────────────────────────────────────
     Pokrętło o trzech położeniach. Położenie widać po gałce na suwaku,
     a nazwę i opis niesie dymek — razem tyle, ile mówił widok „Sito"
     w oknie aplikacji, po które trzeba było wcześniej sięgać. */

  const MESH_ORDER = ["zgrubne", "srednie", "drobne"];
  const MESH_NAME = { zgrubne: "Zgrubne", srednie: "Średnie", drobne: "Drobne" };
  /* Opisy jeden w jeden z main/sieve.js — te same zdania stoją w pasku menu
     i w oknie aplikacji, więc mają już swoje tłumaczenia. */
  const MESH_HINT = {
    zgrubne: "Zostaje prawie wszystko. Znikają tylko zacięcia.",
    srednie: "Czysta wypowiedź, twój głos.",
    drobne: "Zwięźle i formalnie. Gotowe do wysłania.",
  };

  function applyMesh(settings) {
    const mesh = MESH_ORDER.includes(settings.mesh) ? settings.mesh : "srednie";
    $("#meshMark").setAttribute("href", `#w-mesh-${MESH_ORDER.indexOf(mesh) + 1}`);
    $("#slotMesh").dataset.mesh = mesh;
    $("#meshTip").textContent = `${t("Gęstość sita")} — ${t(MESH_NAME[mesh])}`;
    // Opis idzie w tytuł okna gniazda: dymek ma jedną linijkę, a przy
    // dłuższym najechaniu system i tak pokaże pełne zdanie.
    $("#slotMesh").title = `${t(MESH_NAME[mesh])} — ${t(MESH_HINT[mesh])}`;
  }

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

  /**
   * Nowa kartka na pulpicie — i notatka w oknie głównym. Jedno i to samo.
   *
   * ZWYKŁA notatka, a nie szybka, i to jest tu cała różnica. Wcześniej
   * szło stąd `kind: "quick"`, przez co notatka lądowała w oknie głównym
   * w przegródce „Szybkie notatki" (patrz groupNotes w js/notes-core.js).
   * To jest przegródka na myśli rzucone w biegu, w małym okienku, w
   * trakcie rozmowy — a plusik zakłada notatkę, którą się potem pisze
   * i do której się wraca. Wpadała więc między rzeczy jednorazowe.
   *
   * `widget: true` znaczy, że kartka od razu leży na pulpicie: po to
   * sięga się po ten przycisk. Jedna rzecz widoczna z dwóch stron, a nie
   * dwa rodzaje notatki zależnie od tego, skąd powstała.
   *
   * Wołają to DWA przyciski — plusik w tacy (obok „Notatek") i plusik
   * w nagłówku listy. Obydwa mają zakładać dokładnie to samo, więc mają
   * jedno miejsce, w którym to robią.
   *
   * ══ GDZIE NOWA NOTATKA MA SIĘ POJAWIĆ ══
   *
   * Tam, gdzie w tym trybie mieszkają notatki — a tryby są dwa i mieszkają
   * w nich gdzie indziej.
   *
   * W trybie PULPIT notatka to KARTKA NA PULPICIE, w osobnym oknie. Plusik
   * otwierał zamiast niej szybę nad znaczkiem: okno zarządzania notatkami
   * w miejscu, w którym miała powstać notatka. Nowa kartka leżała wtedy na
   * pulpicie dopiero po zamknięciu tej szyby i wyłożeniu talii — czyli po
   * dwóch krokach, o których nikt nie ma powodu wiedzieć.
   *
   * W trybie ZWARTYM kartek na pulpicie nie ma i szyba JEST notatką — tam
   * zostaje po staremu.
   */
  async function newDeskNote() {
    const note = await api.notes.create({ widget: true });
    await refresh();

    if (mode === "desk") {
      /* Kartka na pulpicie, z kursorem w środku. Taca schodzi, bo to nie
         ona jest teraz tym, na co się patrzy. */
      deck = await api.deck.reveal(note.id);
      renderDeck();
      return toBadge();
    }

    /* Od razu otwarta do pisania. Notatka założona i schowana pod listą
       kazałaby ją jeszcze odszukać — a sięga się po plusik wtedy, gdy się
       ma co napisać, nie kiedyś potem. */
    return toSticky(note);
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
      ? window.t("Nagrywam spotkanie — kliknij, żeby zobaczyć notatki")
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
    /* Od tej chwili okno nie dostaje ruchów myszy, więc nic już samo nie
       zniknie. Uchwyt kartki musi więc zejść TERAZ — potem nie będzie
       czym go zdjąć. */
    if (ignore) editor.parkGrip?.();
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
    if (view === "tray") for (const slot of slots) boxes.push(slot.getBoundingClientRect());
    if (view === "list" || view === "sticky") boxes.push(panel.getBoundingClientRect());
    return boxes.some((r) => inBox(r, x, y));
  }

  /* Dymek z pytaniem osobno od reszty i to nie jest drobiazg: kliknięcia
     musi łapać (są w nim dwa przyciski), ale tacy rozkładać NIE ma. Ręka
     idzie tam po „Notuj", a nie po dyktowanie — a pięć kółek wyjeżdżających
     spod znaczka w chwili, gdy się celuje w przycisk, jest dokładnie tym
     rodzajem ruchu, przez który się w niego nie trafia. */
  function overAsk(x, y) {
    const ask = $("#ask");
    return !ask.hidden && inBox(ask.getBoundingClientRect(), x, y);
  }

  /* ══ PODNIESIENIE ZNACZKA LICZYMY SAMI, NIE Z :hover ══

     Znaczek rośnie pod kursorem — i to powiększenie też potrafiło szarpać.
     Powód jest ten sam, dla którego wyżej stoją prostokąty zamiast :hover:
     przepuszczanie kliknięć włącza się i wyłącza w trakcie ruchu ręki,
     a razem z nim okno raz po raz przestaje dostawać zdarzenia myszy.
     Przeglądarka gubi wtedy stan najechania i zakłada go z powrotem —
     a przejście z odbiciem (--t-lift) startuje przy każdym takim zgubieniu
     od nowa, w połowie poprzedniego ruchu.

     Ten sam rachunek co przy tacy daje stan, który się nie miga. Sam
     znaczek, nie cała taca: kursor stojący na kółku tacy nie jest powodem,
     żeby podnosić znaczek. */
  function nearBadge(x, y) {
    return inBox(badge.getBoundingClientRect(), x, y);
  }

  function setNear(near) {
    const value = near ? "true" : "false";
    if (stage.dataset.near !== value) stage.dataset.near = value;
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
    const onAsk = overAsk(event.clientX, event.clientY);
    const over = onAsk || overUs(event.clientX, event.clientY);
    setPassthrough(!over);
    setNear(nearBadge(event.clientX, event.clientY));

    // Przy rozwiniętej szybie taca nie ma nic do roboty: notatki są już na
    // wierzchu, a kółka pod nimi byłyby drugim menu do tego samego.
    if (view === "list" || view === "sticky") return;

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
     tylko to zdarzenie. Bez niego taca zostałaby rozłożona i dalej łapałaby
     kliknięcia należne temu, co pod nią leży. */
  document.addEventListener("mouseleave", () => {
    if (grab || sizing) return;
    setPassthrough(true);
    setNear(false);
    clearTimeout(leaveTimer);
    hovering = false;
    settleHover();
  });

  /* ── Przeciąganie ───────────────────────────────────────────── */

  const DRAG_MIN = 4;
  let grab = null;
  let moved = false;
  let swallowClick = false;

  /* Chwyt zapamiętujemy jako KOTWICĘ EKRANOWĄ i przesunięcie od niej —
     nie jako odstęp od środka znaczka wewnątrz okna.

     Różnica wygląda na kosmetyczną, a jest powodem szarpnięć. Odstęp
     liczony w oknie (clientX − geom.ax) jest prawdziwy tylko dopóki okno
     ma ten sam rozmiar i znaczek to samo miejsce w środku. A w trakcie
     przeciągania nie ma: taca chowa się na pierwszym ruchu, więc okno
     kurczy się do samego znaczka, `geom.ax` skacze na nową wartość —
     a zapamiętany odstęp zostaje stary. Znaczek przeskakiwał wtedy o całą
     szerokość tacy, dokładnie w chwili, w której ręka ruszała.

     Kotwica ekranowa nie wie nic o oknie i dlatego nie ma po czym skoczyć:
     nowe miejsce to stare plus tyle, ile przejechała ręka. Ten sam wzór,
     na którym stoi rozciąganie szyby uchwytem (patrz `sizing` wyżej). */
  badge.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0) return;
    /* Znaczek rusza — a razem z nim całe okno. Wszystko, co stoi na
       współrzędnych okna, a nie należy do znaczka, musi wtedy zejść:
       uchwyt kartki pojechałby z oknem jako sześć kropek obok znaczka. */
    editor.parkGrip?.();
    grab = { sx: event.screenX, sy: event.screenY };
    moved = false;
    badge.setPointerCapture(event.pointerId);
    await api.widget.dragStart();
  });

  /* Ruch służy tu WYŁĄCZNIE do tego, żeby wiedzieć, że przeciąganie się
     zaczęło — okno przesuwa proces główny, klatka po klatce, z prawdziwego
     położenia kursora. Renderer nie liczy tu już żadnych współrzędnych
     i to jest cała poprawka: policzone tutaj były z definicji spóźnione
     o jedno przesunięcie okna. */
  badge.addEventListener("pointermove", (event) => {
    if (!grab || moved) return;
    if (Math.hypot(event.screenX - grab.sx, event.screenY - grab.sy) < DRAG_MIN) return;
    moved = true;
    badge.dataset.drag = stage.dataset.drag = "true";
    // Taca znika na czas przeciągania. W nowym miejscu może wychodzić
    // w inną stronę niż w starym, a przeliczanie tego co klatkę byłoby
    // migotaniem czterech kółek wokół ręki.
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

    // Puszczenie po przeciągnięciu nie może rozwinąć listy — kliknięcie
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
    // Bez tego pętla w procesie głównym zostałaby włączona na zawsze
    // i znaczek chodziłby za kursorem po całym ekranie.
    applyGeometry((await api.widget.dragEnd())?.spot);
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
    /* Pytanie o notatki ze spotkania. Przed znaczkiem, bo dymek leży
       tuż obok niego i kliknięcie w przycisk nie ma prawa być przy okazji
       kliknięciem w znaczek. */
    if (event.target.closest("#askYes")) return void api.meetings.answer(true);
    if (event.target.closest("#askNo")) return void api.meetings.answer(false);

    /* ══ ZNACZEK NIE OTWIERA OKNA APLIKACJI — NIGDY, ŻADNYM STANEM ══

       Nawet w trakcie nagrywania. Okno aplikacji ma dokładnie jedną drogę
       z widgetu — gniazdo „Otwórz Cribro Sift" w rozłożonej tacy (patrz
       action === "app" w main/main.js) — i to jest jedyne miejsce, które
       samo z siebie wywołuje coś większego niż stickies. Wcześniej stał tu
       wyjątek: w trakcie nagrywania klik w sam znaczek wołał okno na
       zakładkę Spotkania. Kończyło się to oknem wyskakującym nad cudzą
       pracą przy zwyczajnym geście chowania/pokazywania kartek — dokładnie
       tym, przed czym broni reguła w main/main.js przy ipcMain.handle("widget:run", …). */
    if (event.target.closest("#badge") || event.target.closest("#slotNotes")) {
      if (deck) return void hideDeck();
      if (view === "list" || view === "sticky") return void toBadge();
      return mode === "desk" ? toggleDeck() : toList();
    }

    const slot = event.target.closest(".slot[data-do]");
    if (slot) return void runAction(slot.dataset.do);

    if (event.target.closest("#closeList")) return toBadge();
    if (event.target.closest("#back")) return toList();

    /* Plusik w tacy — obok „Notatek", bo to ta sama sprawa: tamto otwiera
       to, co na pulpicie leży, to dokłada tam nową kartkę. Idzie przez tę
       samą drogę co plusik w nagłówku listy, żeby jedno i drugie zakładało
       DOKŁADNIE tę samą notatkę. */
    if (event.target.closest("#slotNewNote")) return void newDeskNote();

    // Plusik w nagłówku listy — ta sama notatka co z tacy.
    if (event.target.closest("#add")) return void newDeskNote();

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
    // Pytanie o spotkanie zdejmuje się jak każde inne — i jest wierzchnią
    // warstwą, bo przyszło samo, bez pytania.
    if (meeting.spotted) return void api.meetings.answer(false);
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

  /* Talia bywa chowana bez udziału znaczka: Escape'em na kartce albo
     Escape'em wciśniętym w cudzej aplikacji. Bez tej wiadomości znaczek
     zostawałby z pamięcią o rozłożonej talii i pierwsze kliknięcie w niego
     szłoby na nic — chowałby coś, czego już nie ma. */
  api.deck.onChange?.(({ open } = {}) => {
    deck = !!open;
    renderDeck();
  });

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


  /* Wielkość pisma na kartce — z ustawień, nie ze skali okna.

     Skala kartki ciągnie za sobą wszystko (transform: scale), więc na
     mniejszym ekranie malał razem z nią także krój pisma i zostawało
     dziesięć pikseli. Kartka nadal skaluje się z pulpitem; pismo w niej
     jest odtąd sprawą człowieka, a nie przekątnej monitora. */
  const TEXT_SIZE = { s: "12px", m: "13.5px", l: "15.5px", xl: "18px" };
  const applyTextSize = (settings) => {
    const chosen = TEXT_SIZE[settings?.widget?.textSize] ?? TEXT_SIZE.m;
    document.documentElement.style.setProperty("--sticky-fs", chosen);
  };

  api.settings.onChange?.(async (settings) => {
    setLanguage(settings.uiLanguage ?? "pl");
    applyTextSize(settings);
    await applyMode(settings.widget?.mode);
    applyLanguage(settings);
    applyMesh(settings);
    renderList();
    translateTree();
  });

  /* ── Start ──────────────────────────────────────────────────── */

  (async function boot() {
    const settings = await api.settings.get();
    setLanguage(settings.uiLanguage ?? "pl");
    applyTextSize(settings);
    mode = settings.widget?.mode === "desk" ? "desk" : "compact";
    stage.dataset.mode = mode;
    buildPalette();
    applyLanguage(settings);
    applyMesh(settings);
    await layout("badge");
    paintGenie(0);
    await refresh();
    // Talia mogła zostać rozłożona przed przeładowaniem widgetu — znaczek
    // pyta o stan, zamiast zakładać, że wszystko jest schowane.
    deck = mode === "desk" && (await api.deck.state()).open;
    renderDeck();
    // Spotkanie mogło się zacząć, zanim widget wstał — pytamy o stan,
    // zamiast zakładać, że nic się nie dzieje.
    applyMeeting(await api.meetings?.state?.());
    translateTree();
  })();
})();
