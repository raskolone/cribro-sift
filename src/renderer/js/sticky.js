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
    retitle,
    countWords,
    colorOf,
    NOTE_COLORS,
    renameInPlace,
    ensureIcons,
    actionBar,
    paintActions,
    runAction,
    runShare,
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

  const editor = window.CribroEditor.create($("#text"), { onInput: () => scheduleSave() });

  /* Pasek czynności — ten sam, co pod notatką w Notatniku. Bez „Na pulpit":
     kartka już na nim leży, a zdejmuje ją krzyżyk w nagłówku, więc drugi
     przycisk od tego samego byłby pytaniem, czym się różnią. */
  ensureIcons(document);
  $("#acts").outerHTML = actionBar({ skip: ["desktop"] });

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
    $("#title").textContent = titleOf(note);
    document.title = `${titleOf(note)} — Cribro Sift`;
    editor.setMarkdown(note.text);
    paint();
    setWords();
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
     Tytuł jest pierwszą niepustą linią notatki, więc przepisanie go jest
     przepisaniem treści — i wraca tą samą drogą co pisanie w kartce. */

  function startRename() {
    if (!note) return;
    const target = note;
    renameInPlace($("#title"), {
      text: rawTitle(target),
      onCommit: async (title) => {
        target.text = retitle(target.text, title);
        editor.setMarkdown(target.text);
        await api.notes.update(target.id, { text: target.text });
        setState(t("Zapisane"));
      },
      onEnd: () => {
        $("#title").textContent = titleOf(target);
        document.title = `${titleOf(target)} — Cribro Sift`;
        setWords();
      },
    });
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
    // Tytuł kartki to pierwsza linia notatki, więc jedzie razem z pisaniem.
    $("#title").textContent = titleOf(note);

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), SAVE_DELAY);
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    if (!note) return;
    try {
      await api.notes.update(note.id, { text: note.text });
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

  head.addEventListener("pointerdown", (event) => {
    // Przyciski i przepisywany tytuł nie są uchwytem — w jednym się klika,
    // w drugim stawia kursor.
    if (event.button !== 0) return;
    if (event.target.closest(".ico") || $("#title").dataset.renaming === "true") return;
    grab = { x: event.screenX - window.screenX, y: event.screenY - window.screenY };
    moved = false;
  });

  head.addEventListener("pointermove", (event) => {
    if (!grab) return;
    const point = { x: event.screenX - grab.x, y: event.screenY - grab.y };
    if (!moved) {
      if (Math.hypot(point.x - window.screenX, point.y - window.screenY) < DRAG_MIN) return;
      moved = true;
      head.dataset.drag = "true";
      /* MYSZ ŁAPIEMY DOPIERO TERAZ, nie przy naciśnięciu.
         Przechwycenie wskaźnika przekierowuje na element chwytający także
         zwykłe `click` i `dblclick` — a wtedy podwójne kliknięcie w tytuł
         dochodzi do paska, nie do tytułu, i tytuł nigdy nie robi się polem.
         Złapane dopiero po przekroczeniu progu ruchu nie wchodzi w drogę
         klikaniu, bo klikanie progu nie przekracza. */
      head.setPointerCapture(event.pointerId);
    }
    api.deck.move(point);
  });

  const dropCard = (event) => {
    if (!grab) return;
    grab = null;
    delete head.dataset.drag;
    if (moved) {
      try {
        head.releasePointerCapture(event.pointerId);
      } catch {
        /* przechwycenia już nie ma */
      }
      api.deck.drop(noteId);
    }
  };

  head.addEventListener("pointerup", dropCard);
  head.addEventListener("pointercancel", dropCard);

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
    const swatch = event.target.closest("#palette [data-color]");
    if (swatch) return setColor(swatch.dataset.color);
    if (event.target.closest("#paint")) return showPalette($("#palette").hidden);
    // Klik gdziekolwiek indziej zamyka paletę — tak jak każde menu.
    showPalette(false);

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
      if (menu) menu.hidden = !menu.hidden;
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
  }

  /* Escape zdejmuje po jednej warstwie, od wierzchu — tak samo jak
     w Notatniku i w widgecie: najpierw trwające nagranie, potem cała
     talia. Pojedynczej kartki Escape nie zamyka: zamknięcie zdejmuje
     notatkę z wierzchu, a to jest decyzja, nie odruch. */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (runtime === "listening") return void api.system.cancelCapture?.();
    if (!$("#palette").hidden) return showPalette(false);
    void api.deck.show(false);
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
    setTimeout(unfoldAnyway, 400);
    const settings = await api.settings.get();
    setLanguage(settings.uiLanguage ?? "pl");
    applyTextSize(settings);
    await load();
    translateTree();
  })();
})();
