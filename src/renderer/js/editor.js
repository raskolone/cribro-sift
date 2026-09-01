"use strict";

/**
 * Edytor notatki — zwykły edytor tekstu, nie pole na Markdown.
 *
 * ⌘B pogrubia zaznaczone słowo i widać, że jest pogrubione. Gwiazdek nie
 * ma na ekranie; są dopiero w pliku, bo notatka na dysku ma zostać tekstem,
 * który przeżyje kopiowanie gdziekolwiek (patrz shared/richtext.js).
 *
 * Pod spodem siedzi contenteditable, więc pisanie, Enter w liście i cofanie
 * obsługuje przeglądarka — tego kodu tutaj celowo nie ma. Dopisane jest to,
 * czego Chromium nie robi samo albo robi w sposób nie do zapisania:
 *
 *   — bloki (nagłówek, cytat, listy) przebudowywane wprost, patrz #setBlock,
 *   — lista zadań: własny rodzaj listy z polem do odhaczenia,
 *   — wklejanie zawsze jako czysty tekst, żeby ze strony WWW nie wpadały
 *     cudze kolory i rozmiary,
 *   — stan przycisków paska (czy kursor stoi w pogrubieniu).
 */

(function () {
  const { markdownToHtml, htmlToMarkdown, foldRange, clickFold } = window.CribroRichtext;
  /* Pod inną nazwą, bo metoda klasy nazywa się tak samo — a `applyFolds()`
     w ciele metody sięgałoby wtedy po funkcję z modułu, nie po metodę,
     i czytałoby się jak pomyłka nawet wtedy, gdy nią nie jest. */
  const foldTree = window.CribroRichtext.applyFolds;
  const { landing, nearest, pointless } = window.CribroBlockMove;

  const CHECKBOX_ZONE = 26; // szerokość pola do odhaczenia, w pikselach
  /* Najmniejszy obrazek, jaki ma sens: poniżej dziesiątej części kolumny
     zrzut przestaje być czymkolwiek do obejrzenia. Ta sama liczba stoi
     w shared/richtext.js — tam pilnuje zapisu, tutaj gestu. */
  const MIN_IMAGE = 10;
  /* Uchwyt do przenoszenia linii — rozmiar i odstęp od tekstu. Stoi
     w marginesie, po lewej stronie notatki, i nigdy nad literami. */
  const GRIP_W = 16;
  const GRIP_H = 20;

  /* Edytory otwarte w tym oknie. Spis jest tu po to, żeby dało się zdjąć
     uchwyty przenoszenia ze WSZYSTKICH notatek naraz — patrz parkAll na
     końcu pliku. Notatka bywa w oknie niejedna: zakładka Notatki, kartka
     na pulpicie, spotkanie obok. */
  const live = new Set();
  /* Szerokość strzałki przy nagłówku składanym. Tak samo jak przy liście
     zadań: rysuje ją CSS, więc kliknięcie w nią jest kliknięciem w lewy
     skraj bloku i tylko tutaj wiadomo, gdzie ten skraj przebiega. */
  const TOGGLE_ZONE = 24;
  const BLOCKS = new Set(["P", "H1", "H2", "H3", "UL", "OL", "BLOCKQUOTE", "HR"]);
  const HEADINGS = ["H1", "H2", "H3"];

  class RichEditor {
    /**
     * @param {HTMLElement} root  element z contenteditable
     * @param {{ onInput?: () => void }} options
     */
    constructor(root, { onInput } = {}) {
      this.root = root;
      this.onInput = onInput ?? (() => {});
      this.root.setAttribute("contenteditable", "true");

      // Bez tego Chromium formatuje stylami inline (<span style="font-weight:700">),
      // a z takiego zapisu nie da się odczytać intencji przy zapisie do Markdown.
      document.execCommand("styleWithCSS", false, false);
      document.execCommand("defaultParagraphSeparator", false, "p");

      this.root.addEventListener("input", () => this.#changed());
      this.root.addEventListener("paste", (event) => this.#paste(event));
      this.root.addEventListener("click", (event) => this.#click(event));
      this.root.addEventListener("pointerdown", (event) => this.#imageDown(event));
      this.root.addEventListener("keydown", (event) => this.#keydown(event));

      this.#dragSetup();
      this.#imageSetup();
    }

    /* ── Treść ── */

    setMarkdown(markdown) {
      // Podmiana w trakcie pisania zabrałaby kursor — wchodzimy tylko wtedy,
      // gdy na ekranie jest naprawdę co innego niż w notatce.
      const same = this.getMarkdown() === String(markdown ?? "").trim();
      if (same && this.root.innerHTML.trim()) return;
      this.#unpick();
      this.root.innerHTML = markdownToHtml(markdown);
      this.applyFolds();
      this.#markEmpty();
    }

    getMarkdown() {
      return htmlToMarkdown(this.root);
    }

    get text() {
      return this.root.textContent ?? "";
    }

    focus() {
      this.root.focus();
    }

    /** Kursor na sam koniec — po dopisaniu z dyktowania. */
    focusEnd() {
      this.root.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(this.root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      this.root.scrollTop = this.root.scrollHeight;
    }

    /** Tekst w miejscu kursora — używa tego wstawianie godziny. */
    insertText(text) {
      this.root.focus();
      document.execCommand("insertText", false, text);
      this.#changed();
    }

    /* ── Formatowanie ── */

    format(kind) {
      this.root.focus();

      if (kind === "bold" || kind === "italic") {
        // Znaczniki wewnątrz linii Chromium stawia dobrze — reszty
        // execCommand nie tykamy, patrz komentarz przy #setBlock.
        document.execCommand(kind);
      } else if (kind === "code") {
        this.#wrapInline("code");
      } else if (kind === "h1" || kind === "h2" || kind === "h3") {
        this.#setBlock(kind);
      } else if (kind === "toggle") {
        this.#toggleFold();
      } else if (kind === "divider") {
        this.#insertDivider();
      } else if (kind === "quote") {
        this.#setBlock("blockquote");
      } else if (kind === "bullet" || kind === "todo") {
        this.#toggleList(kind === "todo");
      }

      this.#changed();
    }

    /** Co jest włączone tam, gdzie stoi kursor — do podświetlenia paska. */
    activeFormats() {
      const block = this.#blockAt(this.#anchor());
      const list = block?.closest?.("ul, ol") ?? null;
      const heading = block?.closest?.("h1, h2, h3") ?? null;
      return {
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        h1: heading?.tagName === "H1",
        h2: heading?.tagName === "H2",
        h3: heading?.tagName === "H3",
        toggle: !!heading?.hasAttribute("data-toggle"),
        quote: !!block?.closest?.("blockquote"),
        bullet: !!list && !list.classList.contains("task"),
        todo: !!list && list.classList.contains("task"),
      };
    }

    /* ── Środek ── */

    #changed() {
      this.#normalizeBlocks();
      this.#normalizeTasks();
      this.applyFolds();
      this.#markEmpty();
      // Obrazek mógł właśnie zmienić rozmiar albo miejsce; ramka stoi na
      // współrzędnych ekranu i sama się o tym nie dowie.
      this.#paintPick();
      this.onInput();
    }

    #markEmpty() {
      this.root.dataset.empty = this.text.trim() ? "false" : "true";
    }

    #anchor() {
      const selection = window.getSelection();
      const node = selection?.anchorNode ?? null;
      if (!node || !this.root.contains(node)) return null;
      return node.nodeType === 1 ? node : node.parentElement;
    }

    #blockAt(node) {
      return node?.closest?.("h1, h2, h3, p, li, blockquote, hr, div") ?? null;
    }

    /* ── Bloki ──────────────────────────────────────────────────
       Nagłówek, cytat i lista są przebudowywane wprost, bez execCommand.
       Powód jest konkretny: `formatBlock` i `insertUnorderedList` w Chromium
       potrafią zostawić nowy blok WEWNĄTRZ akapitu (<p><ul><li>…), a taki
       zapis nie ma odpowiednika w Markdownie — notatka traciłaby punktory
       przy pierwszym zapisie. Własna przebudowa jest za to przewidywalna:
       blok najwyższego poziomu wchodzi, blok najwyższego poziomu wychodzi. */

    /**
     * Co obejmuje zaznaczenie: akapity i nagłówki jako całe bloki, a listy
     * z dokładnością do punktu. Bez tego naciśnięcie „lista" przy kursorze
     * w jednym punkcie rozbijałoby całą listę na akapity.
     */
    #selectedUnits() {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return [];
      const range = selection.getRangeAt(0);
      const units = [];

      for (const block of this.root.children) {
        if (!range.intersectsNode(block)) continue;
        if (block.tagName === "UL" || block.tagName === "OL") {
          const items = [...block.children].filter((item) => range.intersectsNode(item));
          units.push(...(items.length ? items : [block]));
        } else {
          units.push(block);
        }
      }

      if (units.length) return units;
      return this.root.firstElementChild ? [this.root.firstElementChild] : [];
    }

    /* Zaznaczenie przeżywa przebudowę, bo węzły tekstu są przenoszone,
       a nie kopiowane — to te same węzły, tylko w innym rodzicu. */
    #saveSelection() {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return null;
      const range = selection.getRangeAt(0);
      return {
        start: range.startContainer,
        startOffset: range.startOffset,
        end: range.endContainer,
        endOffset: range.endOffset,
      };
    }

    #restoreSelection(saved) {
      if (!saved || !this.root.contains(saved.start) || !this.root.contains(saved.end)) return;
      const range = document.createRange();
      try {
        range.setStart(saved.start, saved.startOffset);
        range.setEnd(saved.end, saved.endOffset);
      } catch {
        return; // węzeł skrócił się w międzyczasie — zostawiamy kursor tam, gdzie jest
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    /** Jeden blok na inny. Lista rozpada się na tyle bloków, ile miała punktów. */
    #replaceBlock(block, tag) {
      const name = block.tagName.toLowerCase();
      if (name === tag) return;

      if (name === "ul" || name === "ol") {
        const fragment = document.createDocumentFragment();
        for (const item of [...block.children]) {
          const element = document.createElement(tag);
          element.append(...item.childNodes);
          fragment.appendChild(element);
        }
        block.replaceWith(fragment);
        return;
      }

      const element = document.createElement(tag);
      element.append(...block.childNodes);
      block.replaceWith(element);
    }

    /**
     * Punkt wyjęty z listy. Lista dzieli się na część przed i po nim,
     * więc z jednego punktu w środku robi się akapit, a lista zostaje listą.
     */
    #extractItem(item, tag) {
      const list = item.parentElement;
      const element = document.createElement(tag);
      const nested = [...item.childNodes].filter(
        (node) => node.tagName === "UL" || node.tagName === "OL",
      );
      element.append(...[...item.childNodes].filter((node) => !nested.includes(node)));

      const after = [...list.children].slice([...list.children].indexOf(item) + 1);
      list.after(element);
      if (after.length) {
        const tail = document.createElement(list.tagName.toLowerCase());
        tail.className = list.className;
        tail.append(...after);
        element.after(tail);
      }

      item.remove();
      if (!list.children.length) list.remove();
      return element;
    }

    /** Nagłówek i cytat są przełącznikami: drugie naciśnięcie wraca do akapitu. */
    #setBlock(tag) {
      const saved = this.#saveSelection();
      const units = this.#selectedUnits();
      if (!units.length) return;

      const already = units.every((unit) => unit.tagName.toLowerCase() === tag);
      const target = already ? "p" : tag;
      for (const unit of units) {
        if (unit.tagName === "LI") this.#extractItem(unit, target);
        else this.#replaceBlock(unit, target);
      }
      this.#restoreSelection(saved);
    }

    /* ── Nagłówek składany ─────────────────────────────────────
       Nagłówek, pod którym da się schować wszystko aż do następnego
       nagłówka tego samego albo wyższego stopnia. Notatka ze spotkania
       rośnie w dół przez godzinę i po tej godzinie nikt nie chce widzieć
       jej całej naraz — chce widzieć spis części i rozwinąć jedną.

       Stan („zwinięty" / „rozwinięty") idzie do PLIKU strzałką przy
       nagłówku (patrz TOGGLE_MARK w shared/richtext.js). Trzymanie go
       obok, w widoku, znaczyłoby, że notatka otwarta w drugim oknie albo
       nazajutrz rozkłada się z powrotem w całości. */

    /** Nagłówek zamienia się w składany i z powrotem. Zwykły blok robi się
        przy tym nagłówkiem — inaczej przycisk nie miałby czego przełączyć. */
    #toggleFold() {
      const saved = this.#saveSelection();
      const block = this.#blockAt(this.#anchor());
      let heading = block?.closest?.("h1, h2, h3") ?? null;

      if (!heading) {
        this.#setBlock("h2");
        heading = this.#blockAt(this.#anchor())?.closest?.("h1, h2, h3") ?? null;
        if (!heading) return;
        heading.setAttribute("data-toggle", "open");
        return;
      }

      if (heading.hasAttribute("data-toggle")) heading.removeAttribute("data-toggle");
      else heading.setAttribute("data-toggle", "open");
      this.#restoreSelection(saved);
    }

    /** Co należy do tego nagłówka: wszystko aż do nagłówka nie niższego.
        Zasada mieszka w shared/richtext.js, bo obowiązuje także tam, gdzie
        notatki się nie pisze — w podglądzie podsumowania spotkania. */
    #foldRange(heading) {
      return foldRange(heading);
    }

    /**
     * Chowanie i pokazywanie treści pod nagłówkami. Wołane po każdej
     * zmianie, bo blok dopisany pod zwiniętym nagłówkiem też ma być
     * schowany — a bloków przybywa przy każdym naciśnięciu Entera.
     *
     * Zostawia po sobie TRZY ślady w drzewie, i każdy odpowiada na inne
     * pytanie, które człowiek zadaje patrząc na notatkę:
     *
     *   data-folded  „tego nie widać" — samo chowanie;
     *   data-inside  „to należy do nagłówka wyżej" — po tym CSS rysuje
     *                wcięcie i pionową kreskę, więc widać zawartość toggle
     *                ZANIM się go zwinie. Bez tego jedynym sposobem, żeby
     *                się dowiedzieć, co jest w środku, było zwinięcie
     *                i sprawdzenie, co zniknęło;
     *   data-hidden  ile bloków chowa zwinięty nagłówek. Zwinięty toggle
     *                bez tej liczby wygląda jak zwykły nagłówek i nie ma
     *                po czym poznać, że coś pod nim jest.
     *
     * Publiczna, bo woła ją także okno: kliknięcie w strzałkę obsługuje
     * edytor, ale wczytanie notatki z zewnątrz — już nie.
     */
    applyFolds() {
      foldTree(this.root);
    }

    /** Kreska w miejscu kursora, a pod nią akapit, w którym pisze się dalej. */
    #insertDivider() {
      const block = this.#blockAt(this.#anchor()) ?? this.root.lastElementChild;
      const rule = document.createElement("hr");
      const after = document.createElement("p");
      after.appendChild(document.createElement("br"));

      // Blok najwyższego poziomu, nie punkt listy: kreska w środku listy
      // nie ma odpowiednika w Markdownie (patrz komentarz przy #setBlock).
      const top = block && block.parentElement !== this.root
        ? block.closest("ul, ol, blockquote") ?? this.root.lastElementChild
        : block;

      if (top) top.after(rule);
      else this.root.appendChild(rule);
      rule.after(after);

      const range = document.createRange();
      range.setStart(after, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    /**
     * Lista i lista zadań to ta sama lista; różni je znacznik i pole
     * do odhaczenia. Dzięki temu przełączanie między nimi nie gubi punktów.
     */
    #toggleList(task) {
      const saved = this.#saveSelection();
      const units = this.#selectedUnits();
      if (!units.length) return;

      // Ten sam rodzaj listy drugi raz znaczy „wyjdź z listy".
      const sameKind = (unit) =>
        (unit.tagName === "LI" ? unit.parentElement : unit).tagName === "UL" &&
        (unit.tagName === "LI" ? unit.parentElement : unit).classList.contains("task") === task;

      if (units.every(sameKind)) {
        for (const unit of units) {
          if (unit.tagName === "LI") this.#extractItem(unit, "p");
          else this.#replaceBlock(unit, "p");
        }
        this.#restoreSelection(saved);
        return;
      }

      // Punkty innej listy wracają najpierw do akapitów, żeby wszystko,
      // co zaznaczone, weszło do jednej nowej listy w tej samej kolejności.
      const blocks = units.map((unit) =>
        unit.tagName === "LI" ? this.#extractItem(unit, "p") : unit,
      );

      const list = document.createElement("ul");
      if (task) list.classList.add("task");

      for (const block of blocks) {
        if (block.tagName === "UL" || block.tagName === "OL") {
          for (const item of [...block.children]) {
            if (task) item.setAttribute("data-done", "false");
            else item.removeAttribute("data-done");
            list.appendChild(item);
          }
          continue;
        }
        const item = document.createElement("li");
        if (task) item.setAttribute("data-done", "false");
        item.append(...block.childNodes);
        if (!item.childNodes.length) item.appendChild(document.createElement("br"));
        list.appendChild(item);
      }

      blocks[0].replaceWith(list);
      for (const block of blocks.slice(1)) block.remove();
      this.#restoreSelection(saved);
    }

    /* Tekst wpisany prosto do edytora, bez akapitu wokół, popsułby zapis
       do Markdownu — akapit jest najmniejszą jednostką, jaką ten format zna. */
    #normalizeBlocks() {
      const strays = [...this.root.childNodes].filter(
        (node) => node.nodeType === 3 || (node.nodeType === 1 && !BLOCKS.has(node.tagName)),
      );
      for (const node of strays) {
        if (node.nodeType === 3 && !node.nodeValue.trim()) {
          node.remove();
          continue;
        }
        const paragraph = document.createElement("p");
        node.replaceWith(paragraph);
        paragraph.appendChild(node);
      }
    }

    /** Każdy punkt listy zadań ma stan; nowy punkt zaczyna nieodhaczony. */
    #normalizeTasks() {
      for (const item of this.root.querySelectorAll("ul.task > li")) {
        if (!item.hasAttribute("data-done") || !item.textContent.trim()) {
          item.setAttribute("data-done", "false");
        }
      }
      for (const item of this.root.querySelectorAll("ul:not(.task) > li[data-done]")) {
        item.removeAttribute("data-done");
      }
    }

    #wrapInline(tag) {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const wrapper = document.createElement(tag);
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    /* ── Przenoszenie linii ─────────────────────────────────────
       Uchwyt jak w Notion: pokazuje się przy linii, nad którą stoi kursor,
       i pozwala przełożyć ją gdzie indziej.

       CHWYTA SIĘ WYŁĄCZNIE PUNKTY LIST — wypunktowanych, numerowanych
       i zadań. Akapit, nagłówek i cytat uchwytu nie dostają, choć kod
       potrafiłby je przenieść. Powód jest taki: notatka to w większości
       akapity, a uchwyt przy każdym z nich to sześć kropek chodzących za
       kursorem przez cały czas pisania — ruch w kącie oka przy czynności,
       która wymaga skupienia. Przestawia się zaś głównie punkty, bo to
       one są listą rzeczy do zrobienia, a nie tekstem do przeczytania.

       Klawiatura zostaje przy wszystkim: ⌥↑ i ⌥↓ ruszają każdą linią,
       także akapitem. To inny gest — nie widać go, dopóki się go nie
       wywoła, więc niczego nie zaśmieca.

       DWIE DECYZJE, KTÓRE WYGLĄDAJĄ NA DROBIAZG, A NIM NIE SĄ:

       1. UCHWYT NIE JEST ELEMENTEM EDYTORA. Leży w <body> i stoi na
          współrzędnych ekranu. Wszystko, co narysujemy wewnątrz
          contenteditable, jest treścią: da się w to wejść kursorem, da się
          to skasować Backspace'em i wchodzi do htmlToMarkdown. Uchwyt
          postawiony w środku notatki zostawiałby ślad w pliku na dysku.

       2. PRZECIĄGANIE CHODZI NA ZDARZENIACH WSKAŹNIKA, nie na HTML5 drag
          and drop. Wewnątrz contenteditable przeglądarka ma własne
          przeciąganie zaznaczonego tekstu i te dwa mechanizmy walczyłyby
          o ten sam gest — a cudze wygrywa, bo zaczyna się wcześniej.

       Rozstrzygnięcia (czym staje się przeniesiona linia, ile linii jedzie
       razem ze zwiniętym nagłówkiem, do której szczeliny) siedzą osobno,
       w shared/blockmove.js, i są sprawdzane bez przeglądarki. */

    #dragSetup() {
      const doc = this.root.ownerDocument;

      /* Sprzątanie po poprzednikach.
         Uchwyt leży w <body>, a nie w edytorze — i to jest jedyna rzecz,
         która go przeżywa. Notatnik przebudowuje swój szkielet
         (root.innerHTML = SKELETON w js/notes-view.js), więc element
         edytora ginie razem ze swoimi nasłuchami, a uchwyt zostawałby
         w dokumencie na zawsze: jeden na każde otwarcie widoku. Po korzeniu
         odłączonym od dokumentu poznajemy uchwyt, który nie ma już czym
         ruszać. */
      for (const stale of doc.querySelectorAll(".prose-grip, .prose-drop")) {
        if (!stale.__root?.isConnected) stale.remove();
      }

      /* Uchwyt wisi POD warstwą okna, a nie nad całym dokumentem.

         Stoi na współrzędnych ekranu (position: fixed), więc miejsce
         w drzewie nie rusza go ani o piksel — rozstrzyga tylko o KOLEJNOŚCI
         MALOWANIA. W <body> uchwyt był rodzeństwem całego okna i wygrywał
         z nim wszystko, także z menu po lewej: gdy raz zawisł nad zakładką,
         klik trafiał w niego zamiast w nią. Wewnątrz `#app` przegrywa
         z pasem bocznym (z-index 60), a nadal wygrywa z treścią notatki —
         czyli z jedynym, nad czym ma stać.

         `#app` jest tylko w oknie głównym; kartka na pulpicie i Notatnik
         nie mają nad czym górować i zostają przy <body>. */
      const host = doc.getElementById("app") ?? doc.body;
      live.add(this);

      this.grip = doc.createElement("div");
      this.grip.className = "prose-grip";
      this.grip.hidden = true;
      this.grip.title = "Przeciągnij, żeby przenieść (⌥↑ ⌥↓)";
      this.grip.__root = this.root;
      host.appendChild(this.grip);

      this.dropMark = doc.createElement("div");
      this.dropMark.className = "prose-drop";
      this.dropMark.hidden = true;
      this.dropMark.__root = this.root;
      host.appendChild(this.dropMark);

      this.drag = null;
      this.gripLine = null;

      // Uchwyty trzymane osobno, bo odpinamy je po każdym przeciągnięciu.
      this.onDragMove = (event) => this.#dragMove(event);
      this.onDragEnd = (event) => this.#dragEnd(event);
      this.onDragCancel = () => this.#dragCleanup();
      /* Przeglądarka chce w trakcie przeciągania zaznaczać tekst — bo z jej
         punktu widzenia trzymamy przycisk i wodzimy myszą po dokumencie.
         `user-select: none` nie wystarcza: w contenteditable Chromium
         zaznacza mimo niego. Trzeba odmówić samego rozpoczęcia. */
      this.onNoSelect = (event) => event.preventDefault();
      this.onDragKey = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        this.#dragCleanup();
      };

      this.root.addEventListener("pointermove", (event) => this.#gripFollow(event));
      // Wyjście kursora NA UCHWYT nie jest wyjściem z notatki — inaczej
      // uchwyt znikałby dokładnie w chwili, w której sięga się po niego.
      this.root.addEventListener("pointerleave", (event) => {
        if (event.relatedTarget === this.grip) return;
        this.#gripHide();
      });
      this.grip.addEventListener("pointerleave", (event) => {
        if (this.drag || this.root.contains(event.relatedTarget)) return;
        this.#gripHide();
      });
      this.grip.addEventListener("pointerdown", (event) => this.#dragStart(event));

      /* Przewinięcie i zmiana rozmiaru okna przesuwają linię spod uchwytu.
         Uchwyt stoi na współrzędnych ekranu, więc musi zniknąć, zamiast
         zawisnąć nad cudzym zdaniem. */
      doc.addEventListener("scroll", () => this.#gripHide(), true);
      doc.defaultView?.addEventListener("resize", () => this.#gripHide());
      /* UTRATY FOKUSU TU NIE MA i to jest decyzja po próbie.

         Kusi, żeby chować uchwyt razem z aktywnością okna — okno, które
         zeszło pod spód, nie potrzebuje uchwytu. Ale „blur" przychodzi
         także wtedy, gdy fokus zabiera cudze okno POJAWIAJĄCE SIĘ obok,
         a kursor zostaje nad notatką: uchwyt znikał wtedy spod ręki
         w połowie sięgania po niego. Widać to było jako migotanie
         w testach uruchamianych razem z innymi oknami.

         Miejsca, w których uchwyt naprawdę trzeba zdjąć, są dwa i oba są
         wyraźne: zwinięcie kartki i chwycenie znaczka. Robi to widget
         wprost, przez parkGrip. */

      /* Uchwyt leży w <body>, więc nie ma jak zniknąć razem z tym, przy
         czym stał. Przejście na inną zakładkę podmienia cały szkielet
         widoku (root.innerHTML = SKELETON), czyli element notatki znika
         POD kursorem — żadne pointerleave wtedy nie pada i uchwyt zostaje
         wisieć nad tym, co się w tym miejscu pojawi. Widać to było jako
         sześć kropek na karcie ustawień spotkań.

         Stąd nasłuch na całym dokumencie: wskaźnik gdziekolwiek indziej
         chowa uchwyt, a notatka odłączona od dokumentu każe mu posprzątać
         po sobie — razem z tym nasłuchem, żeby nie został po każdym
         otwarciu widoku po jednym. */
      this.onOutside = (event) => {
        if (!this.root.isConnected) return void this.#retire();
        if (this.drag) return;
        if (event.target === this.grip || this.root.contains(event.target)) return;
        this.#gripHide();
      };
      doc.addEventListener("pointermove", this.onOutside, true);

      /* ══ NOTATKA ZNIKA, UCHWYT ZOSTAJE — I TO JEST TEN BŁĄD ══

         Nasłuch wyżej chowa uchwyt, gdy wskaźnik pójdzie gdzie indziej.
         Nie wystarcza, bo widok znika NIE spod myszy: kliknięcie w zakładkę
         zakłada sekcji `hidden`, a kursor zostaje tam, gdzie był. Żaden ruch
         wtedy nie pada — a nawet gdy padnie, potrafi trafić w sam uchwyt,
         który jest wtedy elementem NA WIERZCHU (z-index 40). Wtedy warunek
         `event.target === this.grip` każe go zostawić.

         Widać to było jako sześć kropek wiszących na cudzej zakładce —
         i, co gorsza, jako miejsce, w którym nie da się w nic kliknąć: pod
         kropkami leży menu albo przycisk, a klik trafia w uchwyt.

         Obserwator patrzy więc na to, czy notatka jest jeszcze widoczna.
         `hidden` na sekcji, przewinięcie poza ekran, zamknięcie panelu —
         wszystkie trzy kończą się tym samym zdarzeniem, więc i uchwyt
         schodzi we wszystkich trzech przypadkach.

         `IntersectionObserver`, a nie `MutationObserver`: pytanie brzmi
         „czy tę notatkę widać", a nie „czy ktoś zmienił jej atrybut" —
         a zmienić ją może każdy z pięciu przodków po drodze. */
      this.watch = new (doc.defaultView?.IntersectionObserver ?? IntersectionObserver)(
        ([entry]) => {
          if (!entry?.isIntersecting) this.parkGrip();
        },
      );
      this.watch.observe(this.root);
    }

    /** Koniec życia uchwytu: notatki, przy której stał, już nie ma. */
    #retire() {
      const doc = this.grip.ownerDocument;
      live.delete(this);
      doc.removeEventListener("pointermove", this.onOutside, true);
      doc.removeEventListener("pointerdown", this.onPickOutside, true);
      doc.removeEventListener("scroll", this.onPickReflow, true);
      doc.defaultView?.removeEventListener("resize", this.onPickReflow);
      this.watch?.disconnect();
      this.grip.remove();
      this.dropMark.remove();
      this.pick?.remove();
    }

    /**
     * Linia, którą wolno przenieść: punkt listy najwyższego poziomu albo
     * blok stojący wprost w notatce.
     *
     * Punkty list zagnieżdżonych zostają nietknięte celowo — przenoszenie
     * między poziomami wcięcia to inne zadanie i inne zasady, a wpuszczone
     * tutaj tylnymi drzwiami rozsypywałoby wcięcia bez ostrzeżenia.
     */
    #lineFor(node) {
      const line = node?.closest?.("li, p, h1, h2, h3, blockquote, hr");
      if (!line || !this.root.contains(line)) return null;
      if (line.tagName === "LI") {
        return line.parentElement?.parentElement === this.root ? line : null;
      }
      return line.parentElement === this.root ? line : null;
    }

    /**
     * Czy tę linię wolno złapać MYSZĄ.
     *
     * Węziej niż #lineFor i to jest cała różnica między dwoma gestami:
     * uchwyt dostają wyłącznie punkty list, klawiatura rusza wszystkim.
     * Dlaczego — patrz komentarz nad #dragSetup.
     */
    #draggable(line) {
      return line?.tagName === "LI";
    }

    /** Linie po kolei, z pominięciem schowanych pod zwiniętym nagłówkiem. */
    #lines() {
      const out = [];
      for (const block of this.root.children) {
        if (block.getAttribute("data-folded") === "true") continue;
        if (block.tagName === "UL" || block.tagName === "OL") out.push(...block.children);
        else out.push(block);
      }
      return out;
    }

    /**
     * Co jedzie razem ze złapaną linią.
     *
     * Zwykle ona sama. Wyjątkiem jest nagłówek ZWINIĘTY: pod nim stoi treść,
     * której nie widać, a przeniesienie samego nagłówka zostawiłoby ją
     * w miejscu — czyli rozsypałoby notatkę dokładnie tam, gdzie autor jej
     * nie widzi. Co należy do nagłówka, wie już #foldRange; to samo pytanie
     * zadaje przy chowaniu i pokazywaniu, więc drugiej odpowiedzi nie ma.
     */
    #group(line) {
      const closed =
        HEADINGS.includes(line.tagName) && line.getAttribute("data-toggle") === "closed";
      return closed ? [line, ...this.#foldRange(line)] : [line];
    }

    /**
     * Szczeliny między liniami — o jedną więcej niż linii, bo jest jeszcze
     * ta na samym końcu. Indeks szczeliny znaczy „przed tą linią”.
     */
    #gaps() {
      const lines = this.#lines();
      const gaps = lines.map((line) => ({
        y: line.getBoundingClientRect().top,
        before: line,
        container: line.parentElement,
      }));
      const last = lines[lines.length - 1];
      if (last) {
        gaps.push({
          y: last.getBoundingClientRect().bottom,
          before: null,
          container: last.parentElement,
        });
      }
      return gaps;
    }

    /**
     * Linia, przy której ma stanąć uchwyt.
     *
     * NIE WOLNO pytać o nią samym trafieniem w element i to jest cała nauka
     * z pierwszej wersji, która „po prostu nie działała". Uchwyt stoi
     * w pasku po lewej stronie notatki, więc ręka idąca po niego przechodzi
     * przez ten pasek — czyli przez sam `.prose`, w którym żadnej linii pod
     * kursorem nie ma. Uchwyt znikał dokładnie w chwili, w której się po
     * niego sięgało, a kliknięcie trafiało już w tekst.
     *
     * Automat tego nie widział, bo skakał myszą prosto na środek uchwytu.
     * Ręka przechodzi przez wszystkie piksele po drodze.
     *
     * Dlatego o linię pyta się PIONEM: liczy się, na wysokości której linii
     * jest kursor, a nie w co trafił. Przy okazji uchwyt trzyma się także
     * w przerwach między akapitami, gdzie też nie ma czego trafić.
     */
    #lineAt(event) {
      const direct = this.#lineFor(event.target);
      if (direct) return this.#draggable(direct) ? direct : null;

      const bounds = this.root.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right) return null;

      let best = null;
      let nearestGap = Infinity;
      for (const line of this.#lines()) {
        const box = line.getBoundingClientRect();
        const gap =
          event.clientY < box.top
            ? box.top - event.clientY
            : event.clientY > box.bottom
              ? event.clientY - box.bottom
              : 0;
        if (gap < nearestGap) {
          nearestGap = gap;
          best = line;
        }
      }
      // Dalej niż pół wiersza od czegokolwiek — to już nie jest „przy linii".
      if (nearestGap > GRIP_H) return null;
      /* Najbliższej szukamy wśród WSZYSTKICH linii, a dopiero na końcu
         pytamy, czy wolno ją złapać. Odwrotna kolejność — przeglądanie od
         razu samych punktów — kazałaby uchwytowi przeskakiwać ponad
         akapitem do listy stojącej piętro niżej: kursor przy zdaniu,
         kropki przy czymś zupełnie innym. */
      return this.#draggable(best) ? best : null;
    }

    #gripFollow(event) {
      if (this.drag) return;
      const line = this.#lineAt(event);
      if (!line) {
        this.#gripHide();
        return;
      }
      this.gripLine = line;

      const box = line.getBoundingClientRect();
      const view = this.root.ownerDocument.defaultView;
      const leading = parseFloat(view.getComputedStyle(line).lineHeight) || 24;

      /* Uchwyt stoi W NOTATCE, w pasku wolnym po jej lewej stronie
         (--grip-gutter w css/prose.css) — nie obok niej. Odmierzanie od
         krawędzi punktu listy wystawiało go poza kartkę, bo tam kartki
         już nie ma; a wystający uchwyt wygląda jak rzecz, która się
         odczepiła, a nie jak część notatki.

         Pasek czytamy ze stylu, zamiast wpisywać liczbę: kartka na pulpicie
         jest wąska i ma go węższy, a uchwyt ma się mieścić w obu. */
      const bounds = this.root.getBoundingClientRect();
      /* Notatka bez powierzchni to notatka schowana — a jej prostokąt jest
         wtedy zerem w lewym górnym rogu okna. Uchwyt odmierzony od takiego
         zera lądowałby na menu, czyli na czymś, co z notatką nie ma nic
         wspólnego. Lepiej nie pokazać go wcale. */
      if (bounds.width < 1 || bounds.height < 1) {
        this.#gripHide();
        return;
      }
      const gutter = parseFloat(view.getComputedStyle(this.root).paddingLeft) || GRIP_W + 8;
      const left = bounds.left + Math.max(2, (gutter - GRIP_W) / 2);

      this.grip.hidden = false;
      this.grip.style.left = `${left}px`;
      // Do PIERWSZEGO wiersza bloku, nie do jego środka: akapit na cztery
      // wiersze ma uchwyt przy górze, tam gdzie się zaczyna.
      this.grip.style.top = `${box.top + Math.min(leading, box.height) / 2 - GRIP_H / 2}px`;
    }

    #gripHide() {
      if (this.drag) return;
      this.grip.hidden = true;
      this.gripLine = null;
    }

    /**
     * Uchwyt schodzi na żądanie, a nie za kursorem.
     *
     * Potrzebne wszędzie tam, gdzie notatka znika Z OKNEM, a nie spod myszy.
     * Widget jest tego przypadkiem skrajnym: kartka zwija się do znaczka,
     * a okno w tej samej chwili zaczyna przepuszczać kliknięcia na wylot —
     * czyli przestaje dostawać ruchy myszy. Żadne pointerleave wtedy nie
     * pada i uchwyt zostaje wisieć obok znaczka jako sześć kropek, których
     * nic już nie chowa. Widać to było przy przeciąganiu widgetu.
     */
    parkGrip() {
      if (this.drag) this.#dragCleanup();
      if (this.sizing) this.#resizeEnd();
      this.#gripHide();
      // Ramka obrazka znika razem z uchwytem i z tego samego powodu: notatki,
      // przy której stała, nie widać już na ekranie.
      this.#unpick();
    }

    #dragStart(event) {
      const line = this.gripLine;
      if (!line || event.button !== 0) return;
      // Bez tego zaczyna się zaznaczanie tekstu i notatka miga na niebiesko.
      event.preventDefault();

      const lines = this.#lines();
      const from = lines.indexOf(line);
      if (from === -1) return;
      const group = this.#group(line);

      this.drag = {
        pointerId: event.pointerId,
        group,
        from,
        /* Ile SZCZELIN zajmuje to, co jedzie — a nie ile bloków jedzie.
           Treść pod zwiniętym nagłówkiem jest schowana, więc w spisie linii
           jej nie ma i cała część zajmuje dokładnie jedno miejsce. */
        span: group.filter((node) => lines.includes(node)).length || 1,
        slot: -1,
        gaps: [],
      };

      /* Przechwycenie wskaźnika bierzemy, jeśli się da — ale NIE WOLNO na nim
         stać. Chromium potrafi oddać je natychmiast po przyznaniu (widać to
         w śladzie jako gotpointercapture i zaraz lostpointercapture), a wtedy
         ruchy myszy idą już do notatki pod spodem: gest wygląda na martwy,
         a przeglądarka zaczyna zaznaczać tekst. Dlatego nasłuchy wiszą na
         DOKUMENCIE, w fazie przechwytywania — dochodzą niezależnie od tego,
         nad czym akurat jest kursor i czy przechwycenie żyje. */
      const doc = this.root.ownerDocument;
      try {
        this.grip.setPointerCapture(event.pointerId);
      } catch {
        /* wskaźnik zniknął między naciśnięciem a przechwyceniem */
      }
      this.grip.dataset.dragging = "true";
      doc.body.classList.add("is-moving-line");
      for (const node of this.drag.group) node.setAttribute("data-moving", "true");

      // Zaznaczenie sprzed chwytu tylko przeszkadza: po upuszczeniu i tak
      // wracamy kursorem do przeniesionej linii.
      doc.getSelection?.()?.removeAllRanges();

      doc.addEventListener("pointermove", this.onDragMove, true);
      doc.addEventListener("pointerup", this.onDragEnd, true);
      doc.addEventListener("pointercancel", this.onDragCancel, true);
      doc.addEventListener("selectstart", this.onNoSelect, true);
      doc.addEventListener("dragstart", this.onNoSelect, true);
      doc.addEventListener("keydown", this.onDragKey, true);
    }

    #dragMove(event) {
      if (!this.drag) return;
      const gaps = this.#gaps();
      const slot = nearest(gaps.map((gap) => gap.y), event.clientY);
      this.drag.gaps = gaps;
      this.drag.slot = slot;

      // Szczelina tuż nad złapaną linią i tuż pod nią to jest to miejsce,
      // w którym linia już stoi. Kreska ma wtedy zniknąć — bo nic się nie
      // stanie, a kreska obiecywałaby, że się stanie.
      if (slot === -1 || pointless(this.drag.from, this.drag.span, slot)) {
        this.dropMark.hidden = true;
        return;
      }

      const gap = gaps[slot];
      const anchor = gap.before ?? this.#lines().at(-1);
      if (!anchor) {
        this.dropMark.hidden = true;
        return;
      }
      const box = anchor.getBoundingClientRect();
      const bounds = this.root.getBoundingClientRect();
      this.dropMark.hidden = false;
      this.dropMark.style.left = `${bounds.left}px`;
      this.dropMark.style.width = `${bounds.width}px`;
      this.dropMark.style.top = `${(gap.before ? box.top : box.bottom) - 1}px`;
    }

    #dragEnd() {
      const drag = this.drag;
      if (!drag) return;
      this.#dragCleanup();

      if (drag.slot === -1 || pointless(drag.from, drag.span, drag.slot)) return;
      const gap = drag.gaps[drag.slot];
      if (!gap) return;

      const saved = this.#saveSelection();
      this.#place(drag.group, gap);
      this.#restoreSelection(saved);
      this.#changed();
    }

    #dragCleanup() {
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;

      const doc = this.root.ownerDocument;
      try {
        this.grip.releasePointerCapture(drag.pointerId);
      } catch {
        /* wskaźnik już puszczony albo przechwycenie i tak nie dożyło */
      }
      doc.removeEventListener("pointermove", this.onDragMove, true);
      doc.removeEventListener("pointerup", this.onDragEnd, true);
      doc.removeEventListener("pointercancel", this.onDragCancel, true);
      doc.removeEventListener("selectstart", this.onNoSelect, true);
      doc.removeEventListener("dragstart", this.onNoSelect, true);
      doc.removeEventListener("keydown", this.onDragKey, true);

      delete this.grip.dataset.dragging;
      doc.body.classList.remove("is-moving-line");
      for (const node of drag.group) node.removeAttribute("data-moving");

      this.dropMark.hidden = true;
      this.grip.hidden = true;
      this.gripLine = null;
    }

    /**
     * Przeprowadzka.
     *
     * REGUŁA JEST JEDNA: pojemnikiem staje się pojemnik linii, OBOK której
     * upuszczono. Punkt położony obok innego punktu wchodzi do tej samej
     * listy; punkt położony obok akapitu wychodzi z listy i sam staje się
     * akapitem. Nie ma tu drugiego wymiaru ani decyzji podejmowanej
     * z położenia w poziomie — jedna reguła, którą widać po kresce.
     *
     * Wyprowadzenia punktu z listy, pod którą nic nie stoi, tą drogą się
     * nie da. I nie ma potrzeby: od wychodzenia z listy jest przycisk na
     * pasku, który robi to jednym naciśnięciem.
     */
    #place(group, gap) {
      /* Część zwinięta pod nagłówkiem jedzie w całości i wyłącznie na
         poziom notatki: nie ma takiej listy, w której nagłówek z treścią
         miałby sens. */
      const intoList = group.length === 1 && gap.container !== this.root;
      const container = intoList ? gap.container : this.root;
      const before = intoList ? gap.before : this.#topLevel(gap.before);
      const task = intoList && gap.container.classList.contains("task");

      const moved = group.map((line) =>
        this.#reshape(line, landing({ tag: line.tagName, done: line.getAttribute("data-done") }, {
          list: intoList,
          task,
        })),
      );

      // Rodziców zapamiętujemy PRZED wyjęciem: lista, z której zabrano
      // ostatni punkt, ma zniknąć, a po wyjęciu nie ma już jak jej znaleźć.
      const orphans = new Set(group.map((line) => line.parentElement));
      for (const line of group) line.remove();
      for (const node of moved) container.insertBefore(node, before);
      for (const parent of orphans) {
        if (parent && parent !== this.root && parent.parentElement && !parent.children.length) {
          parent.remove();
        }
      }
    }

    /** Blok najwyższego poziomu, w którym siedzi ta linia. */
    #topLevel(node) {
      if (!node) return null;
      if (node.parentElement === this.root) return node;
      return node.closest("ul, ol, blockquote");
    }

    /** Linia przebrana w to, czym ma być po wylądowaniu. */
    #reshape(line, shape) {
      if (line.tagName === shape.tag) {
        if (shape.done === null) line.removeAttribute("data-done");
        else line.setAttribute("data-done", shape.done);
        return line;
      }

      const doc = line.ownerDocument;
      const element = doc.createElement(shape.tag.toLowerCase());
      element.append(...line.childNodes);
      if (shape.done !== null) element.setAttribute("data-done", shape.done);
      // Składany zostaje składanym, dopóki zostaje nagłówkiem.
      const toggle = line.getAttribute("data-toggle");
      if (toggle && /^H[1-3]$/.test(shape.tag)) element.setAttribute("data-toggle", toggle);
      if (!element.childNodes.length) element.appendChild(doc.createElement("br"));
      return element;
    }

    /**
     * Ten sam ruch bez myszy: ⌥↑ i ⌥↓.
     *
     * Nie jest to dodatek dla porządku. Uchwyt wymaga trafienia w szesnaście
     * pikseli w marginesie, a linię przestawia się najczęściej wtedy, gdy
     * ręce są już na klawiaturze — w trakcie pisania listy.
     */
    #moveByKey(direction) {
      const line = this.#lineFor(this.#anchor());
      return line ? this.#moveLine(line, direction) : false;
    }

    /**
     * Przełożenie WSKAZANEJ linii o jedno miejsce.
     *
     * Osobno od #moveByKey, bo linię wskazuje się na dwa sposoby: kursorem
     * (wtedy szuka jej #anchor) albo zaznaczonym obrazkiem (wtedy jest znana
     * wprost, a kursora w niej nie ma wcale).
     */
    #moveLine(line, direction) {
      const lines = this.#lines();
      const from = lines.indexOf(line);
      if (from === -1) return false;
      const group = this.#group(line);
      const span = group.filter((node) => lines.includes(node)).length || 1;

      // W górę: szczelina przed linią poprzednią. W dół: tuż za linią,
      // która stoi za całą przenoszoną częścią.
      const slot = direction < 0 ? from - 1 : from + span + 1;
      if (slot < 0 || slot > lines.length) return false;

      const gap = this.#gaps()[slot];
      if (!gap) return false;

      const saved = this.#saveSelection();
      this.#place(group, gap);
      this.#restoreSelection(saved);
      this.#changed();
      return true;
    }

    /* ── Obrazek w notatce ─────────────────────────────────────
       Zrzut ekranu wchodził do notatki i stawał się w niej rzeczą martwą:
       nie dało się go zmniejszyć, przesunąć ani skasować — zostawało
       otwarcie pliku .md w innym edytorze i szukanie nawiasów.

       Cała obsługa stoi POZA notatką, w warstwie nad nią, i to jest ta
       sama decyzja co przy uchwycie przenoszenia linii: wszystko, co
       narysujemy wewnątrz contenteditable, JEST treścią — da się w to
       wejść kursorem, skasować Backspace'em i wychodzi do Markdownu.
       Ramka i pasek narysowane przy obrazku zostawiłyby po sobie ślad
       w pliku na dysku.

       Rozmiar mieszka w opisie obrazka (patrz IMAGE_WIDTH w
       shared/richtext.js), więc przeżywa zamknięcie notatki, wysyłkę do
       PDF-u i synchronizację. */

    #imageSetup() {
      const doc = this.root.ownerDocument;

      /* Sprzątanie po poprzednikach — tak samo jak przy uchwycie: Notatnik
         przebudowuje szkielet widoku, więc element notatki ginie, a warstwa
         leżąca w oknie zostałaby po każdym otwarciu po jednej. */
      for (const stale of doc.querySelectorAll(".prose-pick")) {
        if (!stale.__root?.isConnected) stale.remove();
      }

      const host = doc.getElementById("app") ?? doc.body;
      this.picked = null;
      this.sizing = null;

      const pick = doc.createElement("div");
      pick.className = "prose-pick";
      pick.hidden = true;
      pick.__root = this.root;
      pick.innerHTML = `
        <div class="prose-pick__frame"></div>
        <div class="prose-pick__bar">
          <button type="button" data-do="smaller" title="Mniejszy">−</button>
          <button type="button" data-do="bigger" title="Większy">+</button>
          <button type="button" data-do="full" title="Cała szerokość">⤢</button>
          <span class="prose-pick__size">100%</span>
          <button type="button" data-do="alt" title="Opis obrazka">Opis</button>
          <button type="button" data-do="drop" title="Usuń obrazek (Backspace)">Usuń</button>
        </div>
        <input class="prose-pick__alt" type="text" hidden placeholder="opis obrazka" />
        <div class="prose-pick__grab" title="Przeciągnij róg, żeby zmienić rozmiar"></div>
      `;
      host.appendChild(pick);

      this.pick = pick;
      this.pickSize = pick.querySelector(".prose-pick__size");
      this.pickAlt = pick.querySelector(".prose-pick__alt");

      /* Pasek działa NA WCIŚNIĘCIU, a nie na kliknięciu, i nie oddaje
         fokusu. Inaczej naciśnięcie przycisku zabiera zaznaczenie z notatki,
         a przeglądarka — widząc, że contenteditable stracił fokus — zwija
         zaznaczenie obrazka, więc guzik działa raz i przestaje. */
      pick.addEventListener("pointerdown", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        this.#imageDo(button.dataset.do);
      });

      pick.querySelector(".prose-pick__grab").addEventListener("pointerdown", (event) =>
        this.#resizeStart(event),
      );

      this.pickAlt.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.#applyAlt();
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.pickAlt.hidden = true;
          this.root.focus();
        }
        event.stopPropagation();
      });
      this.pickAlt.addEventListener("blur", () => this.#applyAlt());

      this.onResizeMove = (event) => this.#resizeMove(event);
      this.onResizeEnd = () => this.#resizeEnd();

      /* Ramka stoi na współrzędnych ekranu, więc przewinięcie i zmiana
         rozmiaru okna przesuwają obrazek pod nią. Przerysowujemy ją zamiast
         chować: zaznaczenie obrazka ma przeżyć przewinięcie do niego. */
      this.onPickReflow = () => this.#paintPick();
      doc.addEventListener("scroll", this.onPickReflow, true);
      doc.defaultView?.addEventListener("resize", this.onPickReflow);

      /* Kliknięcie gdziekolwiek indziej zdejmuje zaznaczenie — także poza
         notatką, bo obrazek zaznaczony przy zamkniętej notatce byłby ramką
         wiszącą nad cudzą zakładką. */
      this.onPickOutside = (event) => {
        if (!this.root.isConnected) return void this.#unpick();
        if (this.sizing) return;
        if (this.pick.contains(event.target)) return;
        if (event.target?.tagName === "IMG" && this.root.contains(event.target)) return;
        this.#unpick();
      };
      doc.addEventListener("pointerdown", this.onPickOutside, true);
    }

    /** Obrazek pod wskaźnikiem, o ile należy do TEJ notatki. */
    #imageAt(node) {
      const img = node?.closest?.("img");
      return img && this.root.contains(img) ? img : null;
    }

    /**
     * Szerokość KOLUMNY TEKSTU, względem której liczy się procent.
     *
     * Nie `clientWidth` notatki: ta zawiera pasek na uchwyt przenoszenia
     * linii (--grip-gutter), a `width: 60%` w CSS liczy się od pola treści,
     * czyli już bez niego. Dwie różne podstawy dawały rozjazd kilku punktów
     * między tym, co zapisane w pliku, a tym, co widać na ekranie — i to
     * przy każdym pierwszym naciśnięciu „mniejszy".
     */
    #column() {
      const view = this.root.ownerDocument.defaultView;
      const style = view.getComputedStyle(this.root);
      const inside =
        this.root.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      return Math.max(1, inside);
    }

    /** Szerokość obrazka w procentach kolumny — zawsze liczba. */
    #widthOf(img) {
      const stored = Number(img.getAttribute("data-width"));
      if (Number.isFinite(stored) && stored > 0) return stored;
      /* Bez zapisanej szerokości obrazek zajmuje tyle, ile zajmuje: pełną
         kolumnę albo mniej, jeśli sam jest mniejszy niż ona. Pytamy więc
         o stan faktyczny, zamiast zakładać sto procent — inaczej pierwsze
         naciśnięcie „mniejszy" przy wąskim zrzucie potrafiłoby go
         POWIĘKSZYĆ. */
      const column = this.#column();
      const shown = img.getBoundingClientRect().width || column;
      return Math.min(100, Math.round((shown / column) * 100));
    }

    #setWidth(img, percent) {
      const width = Math.max(MIN_IMAGE, Math.min(100, Math.round(percent)));
      if (width >= 100) {
        // Pełna szerokość nie zapisuje się do pliku — patrz richtext.js.
        img.removeAttribute("data-width");
        img.style.removeProperty("width");
      } else {
        img.setAttribute("data-width", String(width));
        img.style.width = `${width}%`;
      }
      return width;
    }

    #pick(img) {
      if (this.picked === img) return this.#paintPick();
      this.#unpick();
      this.picked = img;
      img.setAttribute("data-picked", "true");
      this.#paintPick();
    }

    #unpick() {
      this.pickAlt.hidden = true;
      if (this.picked) this.picked.removeAttribute("data-picked");
      this.picked = null;
      if (this.pick) this.pick.hidden = true;
    }

    /** Ramka, pasek i uchwyt na swoje miejsca — nad obrazkiem, na ekranie. */
    #paintPick() {
      if (!this.picked) return;
      // Obrazek mógł zniknąć razem z notatką albo z akapitem, w którym stał.
      if (!this.root.contains(this.picked)) return void this.#unpick();

      const box = this.picked.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return void (this.pick.hidden = true);

      this.pick.hidden = false;
      this.pick.style.left = `${box.left}px`;
      this.pick.style.top = `${box.top}px`;
      this.pick.style.width = `${box.width}px`;
      this.pick.style.height = `${box.height}px`;
      this.pickSize.textContent = `${this.#widthOf(this.picked)}%`;
    }

    /** Co robią przyciski paska. Jedno miejsce, żeby żaden nie zapomniał zapisać. */
    #imageDo(what) {
      const img = this.picked;
      if (!img) return;

      if (what === "drop") return this.#dropPicked();
      if (what === "alt") {
        this.pickAlt.hidden = !this.pickAlt.hidden;
        if (this.pickAlt.hidden) return;
        this.pickAlt.value = img.getAttribute("alt") ?? "";
        this.pickAlt.focus();
        this.pickAlt.select();
        return;
      }

      const now = this.#widthOf(img);
      const next = what === "full" ? 100 : what === "bigger" ? now + 10 : now - 10;
      this.#setWidth(img, next);
      this.#paintPick();
      this.#changed();
    }

    #applyAlt() {
      if (this.pickAlt.hidden || !this.picked) return;
      this.picked.setAttribute("alt", this.pickAlt.value);
      this.pickAlt.hidden = true;
      this.#changed();
    }

    /**
     * Obrazek znika, a razem z nim akapit, w którym stał sam.
     *
     * Pusty akapit po skasowanym zrzucie jest pustą linią w środku notatki,
     * której nikt nie prosił — i której nie widać, więc nie wiadomo, skąd
     * się wzięła.
     */
    #dropPicked() {
      const img = this.picked;
      if (!img) return;
      const block = img.closest("p, li, blockquote, h1, h2, h3");
      this.#unpick();
      img.remove();
      if (block && this.root.contains(block) && !block.textContent.trim() && !block.querySelector("img")) {
        // Poza listą kasujemy blok; punkt listy zostaje, bo lista bez punktu
        // rozsypałaby się bardziej, niż kosztuje pusty punkt.
        if (block.tagName !== "LI") block.remove();
      }
      this.root.focus();
      this.#changed();
    }

    /* ── Skalowanie ciągnięciem za róg ── */

    #resizeStart(event) {
      if (!this.picked || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const doc = this.root.ownerDocument;
      this.sizing = {
        pointerId: event.pointerId,
        startX: event.clientX,
        // Szerokość liczymy względem KOLUMNY notatki, bo w takich jednostkach
        // rozmiar idzie do pliku — inaczej ten sam gest znaczyłby co innego
        // w oknie głównym i na wąskiej kartce z pulpitu.
        column: this.#column(),
        from: this.picked.getBoundingClientRect().width,
      };
      doc.body.classList.add("is-sizing-image");
      doc.addEventListener("pointermove", this.onResizeMove, true);
      doc.addEventListener("pointerup", this.onResizeEnd, true);
      doc.addEventListener("pointercancel", this.onResizeEnd, true);
      doc.addEventListener("selectstart", this.onNoSelect, true);
    }

    #resizeMove(event) {
      if (!this.sizing || !this.picked) return;
      const width = this.sizing.from + (event.clientX - this.sizing.startX);
      this.#setWidth(this.picked, (width / this.sizing.column) * 100);
      this.#paintPick();
    }

    #resizeEnd() {
      if (!this.sizing) return;
      const doc = this.root.ownerDocument;
      this.sizing = null;
      doc.body.classList.remove("is-sizing-image");
      doc.removeEventListener("pointermove", this.onResizeMove, true);
      doc.removeEventListener("pointerup", this.onResizeEnd, true);
      doc.removeEventListener("pointercancel", this.onResizeEnd, true);
      doc.removeEventListener("selectstart", this.onNoSelect, true);
      this.#paintPick();
      this.#changed();
    }

    /**
     * Wciśnięcie na obrazku: zaznacza go, a ruch z wciśniętym przyciskiem
     * przenosi cały akapit.
     *
     * Przenoszenie idzie tą samą drogą co uchwyt przy punkcie listy —
     * i to nie jest oszczędność kodu, tylko warunek zgodności: kreska
     * pokazująca miejsce upuszczenia, klawisz Escape przerywający gest
     * i reguła „pojemnikiem staje się pojemnik linii obok" mają znaczyć
     * przy obrazku dokładnie to samo, co przy każdej innej linii.
     *
     * Samo wciśnięcie bez ruchu kończy się niczym: #dragEnd nie ma wtedy
     * szczeliny, do której miałby przełożyć — więc gest jest po prostu
     * zaznaczeniem.
     */
    #imageDown(event) {
      const img = this.#imageAt(event.target);
      if (!img) {
        if (this.picked && !this.pick.contains(event.target)) this.#unpick();
        return;
      }
      if (event.button !== 0) return;

      this.#pick(img);
      /* ══ FOKUS TRZEBA WZIĄĆ RĘCZNIE ══

         Za chwilę #dragStart odmówi domyślnej obsługi wciśnięcia (bez tego
         przeglądarka zaczyna zaznaczać tekst) — a razem z nią odmawia
         USTAWIENIA FOKUSU na notatce. Notatka bez fokusu nie dostaje
         klawiszy: zaznaczony obrazek nie dawał się skasować Backspace'em
         ani przesunąć ⌥↑, bo klawisze szły do okna, a nie do edytora.
         Wciśnięcie na obrazku jest wejściem w notatkę tak samo jak
         wciśnięcie na zdaniu, więc fokus bierzemy wprost. */
      this.root.focus({ preventScroll: true });
      const line = this.#lineFor(img);
      if (!line) return;
      this.gripLine = line;
      this.#dragStart(event);
    }

    /* Odhaczanie: pole jest rysowane przez CSS, więc kliknięcie w nie
       jest kliknięciem w lewy skraj punktu listy. */
    #click(event) {
      // Obrazek obsłużyło już wciśnięcie (#imageDown) — tutaj kliknięcie
      // w niego mogłoby najwyżej trafić w odhaczanie punktu listy, w którym
      // zrzut stoi.
      if (this.#imageAt(event.target)) return;

      // Strzałka nagłówka składanego. Jest przed odhaczaniem, bo nagłówek
      // nie jest punktem listy i te dwa obszary nigdy się nie spotkają.
      // Sam gest siedzi w shared/richtext.js — ten sam, co w podglądzie
      // podsumowania spotkania, żeby strzałka znaczyła wszędzie to samo.
      if (clickFold(event, this.root, { zone: TOGGLE_ZONE })) {
        this.#changed();
        return;
      }

      const item = event.target.closest?.("ul.task > li");
      if (!item) return;
      const box = item.getBoundingClientRect();
      if (event.clientX > box.left + CHECKBOX_ZONE) return;

      event.preventDefault();
      item.setAttribute("data-done", item.getAttribute("data-done") === "true" ? "false" : "true");
      this.#changed();
    }

    #keydown(event) {
      /* ══ ZAZNACZONY OBRAZEK PRZEJMUJE KLAWISZE ══

         Idzie to PRZED wszystkim innym, bo obrazek zaznaczony kliknięciem
         nie ma w sobie kursora — Backspace bez tego trafiałby w miejsce,
         w którym kursor stał ostatnio, czyli kasowałby literę gdzie indziej
         w notatce. */
      if (this.picked) {
        if (event.key === "Escape") {
          event.preventDefault();
          this.#unpick();
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          this.#dropPicked();
          return;
        }
        if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          // Obrazek jeździ po notatce tak samo jak każda inna linia.
          const line = this.#lineFor(this.picked);
          if (line) {
            event.preventDefault();
            this.#moveLine(line, event.key === "ArrowUp" ? -1 : 1);
            this.#paintPick();
            return;
          }
        }
      }

      /* Przenoszenie linii idzie na ⌥ ze strzałką — przed sprawdzeniem ⌘,
         bo nie ma z nim nic wspólnego. macOS przypisuje temu skrótowi skok
         o akapit; przejmujemy go tylko wtedy, gdy naprawdę było co ruszyć. */
      if (event.altKey && !event.metaKey && !event.ctrlKey) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          if (this.#moveByKey(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
          return;
        }
      }

      if (!(event.metaKey || event.ctrlKey)) return;
      // Skróty systemowe okna obsługuje menu aplikacji; tutaj tylko te,
      // które dotyczą zaznaczenia w edytorze.
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i") {
        event.preventDefault();
        this.format(key === "b" ? "bold" : "italic");
      }
    }

    /* Wklejanie zawsze jako czysty tekst: notatka ma jeden krój i jeden
       rozmiar, a ze strony WWW przyjechałoby wszystko naraz.

       WYJĄTKIEM JEST OBRAZEK. Zrzut ekranu w schowku to nie jest
       formatowanie, które trzeba zdjąć — to jest treść, której inaczej nie
       da się do notatki wstawić w ogóle. */
    #paste(event) {
      event.preventDefault();

      const image = this.#imageInClipboard(event.clipboardData);
      const text = event.clipboardData?.getData("text/plain") ?? "";
      /* Obrazek ma pierwszeństwo, ale tylko wtedy, gdy NIE MA tekstu.
         Kopiując fragment strony, dostaje się jedno i drugie — i wtedy
         chodziło o tekst; nikt nie kopiuje akapitu po to, żeby wkleić
         ikonkę, która akurat w nim stała. */
      if (image && !text.trim()) {
        void this.#pasteImage(image);
        return;
      }

      /* Pusty schowek zdarzenia wklejania nie znaczy pusty schowek systemu.
         Zrzut zrobiony ⌃⌘⇧4 potrafi nie pojawić się w `clipboardData`
         wcale — a to najczęstszy sposób robienia zrzutów. Pytamy więc
         jeszcze proces główny, który widzi schowek w całości. */
      if (!image && !text) {
        void this.#pasteImage(null);
        return;
      }

      document.execCommand("insertText", false, text);
    }

    /** Obrazek w schowku, o ile jest — jako element, z którego da się czytać. */
    #imageInClipboard(data) {
      for (const item of data?.items ?? []) {
        if (item.kind === "file" && String(item.type).startsWith("image/")) {
          const file = item.getAsFile?.();
          if (file) return file;
        }
      }
      for (const file of data?.files ?? []) {
        if (String(file.type).startsWith("image/")) return file;
      }
      return null;
    }

    /**
     * Obrazek ze schowka do notatki.
     *
     * Bajtów NIE trzymamy w treści. Obrazek wklejony jako `data:` wchodzi
     * do Markdownu w całości — kilkaset kilobajtów base64 w jednej linii
     * pliku, który ma się dać przeczytać w cudzym edytorze, wysłać do
     * Notatek Apple i zsynchronizować. Zapisuje go więc proces główny obok
     * pozostałych zrzutów, a notatka trzyma sam adres — dokładnie tak, jak
     * przy „Tekście z ekranu" (patrz main/shot.js).
     */
    async #pasteImage(file) {
      const bridge = window.cribro?.notes?.pasteImage;
      if (!bridge) return; // okno bez mostu (podgląd, test) — nie ma dokąd zapisać

      let dataUrl = null;
      if (file) {
        dataUrl = await new Promise((done) => {
          const reader = new FileReader();
          reader.onload = () => done(String(reader.result ?? ""));
          reader.onerror = () => done(null);
          reader.readAsDataURL(file);
        });
      }

      const result = await bridge(dataUrl).catch(() => null);
      if (!result?.markdown) return;

      this.insertImage(result.markdown);
    }

    /**
     * Gotowy znacznik obrazka w miejsce kursora, jako OSOBNY BLOK.
     *
     * Nie przez insertText: obrazek wstawiony w środek zdania zostawiałby
     * w pliku znacznik Markdowna wciśnięty między słowa, a na ekranie —
     * kafelek w połowie akapitu. Zrzut jest rzeczą osobną i wchodzi jako
     * własny akapit, tak samo jak wchodzi z „Tekstu z ekranu".
     */
    insertImage(markdown) {
      const html = markdownToHtml(markdown);
      const block = this.#blockAt(this.#anchor());
      const top = block && block.parentElement !== this.root
        ? (block.closest("ul, ol, blockquote") ?? this.root.lastElementChild)
        : block;

      const holder = this.root.ownerDocument.createElement("div");
      holder.innerHTML = html;
      const blocks = [...holder.children];
      if (!blocks.length) return;

      /* Pusty akapit, w którym stał kursor, ustępuje miejsca obrazkowi —
         inaczej po każdym wklejeniu zostaje nad nim pusta linia. */
      if (top && !top.textContent.trim() && !top.querySelector("img")) {
        top.replaceWith(...blocks);
      } else if (top) {
        top.after(...blocks);
      } else {
        this.root.append(...blocks);
      }

      // Kursor pod obrazkiem: po wklejeniu zrzutu prawie zawsze pisze się
      // do niego zdanie.
      const after = this.root.ownerDocument.createElement("p");
      after.appendChild(this.root.ownerDocument.createElement("br"));
      blocks[blocks.length - 1].after(after);
      const range = this.root.ownerDocument.createRange();
      range.setStart(after, 0);
      range.collapse(true);
      const selection = this.root.ownerDocument.defaultView.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      this.#changed();
    }
  }

  window.CribroEditor = {
    create: (root, options) => new RichEditor(root, options),

    /**
     * Zdejmij uchwyty ze wszystkich otwartych notatek.
     *
     * Woła się to z jednego miejsca — z przerysowania okna po zmianie
     * zakładki (patrz render w js/app.js) — i po to, żeby uchwyt NIE
     * PRZEŻYŁ notatki, przy której stał.
     *
     * Bo notatka nie znika spod myszy, tylko razem z zakładką: sekcja
     * dostaje `hidden`, kursor zostaje tam, gdzie był, i nie pada żaden
     * ruch, po którym uchwyt mógłby się domyślić, że jest już nad czymś
     * cudzym. Zostawał wtedy jako sześć kropek na obcej zakładce — i,
     * co gorsza, jako miejsce, w które nie dało się kliknąć, bo leżał na
     * wierzchu i to on łapał kliknięcia.
     *
     * Obserwator widoczności w #dragSetup pilnuje tego samego, ale nie
     * zawsze zdąży: przeglądarka wstrzymuje go, gdy okno jest przykryte
     * i nie rysuje klatek. Ta droga jest pewna, bo nie zależy od niczego
     * poza wywołaniem.
     */
    parkAll: () => {
      for (const editor of live) editor.parkGrip();
    },
  };
})();
