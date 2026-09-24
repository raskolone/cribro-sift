"use strict";

/**
 * Kartka na pulpicie — jedna notatka we własnym okienku.
 *
 * Okno tworzy i stawia proces główny (patrz „Kartki na pulpicie"
 * w main/main.js); tutaj jest to, czego on nie widzi: treść notatki,
 * kursor i ruch rozwijania.
 *
 * Trzy rzeczy warto wiedzieć, zanim się to czyta:
 *
 *   1. TREŚĆ IDZIE PRZEZ TEN SAM EDYTOR co Notatnik (js/editor.js) i ten
 *      sam arkusz (css/prose.css). To jest cel, nie oszczędność: notatka
 *      ma na pulpicie wyglądać tak samo jak w środku aplikacji, razem
 *      z nagłówkami, listą zadań i cytatem. Formatowanie liczone drugi raz,
 *      po swojemu, rozjechałoby się przy pierwszej zmianie w tamtym.
 *
 *   2. ROZWIJANIE NIE JEST TU DECYZJĄ. Kartka nie wie, ile jest innych
 *      kartek ani która jest w kolejności — dostaje gotowe opóźnienie
 *      i kierunek, a melduje wyłącznie koniec składania, bo dopiero wtedy
 *      wolno schować okno.
 *
 *   3. SKALA PRZYCHODZI Z ZEWNĄTRZ. Ekran, na którym kartka leży, zna
 *      tylko proces główny — i tylko on wie, że kartkę przeciągnięto
 *      na drugi monitor.
 */

