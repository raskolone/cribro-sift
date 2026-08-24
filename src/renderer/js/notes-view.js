"use strict";

/**
 * Zakładka Notatki w oknie głównym.
 *
 * Notatnik był osobnym oknem i tylko osobnym oknem: pozycja na pasku
 * bocznym otwierała okno obok, zamiast zmienić widok tak, jak robią to
 * wszystkie pozostałe pozycje. To była jedyna pozycja, która zachowywała
 * się inaczej niż reszta, więc zachowuje się teraz tak samo.
 *
 * Schemat widoku jest stały i celowo płaski — jedno spojrzenie ma wystarczyć:
 *
 *      ┌── lista ────────────┬── notatka ───────────────────────┐
 *      │ szukaj  ·  + Nowa   │ pasek narzędzi                   │
 *      │ ─────────────────── │ ──────────────────────────────── │
 *      │ tytuł               │                                  │
 *      │ dwie linijki treści │   tekst notatki (edytor)         │
 *      │ kiedy · ile słów    │                                  │
 *      │ …                   │ ──────────────────────────────── │
 *      │                     │ stan zapisu · słowa · podpowiedź │
 *      └─────────────────────┴──────────────────────────────────┘
 *
 * Podwójne kliknięcie w notatkę na liście odrywa ją do własnego okienka —
 * notatka ze spotkania ma prawo stać obok rozmowy. Podwójne kliknięcie
 * w sam tytuł zmienia tytuł, czyli pierwszą linię notatki: tam, gdzie
 * tytuł naprawdę mieszka, i tam, gdzie zmiana ma być widoczna też w tekście.
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
    groupNotes,
    collapsedGroups,
    saveCollapsedGroups,
    matches,
    highlight,
    escape,
    folderOf,
    tagsOf,
    tagKey,
    cleanTag,
    foldersOf,
    renameInPlace,
  } = window.NotesCore;

  const GROUPS_KEY = "cribro:notes-groups";

  const state = {
    notes: [],
    selected: null,
    query: "",
    loaded: false,
    hint: "",
    // Zwinięcie listy to preferencja widoku — zostaje między uruchomieniami,
    // ale nie ma po co jeździć z nią przez most do procesu głównego.
    listOpen: localStorage.getItem("cribro:notes-list") !== "0",
    // Zwinięte przegródki listy — po kluczach, patrz collapsedGroups.
    collapsed: collapsedGroups(GROUPS_KEY),
    /* Wybrana szuflada albo null („wszystkie"). Preferencja widoku, jak
       zwinięcie listy: zostaje między uruchomieniami, ale nie ma po co
       jeździć przez most do procesu głównego. */
    folder: localStorage.getItem("cribro:notes-folder") || null,
    // Kafel, którego tytuł jest właśnie przepisywany. Dopóki tu coś stoi,
    // lista nie przebudowuje się pod palcami piszącego.
    renaming: null,
  };

  let root = null;
  let editor = null;
  let saveTimer = null;
  let spellcheckOn = true;

  /* Atrybut przy samym polu, nie przełącznik na dokumencie: pole ma
     spellcheck="true" wpisane w szkielecie, więc dziedziczenie po
     dokumencie i tak by go nie ruszyło. */
  function applySpellcheck() {
    const field = root?.querySelector("#noteText");
    if (field) field.spellcheck = spellcheckOn;
  }

  const $ = (selector) => root.querySelector(selector);

  /* ── Szkielet ──────────────────────────────────────────────────
     Powstaje raz. Kolejne renderowania podmieniają listę i pasek, ale
     nigdy samego edytora — inaczej pisanie gubiłoby kursor. */

  const SKELETON = `
    <div class="notes" data-list="open">
      <aside class="notes__list">
        <div class="notes__head">
          <div>
            <div class="label">Notatki</div>
            <div class="notes__count" id="noteCount">—</div>
          </div>
          <button class="btn btn--sm" data-note-act="new">Nowa</button>
        </div>
        <div class="search search--notes">
          <svg><use href="#i-search" /></svg>
          <input type="text" id="noteSearch" placeholder="Szukaj w notatkach…" />
        </div>
        <!-- Szuflady. Pas, nie drzewo: szuflad jest kilka, a nie kilkaset,
             i wybiera się jedną — drzewo dokładałoby poziom, po którym
             nie ma czego rozwijać. -->
        <div class="notes__folders" id="noteFolders"></div>
        <div class="notes__items" id="noteItems"></div>
      </aside>

      <!-- Uchwyt na krawędzi listy — ten sam gest co przy pasie bocznym.
           Przycisk w pasku narzędzi notatki zostaje, ale to nie tam się go
           szuka: listę zwija się tam, gdzie lista się kończy. -->
      <button class="notes__edge" data-note-act="toggle-list" title="Zwiń listę notatek"
              aria-label="Zwiń listę notatek">
        <svg><use href="#i-chevron" /></svg>
      </button>

      <section class="notes__editor">
        <header class="notes__bar">
          <button class="icon-btn notes__handle" data-note-act="toggle-list" title="Zwiń listę notatek">
            <svg><use href="#i-chevron" /></svg>
          </button>
          <button class="btn btn--sm btn--note" data-note-act="dictate" id="noteDictate">
            <svg><use href="#i-mic" /></svg> <span>Dyktuj</span>
          </button>
          <span class="notes__sep"></span>
          <button class="icon-btn" data-format="bold" title="Pogrubienie (⌘B)"><svg><use href="#i-bold" /></svg></button>
          <button class="icon-btn" data-format="italic" title="Kursywa (⌘I)"><svg><use href="#i-italic" /></svg></button>
          <div class="notes__menu-wrap">
            <button class="icon-btn" data-note-act="block-menu" title="Nagłówki i bloki">
              <svg><use href="#i-heading" /></svg>
            </button>
            <div class="notes__menu" id="noteBlockMenu" hidden>
              <button data-format="h1"><span>Nagłówek 1</span><kbd>⌘⇧1</kbd></button>
              <button data-format="h2"><span>Nagłówek 2</span><kbd>⌘⇧2</kbd></button>
              <button data-format="h3"><span>Nagłówek 3</span><kbd>⌘⇧3</kbd></button>
              <div class="notes__menu-sep"></div>
              <button data-format="toggle"><span>Nagłówek składany</span><kbd>⌘⇧E</kbd></button>
              <button data-format="divider"><span>Linia rozdzielająca</span><kbd>⌘⇧-</kbd></button>
            </div>
          </div>
          <button class="icon-btn" data-format="bullet" title="Lista (⌘⇧8)"><svg><use href="#i-list" /></svg></button>
          <button class="icon-btn" data-format="todo" title="Lista zadań (⌘⇧9)"><svg><use href="#i-todo" /></svg></button>
          <button class="icon-btn" data-format="quote" title="Cytat (⌘⇧')"><svg><use href="#i-quote" /></svg></button>
          <div class="notes__menu-wrap">
            <button class="icon-btn" data-note-act="align-menu" title="Wyrównanie tekstu">
              <svg><use href="#i-align" /></svg>
            </button>
            <div class="notes__menu" id="noteAlignMenu" hidden>
              <button data-align="left"><span>Do lewej</span></button>
              <button data-align="center"><span>Wyśrodkowany</span></button>
              <button data-align="right"><span>Do prawej</span></button>
              <button data-align="justify"><span>Wyjustowany</span><kbd>⌘⇧J</kbd></button>
            </div>
          </div>
          <span class="notes__sep"></span>
          <button class="icon-btn" data-note-act="stamp" title="Wstaw godzinę (⌘T)"><svg><use href="#i-clock" /></svg></button>
          <button class="icon-btn" data-note-act="sift" title="Przesiej całą notatkę"><svg><use href="#i-sieve" /></svg></button>
          <span class="notes__spacer"></span>
          <button class="icon-btn" data-note-act="detach" title="Otwórz w osobnym okienku"><svg><use href="#i-window" /></svg></button>
          <button class="icon-btn" data-note-act="widget" id="noteWidget" title="Widoczna w widgecie"><svg><use href="#i-sticky" /></svg></button>
          <button class="icon-btn" data-note-act="pin" id="notePin" title="Przypnij"><svg><use href="#i-pin" /></svg></button>
          <div class="notes__menu-wrap">
            <button class="icon-btn" data-note-act="share-menu" title="Udostępnij"><svg><use href="#i-share" /></svg></button>
            <div class="notes__menu" id="noteShareMenu" hidden>
              <button data-share="apple">Wyślij do Notatek Apple</button>
              <button data-share="notion">Wyślij do Notion</button>
              <div class="notes__menu-sep"></div>
              <button data-share="text">Kopiuj tekst</button>
              <button data-share="md">Kopiuj jako Markdown</button>
              <div class="notes__menu-sep"></div>
              <button data-share="pdf">Zapisz jako PDF…</button>
              <button data-share="file">Zapisz jako plik .md…</button>
            </div>
          </div>
          <button class="icon-btn icon-btn--danger" data-note-act="delete" title="Usuń notatkę"><svg><use href="#i-trash" /></svg></button>
        </header>

        <!-- Szuflada i etykiety. Pod paskiem narzędzi, nad tekstem: to jest
             metryczka notatki, a nie czynność do zrobienia — stąd osobny
             pas, a nie kolejne przyciski w i tak pełnym pasku. -->
        <div class="notes__meta" id="noteMeta"></div>

        <div
          id="noteText"
          class="prose"
          spellcheck="true"
          data-i18n="skip"
          data-empty="true"
          data-placeholder="Pisz albo naciśnij &#8222;Dyktuj&#8221; i mów.&#10;Notatka zapisuje się sama."
        ></div>

        <footer class="notes__foot">
          <span id="noteStatus">Zapisane</span>
          <span class="dot">·</span>
          <span id="noteWords">0 słów</span>
          <span class="notes__spacer"></span>
          <span class="notes__hint" id="noteHint"></span>
        </footer>
      </section>
    </div>`;

  const EMPTY = `
    <div class="notes notes--empty">
      <div class="empty">
        <h3>Notatnik jest pusty</h3>
        <p>Notatka ze spotkania zaczyna się od jednego zdania. Reszta dopisze się sama — także głosem.</p>
        <button class="btn btn--primary" data-note-act="new">Nowa notatka</button>
      </div>
    </div>`;

  /* ── Rysowanie ── */

  const current = () => state.notes.find((note) => note.id === state.selected) ?? null;

  function renderCards() {
    // Przepisywany tytuł jest w tej chwili jedynym miejscem, gdzie stoi
    // kursor — przebudowa listy zabrałaby go w połowie słowa.
    if (state.renaming) return;

    const query = state.query.trim();
    /* Szuflada zawęża, fraza szuka w tym, co zostało. Odwrotnie („szukaj
       wszędzie, mimo wybranej szuflady") znaczyłoby, że wybór szuflady
       przestaje cokolwiek znaczyć w chwili, w której zaczyna się pisać. */
    const inFolder = (note) => !state.folder || folderOf(note) === state.folder;
    const visible = state.notes.filter((note) => inFolder(note) && matches(note, query));
    const { groups, divided } = groupNotes(visible);

    renderFolders();

    $("#noteCount").textContent = query
      ? t("{n} z {all}", { n: visible.length, all: state.notes.length })
      : state.notes.length === 1
        ? t("1 notatka")
        : t("{n} notatki", { n: state.notes.length });

    // Numer kafla biegnie przez całą listę, nie przez grupę: rozkładanie
    // ma iść z góry na dół jednym ruchem, a nie zaczynać się dwa razy.
    let index = 0;
    const card = (note) => {
      const preview = previewOf(note);
      return `
        <div class="note-card" role="button" tabindex="0" data-id="${note.id}" style="--i: ${index++}"
             aria-selected="${note.id === state.selected}"
             title="Podwójne kliknięcie otwiera notatkę w osobnym okienku">
          <div class="note-card__title" data-i18n="skip" title="Podwójne kliknięcie zmienia tytuł">${highlight(titleOf(note), query)}</div>
          ${preview ? `<div class="note-card__preview" data-i18n="skip">${highlight(preview, query)}</div>` : ""}
          ${tagRow(note)}
          <div class="note-card__meta">
            <span>${escape(when(note.updatedAt))}</span>
            <span class="dot">·</span>
            <span>${t("{n} sł.", { n: countWords(note.text) })}</span>
          </div>
          <button class="note-card__pin" data-note-pin="${note.id}" aria-pressed="${!!note.pinned}"
                  title="${note.pinned ? "Odepnij" : "Przypnij"}">
            <svg><use href="#i-pin" /></svg>
          </button>
        </div>`;
    };

    /* Zwinięta przegródka chowa kafle, ale nie przy szukaniu: fraza ma
       pokazać wszystko, co pasuje, a nie milczeć dlatego, że trafienie
       leży w przegródce zamkniętej tydzień temu. */
    const head = (group) => {
      const open = !!query || !state.collapsed.has(group.key);
      return `
        <button class="notes__group" data-note-act="toggle-group" data-group="${group.key}"
                aria-expanded="${open}" title="${open ? "Zwiń przegródkę" : "Rozwiń przegródkę"}">
          <svg class="notes__caret"><use href="#i-chevron" /></svg>
          <span>${group.label}</span><i></i><b data-i18n="skip">${group.items.length}</b>
        </button>`;
    };

    $("#noteItems").innerHTML = visible.length
      ? groups
          .map((group) => {
            if (!divided) return group.items.map(card).join("");
            const open = !!query || !state.collapsed.has(group.key);
            return head(group) + (open ? group.items.map(card).join("") : "");
          })
          .join("")
      : `<p class="notes__nothing">Nic nie pasuje.</p>`;
  }

  /* Etykiety na kaflu. Kliknięcie w etykietę wpisuje ją w wyszukiwarkę —
     bo to jest to, po co się na nią patrzy: „pokaż mi resztę tych". */
  function tagRow(note) {
    const tags = tagsOf(note);
    if (!tags.length) return "";
    return `<div class="note-card__tags">${tags
      .map(
        (tag) =>
          `<button class="tag tag--sm" data-note-act="filter-tag" data-tag="${escape(tag)}"
                   title="Pokaż notatki z tą etykietą" data-i18n="skip">#${escape(tag)}</button>`,
      )
      .join("")}</div>`;
  }

  /**
   * Pas szuflad nad listą. „Wszystkie" zawsze pierwsze — bez niego nie
   * byłoby drogi powrotnej z wybranej szuflady, a wybór jednej z nich
   * to najczęstsza rzecz, którą się potem cofa.
   */
  function renderFolders() {
    const rail = root.querySelector("#noteFolders");
    if (!rail) return;

    const folders = foldersOf(state.notes);
    // Pas bez szuflad byłby pustą listwą nad listą. Póki nikt nie założył
    // ani jednej, nie ma czego pokazywać — zakłada się je przy notatce.
    rail.hidden = !folders.length;
    if (!folders.length) return;

    const chip = (key, label, count) => `
      <button class="folder-chip" data-note-act="pick-folder" data-folder="${escape(key ?? "")}"
              aria-pressed="${state.folder === key}">
        <span data-i18n="skip">${escape(label)}</span><b data-i18n="skip">${count}</b>
      </button>`;

    rail.innerHTML =
      chip(null, t("Wszystkie"), state.notes.length) +
      folders
        .map((name) =>
          chip(name, name, state.notes.filter((note) => folderOf(note) === name).length),
        )
        .join("");
  }

  /**
   * Metryczka otwartej notatki: w której szufladzie leży i czego dotyczy.
   *
   * Szuflada jest przyciskiem otwierającym listę istniejących (plus
   * „Nowa szuflada…"), etykiety są kaflami z krzyżykiem, a na końcu stoi
   * pole do dopisania kolejnej. Wpisanie działa jak w każdym polu etykiet:
   * Enter albo przecinek kończy jedną, Escape odpuszcza.
   */
  function renderMeta() {
    const box = root.querySelector("#noteMeta");
    const note = current();
    if (!box || !note) return;

    const folder = folderOf(note);
    const folders = foldersOf(state.notes).filter((name) => name !== folder);

    box.innerHTML = `
      <div class="notes__menu-wrap">
        <button class="folder-btn" data-note-act="folder-menu"
                aria-pressed="${!!folder}" title="Szuflada notatki">
          <svg><use href="#i-folder" /></svg>
          <span data-i18n="${folder ? "skip" : ""}">${folder ? escape(folder) : t("Bez szuflady")}</span>
        </button>
        <div class="notes__menu" id="noteFolderMenu" hidden>
          ${folders
            .map(
              (name) =>
                `<button data-set-folder="${escape(name)}" data-i18n="skip">${escape(name)}</button>`,
            )
            .join("")}
          ${folders.length ? '<div class="notes__menu-sep"></div>' : ""}
          <button data-set-folder="">Bez szuflady</button>
          <button data-note-act="new-folder">Nowa szuflada…</button>
        </div>
      </div>
      <div class="notes__tags">
        ${tagsOf(note)
          .map(
            (tag) => `
              <span class="tag" data-i18n="skip">#${escape(tag)}
                <button data-note-act="drop-tag" data-tag="${escape(tag)}"
                        title="Zdejmij etykietę" aria-label="Zdejmij etykietę">×</button>
              </span>`,
          )
          .join("")}
        <input class="tag-input" id="noteTagInput" type="text" placeholder="+ etykieta"
               spellcheck="false" maxlength="32" />
      </div>`;
  }

  /**
   * Etykieta dopisana albo zdjęta. Porównujemy formy złożone (tagKey),
   * a zapisujemy tę, którą ktoś wpisał — „Pilne" i „pilne" to dla człowieka
   * jedna etykieta i nie ma powodu, żeby leżały obok siebie dwie.
   */
  async function setTags(note, tags) {
    note.tags = tags;
    await api.notes.update(note.id, { tags });
    renderMeta();
    renderCards();
    translateTree(root);
  }

  async function addTag(raw) {
    const note = current();
    const tag = cleanTag(raw);
    if (!note || !tag) return;
    const have = tagsOf(note);
    if (have.some((item) => tagKey(item) === tagKey(tag))) return;
    await setTags(note, [...have, tag]);
  }

  async function dropTag(raw) {
    const note = current();
    if (!note) return;
    await setTags(
      note,
      tagsOf(note).filter((item) => tagKey(item) !== tagKey(raw)),
    );
  }

  async function setFolder(note, name) {
    const folder = String(name ?? "").trim() || null;
    note.folder = folder;
    await api.notes.update(note.id, { folder });
    // Szuflada, do której notatka właśnie weszła, ma się na pasie pokazać
    // od razu — także wtedy, gdy powstała przed chwilą i nie było jej tam.
    renderMeta();
    renderCards();
    translateTree(root);
  }

  /* Nazwa nowej szuflady wpisywana wprost w przycisk, w którym potem stoi.
     Ten sam gest, co przepisywanie tytułu na kaflu — i ta sama funkcja,
     żeby Enter, Escape i klik obok znaczyły wszędzie to samo. */
  function startFolderName(element, note) {
    renameInPlace(element, {
      text: "",
      onCommit: (name) => setFolder(note, name),
      onEnd: () => renderMeta(),
    });
  }

  /** Wyrównanie tekstu — cecha całej notatki, patrz [data-align] w prose.css. */
  async function setAlign(note, align) {
    note.align = align;
    root.querySelector("#noteText")?.setAttribute("data-align", align);
    await api.notes.update(note.id, { align });
  }

  /** Przypięcie z listy i z paska narzędzi to jedno i to samo. */
  /* Notatka „na wierzchu" — widoczna w pływającym widgecie. Flaga zostaje
     na tym komputerze i nie jedzie do chmury: „mam to teraz przed oczami"
     opisuje biurko, przy którym się siedzi, a nie treść notatki. */
  async function toggleWidget(note) {
    if (!note) return;
    note.widget = !note.widget;
    await api.notes.update(note.id, { widget: note.widget });
    if (note.id === state.selected) {
      root.querySelector("#noteWidget")?.setAttribute("aria-pressed", String(!!note.widget));
    }
    flash(note.widget ? t("Notatka jest na wierzchu") : t("Notatka zeszła z wierzchu"));
  }

  async function togglePin(id) {
    const note = state.notes.find((item) => item.id === id);
    if (!note) return;

    note.pinned = !note.pinned;
    await api.notes.update(note.id, { pinned: note.pinned });
    // Sam pasek narzędzi, nie całe renderNote: przełożenie pinezki nie ma
    // prawa przestawić kursora w tekście, który się właśnie pisze.
    if (note.id === state.selected) {
      root.querySelector("#notePin")?.setAttribute("aria-pressed", String(!!note.pinned));
    }
    renderCards();
    translateTree(root);
  }

  /**
   * Przepisanie tytułu na kaflu. Tytuł nie jest osobnym polem — jest
   * pierwszą linią notatki — więc jego zmiana wchodzi prosto w tekst
   * i widać ją także w edytorze obok.
   */
  function startRename(element) {
    const note = state.notes.find(
      (item) => item.id === element.closest(".note-card")?.dataset.id,
    );
    if (!note || state.renaming) return;

    state.renaming = note.id;
    const before = rawTitle(note);
    element.textContent = before;
    element.contentEditable = "plaintext-only";
    element.spellcheck = false;
    element.classList.add("is-editing");
    element.focus();
    document.getSelection()?.selectAllChildren(element);

    const stop = async (commit) => {
      if (state.renaming !== note.id) return;
      state.renaming = null;
      element.contentEditable = "false";
      element.classList.remove("is-editing");

      const after = element.textContent.trim();
      if (commit && after && after !== before) {
        note.text = retitle(note.text, after);
        note.updatedAt = new Date().toISOString();
        await api.notes.update(note.id, { text: note.text });
        if (note.id === state.selected) editor?.setMarkdown(note.text);
      }
      renderCards();
      translateTree(root);
    };

    const finish = (commit) => stop(commit).catch((error) => flash(String(error.message || error)));

    element.addEventListener("keydown", (event) => {
      // Enter kończy, Escape cofa. Notatka jest wielolinijkowa, tytuł nie.
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    element.addEventListener("blur", () => finish(true));
  }

  function renderNote() {
    const note = current();
    // Przy pustym notatniku nie ma paska ani edytora — nie ma czego odświeżać.
    if (!note || !root.querySelector("#noteText")) return;

    editor.setMarkdown(note.text);
    $("#noteText").setAttribute("data-align", note.align ?? "left");
    renderMeta();
    $("#notePin").setAttribute("aria-pressed", String(!!note.pinned));
    $("#noteWidget").setAttribute("aria-pressed", String(!!note.widget));
    $("#noteWords").textContent = t("{n} słów", { n: countWords(note.text) });
    $("#noteHint").innerHTML = state.hint
      ? escape(state.hint)
      : note.previousText
        ? '<span class="notes__undo" data-note-act="undo-sift">Przesiane — cofnij</span>'
        : "";
    refreshFormatState();
  }

  /* Wybór notatki podmienia zaznaczenie w miejscu, bez przebudowy listy:
     gdyby kafle powstawały od nowa, drugie kliknięcie trafiałoby w świeży
     element i przeglądarka nie miałaby na czym wywołać podwójnego kliknięcia. */
  function selectCard(id) {
    state.selected = id;
    for (const card of root.querySelectorAll(".note-card")) {
      card.setAttribute("aria-selected", String(card.dataset.id === id));
    }
    renderNote();
  }


  /* ── Cisza w tle na czas składania listy ───────────────────────
     Panel składa się w trzech wymiarach, kafle wychodzą po kolei, a pod
     tym wszystkim leży animowane tło pod szkłem — i to ono przelicza
     rozmycie przy każdej swojej klatce (patrz js/constellation.js).
     Trzy kosztowne rzeczy w jednej klatce widać jako szarpnięcie, więc
     na te niecałą sekundę tło staje. Nikt na nie wtedy nie patrzy. */
  const FOLD_MS = 420 + 12 * 26 + 80;
  let quiet = false;
  let quietTimer = null;

  function quietBackground(ms = FOLD_MS) {
    if (!quiet) {
      quiet = true;
      window.CribroConstellation?.pause();
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quiet = false;
      window.CribroConstellation?.resume();
    }, ms);
  }

  /** Lista rozłożona czy złożona — i co mówi o tym uchwyt. */
  function applyListState() {
    const panel = root.querySelector(".notes");
    if (!panel) return;
    if (panel.dataset.list !== (state.listOpen ? "open" : "closed")) quietBackground();
    panel.dataset.list = state.listOpen ? "open" : "closed";
    const label = state.listOpen ? t("Zwiń listę notatek") : t("Rozwiń listę notatek");
    for (const handle of root.querySelectorAll(".notes__handle, .notes__edge")) {
      handle.title = label;
      handle.setAttribute("aria-label", label);
      handle.setAttribute("aria-expanded", String(state.listOpen));
    }
    localStorage.setItem("cribro:notes-list", state.listOpen ? "1" : "0");
  }

  function refreshFormatState() {
    const active = editor.activeFormats();
    for (const button of root.querySelectorAll("[data-format]")) {
      button.setAttribute("aria-pressed", String(!!active[button.dataset.format]));
    }
    // Wyrównanie nie zależy od kursora — jest cechą notatki, więc bierze
    // się z niej, a nie z zaznaczenia.
    const align = current()?.align ?? "left";
    for (const button of root.querySelectorAll("[data-align]")) {
      button.setAttribute("aria-pressed", String(button.dataset.align === align));
    }
  }

  function render() {
    if (!state.notes.length) {
      // Pusty notatnik nie potrzebuje ani listy, ani paska narzędzi.
      if (!root.querySelector(".notes--empty")) root.innerHTML = EMPTY;
      translateTree(root);
      return;
    }
    if (!root.querySelector(".notes__editor")) build();

    applyListState();
    renderCards();
    renderNote();
    translateTree(root);
  }

  /* ── Zapis ── */

  function scheduleSave() {
    const note = current();
    if (!note) return;

    note.text = editor.getMarkdown();
    note.updatedAt = new Date().toISOString();
    $("#noteStatus").textContent = t("Zapisuję…");
    $("#noteStatus").dataset.state = "saving";
    $("#noteWords").textContent = t("{n} słów", { n: countWords(note.text) });
    refreshFormatState();

    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await api.notes.update(note.id, { text: note.text });
      $("#noteStatus").textContent = t("Zapisane");
      $("#noteStatus").dataset.state = "saved";
      renderCards();
      translateTree(root);
    }, 450);
  }

  async function newNote() {
    const note = await api.notes.create();
    state.notes.unshift(note);
    state.selected = note.id;
    render();
    editor?.focus();
  }

  function flash(message) {
    state.hint = message;
    renderNote();
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => {
      state.hint = "";
      renderNote();
    }, 2600);
  }

  /* ── Szkielet i zdarzenia ── */

  function build() {
    root.innerHTML = SKELETON;
    editor = window.CribroEditor.create($("#noteText"), { onInput: scheduleSave });
    applySpellcheck();
  }

  async function reload(keepSelection = true) {
    state.notes = await api.notes.get();
    const stillThere = state.notes.some((note) => note.id === state.selected);
    if (!keepSelection || !stillThere) {
      state.selected = state.notes.length ? sortNotes(state.notes)[0].id : null;
    }
    state.loaded = true;
  }

  /* Wszystkie menu paska są tym samym rodzajem rzeczy: wychodzą spod
     przycisku i zasłaniają tekst. Otwarte może być jedno. */
  const MENUS = ["#noteShareMenu", "#noteBlockMenu", "#noteAlignMenu", "#noteFolderMenu"];

  function closeMenus(except = null) {
    for (const id of MENUS) {
      if (id === except) continue;
      const menu = root.querySelector(id);
      if (menu) menu.hidden = true;
    }
  }

  function toggleMenu(id) {
    const menu = root.querySelector(id);
    if (!menu) return;
    const open = menu.hidden;
    closeMenus(id);
    menu.hidden = !open;
  }

  async function runShare(what, note) {
    try {
      if (what === "apple") {
        flash(t("Wysyłam do Notatek Apple…"));
        await api.notes.toAppleNotes(note.id);
        flash(t("Wysłane do Notatek Apple"));
      } else if (what === "text") {
        await api.system.copy(note.text);
        flash(t("Tekst skopiowany"));
      } else if (what === "md") {
        await api.system.copy(await api.notes.markdown(note.id));
        flash(t("Markdown skopiowany"));
      } else if (what === "file") {
        const result = await api.notes.export(note.id);
        if (!result.canceled) flash(t("Zapisane do pliku"));
      } else if (what === "pdf") {
        const result = await api.notes.pdf(note.id);
        if (!result.canceled) flash(t("Zapisane jako PDF"));
      } else if (what === "notion") {
        flash(t("Wysyłam do Notion…"));
        const result = await api.notes.toNotion(note.id);
        flash(result.updated ? t("Zaktualizowane w Notion") : t("Wysłane do Notion"));
      }
    } catch (error) {
      flash(String(error.message || error));
    }
  }

  async function onClick(event) {
    // Pinezka na kaflu jest przed kaflem: przypięcie nie ma przy okazji
    // przerzucać edytora na inną notatkę.
    const pin = event.target.closest("[data-note-pin]");
    if (pin) return togglePin(pin.dataset.notePin);

    // Etykieta na kaflu też jest przed kaflem, i z tego samego powodu:
    // kliknięcie w nią znaczy „pokaż resztę takich", a nie „otwórz tę".
    const tagged = event.target.closest('[data-note-act="filter-tag"]');
    if (tagged) {
      const tag = tagged.dataset.tag;
      const field = root.querySelector("#noteSearch");
      state.query = `#${tag}`;
      if (field) field.value = state.query;
      renderCards();
      translateTree(root);
      return;
    }

    // W trakcie przepisywania tytułu kliknięcie w niego stawia kursor
    // i nic poza tym — inaczej zabrałoby sobie samo zaznaczenie.
    if (state.renaming && event.target.closest(".note-card__title")) return;

    const card = event.target.closest(".note-card");
    if (card) {
      selectCard(card.dataset.id);
      editor?.focus();
      return;
    }

    const format = event.target.closest("[data-format]");
    if (format) {
      closeMenus();
      editor.format(format.dataset.format);
      refreshFormatState();
      return;
    }

    const align = event.target.closest("[data-align]");
    if (align) {
      closeMenus();
      const note = current();
      if (note) await setAlign(note, align.dataset.align);
      return;
    }

    const pick = event.target.closest("[data-set-folder]");
    if (pick) {
      closeMenus();
      const note = current();
      if (note) await setFolder(note, pick.dataset.setFolder);
      return;
    }

    const share = event.target.closest("[data-share]");
    if (share) {
      closeMenus();
      const note = current();
      if (note) await runShare(share.dataset.share, note);
      return;
    }

    const action = event.target.closest("[data-note-act]")?.dataset.noteAct;
    if (!action) {
      closeMenus();
      return;
    }

    /* Czynności, które nie potrzebują otwartej notatki — a bywają robione
       wtedy, gdy żadna nie jest wybrana (pusta szuflada, świeże okno). */
    if (action === "pick-folder") {
      const name = event.target.closest("[data-folder]").dataset.folder || null;
      state.folder = state.folder === name ? null : name;
      if (state.folder) localStorage.setItem("cribro:notes-folder", state.folder);
      else localStorage.removeItem("cribro:notes-folder");
      renderCards();
      translateTree(root);
      return;
    }
    if (["share-menu", "block-menu", "align-menu", "folder-menu"].includes(action)) {
      toggleMenu({
        "share-menu": "#noteShareMenu",
        "block-menu": "#noteBlockMenu",
        "align-menu": "#noteAlignMenu",
        "folder-menu": "#noteFolderMenu",
      }[action]);
      return;
    }
    if (action === "toggle-list") {
      state.listOpen = !state.listOpen;
      applyListState();
      return;
    }
    if (action === "toggle-group") {
      const key = event.target.closest("[data-group]").dataset.group;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      saveCollapsedGroups(GROUPS_KEY, state.collapsed);
      renderCards();
      translateTree(root);
      return;
    }
    if (action === "new") {
      // Nowa notatka przy zwiniętej liście: rozkładamy ją, żeby było widać,
      // że coś przybyło — i skąd potem wrócić do poprzedniej.
      if (!state.listOpen) {
        state.listOpen = true;
        applyListState();
      }
      return newNote();
    }

    const note = current();
    if (!note) return;

    switch (action) {
      case "dictate":
        // Tekst ma dopisać się do notatki, a nie wylądować pod kursorem
        // w aplikacji, która akurat była na wierzchu.
        await api.notes.dictate(note.id);
        break;
      case "detach":
        await api.notes.openWindow(note.id);
        break;
      case "stamp":
        editor.insertText(
          `${new Date().toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" })} — `,
        );
        break;
      case "pin":
        await togglePin(note.id);
        break;
      case "widget":
        await toggleWidget(note);
        break;
      case "sift":
        flash(t("Przesiewam notatkę…"));
        try {
          Object.assign(note, await api.notes.sift(note.id));
          state.hint = "";
          render();
        } catch (error) {
          flash(String(error.message || error));
        }
        break;
      case "undo-sift":
        Object.assign(note, await api.notes.undoSift(note.id), { previousText: null });
        render();
        break;
      case "drop-tag":
        await dropTag(event.target.closest("[data-tag]").dataset.tag);
        break;
      case "new-folder": {
        closeMenus();
        /* Nazwa szuflady wpisuje się w to samo pole, w którym potem stoi.
           Osobne okienko z pytaniem byłoby trzecim oknem dla jednego słowa. */
        const field = root.querySelector("#noteMeta .folder-btn span");
        if (field) startFolderName(field, note);
        break;
      }
      case "delete":
        await api.notes.remove(note.id);
        state.notes = state.notes.filter((item) => item.id !== note.id);
        state.selected = state.notes.length ? sortNotes(state.notes)[0].id : null;
        render();
        break;
    }
  }

  /* ── Wejście od okna ── */

  const NotesView = {
    mount(element) {
      root = element;
      root.addEventListener("click", (event) => {
        onClick(event).catch((error) => flash(String(error.message || error)));
      });

      /* Podwójne kliknięcie w tytuł przepisuje tytuł, w resztę kafla —
         odrywa notatkę do własnego okienka. Tytuł jest tym jednym miejscem
         na kaflu, o którym wiadomo, co znaczy jego zmiana. */
      root.addEventListener("dblclick", (event) => {
        const title = event.target.closest(".note-card__title");
        if (title) return startRename(title);
        const card = event.target.closest(".note-card");
        if (card) api.notes.openWindow(card.dataset.id);
      });

      /* Kafel nie jest już przyciskiem — w środku siedzą pinezka i tytuł
         do przepisania, a przycisk w przycisku nie przetrwałby wczytania
         szablonu. Klawiatura dostaje więc to, co przycisk dawał sam. */
      root.addEventListener("keydown", (event) => {
        const card = event.target.closest?.(".note-card");
        if (!card || state.renaming) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectCard(card.dataset.id);
        editor?.focus();
      });

      root.addEventListener("input", (event) => {
        if (event.target.id !== "noteSearch") return;
        state.query = event.target.value;
        renderCards();
        translateTree(root);
      });

      /* Pole etykiety. Enter i przecinek kończą jedną, Backspace w pustym
         polu zdejmuje ostatnią — tak zachowuje się każde pole etykiet
         i nie ma powodu, żeby to jedno zachowywało się inaczej. */
      root.addEventListener("keydown", (event) => {
        if (event.target.id !== "noteTagInput") return;
        const field = event.target;
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          const value = field.value;
          field.value = "";
          void addTag(value).then(() => root.querySelector("#noteTagInput")?.focus());
          return;
        }
        if (event.key === "Backspace" && !field.value) {
          const last = tagsOf(current()).at(-1);
          if (!last) return;
          event.preventDefault();
          void dropTag(last).then(() => root.querySelector("#noteTagInput")?.focus());
          return;
        }
        if (event.key === "Escape") {
          field.value = "";
          field.blur();
        }
      });

      /* Naciśnięcie przycisku paska nie ma zabierać zaznaczenia z tekstu. */
      root.addEventListener("mousedown", (event) => {
        if (event.target.closest("[data-format]")) event.preventDefault();
      });

      document.addEventListener("selectionchange", () => {
        if (editor && document.activeElement === root.querySelector("#noteText")) {
          refreshFormatState();
        }
      });

      /* Przycisk „Dyktuj" jest jednocześnie wskaźnikiem stanu — przy
         dyktowaniu do notatki to jedyne, co widać w tej kolumnie. */
      api.onState(({ state: next }) => {
        const button = root.querySelector("#noteDictate");
        if (!button) return;
        button.dataset.state = next;
        button.querySelector("span").textContent =
          next === "listening" ? t("Słucham…") : next === "sifting" ? t("Przesiewam…") : t("Dyktuj");
      });

      // Dopisanie z dyktowania i zmiany z innych okien tej samej notatki.
      api.notes.onAppended(async ({ id }) => {
        await reload(false);
        if (id) state.selected = id;
        render();
        if (NotesView.isVisible()) {
          editor?.focusEnd();
          flash(t("Dopisane z dyktowania"));
        }
      });

      api.notes.onChanged?.(async () => {
        if (!state.loaded) return;
        await reload();
        render();
      });

      /* Pisownia. Ustawienie trzymamy obok, bo pole edytora powstaje
         dopiero przy pierwszej notatce (patrz build) — a wtedy musi już
         wiedzieć, czy podkreślać. */
      const spell = (settings) => {
        spellcheckOn = settings.spellcheck?.enabled !== false;
        applySpellcheck();
      };
      api.settings.get().then(spell);
      api.settings.onChange?.(spell);
    },

    isVisible: () => !!root && !root.hidden,

    /**
     * Zakładka właśnie się otworzyła. Listę czytamy za każdym razem:
     * notatka mogła powstać w szybkiej notatce albo w Notatniku, kiedy
     * patrzyliśmy gdzie indziej, a odczyt to sięgnięcie po gotową tablicę.
     */
    async show() {
      await reload(state.loaded);
      render();
    },

    /** Nowa notatka z menu aplikacji (⌘N). */
    async createNote() {
      if (!state.loaded) await reload(false);
      if (!root.querySelector(".notes__editor")) build();
      await newNote();
    },

    /** Skróty formatowania z okna — działają tylko przy otwartej zakładce. */
    format(kind) {
      if (!editor || !NotesView.isVisible()) return false;
      // Wyrównanie nie jest blokiem, więc nie idzie do edytora. ⌘⇧J
      // przełącza: drugie naciśnięcie wraca do wyrównania do lewej.
      if (kind === "justify") {
        const note = current();
        if (!note) return false;
        void setAlign(note, note.align === "justify" ? "left" : "justify");
        refreshFormatState();
        return true;
      }
      editor.format(kind);
      refreshFormatState();
      return true;
    },

    /** ⌘⇧L — lista notatek w bok i z powrotem. */
    toggleList() {
      if (!root || !root.querySelector(".notes__editor")) return false;
      state.listOpen = !state.listOpen;
      applyListState();
      return true;
    },

    focusSearch() {
      const input = root?.querySelector("#noteSearch");
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    },
  };

  window.NotesView = NotesView;
})();
