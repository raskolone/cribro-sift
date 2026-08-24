"use strict";

/**
 * Wspólny kawałek Notatnika: te same notatki pokazuje zakładka w oknie
 * głównym i osobne okno Notatnika, więc tytuł, zajawka i kolejność muszą
 * wyglądać identycznie w obu miejscach. Reszta — układ, pasek narzędzi,
 * zdarzenia — należy do konkretnego widoku.
 */

(function () {
  const escape = (text) =>
    String(text ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

  /* Sama kreska nie jest treścią. Notatka zaczynająca się od linii
     rozdzielającej brałaby ją za tytuł i na liście stałoby „---". */
  const DIVIDER = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

  /* Znaczniki Markdownu zdejmujemy z tytułu i zajawki: na liście ma być
     widać treść, a nie zapis, w którym akurat leży na dysku. Strzałka
     nagłówka składanego odchodzi razem z kratami — mówi o tym, czy coś
     jest schowane, a nie o tym, jak notatka się nazywa. */
  const plain = (line) =>
    DIVIDER.test(String(line ?? ""))
      ? ""
      : String(line ?? "")
          /* Obrazek nie jest tytułem. Notatka z tekstu z ekranu zaczyna się
             od zrzutu, a na liście stałby wtedy adres pliku — więc obrazek
             znika stąd w całości i tytułem zostaje pierwsza linia, która
             coś mówi. */
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
          .replace(/^\s*(#{1,6}\s+|[-*]\s+\[[ xX]\]\s+|[-*]\s+|>\s?|\d+\.\s+)/, "")
          .replace(/^[\u25B8\u25BE]\s*/, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/[*_`]/g, "")
          .trim();

  /** Tytuł to pierwsza niepusta linia — nikt w trakcie rozmowy nie wymyśla nazwy. */
  const rawTitle = (note) => (note?.text ?? "").split("\n").map(plain).find(Boolean) ?? "";

  const titleOf = (note) => {
    const first = rawTitle(note);
    return first ? first.slice(0, 60) : t("Bez tytułu");
  };

  /**
   * Zmiana tytułu, czyli przepisanie pierwszej niepustej linii — bo tam
   * tytuł naprawdę mieszka. Forma linii zostaje: jeśli nagłówek zaczynał
   * się od „# ", nowy tytuł też się od niego zaczyna, a notatka na dysku
   * dalej wygląda jak Markdown, którym jest.
   */
  function retitle(text, title) {
    const clean = String(title ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return String(text ?? "");

    const lines = String(text ?? "").split("\n");
    const index = lines.findIndex((line) => plain(line));
    // Pusta notatka nie ma czego przepisywać — tytuł staje się jej treścią.
    if (index === -1) return clean;

    const prefix = /^\s*(?:#{1,6}\s+|[-*]\s+\[[ xX]\]\s+|[-*]\s+|>\s?|\d+\.\s+)?(?:[\u25B8\u25BE]\s*)?/.exec(
      lines[index],
    )[0];
    lines[index] = prefix + clean;
    return lines.join("\n");
  }

  /** Dwie linijki tego, co jest w środku — bez tytułu, bo ten już widać. */
  const previewOf = (note, limit = 120) => {
    const lines = (note?.text ?? "").split("\n").map(plain).filter(Boolean);
    return lines.slice(1).join(" ").slice(0, limit);
  };

  /* Liczymy słowa, nie znaki zapisu: „- [ ] zadzwonić" to jedno słowo,
     a nie cztery. Inaczej lista zadań nabijałaby licznik myślnikami. */
  const countWords = (text) => {
    const words = String(text ?? "")
      .split("\n")
      .map(plain)
      .join(" ")
      .trim();
    return words ? words.split(/\s+/).length : 0;
  };

  function when(iso) {
    const date = new Date(iso);
    const minutes = Math.round((Date.now() - date) / 60000);
    if (minutes < 1) return t("teraz");
    if (minutes < 60) return t("{n} min", { n: minutes });
    if (minutes < 1440) return t("{n} godz.", { n: Math.round(minutes / 60) });
    return date.toLocaleDateString(uiLocale(), { day: "numeric", month: "short" });
  }

  /** Przypięte na górze, potem najświeższe. */
  const sortNotes = (notes) =>
    [...notes].sort((a, b) => {
      if (!a.pinned !== !b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

  /* Szybka notatka to notatka jak każda inna — z jedną różnicą, którą
     widać na liście. Powstaje w małym okienku, w trakcie rozmowy, i jest
     zwykle jednym zdaniem. Notatka ze spotkania rośnie i wraca się do niej
     przez tydzień. Trzymanie ich w jednym ciągu znaczyło, że dziesięć
     rzuconych myśli spycha tę jedną, po którą się przyszło. */
  const isQuick = (note) => note?.kind === "quick";

  /**
   * Podział listy na przegródki. Kolejność jest kolejnością ważności:
   * najpierw przypięte — to one są powodem, dla którego ktokolwiek
   * przypina — potem szybkie notatki, na końcu cała reszta. Przypięta
   * szybka notatka idzie na górę, a nie zostaje w swojej przegródce:
   * przypięcie znaczy „mam to mieć przed oczami", nie „posortuj mnie".
   *
   * Nagłówek pokazujemy dopiero wtedy, gdy naprawdę jest co dzielić — kto
   * nigdy nie przypiął notatki ani nie użył szybkiej, nie ma powodu oglądać
   * nagłówka nad wszystkim, co ma.
   *
   * @returns {{ groups: {key: string, label: string, items: object[]}[], divided: boolean }}
   */
  function groupNotes(notes) {
    const sorted = sortNotes(notes);
    const loose = sorted.filter((note) => !note.pinned);
    const groups = [
      { key: "pinned", label: "Przypięte", items: sorted.filter((note) => !!note.pinned) },
      { key: "quick", label: "Szybkie notatki", items: loose.filter(isQuick) },
      { key: "note", label: "Notatki", items: loose.filter((note) => !isQuick(note)) },
    ].filter((group) => group.items.length);

    return { groups, divided: groups.length > 1 };
  }

  /* Zwinięta przegródka to preferencja widoku — zostaje między
     uruchomieniami, ale nie ma po co jeździć z nią przez most do procesu
     głównego. Zapisujemy klucze, nie stan „każdej po kolei": przegródka,
     której nie ma, nie zajmuje miejsca w pamięci ustawień. */
  function collapsedGroups(key) {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
      return new Set(Array.isArray(stored) ? stored : []);
    } catch {
      return new Set();
    }
  }

  const saveCollapsedGroups = (key, collapsed) =>
    localStorage.setItem(key, JSON.stringify([...collapsed]));

  /* ── Kolor kartki ──────────────────────────────────────────────
     Karteczka na pulpicie ma kolor z tego samego powodu, z którego mają go
     karteczki na monitorze: żeby rozpoznać ją, zanim się ją przeczyta.
     „Ta żółta" jest szybsza niż „ta druga od góry" i przeżywa przesunięcie.

     Kolorów jest siedem i wszystkie są CIEMNE. To nie jest paleta do wyboru
     ładnego odcienia, tylko do rozróżniania kartek — a kartka na wierzchu
     musi zostać czytelna, więc jasne tło pod jasnym tekstem nie wchodzi
     w grę. Akcent (odhaczenia, punktory) zostaje zielony we wszystkich:
     zieleń tutaj znaczy „zrobione", a nie „taki kolor notatki".

     Klucz jedzie do pliku notatki i na serwer; to własność notatki, nie
     tego biurka — inaczej niż „na wierzchu" (patrz toggleWidget w notes.js). */
  const NOTE_COLORS = [
    ["default", "Granat"],
    ["moss", "Mech"],
    ["amber", "Bursztyn"],
    ["violet", "Fiolet"],
    ["rose", "Róż"],
    ["sky", "Błękit"],
    ["graphite", "Grafit"],
  ];

  const COLOR_KEYS = new Set(NOTE_COLORS.map(([key]) => key));

  /** Kolor notatki albo „default" — także dla wartości, której już nie ma. */
  const colorOf = (note) => (COLOR_KEYS.has(note?.color) ? note.color : "default");

  /**
   * Przepisanie tytułu w miejscu.
   *
   * Tytuł notatki nie jest osobnym polem — jest pierwszą niepustą linią
   * treści (patrz titleOf i retitle wyżej). Przepisywanie go jest więc
   * przepisywaniem notatki i musi wracać tą samą drogą co każda inna
   * zmiana tekstu, a nie własną.
   *
   * Enter kończy, Escape cofa, klik obok kończy. Notatka jest
   * wielolinijkowa, tytuł nie — dlatego `plaintext-only` i przechwycony
   * Enter: wklejony akapit ma wejść jako jedna linia albo nie wejść wcale.
   *
   * @param {HTMLElement} element  miejsce, w którym stoi tytuł
   * @param {object}   options
   * @param {string}   options.text      tytuł przed zmianą
   * @param {Function} options.onCommit  (nowyTytuł) => void | Promise
   * @param {Function} [options.onStart] wołane, gdy pole staje się polem
   * @param {Function} [options.onEnd]   wołane po zakończeniu, zawsze
   */
  function renameInPlace(element, { text, onCommit, onStart, onEnd }) {
    // Drugie wejście w to samo pole zdublowałoby nasłuchy i zapisało
    // tytuł dwa razy — a przy Escape zapisałoby ten cofnięty.
    if (!element || element.dataset.renaming === "true") return;
    element.dataset.renaming = "true";

    const before = String(text ?? "");
    element.textContent = before;
    element.contentEditable = "plaintext-only";
    element.spellcheck = false;
    element.classList.add("is-editing");
    onStart?.();
    element.focus();
    document.getSelection()?.selectAllChildren(element);

    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      delete element.dataset.renaming;
      element.contentEditable = "false";
      element.classList.remove("is-editing");
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("blur", onBlur);

      const after = element.textContent.replace(/\s+/g, " ").trim();
      if (commit && after && after !== before) await onCommit(after);
      onEnd?.();
    };

    const run = (commit) => void finish(commit).catch(() => onEnd?.());

    function onKey(event) {
      if (event.key === "Enter") {
        event.preventDefault();
        run(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        run(false);
      }
    }
    function onBlur() {
      run(true);
    }

    element.addEventListener("keydown", onKey);
    element.addEventListener("blur", onBlur);
  }

  /* ── Szuflady i etykiety ───────────────────────────────────────
     Szuflada jest jedna i mówi, GDZIE notatka leży. Etykiet jest dowolnie
     wiele i mówią, CZEGO notatka dotyczy. Notatka ze spotkania należy do
     jednego projektu i dotyczy trzech spraw naraz — dlatego to nie jest
     jedno pole użyte dwa razy.

     Obie listy powstają z samych notatek, nie z osobnego rejestru. Szuflada
     bez notatek przestaje istnieć sama, a rejestr trzeba by sprzątać ręcznie
     i pilnować, żeby nie rozjechał się z tym, co naprawdę leży w notatkach. */

  /** Nazwa szuflady albo null. Puste, spacje i „null" znaczą to samo. */
  const folderOf = (note) => {
    const name = String(note?.folder ?? "").trim();
    return name || null;
  };

  const tagsOf = (note) =>
    (Array.isArray(note?.tags) ? note.tags : [])
      .map((tag) => String(tag ?? "").trim())
      .filter(Boolean);

  /* Etykieta zapisana raz jako „Pilne", a raz jako „pilne", to dla człowieka
     jedna etykieta — i tak ma się zachowywać przy szukaniu i przy dokładaniu.
     Zapisujemy formę, którą ktoś wpisał; porównujemy zawsze złożoną. */
  const tagKey = (tag) => String(tag ?? "").trim().toLowerCase();

  /** Etykieta w postaci nadającej się do zapisu: bez kraty, bez spacji. */
  const cleanTag = (tag) =>
    String(tag ?? "")
      .replace(/^#+/, "")
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}_-]/gu, "")
      .slice(0, 32);

  /** Wszystkie szuflady, jakie są w notatkach — po jednej, alfabetycznie. */
  function foldersOf(notes) {
    const seen = new Map();
    for (const note of notes ?? []) {
      const name = folderOf(note);
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, uiLocale()));
  }

  /** Wszystkie etykiety razem z liczbą notatek — najczęstsze pierwsze. */
  function allTags(notes) {
    const count = new Map();
    for (const note of notes ?? []) {
      for (const tag of tagsOf(note)) {
        const key = tagKey(tag);
        const seen = count.get(key);
        if (seen) seen.n += 1;
        else count.set(key, { tag, n: 1 });
      }
    }
    return [...count.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag, uiLocale()));
  }

  /**
   * Czy notatka pasuje do frazy.
   *
   * Fraza „#pilne" szuka etykiety, a nie słowa w treści — bo tak ją się
   * pisze i tak ją się widzi na kaflu. Reszta frazy szuka po staremu:
   * w treści, w nazwie szuflady i w etykietach.
   */
  function matches(note, query) {
    const raw = String(query ?? "").trim();
    if (!raw) return true;

    const tags = tagsOf(note).map(tagKey);
    const words = raw.split(/\s+/).filter(Boolean);
    const wanted = words.filter((word) => word.startsWith("#") && word.length > 1);
    if (wanted.some((word) => !tags.some((tag) => tag.startsWith(tagKey(word.slice(1))))))
      return false;

    const rest = words.filter((word) => !word.startsWith("#")).join(" ").toLowerCase();
    if (!rest) return true;

    const hay = [String(note.text ?? ""), folderOf(note) ?? "", ...tagsOf(note)]
      .join(" ")
      .toLowerCase();
    return hay.includes(rest);
  }

  /** Podświetlenie szukanej frazy — po ucieczce znaków, nie przed. */
  function highlight(text, query) {
    const safe = escape(text);
    const needle = query.trim();
    if (!needle) return safe;
    const pattern = escape(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return safe.replace(new RegExp(pattern, "gi"), (hit) => `<mark>${hit}</mark>`);
  }

  window.NotesCore = {
    escape,
    titleOf,
    rawTitle,
    retitle,
    previewOf,
    countWords,
    when,
    sortNotes,
    isQuick,
    folderOf,
    tagsOf,
    tagKey,
    cleanTag,
    foldersOf,
    allTags,
    groupNotes,
    collapsedGroups,
    saveCollapsedGroups,
    matches,
    highlight,
    NOTE_COLORS,
    colorOf,
    renameInPlace,
  };
})();