(function () {
  const api = window.cribro;
  const {
    titleOf,
    rawTitle,
    saveTitle,
    countWords,
    colorOf,
    NOTE_COLORS,
    TEXT_COLORS,
    renameInPlace,
    ensureIcons,
    actionBar,
    paintActions,
    runAction,
    fitMenu,
    runShare,
    dateStamp,
  } = window.NotesCore;
  const $ = (selector) => document.querySelector(selector);

  const params = new URLSearchParams(location.search);
  const noteId = params.get("note");
  const SAVE_DELAY = 450;

  const card = $("#card");
  const stage = document.documentElement;

  let note = null;
  let saveTimer = null;
  let runtime = "idle";

  let linkCards = null;

  const editor = window.CribroEditor.create($("#text"), {
    onInput: () => {
      scheduleSave();
      /* Pisanie zmienia to, co pasek ma podświetlone: „- " zamienione przez
         edytor w listę (patrz #autoList w js/editor.js) ma zapalić kropki
         w tej samej chwili, w której punkt pojawia się w tekście. */
      refreshTools();
    },
  });

  if (window.LinkCardManager) {
    linkCards = new window.LinkCardManager($("#text"), {
      onSave: (cards) => {
        if (!note) return;
        note.linkCards = cards;
        scheduleSave();
      },
    });
  }

  $("#text").addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text && linkCards) {
      void linkCards.handlePaste(text);
    }
  });

  /* Pulsar: kartka ożywa (klasa sticky-focused) gdy kursor stoi w edytorze,
     a gaśnie płynnie po jego opuszczeniu. Zdarzenia są na ELEMENCIE #text,
     bo tam jest contenteditable — edytor nie eksponuje własnych callbacki fokusu. */
  $("#text").addEventListener("focus", () => card.classList.add("sticky-focused"));
  $("#text").addEventListener("blur",  () => card.classList.remove("sticky-focused"));

  /* Pasek czynności — ten sam, co pod notatką w Notatniku. Bez „Na pulpit":
     kartka już na nim leży, a zdejmuje ją krzyżyk w nagłówku, więc drugi
     przycisk od tego samego byłby pytaniem, czym się różnią. */
  ensureIcons(document);
  $("#acts").outerHTML = actionBar({ skip: ["desktop"] });

  /* ── Narzędzia pisania ──────────────────────────────────────────
     Cała robota siedzi w js/editor.js — tak samo jak w Notatniku (patrz
     applyFormat w js/notes.js). Tutaj zostaje jedno wywołanie i odświeżenie
     paska, żeby przyciski pokazywały, co jest włączone tam, gdzie stoi
     kursor. Znaczki w pasku i skróty niżej to są DWIE DROGI DO TEGO SAMEGO,
     a nie dwie funkcje: ta sama metoda edytora, ten sam zapis w pliku.

     Trzeciej drogi — samego pisania — nie ma tu w ogóle i to jest w tym
     najważniejsze. „- ", „1. " i „[] " na początku linii robią listę same,
     bo robi to edytor, ten sam w każdym oknie. Kartka nie ma z tego powodu
     ani jednej linijki kodu i nie ma jej mieć: wypunktowanie liczone drugi
     raz, po swojemu, rozjechałoby się z Notatnikiem przy pierwszej zmianie
     w tamtym. */

  function applyFormat(kind, value) {
    editor.format(kind, value);
    refreshTools();
  }

  /** Podświetlenie paska: co jest włączone tam, gdzie stoi kursor. */
  function refreshTools() {
    const active = editor.activeFormats();
    for (const button of document.querySelectorAll("[data-format]")) {
      button.setAttribute("aria-pressed", String(!!active[button.dataset.format]));
    }
    refreshTextColor(active.color);
  }

  /* ── Kolor tekstu ──────────────────────────────────────────────
     Wybierak wysuwa się spod paska narzędzi, tak jak paleta koloru kartki
     spod nagłówka — ten sam gest, inne miejsce. Klucz jedzie prosto do
     shared/richtext.js (patrz #applyColor w js/editor.js), więc paleta tu
     ma dokładnie te same klucze, co tam. */

  function buildTextColors() {
    $("#textColors").innerHTML = TEXT_COLORS.map(
      ([key, label, hex]) => `
        <button type="button" data-text-color="${key}" title="${label}"
                aria-pressed="false" style="--text-color-dot: ${hex}">
          <span class="dot"></span>
        </button>`,
    ).join("");
  }

  /** Kropka na znaczku i zaznaczenie w popowerze pokazują kolor pod kursorem. */
  function refreshTextColor(key) {
    const entry = TEXT_COLORS.find(([k]) => k === key) ?? TEXT_COLORS[0];
    $("#textColor").style.setProperty("--text-color-dot", entry[2]);
    for (const button of $("#textColors").querySelectorAll("[data-text-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.textColor === entry[0]));
    }
  }

  const showTextColors = (open) => {
    $("#textColors").hidden = !open;
    $("#textColor").setAttribute("aria-expanded", String(!!open));
  };

  /* Data i godzina w miejscu kursora — jedna rzecz, po którą na kartce
     leżącej przy pracy sięga się równie często co po listę: „14:30 — " przed
     zdaniem robi z notatki zapis przebiegu dnia. Znacznik niesie DATĘ I
     GODZINĘ, bo sama godzina gubi się nazajutrz (patrz dateStamp
     w js/notes-core.js) — i jest tym samym znacznikiem co w Notatniku. */
  function insertStamp() {
    editor.insertText(`${dateStamp()} — `);
  }

  /* Naciśnięcie przycisku paska nie ma zabierać zaznaczenia z tekstu —
     inaczej „B" pogrubiałoby to, co przed chwilą było zaznaczone, albo nic,
     a znacznik czasu wpadałby na koniec notatki zamiast tam, gdzie stoi
     kursor. Osobny nasłuch, bo ten wyżej melduje kliknięcie procesowi
     głównemu i ma dochodzić zawsze. */
  document.addEventListener("mousedown", (event) => {
    if (event.target.closest("[data-format], #stamp, #textColor, #textColors [data-text-color]")) {
      event.preventDefault();
    }
  });

  document.addEventListener("selectionchange", () => {
    if (document.activeElement === $("#text")) refreshTools();
  });

  /* ── Skala ekranu ───────────────────────────────────────────── */

  function applyScale(scale) {
    const k = Number(scale);
    if (!Number.isFinite(k) || k <= 0) return;
    stage.style.setProperty("--k", String(k));
    stage.style.setProperty("--k1", String(1 / k));
  }

  /* ── Rozwijanie ─────────────────────────────────────────────────
     Animacja jest w CSS (patrz sticky.html), a tutaj zostaje to, czego
     CSS nie umie: który kierunek, jakie opóźnienie i co zrobić, gdy ruch
     dobiegnie końca. Klasa zdejmowana i zakładana od nowa restartuje
     animację — bez tego druga taka sama nie zagrałaby wcale. */

  function fold({ dir, delay = 0, gen }) {
    card.style.setProperty("--delay", `${delay}ms`);
    delete card.dataset.fold;
    // Wymuszony przeliczony układ: bez tego przeglądarka skleiłaby zdjęcie
    // i założenie atrybutu w jedną zmianę i animacja by nie ruszyła.
    void card.offsetWidth;
    card.dataset.fold = dir;

    /* Wyłącznik talii wraca w położenie „włączony" razem z kartką. Okno nie
       jest zamykane, tylko chowane (patrz hideDeck w main/main.js), więc bez
       tego kartka wracałaby na pulpit z dźwignią przełożoną na „zgaszone" —
       czyli z wyłącznikiem mówiącym coś przeciwnego niż to, co widać. */
    if (dir === "out") delete $("#hideAll").dataset.off;

    if (dir !== "in") return;
    const done = () => {
      card.removeEventListener("animationend", done);
      api.deck.folded(gen);
    };
    card.addEventListener("animationend", done);
  }

  /* ── Treść ──────────────────────────────────────────────────── */

  async function load() {
    const all = await api.notes.get();
    note = all.find((item) => item.id === noteId) ?? null;
    if (!note) return;
    render();
  }

  function render() {
    showTitle();
    editor.setMarkdown(note.text);
    linkCards?.loadNote(note);
    paint();
    setWords();
    refreshTools();
  }

  /* ── Kolor ──────────────────────────────────────────────────────
     Kolor podmienia trzy odcienie podłoża i krawędź (patrz [data-color]
     w css/tokens.css); gradient, połysk i cień są zapisane przez `var()`
     i przeliczają się same. Kartka wygląda więc dokładnie tak samo,
     tylko w innym kolorze — o to chodziło. */

  function buildPalette() {
    $("#palette").innerHTML = NOTE_COLORS.map(
      ([key, label]) => `
        <button data-color="${key}" title="${label}" aria-pressed="false">
          <span class="swatch"></span>
        </button>`,
    ).join("");
  }

  function paint() {
    paintActions(document, note);
    const color = colorOf(note);
    card.dataset.color = color;
    $("#paint").dataset.color = color;
    for (const button of $("#palette").querySelectorAll("[data-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.color === color));
    }
  }

  const showPalette = (open) => {
    $("#palette").hidden = !open;
    $("#paint").setAttribute("aria-expanded", String(!!open));
  };

  async function setColor(color) {
    if (!note) return;
    note.color = color;
    paint();
    showPalette(false);
    await api.notes.update(note.id, { color });
  }

  /* ── Tytuł ──────────────────────────────────────────────────────
     Nagłówek kartki NIE JEST pierwszą linią notatki: nazwa siedzi we
     własnym polu (`note.title`, patrz saveTitle w js/notes-core.js).
     Kartka nazwana „Plan dnia" ma się tak nazywać i mieć w środku plan,
     a nie słowa „Plan dnia" jako pierwsze zdanie — a to właśnie robiło
     wcześniejsze przepisywanie tytułu w treść.

     Skutek uboczny jest zamierzony: od chwili nazwania nagłówek stoi
     w miejscu. Notatka nienazwana dalej podpisuje się pierwszą linią
     i zmienia podpis razem z nią. */

  function startRename() {
    if (!note || note.system) return;
    const target = note;
    renameInPlace($("#title"), {
      text: rawTitle(target),
      onCommit: async (title) => {
        await saveTitle(api, target, title);
        setState(t("Zapisane"));
      },
      onEnd: () => showTitle(target),
    });
  }

  /** Nazwa kartki w belce i w tytule okna — zawsze te same dwa miejsca. */
  function showTitle(target = note) {
    $("#title").textContent = titleOf(target);
    document.title = `${titleOf(target)} — Cribro Sift`;
  }

  function setWords() {
    const n = countWords(note?.text ?? "");
    $("#words").textContent = n === 1 ? t("1 słowo") : t("{n} słów", { n });
  }

  const setState = (label, mark) => {
    const element = $("#state");
    element.textContent = label;
    if (mark) element.dataset.state = mark;
    else delete element.dataset.state;
  };

  function scheduleSave() {
    if (!note) return;
    note.text = editor.getMarkdown();
    setState(t("Zapisuję…"), "saving");
    setWords();
    /* Nienazwana kartka podpisuje się pierwszą linią, więc podpis jedzie
       razem z pisaniem. Nazwana stoi w miejscu — titleOf pilnuje różnicy. */
    showTitle();

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), SAVE_DELAY);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    if (!note) return;
    try {
      const payload = { text: note.text };
      if (note.linkCards !== undefined) payload.linkCards = note.linkCards;
      await api.notes.update(note.id, payload);
      setState(t("Zapisane"));
    } catch (error) {
      setState(String(error.message || error).slice(0, 26));
    }
  }

  /* ── Zdarzenia ──────────────────────────────────────────────── */

  /* Kartka bierze fokus dopiero wtedy, gdy ktoś w nią kliknął. Talia
     wychodzi na pulpit bez ruszania tego, w czym się właśnie pisze —
     a kliknięcie w okno nieaktywnej aplikacji macOS domyślnie połyka. */
  document.addEventListener("mousedown", () => api.deck.grabFocus());

  /* ── Przesuwanie kartki ─────────────────────────────────────────
     Ruch mierzymy na EKRANIE, nie w oknie: okno jedzie za kursorem, więc
     współrzędne w nim stoją w miejscu, choćby kartka przejechała pulpit.

     Próg ruchu godzi dwie rzeczy, które dzieją się na tym samym pasku:
     przeciąganie kartki i podwójne kliknięcie w tytuł. Poniżej progu nic
     się nie przesuwa i kliknięcie zostaje kliknięciem. */

  const DRAG_MIN = 4;
  const head = document.querySelector(".head");
  let grab = null;
  let moved = false;
  let stackDragMoved = false;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const isStacked = card.dataset.stacked === "true";
    if (!isStacked) {
      if (!event.target.closest(".head")) return;
      if (event.target.closest(".ico") || $("#title").dataset.renaming === "true") return;
    }
    grab = { x: event.screenX - window.screenX, y: event.screenY - window.screenY };
    moved = false;
    stackDragMoved = false;
  };

  const onPointerMove = (event) => {
    if (!grab) return;
    const point = { x: event.screenX - grab.x, y: event.screenY - grab.y };
    if (!moved) {
      if (Math.hypot(point.x - (event.screenX - grab.x), point.y - (event.screenY - grab.y)) < DRAG_MIN &&
          Math.hypot(event.screenX - (window.screenX + grab.x), event.screenY - (window.screenY + grab.y)) < DRAG_MIN) {
        return;
      }
      moved = true;
      if (card.dataset.stacked === "true") {
        stackDragMoved = true;
        card.dataset.drag = "true";
      } else {
        head.dataset.drag = "true";
      }
      try {
        (card.dataset.stacked === "true" ? card : head).setPointerCapture(event.pointerId);
      } catch {}
    }
    api.deck.move(point);
  };

  const dropCard = (event) => {
    if (!grab) return;
    grab = null;
    delete head.dataset.drag;
    delete card.dataset.drag;
    if (moved) {
      try {
        (card.dataset.stacked === "true" ? card : head).releasePointerCapture(event.pointerId);
      } catch {
        /* przechwycenia już nie ma */
      }
      api.deck.drop(noteId);
      setTimeout(() => {
        stackDragMoved = false;
      }, 50);
    }
  };

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", dropCard);
  document.addEventListener("pointercancel", dropCard);

  document.addEventListener("contextmenu", (event) => {
    if (card.dataset.stacked === "true") {
      event.preventDefault();
      event.stopPropagation();
      api.deck.showStackMenu?.({ screenX: event.screenX, screenY: event.screenY });
    }
  });

  /* ── Rozmiar kartki ─────────────────────────────────────────────
     Ta sama zasada co przy przesuwaniu: liczymy w pikselach EKRANU, bo
     okno zmienia rozmiar pod kursorem i współrzędne w nim uciekają. Róg
     jest jeden — prawy dolny — więc kartka rośnie w prawo i w dół, a jej
     lewy górny róg zostaje tam, gdzie się ją położyło.

     Skala ekranu (--k) nie wchodzi w ten rachunek: uchwyt jest narysowany
     w skali kartki, ale mysz mierzy się pikselami ekranu i tyle samo
     dostaje okno. */

  const grip = $("#grip");
  let sizing = null;

  const sendSize = (event, commit) => {
    if (!sizing) return;
    api.deck.resize({
      id: noteId,
      width: sizing.w + (event.screenX - sizing.sx),
      height: sizing.h + (event.screenY - sizing.sy),
      commit,
    });
  };

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sizing = { sx: event.screenX, sy: event.screenY, w: window.innerWidth, h: window.innerHeight };
    grip.dataset.drag = "true";
    grip.setPointerCapture(event.pointerId);
  });

  grip.addEventListener("pointermove", (event) => sendSize(event, false));

  const dropGrip = (event) => {
    if (!sizing) return;
    sendSize(event, true);
    sizing = null;
    delete grip.dataset.drag;
    try {
      grip.releasePointerCapture(event.pointerId);
    } catch {
      /* przechwycenia już nie ma */
    }
  };

  grip.addEventListener("pointerup", dropGrip);
  grip.addEventListener("pointercancel", dropGrip);

  $("#title").addEventListener("dblclick", () => startRename());

  document.addEventListener("click", async (event) => {
    // Kliknięcie w dowolną część zwiniętego stosiku kart rozwija go z powrotem.
    // Jeśli użytkownik przeciągał stosik (stackDragMoved), nie rozwijamy!
    if (card.dataset.stacked === "true") {
      if (stackDragMoved) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      await api.deck.unstack();
      return;
    }

    const swatch = event.target.closest("#palette [data-color]");
    if (swatch) return setColor(swatch.dataset.color);
    if (event.target.closest("#paint")) return showPalette($("#palette").hidden);
    // Klik gdziekolwiek indziej zamyka paletę — tak jak każde menu.
    showPalette(false);

    const textColor = event.target.closest("#textColors [data-text-color]");
    if (textColor) {
      applyFormat("color", textColor.dataset.textColor);
      showTextColors(false);
      return;
    }
    if (event.target.closest("#textColor")) return showTextColors($("#textColors").hidden);
    showTextColors(false);

    const tool = event.target.closest("[data-format]");
    if (tool) return applyFormat(tool.dataset.format);
    if (event.target.closest("#stamp")) return insertStamp();
    if (event.target.closest("#stackAll, #hideAll")) return void stackDeck();

    /* Zwinięcie do nagłówka. Stan trzyma proces główny razem z resztą
       geometrii kartki — bo to on zmienia wysokość okna, a kartka ma
       wracać zwinięta także po ponownym wyłożeniu talii. */
    if (event.target.closest("#roll")) {
      const rolled = card.dataset.rolled !== "true";
      card.dataset.rolled = rolled ? "true" : "false";
      $("#roll").title = window.t(rolled ? "Rozwiń kartkę" : "Zwiń do nagłówka");
      if (note) await api.deck.roll(note.id, rolled);
      return;
    }
    if (event.target.closest("#expand")) {
      await flushSave();
      if (note) await api.notes.openWindow(note.id);
      return;
    }
    if (event.target.closest("#dismiss")) {
      await flushSave();
      if (note) await api.deck.dismiss(note.id);
      return;
    }

    /* ── Pasek czynności ──
       Zapis idzie PRZED czynnością i nie jest to ostrożność na wyrost:
       kartka zapisuje się z opóźnieniem (SAVE_DELAY), więc „Udostępnij"
       naciśnięte zaraz po dopisaniu zdania wysłałoby notatkę bez niego,
       a „Przesiej" przesiałoby wersję sprzed pół sekundy. */
    const shareTo = event.target.closest("[data-share]");
    if (shareTo) {
      closeShare();
      await flushSave();
      try {
        await runShare(shareTo.dataset.share, note, { api, say: (text) => text && setState(text) });
      } catch (problem) {
        setState(String(problem.message || problem), "error");
      }
      return;
    }

    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "share") {
      const menu = document.querySelector('[data-acts-menu="share"]');
      const btn = event.target.closest('[data-act="share"]');
      if (menu) {
        const willOpen = menu.hidden;
        menu.hidden = !menu.hidden;
        btn?.setAttribute("aria-expanded", String(willOpen));
      }
      /* Kartka bywa węższa niż samo menu — tu domknięcie do krawędzi jest
         potrzebne najbardziej z całej trójki okien. */
      fitMenu(menu);
      return;
    }
    closeShare();
    if (!act || !note) return;

    await flushSave();
    try {
      /* Skasowanie zamyka to okno — ale nie stąd. Kartkę niszczy proces
         główny w obsłudze `notes:delete`, razem z jej wpisem w talii;
         zamykanie jej jeszcze raz z tej strony byłoby wyścigiem z kodem,
         który już to robi. Dlatego wynik `runAction` nas tu nie obchodzi. */
      await runAction(act, note, {
        api,
        say: (text) => text && setState(text),
        after: () => paint(),
      });
    } catch (problem) {
      setState(String(problem.message || problem), "error");
    }
  });

  /** Menu „Udostępnij" zamyka się tak samo jak paleta kolorów: byle czym. */
  function closeShare() {
    const menu = document.querySelector('[data-acts-menu="share"]');
    if (menu) menu.hidden = true;
    document.querySelector('[data-act="share"]')?.setAttribute("aria-expanded", "false");
  }

  /* ── „Zwiń w stosik" ─────────────────────────────────────────────
     Zwija WSZYSTKIE aktywne kartki w fizyczny stosik kart w stronę tej kartki,
     natychmiast odsłaniając pulpit pod spodem do pracy z innymi oknami.
     Kliknięcie w stosik płynnie rozsuwa kartki z powrotem. */
  async function stackDeck() {
    await flushSave();
    await api.deck.stack(true, noteId);
  }

  /* Escape zdejmuje po jednej warstwie, od wierzchu — tak samo jak
     w Notatniku i w widgecie: najpierw trwające nagranie, potem stosik. */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    api.deck.closeStackMenu?.();
    if (runtime === "listening") return void api.system.cancelCapture?.();
    if (!$("#palette").hidden) return showPalette(false);
    if (card.dataset.stacked === "true") return void api.deck.unstack();
    void stackDeck();
  });

  /* ── Skróty formatowania ────────────────────────────────────────
     Te same cztery co w Notatniku (patrz keydown w js/notes.js), bo notatka
     jest jedna i ma się w niej pisać tak samo, w którymkolwiek oknie akurat
     stoi kursor. ⌘B i ⌘I obsługuje sam edytor, więc ich tu nie ma —
     powtórzone byłyby drugim przełączeniem tego samego. */

  const FORMAT_KEYS = {
    7: "numbered",
    "&": "numbered",
    8: "bullet",
    "*": "bullet",
    9: "todo",
    "(": "todo",
    "'": "quote",
    '"': "quote",
  };

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !event.metaKey) return;
    // ⌘T bez Shifta — ten sam klawisz co w Notatniku.
    if (!event.shiftKey) {
      if (event.key !== "t") return;
      event.preventDefault();
      return insertStamp();
    }
    const kind = FORMAT_KEYS[event.key];
    if (!kind) return;
    event.preventDefault();
    applyFormat(kind);
  });

  /* Notatka bywa otwarta w kilku miejscach naraz — kartka, Notatnik,
     zakładka w oknie głównym. Zmiana z każdego z nich ma być tu widoczna
     od razu, ale NIE POD PALCAMI PISZĄCEGO: podmiana treści w trakcie
     pisania zabrałaby kursor w połowie słowa. */
  api.notes.onChanged?.(async ({ id } = {}) => {
    if (id && id !== noteId) return;
    if (document.activeElement === $("#text")) return;
    await load();
  });

  api.notes.onAppended?.(async ({ id }) => {
    if (id !== noteId) return;
    await load();
    editor.focusEnd();
    setState(t("Zapisane"));
  });

  api.deck.onFold?.(fold);
  api.deck.onScale?.(applyScale);
  api.deck.onStack?.(({ stacked, rot = 0, isTop = false }) => {
    if (stacked) {
      card.dataset.stacked = "true";
      card.dataset.stackedTop = String(isTop);
      card.style.setProperty("--stack-rot", `${rot}deg`);
    } else {
      delete card.dataset.stacked;
      delete card.dataset.stackedTop;
      card.style.removeProperty("--stack-rot");
    }
  });
  /* Kartka założona plusikiem — kursor stoi w niej od pierwszej chwili.
     Zwykłe wyłożenie talii tego nie robi i nie ma robić: talia wychodzi
     obok tego, co ktoś właśnie pisze gdzie indziej. */
  api.deck.onWrite?.(() => editor.focusEnd());

  /* Kartka pokazuje nagrywanie samą belką — jej tło robi się czerwone,
     tak samo jak znaczek w pasku menu. Przycisku mikrofonu w belce NIE MA
     i to jest decyzja: dyktowanie do notatki ma skrót klawiaturowy, a pasek
     kartki jest wąski i ma mieścić tytuł, nie rząd guzików. */
  api.onState?.(({ state }) => {
    runtime = state;
    card.dataset.state = state;
  });


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

  api.settings.onChange?.((settings) => {
    setLanguage(settings.uiLanguage ?? "pl");
    applyTextSize(settings);
    if (note) setWords();
    translateTree();
  });

  window.addEventListener("beforeunload", () => void flushSave());

  /* ── Zwijanie w stosik przy kliknięciu poza notatką ────────────────────────
     Gdy okno kartki traci fokus (użytkownik kliknął w pulpit, inną aplikację
     lub inny obszar), powiadamiamy proces główny przez IPC.
     Proces główny sprawdza, czy ŻADNA kartka nie ma fokusu i dopiero wtedy
     zwija talie w stosik. Dzięki temu klikanie między kartkami nie składa
     ich w stosik — tylko przejście poza aplikację to robi. */
  window.addEventListener("blur", () => {
    if (card.dataset.stacked === "true") return;
    if (card.dataset.rolled === "true") return;
    api.deck.stickyBlurred?.();
  });


  /* ── Start ──────────────────────────────────────────────────── */

  /* Kartka czeka na rozwinięcie z opacity: 0 — inaczej mrugałaby gotowa
     przez jedną klatkę, zanim ruch się zacznie. Czekanie bez końca byłoby
     jednak gorsze od mrugnięcia: przeładowany renderer (albo podgląd
     w przeglądarce) nie dostanie już polecenia, które poszło przed jego
     startem, i notatka zostałaby pustym prostokątem. Po chwili rozwijamy
     się więc sami. */
  function unfoldAnyway() {
    if (!card.dataset.fold) fold({ dir: "out", delay: 0 });
  }

  (async function boot() {
    applyScale(params.get("scale") ?? 1);
    // Kartka wyłożona zwiniętą wraca zwinięta — inaczej „zwiń" znaczyłoby
    // „schowaj do następnego razu", a to jest zupełnie inna obietnica.
    if (params.get("rolled") === "1") {
      card.dataset.rolled = "true";
      $("#roll").title = "Rozwiń kartkę";
    }
    buildPalette();
    buildTextColors();
    setTimeout(unfoldAnyway, 400);
    const settings = await api.settings.get();
    setLanguage(settings.uiLanguage ?? "pl");
    applyTextSize(settings);
    await load();
    translateTree();
  })();
})();
