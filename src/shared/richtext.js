"use strict";

/**
 * Notatka na dysku jest Markdownem, na ekranie — sformatowanym tekstem.
 *
 * To jedno miejsce, które tłumaczy jedno na drugie w obie strony. Powód
 * jest taki, że oba końce mają rację: w oknie ma być zwykły edytor, gdzie
 * ⌘B pogrubia słowo, a nie wstawia gwiazdki; na dysku ma zostać tekst,
 * który da się przeczytać bez aplikacji, wysłać do Notatek Apple, zapisać
 * jako .md i dopisać do niego zdanie z dyktowania (patrz joinNote w store.js).
 *
 * Zakres jest celowo wąski — dokładnie to, co potrafi pasek narzędzi:
 * nagłówek, pogrubienie, kursywa, kod, lista, lista zadań, cytat.
 * Wszystkiego innego nie ma, więc nie ma też czego stracić po drodze.
 *
 * Plik jest wspólny dla renderera i dla testu w Node, dlatego eksportuje
 * się na oba sposoby. `htmlToMarkdown` dotyka wyłącznie tych własności
 * węzła, które łatwo podstawić (nodeType, tagName, childNodes,
 * getAttribute) — dzięki temu da się go sprawdzić bez przeglądarki.
 *
 * Całość siedzi w klamrze i wychodzi na zewnątrz jednym `CribroRichtext`.
 * W przeglądarce to nie jest kwestia porządku, tylko działania: skrypty
 * ładowane znacznikiem <script> dzielą jedną przestrzeń nazw, a nazwy
 * w rodzaju `renderList`, `attr` czy `escapeHtml` przychodzą do głowy
 * każdemu. Notatnik miał już własne `renderList` (js/notes.js, lista
 * notatek) i to ono wygrywało, bo ładuje się później — przez co notatka
 * z listą przestawała się wyświetlać w całym oknie Notatnika.
 */

