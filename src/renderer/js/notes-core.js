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

  /* Notatka ze spotkania powstaje SAMA, w chwili gdy rozmowa doczeka się
     podsumowania (patrz keepMeetingNote w main/main.js). Nikt jej nie pisze
     i nikt nie zakłada — więc gdyby leżała w jednym ciągu z resztą, każde
     nagrane spotkanie spychałoby w dół notatki naprawdę napisane ręką.
     Ma za to własną naturę: nagłówek, ustalenia, zadania i zapis rozmowy
     na końcu — i wraca się do niej po tygodniu, a nie po godzinie. */
  const isMeeting = (note) => note?.kind === "meeting";

  /**
   * Podział listy na przegródki. Kolejność jest kolejnością ważności:
   * najpierw przypięte — to one są powodem, dla którego ktokolwiek
   * przypina — potem notatki ze spotkań, potem szybkie notatki, na końcu
   * cała reszta. Przypięta notatka idzie na górę bez względu na rodzaj:
   * przypięcie znaczy „mam to mieć przed oczami", nie „posortuj mnie".
   *
   * Spotkania stoją wysoko, bo są jedynymi notatkami, których nikt nie
   * zakładał — dopisują się same po każdej nagranej rozmowie. Wrzucone
   * między napisane ręką, spychałyby je z ekranu tygodniem cudzej pracy.
   *
   * Nagłówek pokazujemy dopiero wtedy, gdy naprawdę jest co dzielić — kto
   * nigdy nie przypiął notatki, nie nagrał spotkania ani nie użył szybkiej,
   * nie ma powodu oglądać nagłówka nad wszystkim, co ma.
   *
   * @returns {{ groups: {key: string, label: string, items: object[]}[], divided: boolean }}
   */
  function groupNotes(notes) {
    const sorted = sortNotes(notes);
    const loose = sorted.filter((note) => !note.pinned);
    const groups = [
      { key: "pinned", label: "Przypięte", items: sorted.filter((note) => !!note.pinned) },
      {
        key: "meeting",
        label: "Notatki ze spotkań",
        items: loose.filter(isMeeting),
      },
      { key: "quick", label: "Szybkie notatki", items: loose.filter(isQuick) },
      {
        key: "note",
        label: "Notatki",
        items: loose.filter((note) => !isQuick(note) && !isMeeting(note)),
      },
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


  /* ══ PASEK CZYNNOŚCI ═══════════════════════════════════════════
     Co MOŻNA ZROBIĆ Z NOTATKĄ, a nie co można zrobić z tekstem.

     ── DLACZEGO NA DOLE, A NIE W GÓRNYM PASKU ──

     Bo to są dwie różne rzeczy, a mieszanie ich kosztowało czytelność.
     Górny pasek to narzędzia PISANIA: pogrubienie, nagłówek, lista. Sięga
     się po nie w trakcie pisania, dziesiątki razy, nie odrywając wzroku od
     zdania. Przypięcie, udostępnienie, przesianie i skasowanie robi się
     RAZ, kiedy notatka jest już napisana — a stojąc obok „B" i „I" mówiły
     „jesteśmy tym samym rodzajem rzeczy". Nie są: jedno zmienia słowo,
     drugie decyduje o losie całej notatki. Kasowanie dwa piksele od
     kursywy to zresztą nie tylko nieporządek.

     ── DLACZEGO Z PODPISAMI ──

     Sama ikona jest zagadką, którą rozwiązuje się najechaniem i czekaniem
     na dymek. Przy pięciu czynnościach, z których każda robi coś
     nieodwracalnego albo prawie, zagadka jest złym pomysłem. Podpis
     kosztuje kilkadziesiąt pikseli i zdejmuje ją całą.

     ── DLACZEGO TU, A NIE OSOBNO W KAŻDYM OKNIE ──

     Bo notatka jest ta sama w zakładce Notatki, w osobnym oknie Notatnika
     i na kartce na pulpicie. Trzy kopie tego samego paska rozjechałyby się
     przy pierwszej zmianie — a rozjazd w miejscu, w którym stoi „Usuń",
     nie jest kosmetyczny. */

  const ACTIONS = [
    { id: "pin", icon: "i-pin", label: "Przypnij", on: "Odepnij", state: "pinned" },
    /* „Widoczna w widgecie" nie mówiło nic nikomu — ani czym jest widget,
       ani co się stanie po naciśnięciu. Czynność jest zaś prosta do
       nazwania: notatka zostaje kartką leżącą na pulpicie, nad wszystkimi
       oknami. Tak też się teraz nazywa. */
    { id: "desktop", icon: "i-sticky", label: "Na pulpit", on: "Z pulpitu", state: "widget" },
    { id: "sift", icon: "i-sieve", label: "Przesiej" },
    { id: "share", icon: "i-share", label: "Udostępnij", menu: true },
    { id: "delete", icon: "i-trash", label: "Usuń", danger: true },
  ];

  /** Dokąd notatka może pojechać. Jedna lista dla obu okien. */
  const SHARE = [
    { id: "apple", label: "Wyślij do Notatek Apple" },
    { id: "notion", label: "Wyślij do Notion" },
    { sep: true },
    { id: "text", label: "Kopiuj tekst" },
    { id: "md", label: "Kopiuj jako Markdown" },
    { sep: true },
    { id: "pdf", label: "Zapisz jako PDF…" },
    { id: "file", label: "Zapisz jako plik .md…" },
  ];

  /**
   * Ikony wstrzykiwane do dokumentu, który ich nie ma.
   *
   * Okno Notatnika ma własny zestaw symboli w swoim HTML-u; kartka na
   * pulpicie ma cztery własne i ani jednego z tamtych. Pasek czynności ma
   * wyglądać w obu tak samo, więc brakujące symbole dokłada kod, który go
   * rysuje — zamiast trzeciej kopii tych samych ścieżek w trzecim pliku.
   */
  const ICON_SHAPES = {
    "i-pin":
      '<path d="M9 3.5h6l-.8 5.2 3 2.6v2.2H6.8v-2.2l3-2.6L9 3.5ZM12 13.5V21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />',
    "i-sticky":
      '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V14l-6 6H5.5A1.5 1.5 0 0 1 4 18.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /><path d="M20 14h-4.5a1.5 1.5 0 0 0-1.5 1.5V20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />',
    "i-sieve":
      '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.7" /><path d="M4.6 9.4h14.8M4.6 14.6h14.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />',
    "i-share":
      '<path d="M12 15.5V3.8M8.2 7.4 12 3.6l3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M5.5 12.5v6a1.8 1.8 0 0 0 1.8 1.8h9.4a1.8 1.8 0 0 0 1.8-1.8v-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />',
    "i-trash":
      '<path d="M4.5 7h15M9.5 7V5.4a1.4 1.4 0 0 1 1.4-1.4h2.2a1.4 1.4 0 0 1 1.4 1.4V7M6.6 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.8-12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />',
    "i-omega":
      '<path d="M7 20h3.2v-1.6a6.4 6.4 0 1 1 3.6 0V20H17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />',
  };

  function ensureIcons(doc = document) {
    const missing = Object.keys(ICON_SHAPES).filter((id) => !doc.getElementById(id));
    if (!missing.length) return;
    const sheet = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    sheet.setAttribute("width", "0");
    sheet.setAttribute("height", "0");
    sheet.setAttribute("aria-hidden", "true");
    sheet.style.position = "absolute";
    sheet.innerHTML = `<defs>${missing
      .map((id) => `<symbol id="${id}" viewBox="0 0 24 24">${ICON_SHAPES[id]}</symbol>`)
      .join("")}</defs>`;
    doc.body.appendChild(sheet);
  }

  /**
   * Pasek czynności jako HTML.
   *
   * @param {object} [options]
   * @param {string[]} [options.skip]  czego w tym oknie nie ma
   */
  function actionBar({ skip = [] } = {}) {
    const buttons = ACTIONS.filter((act) => !skip.includes(act.id))
      .map((act) => {
        const menu = act.menu
          ? `<div class="note-acts__menu" data-acts-menu="${act.id}" hidden>${SHARE.map((item) =>
              item.sep
                ? '<div class="note-acts__sep"></div>'
                : `<button type="button" data-share="${item.id}">${item.label}</button>`,
            ).join("")}</div>`
          : "";
        /* Napisy zostają po polsku i tłumaczy je przebieg po drzewie
           (patrz translateTree w js/i18n.js) — tak samo jak resztę
           szablonów. `data-label-*` zostaje ŹRÓDŁEM, po polsku: to z niego
           paintActions bierze napis i sam go tłumaczy przy przełączaniu
           stanu, więc przetłumaczony w szablonie nie znalazłby się
           w słowniku za drugim razem. */
        return `<div class="note-acts__slot">
            <button type="button" class="note-act${act.danger ? " note-act--danger" : ""}"
                    data-act="${act.id}" data-label-off="${act.label}"
                    ${act.on ? `data-label-on="${act.on}"` : ""}
                    aria-pressed="false" title="${act.label}">
              <svg><use href="#${act.icon}" /></svg><span>${act.label}</span>
            </button>${menu}
          </div>`;
      })
      .join("");
    return `<div class="note-acts">${buttons}</div>`;
  }

  /** Stan przycisków: co jest włączone i jak się w tej chwili nazywa. */
  function paintActions(root, note) {
    for (const act of ACTIONS) {
      const button = root?.querySelector?.(`[data-act="${act.id}"]`);
      if (!button) continue;
      const on = act.state ? !!note?.[act.state] : false;
      button.setAttribute("aria-pressed", String(on));
      const source = on ? button.dataset.labelOn : button.dataset.labelOff;
      if (!source) continue;
      const label = t(source);
      button.title = label;
      const text = button.querySelector("span");
      if (text) text.textContent = label;
    }
  }

  /**
   * Czynność wykonana. Jedno miejsce dla obu okien — bo „Usuń" ma wszędzie
   * znaczyć to samo.
   *
   * @returns {Promise<boolean>} czy notatka przestała istnieć
   */
  async function runAction(what, note, { api, say = () => {}, after = () => {} } = {}) {
    if (!note) return false;

    if (what === "pin") {
      note.pinned = !note.pinned;
      await api.notes.update(note.id, { pinned: note.pinned });
      say(note.pinned ? t("Przypięta") : t("Odpięta"));
      after();
      return false;
    }

    if (what === "desktop") {
      note.widget = !note.widget;
      await api.notes.update(note.id, { widget: note.widget });
      say(note.widget ? t("Notatka jest na wierzchu") : t("Notatka zeszła z wierzchu"));
      after();
      return false;
    }

    if (what === "sift") {
      say(t("Przesiewam notatkę…"));
      Object.assign(note, await api.notes.sift(note.id));
      after();
      return false;
    }

    if (what === "delete") {
      await api.notes.remove(note.id);
      return true;
    }

    return false;
  }

  /**
   * Wysyłka notatki tam, gdzie wskazano w menu „Udostępnij".
   *
   * Meldunek idzie DWA RAZY tam, gdzie czynność trwa: „Wysyłam…" zaraz po
   * naciśnięciu i „Wysłane" po fakcie. Notatki Apple i Notion to cudze
   * serwery i cudze aplikacje — potrafią myśleć kilka sekund, a przycisk,
   * który przez ten czas milczy, wygląda na niedziałający.
   */
  async function runShare(where, note, { api, say = () => {} } = {}) {
    if (!note) return;

    if (where === "apple") {
      say(t("Wysyłam do Notatek Apple…"));
      await api.notes.toAppleNotes(note.id);
      return say(t("Wysłane do Notatek Apple"));
    }
    if (where === "notion") {
      say(t("Wysyłam do Notion…"));
      const result = await api.notes.toNotion(note.id);
      return say(result?.updated ? t("Zaktualizowane w Notion") : t("Wysłane do Notion"));
    }
    if (where === "text") {
      await api.system.copy(note.text ?? "");
      return say(t("Tekst skopiowany"));
    }
    if (where === "md") {
      await api.system.copy(await api.notes.markdown(note.id));
      return say(t("Markdown skopiowany"));
    }
    if (where === "pdf") {
      const result = await api.notes.pdf(note.id);
      if (!result?.canceled) say(t("Zapisane jako PDF"));
      return;
    }
    if (where === "file") {
      const result = await api.notes.export(note.id);
      if (!result?.canceled) say(t("Zapisane do pliku"));
    }
  }

  /* ══ ZNAKI SPECJALNE ═══════════════════════════════════════════
     Znaki, których nie ma na klawiaturze, a których notatka potrzebuje
     naprawdę: myślnik w zdaniu, polski cudzysłów, strzałka w liście
     ustaleń, stopień przy temperaturze, „×" w wymiarach.

     Nie ma tu emoji i to jest decyzja. Emoji wstawia systemowy panel
     (⌃⌘spacja) i robi to lepiej — ma wyszukiwarkę i historię. Tutaj stoją
     znaki, których tamten panel nie pokazuje albo pokazuje na trzeciej
     stronie, bo nie są obrazkami: są interpunkcją. */
  const SPECIALS = [
    ["Interpunkcja", ["—", "–", "…", "„", "”", "«", "»", "’", "‚", "•", "·", "§", "¶"]],
    ["Strzałki", ["→", "←", "↑", "↓", "↔", "⇒", "⇐", "⇔", "↳", "⤵", "▸", "▾"]],
    ["Liczby i miary", ["×", "÷", "±", "≈", "≠", "≤", "≥", "½", "¼", "¾", "°", "′", "″", "‰", "∞"]],
    ["Waluty", ["zł", "€", "$", "£", "¥", "₿"]],
    ["Znaki", ["✓", "✗", "★", "☆", "☐", "☑", "⚠", "©", "®", "™", "№", "†"]],
    ["Greka", ["α", "β", "γ", "δ", "λ", "μ", "π", "σ", "Δ", "Ω", "∑", "√"]],
  ];

  /** Menu znaków specjalnych jako HTML — wkłada je do siebie pasek narzędzi. */
  function specialsMenu() {
    return SPECIALS.map(
      ([group, chars]) =>
        /* Nazwa grupy jest napisem interfejsu i tłumaczy się jak każdy inny.
           Same znaki — nie: „×" i „Ω" nie mają wersji angielskiej, a przebieg
           tłumaczący mógłby trafić na taki, który przypadkiem jest kluczem
           w słowniku. Stąd `skip` na samym rzędzie znaków. */
        `<div class="chars__group"><b>${group}</b><div class="chars__row" data-i18n="skip">${chars
          .map(
            (ch) =>
              `<button type="button" data-char="${escape(ch)}" title="${escape(ch)}">${escape(ch)}</button>`,
          )
          .join("")}</div></div>`,
    ).join("");
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
    isMeeting,
    collapsedGroups,
    saveCollapsedGroups,
    matches,
    highlight,
    NOTE_COLORS,
    colorOf,
    renameInPlace,
    ensureIcons,
    actionBar,
    paintActions,
    runAction,
    runShare,
    specialsMenu,
    ACTIONS,
    SHARE,
    SPECIALS,
  };
})();
