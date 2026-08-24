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
  const { markdownToHtml, htmlToMarkdown } = window.CribroRichtext;

  const CHECKBOX_ZONE = 26; // szerokość pola do odhaczenia, w pikselach
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
      this.root.addEventListener("keydown", (event) => this.#keydown(event));
    }

    /* ── Treść ── */

    setMarkdown(markdown) {
      // Podmiana w trakcie pisania zabrałaby kursor — wchodzimy tylko wtedy,
      // gdy na ekranie jest naprawdę co innego niż w notatce.
      const same = this.getMarkdown() === String(markdown ?? "").trim();
      if (same && this.root.innerHTML.trim()) return;
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

    /** Co należy do tego nagłówka: wszystko aż do nagłówka nie niższego. */
    #foldRange(heading) {
      const rank = HEADINGS.indexOf(heading.tagName);
      const inside = [];
      for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
        const other = HEADINGS.indexOf(node.tagName);
        if (other !== -1 && other <= rank) break;
        inside.push(node);
      }
      return inside;
    }

    /**
     * Chowanie i pokazywanie treści pod nagłówkami. Wołane po każdej
     * zmianie, bo blok dopisany pod zwiniętym nagłówkiem też ma być
     * schowany — a bloków przybywa przy każdym naciśnięciu Entera.
     *
     * Publiczna, bo woła ją także okno: kliknięcie w strzałkę obsługuje
     * edytor, ale wczytanie notatki z zewnątrz — już nie.
     */
    applyFolds() {
      for (const node of this.root.children) node.removeAttribute("data-folded");
      for (const heading of this.root.querySelectorAll('[data-toggle="closed"]')) {
        for (const node of this.#foldRange(heading)) node.setAttribute("data-folded", "true");
      }
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

    /* Odhaczanie: pole jest rysowane przez CSS, więc kliknięcie w nie
       jest kliknięciem w lewy skraj punktu listy. */
    #click(event) {
      // Strzałka nagłówka składanego. Jest przed odhaczaniem, bo nagłówek
      // nie jest punktem listy i te dwa obszary nigdy się nie spotkają.
      const heading = event.target.closest?.("h1[data-toggle], h2[data-toggle], h3[data-toggle]");
      if (heading) {
        const box = heading.getBoundingClientRect();
        if (event.clientX <= box.left + TOGGLE_ZONE) {
          event.preventDefault();
          heading.setAttribute(
            "data-toggle",
            heading.getAttribute("data-toggle") === "closed" ? "open" : "closed",
          );
          this.#changed();
          return;
        }
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
       rozmiar, a ze strony WWW przyjechałoby wszystko naraz. */
    #paste(event) {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, text);
    }
  }

  window.CribroEditor = {
    create: (root, options) => new RichEditor(root, options),
  };
})();