(function () {
  /* ── Markdown → HTML ──────────────────────────────────────────── */

  const LIST_LINE = /^(\s*)([-*]|\d+\.)[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/;
  const QUOTE_LINE = /^\s*>[ \t]?/;
  const HEADING_LINE = /^(#{1,6})[ \t]+(.*)$/;
  /* Linia rozdzielająca. Trzy formy, bo tyle ich zna Markdown i tyle
     przyjedzie z cudzego pliku; wychodzi zawsze jedna („---"). */
  const DIVIDER_LINE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  /* Nagłówek składany. Strzałka stoi w PLIKU, nie tylko na ekranie —
     inaczej zwinięcie rozwijałoby się z powrotem przy każdym otwarciu
     notatki, a stan „to jest schowane" jest częścią treści, nie widoku.
     Znak jest zwykłym Unicode: notatka otwarta w cudzym edytorze dalej
     czyta się jak nagłówek ze strzałką, a nie jak zepsuty zapis. */
  const TOGGLE_MARK = /^([\u25B8\u25BE])[ \t]*/;

  function escapeHtml(text) {
    return String(text ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  }

  /* Obrazek w linii — jedyny znacznik Markdowna, który nie jest ozdobą
     tekstu, tylko osobną rzeczą w notatce. Wchodzi tu razem z tekstem
     z ekranu (patrz main/shot.js): zrzut zostaje na dysku, a notatka
     trzyma do niego adres.

     Wyjmujemy go z tekstu, ZANIM ruszą reguły od gwiazdek i podkreśleń —
     inaczej „snake_case" w nazwie pliku zamieniałby połowę adresu
     w kursywę, a „*" w zapytaniu adresu robiłoby z niego pogrubienie. */
  const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;
  const SLOT = "\u0000";

  /* ── Rozmiar obrazka ──────────────────────────────────────────
     Zrzut wchodzi do notatki w pełnej szerokości kolumny i przez długi
     czas nie dało się z nim zrobić NIC WIĘCEJ: ani zmniejszyć, ani
     przesunąć, ani skasować. Rozmiar musi więc gdzieś zamieszkać — i musi
     to być PLIK, nie okno, bo notatka zamknięta i otwarta jutro ma
     wyglądać tak samo jak dziś.

     Zapisujemy go w opisie obrazka, za kreską: `![zrzut|60%](adres)`.
     Trzy powody akurat tak:

       1. Notatka zostaje Markdownem. Cudzy edytor pokaże obrazek
          normalnie, a w opisie zobaczy „zrzut|60%" — dziwne, ale nie
          zepsute. Własny atrybut w HTML-u nie przeżyłby zapisu do .md.
       2. Procent, a nie piksele. Notatkę czyta się w oknie głównym, na
          kartce na pulpicie i w PDF-ie, a te mają różne szerokości —
          „600 px" znaczy w każdym z nich co innego, „60% kolumny" znaczy
          wszędzie to samo.
       3. Pełna szerokość NIE ZAPISUJE SIĘ WCALE. Dzięki temu wszystkie
          notatki, które już leżą na dysku, zostają co do znaku takie,
          jakie są — a obrazek nietknięty nie ma po sobie żadnego śladu. */
  const IMAGE_WIDTH = /^([\s\S]*?)\s*\|\s*(\d{1,3})\s*%?\s*$/;
  /** Poniżej dziesięciu procent kolumny zrzut przestaje być czymkolwiek. */
  const MIN_WIDTH = 10;

  const clampWidth = (value) => Math.max(MIN_WIDTH, Math.min(100, Math.round(value)));

  /** Znaczniki wewnątrz linii. Ucieczka znaków idzie pierwsza, zawsze. */
  function inlineToHtml(text) {
    const images = [];
    let out = escapeHtml(text).replace(IMAGE, (_all, alt, src) => {
      const sized = IMAGE_WIDTH.exec(alt);
      const label = sized ? sized[1] : alt;
      const width = sized ? clampWidth(Number(sized[2])) : null;
      /* Szerokość stoi i w atrybucie, i w stylu. Atrybut jest tym, co
         wraca do pliku (patrz inlineToMarkdown); styl jest tym, co widać.
         Rozdzielone, bo edytor przestawia rozmiar ciągnięciem za róg
         i musi mieć gdzie zapisać liczbę bez zaglądania w CSS. */
      images.push(
        width === null
          ? `<img src="${src}" alt="${label}" />`
          : `<img src="${src}" alt="${label}" data-width="${width}" style="width:${width}%" />`,
      );
      return `${SLOT}${images.length - 1}${SLOT}`;
    });
    out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    // Kursywa tylko wtedy, gdy gwiazdka albo podkreślenie stoi przy granicy
    // słowa — inaczej „30*40" i „snake_case_nazwa" zamieniłyby się w kursywę.
    out = out.replace(/(^|[\s(„"'])\*([^*\n]+)\*(?=$|[\s.,;:!?)”"'])/g, "$1<em>$2</em>");
    out = out.replace(/(^|[\s(„"'])_([^_\n]+)_(?=$|[\s.,;:!?)”"'])/g, "$1<em>$2</em>");
    return out.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_all, index) => images[Number(index)]);
  }

  function listItem(line) {
    const match = LIST_LINE.exec(line);
    if (!match) return null;
    return {
      indent: match[1].replace(/\t/g, "  ").length,
      ordered: /\d/.test(match[2]),
      done: match[3] === undefined ? null : match[3].toLowerCase() === "x",
      text: match[4],
    };
  }

  const startsBlock = (line) =>
    HEADING_LINE.test(line) ||
    QUOTE_LINE.test(line) ||
    DIVIDER_LINE.test(line) ||
    listItem(line) !== null;

  /**
   * Jedna lista od pozycji `start`. Zwraca [html, następna pozycja].
   * Głębsze wcięcie wchodzi w ostatni punkt jako lista zagnieżdżona —
   * dyktowanie do wciętego punktu dokłada wcięty punkt, więc ta struktura
   * powstaje sama i musi przetrwać obie konwersje.
   */
  function renderList(items, start) {
    const base = items[start].indent;
    const { ordered } = items[start];
    const task = items[start].done !== null;
    const parts = [];
    let i = start;

    while (i < items.length && items[i].indent >= base) {
      if (items[i].indent > base) {
        if (!parts.length) break;
        const [nested, next] = renderList(items, i);
        parts[parts.length - 1] += nested;
        i = next;
        continue;
      }
      // Inny rodzaj listy na tym samym poziomie zaczyna osobną listę.
      if (items[i].ordered !== ordered || (items[i].done !== null) !== task) break;

      const item = items[i];
      const done = task ? ` data-done="${item.done ? "true" : "false"}"` : "";
      parts.push(`<li${done}>${inlineToHtml(item.text)}`);
      i += 1;
    }

    const tag = ordered ? "ol" : "ul";
    const cls = task ? ' class="task"' : "";
    return [`<${tag}${cls}>${parts.map((part) => `${part}</li>`).join("")}</${tag}>`, i];
  }

  function markdownToHtml(markdown) {
    const lines = String(markdown ?? "").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      if (DIVIDER_LINE.test(line)) {
        out.push("<hr />");
        i += 1;
        continue;
      }

      const heading = HEADING_LINE.exec(line);
      if (heading) {
        // Trzy stopnie, nie sześć. Notatka ze spotkania nie ma głębszego
        // podziału niż część, podczęść i podpunkt — a czwarty stopień
        // różniłby się od trzeciego wyłącznie tym, że go nie widać.
        const level = Math.min(3, heading[1].length);
        const toggle = TOGGLE_MARK.exec(heading[2]);
        const body = toggle ? heading[2].slice(toggle[0].length) : heading[2];
        const fold = toggle
          ? ` data-toggle="${toggle[1] === "\u25B8" ? "closed" : "open"}"`
          : "";
        out.push(`<h${level}${fold}>${inlineToHtml(body)}</h${level}>`);
        i += 1;
        continue;
      }

      if (QUOTE_LINE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE_LINE.test(lines[i])) {
          body.push(inlineToHtml(lines[i].replace(QUOTE_LINE, "")));
          i += 1;
        }
        out.push(`<blockquote>${body.join("<br />")}</blockquote>`);
        continue;
      }

      if (listItem(line)) {
        const items = [];
        while (i < lines.length && listItem(lines[i])) {
          items.push(listItem(lines[i]));
          i += 1;
        }
        let at = 0;
        while (at < items.length) {
          const [html, next] = renderList(items, at);
          out.push(html);
          at = next > at ? next : at + 1;
        }
        continue;
      }

      // Akapit: kolejne zwykłe linie to jeden akapit z twardymi łamaniami.
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
        paragraph.push(inlineToHtml(lines[i].trim()));
        i += 1;
      }
      out.push(`<p>${paragraph.join("<br />")}</p>`);
    }

    // Pusty edytor potrzebuje akapitu, w którym da się postawić kursor.
    return out.join("") || "<p><br /></p>";
  }

  /* ── HTML → Markdown ──────────────────────────────────────────── */

  const tagOf = (node) => (node && node.tagName ? String(node.tagName).toLowerCase() : "");
  const isText = (node) => node && node.nodeType === 3;
  const childrenOf = (node) => Array.from(node?.childNodes ?? []);
  const attr = (node, name) => (node?.getAttribute ? node.getAttribute(name) : null);

  /* Ile krat na który nagłówek. h4…h6 nie powstają w edytorze, ale
     przyjeżdżają z wklejonego pliku — zjeżdżają do trzeciego stopnia,
     bo głębszego ta notatka nie umie pokazać. */
  const HEADING_TAG = { h1: "#", h2: "##", h3: "###", h4: "###", h5: "###", h6: "###" };

  const INLINE_MARK = {
    strong: "**",
    b: "**",
    em: "_",
    i: "_",
    code: "`",
  };

  function inlineToMarkdown(node) {
    if (isText(node)) return String(node.nodeValue ?? "");

    const tag = tagOf(node);
    if (tag === "br") return "\n";
    // Obrazek nie ma treści, więc bez tego wyjścia zniknąłby po drodze:
    // pętla niżej składa dzieci, a ich tu nie ma.
    if (tag === "img") {
      const src = attr(node, "src");
      if (!src) return "";
      const alt = attr(node, "alt") ?? "";
      const width = Number(attr(node, "data-width"));
      // Pełna szerokość nie zapisuje się wcale — patrz IMAGE_WIDTH wyżej.
      const size = Number.isFinite(width) && width > 0 && width < 100
        ? `|${clampWidth(width)}%`
        : "";
      return `![${alt}${size}](${src})`;
    }

    const inner = childrenOf(node).map(inlineToMarkdown).join("");
    const mark = INLINE_MARK[tag];
    // Znacznik wokół samych spacji byłby Markdownem, którego nikt nie odczyta
    // z powrotem — pusty pogrubiony fragment zostaje pustym fragmentem.
    if (!mark || !inner.trim()) return inner;

    // Znaczniki obejmują słowo, nie spacje wokół niego.
    const [, head, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return `${head}${mark}${core}${mark}${tail}`;
  }

  function listToMarkdown(list, depth) {
    const ordered = tagOf(list) === "ol";
    const taskList = String(attr(list, "class") ?? "").includes("task");
    const pad = "  ".repeat(depth);
    const lines = [];
    let index = 1;

    for (const li of childrenOf(list)) {
      if (tagOf(li) !== "li") continue;

      const nested = childrenOf(li).filter((child) => tagOf(child) === "ul" || tagOf(child) === "ol");
      const own = childrenOf(li).filter((child) => !nested.includes(child));
      const done = attr(li, "data-done");
      const mark = ordered
        ? `${index++}. `
        : taskList || done !== null
          ? `- [${done === "true" ? "x" : " "}] `
          : "- ";

      lines.push(`${pad}${mark}${own.map(inlineToMarkdown).join("").trim()}`);
      for (const child of nested) lines.push(listToMarkdown(child, depth + 1));
    }

    return lines.join("\n");
  }

  function blockToMarkdown(node) {
    if (isText(node)) return String(node.nodeValue ?? "").trim();

    const tag = tagOf(node);
    const text = childrenOf(node).map(inlineToMarkdown).join("").trim();

    if (tag === "ul" || tag === "ol") return listToMarkdown(node, 0);
    if (tag === "hr") return "---";
    if (tag === "img") return inlineToMarkdown(node);
    if (HEADING_TAG[tag]) {
      if (!text) return "";
      // Strzałka wraca do pliku razem z nagłówkiem — patrz TOGGLE_MARK.
      const fold = attr(node, "data-toggle");
      const mark = fold === "closed" ? "\u25B8 " : fold === "open" ? "\u25BE " : "";
      return `${HEADING_TAG[tag]} ${mark}${text}`;
    }
    if (tag === "blockquote") {
      return text
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    }
    if (tag === "li") return text ? `- ${text}` : ""; // sierota poza listą
    return text;
  }

  function htmlToMarkdown(root) {
    const blocks = childrenOf(root).map(blockToMarkdown).filter((block) => block.trim());
    return (
      blocks
        .join("\n\n")
        // Chromium wstawia twardą spację tam, gdzie zwykła stałaby na skraju
        // formatowania. W pliku ma zostać zwykła spacja — twardą widać dopiero
        // wtedy, gdy notatka trafi gdzie indziej i zacznie się dziwnie łamać.
        .replace(/\u00A0/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  }

  /* ── Nagłówki składane: co należy do czego ────────────────────

     Toggle jest NADRZĘDNY. Wrzuca się do niego akapity, listy, zadania
     i głębsze nagłówki, a zwinięcie zamyka je wszystkie naraz — dokładnie
     tak, jak w Notion. Granicę wyznacza stopień nagłówka, jak w każdym
     konspekcie: H2 trzyma wszystko aż do następnego H2 albo H1.

     Ta zasada mieszka TUTAJ, a nie w edytorze, bo obowiązuje w dwóch
     miejscach naraz: w notatce, którą się pisze, i w podsumowaniu
     spotkania, które się tylko czyta. Dwie kopie rozjechałyby się przy
     pierwszej zmianie, a wtedy ta sama notatka zwijałaby się inaczej
     w dwóch oknach tej samej aplikacji. */

  const FOLDABLE = ["H1", "H2", "H3"];

  /** Bloki należące do tego nagłówka — aż do nagłówka nie niższego stopnia. */
  function foldRange(heading) {
    const rank = FOLDABLE.indexOf(heading.tagName);
    const inside = [];
    for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
      const other = FOLDABLE.indexOf(node.tagName);
      if (other !== -1 && other <= rank) break;
      inside.push(node);
    }
    return inside;
  }

  /**
   * Trzy ślady w drzewie, każdy na inne pytanie:
   *
   *   data-folded  „tego nie widać";
   *   data-inside  „to należy do nagłówka wyżej" — po tym CSS rysuje
   *                wcięcie z prowadnicą, więc zawartość toggle widać
   *                ZANIM się go zwinie;
   *   data-hidden  ile bloków chowa zwinięty nagłówek — bez tej liczby
   *                zwinięty toggle wygląda jak zwykły nagłówek.
   *
   * @param {Element} root  pojemnik z blokami najwyższego poziomu
   */
  function applyFolds(root) {
    if (!root?.children) return;
    for (const node of root.children) {
      node.removeAttribute("data-folded");
      node.removeAttribute("data-inside");
      node.removeAttribute("data-hidden");
    }
    for (const heading of root.querySelectorAll("[data-toggle]")) {
      const inside = foldRange(heading);
      const closed = heading.getAttribute("data-toggle") === "closed";
      for (const node of inside) {
        node.setAttribute("data-inside", "true");
        if (closed) node.setAttribute("data-folded", "true");
      }
      /* Liczba stoi przy nagłówku tylko wtedy, gdy jest co liczyć: „0"
         przy pustym toggle byłoby informacją o niczym. */
      if (closed && inside.length) heading.setAttribute("data-hidden", String(inside.length));
    }
  }

  /**
   * Kliknięcie w strzałkę nagłówka składanego.
   *
   * Wspólne dla edytora i dla podglądu, bo gest jest ten sam i ma znaczyć
   * to samo. Strefa kliknięcia to lewy skraj bloku — tam, gdzie CSS rysuje
   * strzałkę; reszta nagłówka zostaje tekstem, w który można wejść kursorem.
   *
   * @returns {boolean} czy kliknięcie było kliknięciem w strzałkę
   */
  function clickFold(event, root, { zone = 22 } = {}) {
    const heading = event.target?.closest?.(
      "h1[data-toggle], h2[data-toggle], h3[data-toggle]",
    );
    if (!heading || !root?.contains?.(heading)) return false;
    if (event.clientX > heading.getBoundingClientRect().left + zone) return false;
    event.preventDefault();
    heading.setAttribute(
      "data-toggle",
      heading.getAttribute("data-toggle") === "closed" ? "open" : "closed",
    );
    applyFolds(root);
    return true;
  }

  const RICHTEXT = {
    markdownToHtml,
    htmlToMarkdown,
    inlineToHtml,
    escapeHtml,
    applyFolds,
    foldRange,
    clickFold,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = RICHTEXT;
  if (typeof window !== "undefined") window.CribroRichtext = RICHTEXT;
})();
