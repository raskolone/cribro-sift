/* Notatnik — szybkie notatki ze spotkania.
   Zasada: nic nie wymaga zapisywania ręcznie i nic nie ginie.
   Piszesz albo mówisz, reszta dzieje się sama.

   To okno ma dwie postacie. Pełna to lista notatek i edytor obok niej.
   Osobna („solo") pokazuje jedną notatkę bez listy — otwiera ją podwójne
   kliknięcie w zakładce Notatki albo w liście tutaj. Notatka ze spotkania
   ma wtedy własne okno, które można postawić obok rozmowy. */

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
  folderColorOf,
  NOTE_COLORS,
  renameInPlace,
  ensureIcons,
  actionBar,
  paintActions,
  runAction,
  fitMenu,
  runShare: shareNote,
  specialsMenu,
} = window.NotesCore;

/* Pasek czynności i znaki specjalne powstają z kodu, nie z szablonu —
   ten sam kod, co w zakładce Notatki i na kartce na pulpicie. */
ensureIcons(document);
document.getElementById("acts").outerHTML = actionBar();
document.getElementById("charsMenu").innerHTML = specialsMenu();

const GROUPS_KEY = "cribro:notepad-groups";

// „?note=<id>" znaczy: jedna notatka, bez listy.
const soloId = new URLSearchParams(location.search).get("note");

const state = {
  notes: [],
  selected: soloId,
  runtime: "idle",
  query: "",
  solo: !!soloId,
  // Zwinięcie listy zostaje między uruchomieniami. To preferencja widoku,
  // nie ustawienie aplikacji — nie ma po co jeździć z nią przez most.
  listOpen: localStorage.getItem("cribro:notepad-list") !== "0",
  // Zwinięte przegródki listy — po kluczach, patrz collapsedGroups.
  collapsed: collapsedGroups(GROUPS_KEY),
  // Notatka, której tytuł jest właśnie przepisywany. Dopóki tu coś stoi,
  // lista nie przebudowuje się pod palcami piszącego.
  renaming: null,
  // Wybrana szuflada albo null („wszystkie") — preferencja tego okna.
  folder: localStorage.getItem("cribro:notepad-folder") || null,
  /* Czy lista pokazuje siatkę szuflad zamiast kafli notatek. Preferencja
     widoku, nie stan trwały — otwiera się pusta przy każdym starcie. */
  foldersOpen: false,
  // Do koloru szuflad — patrz folderColorOf w notes-core.js.
  settings: null,
};

const $ = (selector) => document.querySelector(selector);

if (state.solo) document.body.classList.add("is-solo");

/* Edytor jest zwykłym edytorem tekstu: ⌘B pogrubia słowo, a nie wstawia
   gwiazdki. Na dysk notatka wraca Markdownem — patrz shared/richtext.js. */
const editor = window.CribroEditor.create($("#text"), { onInput: () => scheduleSave() });

/* ── Rysowanie ────────────────────────────────────────────────── */

function renderList() {
  if (state.solo) return;
  // Przepisywany tytuł jest w tej chwili jedynym miejscem, gdzie stoi
  // kursor — przebudowa listy zabrałaby go w połowie słowa.
  if (state.renaming) return;

  renderFolders();

  /* Siatka szuflad zajmuje to samo miejsce co kafle notatek, nie stoi
     obok nich — patrz folderGrid() niżej i ten sam wzorzec w notes-view.js. */
  if (state.foldersOpen) {
    $("#count").textContent = t("{n} szuflad", { n: foldersOf(state.notes).length });
    $("#items").innerHTML = folderGrid();
    return;
  }

  const query = state.query.trim();
  // `state.folder === null` znaczy „nic nie wybrano" (wszystkie notatki).
  // `""` jest realnym wyborem — „Bez szuflady" — stąd ścisłe porównanie,
  // a nie sama prawdziwość (patrz komentarz w onClick niżej).
  const inFolder = (note) => state.folder === null || folderOf(note) === (state.folder || null);
  const matching = state.notes.filter((note) => inFolder(note) && matches(note, query));
  const { groups, divided } = groupNotes(matching);

  $("#count").textContent = query
    ? t("{n} z {all}", { n: matching.length, all: state.notes.length })
    : state.notes.length === 0
      ? t("brak notatek")
      : state.notes.length === 1
        ? t("1 notatka")
        : t("{n} notatki", { n: state.notes.length });

  const card = (note) => `
      <div class="note" role="button" tabindex="0" data-id="${note.id}"
           aria-selected="${note.id === state.selected}"
           title="Podwójne kliknięcie otwiera notatkę w osobnym okienku">
        <div class="note__title" data-i18n="skip" title="Podwójne kliknięcie zmienia tytuł">${highlight(titleOf(note), query)}</div>
        ${tagRow(note)}
        <div class="note__when">
          <span>${escape(when(note.updatedAt))}</span>
          <span>·</span>
          <span>${t("{n} sł.", { n: countWords(note.text) })}</span>
        </div>
        <button class="note__pin" data-note-pin="${note.id}" aria-pressed="${!!note.pinned}"
                title="${note.pinned ? "Odepnij" : "Przypnij"}">
          <svg><use href="#i-pin" /></svg>
        </button>
      </div>`;

  /* Przypięte, spotkania, szybkie i reszta mają własne przegródki — patrz
     groupNotes w notes-core.js. Zwinięta przegródka chowa kafle, ale nie przy
     szukaniu: fraza ma pokazać wszystko, co pasuje. */
  const head = (group) => {
    const open = !!query || !state.collapsed.has(group.key);
    return `
      <button class="list__group" data-group="${group.key}" aria-expanded="${open}"
              title="${open ? "Zwiń przegródkę" : "Rozwiń przegródkę"}">
        <svg class="list__caret"><use href="#i-chevron" /></svg>
        <span>${group.label}</span><i></i><b data-i18n="skip">${group.items.length}</b>
      </button>`;
  };

  $("#items").innerHTML = groups
    .map((group) => {
      if (!divided) return group.items.map(card).join("");
      const open = !!query || !state.collapsed.has(group.key);
      return head(group) + (open ? group.items.map(card).join("") : "");
    })
    .join("");
}

/** Przypięcie z listy i z paska narzędzi to jedno i to samo. */
/* Notatka „na wierzchu" — widoczna w pływającym widgecie.
 *
 * Flaga zostaje NA TYM KOMPUTERZE i nie jedzie do chmury, choć notatka
 * jedzie. To nie jest niedopatrzenie: „mam to teraz przed oczami" opisuje
 * biurko, przy którym się siedzi, a nie treść notatki. Ta sama lista zadań
 * bywa na wierzchu na komputerze w pracy i schowana na domowym, i tak ma
 * być. Synchronizacja pomija to pole z samej swojej budowy — przyjmuje
 * z serwera tylko te pola, które zna (patrz toNote w main/sync.js).
 */
async function togglePin(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;

  note.pinned = !note.pinned;
  await api.notes.update(note.id, { pinned: note.pinned });
  // Sam pasek narzędzi, nie całe renderEditor: przełożenie pinezki nie ma
  // prawa przestawić kursora w tekście, który się właśnie pisze.
  if (note.id === state.selected) paintActions(document, note);
  renderList();
  translateTree();
}

/**
 * Przepisanie tytułu na kaflu. Tytuł nie jest osobnym polem — jest
 * pierwszą linią notatki — więc jego zmiana wchodzi prosto w tekst
 * i widać ją także w edytorze obok.
 */
function startRename(element) {
  const note = state.notes.find((item) => item.id === element.closest(".note")?.dataset.id);
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
      if (note.id === state.selected) editor.setMarkdown(note.text);
    }
    renderList();
    translateTree();
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

/* ── Cisza w tle na czas składania listy ───────────────────────
   Panel składa się w trzech wymiarach, a pod nim leży animowane tło pod
   szkłem — i to ono przelicza rozmycie przy każdej swojej klatce (patrz
   js/constellation.js). Dwie kosztowne rzeczy w jednej klatce widać jako
   szarpnięcie, więc na czas ruchu tło staje. Nikt na nie wtedy nie patrzy. */
const FOLD_MS = 520;
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
  if (state.solo) return;
  if (document.body.dataset.list !== (state.listOpen ? "open" : "closed")) quietBackground();
  document.body.dataset.list = state.listOpen ? "open" : "closed";
  const label = state.listOpen ? t("Zwiń listę notatek") : t("Rozwiń listę notatek");
  const handle = $("#listToggle");
  if (handle) {
    handle.title = label;
    handle.setAttribute("aria-label", label);
    handle.setAttribute("aria-expanded", String(state.listOpen));
  }
  localStorage.setItem("cribro:notepad-list", state.listOpen ? "1" : "0");
}


/* ── Szuflady i etykiety ───────────────────────────────────────
   To samo, co w zakładce Notatki w oknie głównym (js/notes-view.js).
   Powtórzone, bo oba widoki mają własne szkielety i własne nazwy pól —
   wspólny jest rdzeń, który mówi, czym szuflada i etykieta są
   (js/notes-core.js), a nie to, gdzie stoją na ekranie. */

/** Etykiety na kaflu. Kliknięcie pokazuje resztę notatek z tą etykietą. */
function tagRow(note) {
  const tags = tagsOf(note);
  if (!tags.length) return "";
  return `<div class="note-card__tags">${tags
    .map(
      (tag) =>
        `<button class="tag tag--sm" data-act="filter-tag" data-tag="${escape(tag)}"
                 title="Pokaż notatki z tą etykietą" data-i18n="skip">#${escape(tag)}</button>`,
    )
    .join("")}</div>`;
}

/**
 * Pasek nad listą — zawsze widoczny, tak jak w zakładce Notatki (patrz
 * renderFolders w notes-view.js, ten sam wzorzec). Przycisk „Szuflady"
 * otwiera siatkę (folderGrid); wewnątrz szuflady pasek zamienia się
 * w drogę powrotną.
 */
function renderFolders() {
  const rail = $("#folders");
  if (!rail) return;

  // Ścisłe `!== null`: „Bez szuflady" to `state.folder === ""`, realny
  // wybór — `if (state.folder)` pomyliłby go z „nic nie wybrano".
  if (state.folder !== null) {
    rail.innerHTML = `
      <button class="folder-chip folder-chip--back" data-act="folder-back"
              title="${escape(t("Wróć do szuflad"))}">
        <svg><use href="#i-chevron" /></svg>
        <span data-i18n="skip">${escape(state.folder || t("Bez szuflady"))}</span>
      </button>`;
    return;
  }

  const count = foldersOf(state.notes).length;
  rail.innerHTML = `
    <button class="folder-chip folder-chip--toggle" data-act="folders-toggle"
            aria-pressed="${state.foldersOpen}" title="${escape(t("Szuflady — jak foldery, wchodzi się w nie"))}">
      <svg><use href="#i-folder" /></svg>
      <span>${escape(t("Szuflady"))}</span>
      ${count ? `<b data-i18n="skip">${count}</b>` : ""}
    </button>`;
}

/**
 * Siatka szuflad — patrz folderGrid w notes-view.js, ten sam wzorzec co
 * tam (i te same powody: karta jest `<div role="button">`, nie
 * `<button>`, bo w środku siedzi rząd przycisków zmiany koloru).
 */
function folderGrid() {
  const folders = foldersOf(state.notes);
  const withoutFolder = state.notes.filter((note) => !folderOf(note)).length;

  if (!folders.length && !withoutFolder) {
    return `<p class="notes__nothing">${escape(
      t("Nie masz jeszcze żadnej szuflady — załóż ją przy notatce, w metryczce pod paskiem narzędzi."),
    )}</p>`;
  }

  const swatches = (name) =>
    NOTE_COLORS.map(
      ([key, label]) => `
        <button class="folder-card__swatch" data-act="folder-color"
                data-folder="${escape(name)}" data-color-pick="${key}"
                title="${escape(label)}" aria-pressed="${folderColorOf(name, state.settings) === key}">
          <span class="swatch" data-color="${key}"></span>
        </button>`,
    ).join("");

  const card = (name, count) => `
    <div class="folder-card" role="button" tabindex="0" data-act="pick-folder"
         data-folder="${escape(name ?? "")}" data-color="${folderColorOf(name, state.settings)}">
      <span class="folder-card__icon"><svg><use href="#i-folder" /></svg></span>
      <span class="folder-card__name" data-i18n="skip">${escape(name ?? t("Bez szuflady"))}</span>
      <span class="folder-card__count" data-i18n="skip">${t("{n} notatek", { n: count })}</span>
      ${name ? `<div class="folder-card__colors">${swatches(name)}</div>` : ""}
    </div>`;

  return `<div class="folder-grid">
    ${folders.map((name) => card(name, state.notes.filter((note) => folderOf(note) === name).length)).join("")}
    ${withoutFolder ? card(null, withoutFolder) : ""}
  </div>`;
}

/** Metryczka otwartej notatki: w której szufladzie leży i czego dotyczy. */
function renderMeta() {
  const box = $("#noteMeta");
  const note = state.notes.find((item) => item.id === state.selected);
  if (!box || !note) return;

  const folder = folderOf(note);
  const folders = foldersOf(state.notes).filter((name) => name !== folder);

  box.innerHTML = `
    <div class="menu-wrap">
      <button class="folder-btn" data-act="folder-menu" aria-pressed="${!!folder}"
              title="Szuflada notatki">
        <svg><use href="#i-folder" /></svg>
        <span data-i18n="${folder ? "skip" : ""}">${folder ? escape(folder) : t("Bez szuflady")}</span>
      </button>
      <div class="menu menu--left" id="folderMenu" hidden>
        ${folders
          .map(
            (name) =>
              `<button data-set-folder="${escape(name)}" data-i18n="skip">${escape(name)}</button>`,
          )
          .join("")}
        ${folders.length ? '<div class="menu__sep"></div>' : ""}
        <button data-set-folder="">Bez szuflady</button>
        <button data-act="new-folder">Nowa szuflada…</button>
      </div>
    </div>
    <div class="notes__tags">
      ${tagsOf(note)
        .map(
          (tag) => `
            <span class="tag" data-i18n="skip">#${escape(tag)}
              <button data-act="drop-tag" data-tag="${escape(tag)}"
                      title="Zdejmij etykietę" aria-label="Zdejmij etykietę">×</button>
            </span>`,
        )
        .join("")}
      <input class="tag-input" id="tagInput" type="text" placeholder="+ etykieta"
             spellcheck="false" maxlength="32" />
    </div>`;
}

const currentNote = () => state.notes.find((item) => item.id === state.selected) ?? null;

async function setTags(note, tags) {
  note.tags = tags;
  await api.notes.update(note.id, { tags });
  renderMeta();
  renderList();
  translateTree();
}

async function addTag(raw) {
  const note = currentNote();
  const tag = cleanTag(raw);
  if (!note || !tag) return;
  const have = tagsOf(note);
  if (have.some((item) => tagKey(item) === tagKey(tag))) return;
  await setTags(note, [...have, tag]);
}

async function dropTag(raw) {
  const note = currentNote();
  if (!note) return;
  await setTags(note, tagsOf(note).filter((item) => tagKey(item) !== tagKey(raw)));
}

async function setFolder(note, name) {
  const folder = String(name ?? "").trim() || null;
  note.folder = folder;
  await api.notes.update(note.id, { folder });
  renderMeta();
  renderList();
  translateTree();
}

/** Wyrównanie tekstu — cecha całej notatki, patrz [data-align] w prose.css. */
async function setAlign(note, align) {
  note.align = align;
  $("#text")?.setAttribute("data-align", align);
  await api.notes.update(note.id, { align });
  refreshFormatState();
}

function renderEditor() {
  const note = state.notes.find((item) => item.id === state.selected);
  $("#empty").hidden = state.notes.length > 0;
  $("#app").style.visibility = state.notes.length ? "visible" : "hidden";
  if (!note) return;

  editor.setMarkdown(note.text);
  $("#text").setAttribute("data-align", note.align ?? "left");
  renderMeta();
  if (state.solo) document.title = `${titleOf(note)} — Cribro Sift`;

  $("#meta").textContent = `${new Date(note.at).toLocaleString(uiLocale(), {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  paintActions(document, note);
  $("#words").textContent = t("{n} słów", { n: countWords(note.text) });

  // Cofnięcie pokazujemy tylko wtedy, gdy naprawdę jest do czego wracać.
  $("#hint").innerHTML = note.previousText
    ? '<span class="undo" data-act="undo-sift">Przesiane — cofnij</span>'
    : "";

  refreshFormatState();
}

/** Podświetlenie przycisków paska: co jest włączone tam, gdzie stoi kursor. */
function refreshFormatState() {
  const active = editor.activeFormats();
  for (const button of document.querySelectorAll("[data-format]")) {
    button.setAttribute("aria-pressed", String(!!active[button.dataset.format]));
  }
  /* Nagłówki siedzą w menu, więc bez tego jednego wpisu „stoję w nagłówku"
     dałoby się zobaczyć dopiero po rozwinięciu menu — czyli po kliknięciu
     w coś, co miało dopiero powiedzieć, czy warto klikać. */
  $("#format")?.setAttribute(
    "aria-pressed",
    String(!!(active.h1 || active.h2 || active.h3 || active.toggle)),
  );
  // Wyrównanie nie zależy od kursora — jest cechą notatki, nie zaznaczenia.
  const align = currentNote()?.align ?? "left";
  for (const button of document.querySelectorAll("[data-align]")) {
    button.setAttribute("aria-pressed", String(button.dataset.align === align));
  }
  // Wyrównanie inne niż domyślne widać na samym przycisku menu.
  $("#align")?.setAttribute("aria-pressed", String(align !== "left"));
}

function render() {
  renderList();
  applyListState();
  renderEditor();
  // Szablony są po polsku; jeśli interfejs ma być angielski, podmiana
  // dzieje się tu, na gotowym drzewie (patrz js/i18n.js).
  translateTree();
}

/* ── Zapis ────────────────────────────────────────────────────── */

let saveTimer = null;

function scheduleSave() {
  const note = state.notes.find((item) => item.id === state.selected);
  if (!note) return;

  note.text = editor.getMarkdown();
  note.updatedAt = new Date().toISOString();
  $("#status").textContent = t("Zapisuję…");
  $("#status").dataset.state = "saving";
  $("#words").textContent = t("{n} słów", { n: countWords(note.text) });

  // Zapis po chwili ciszy — nie po każdym znaku.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await api.notes.update(note.id, { text: note.text });
    $("#status").textContent = t("Zapisane");
    $("#status").dataset.state = "saved";
    renderList();
  }, 450);
}

async function newNote() {
  const note = await api.notes.create();
  state.notes.unshift(note);
  state.selected = note.id;
  render();
  editor.focus();
}

/* ── Zdarzenia ────────────────────────────────────────────────── */

/* Naciśnięcie przycisku paska nie ma zabierać zaznaczenia z tekstu —
   inaczej „B" pogrubiałoby to, co przed chwilą było zaznaczone, albo nic. */
document.addEventListener("mousedown", (event) => {
  if (event.target.closest("[data-format], #stamp, #format, #align")) event.preventDefault();
});

document.addEventListener("selectionchange", () => {
  if (document.activeElement === $("#text")) refreshFormatState();
});

/* Podwójne kliknięcie w tytuł przepisuje tytuł, w resztę kafla — odrywa
   notatkę do własnego okna. */
document.addEventListener("dblclick", (event) => {
  const title = event.target.closest(".note__title");
  if (title) return startRename(title);
  const item = event.target.closest(".note");
  if (!item) return;
  api.notes.openWindow(item.dataset.id);
});

/* Kafel nie jest już przyciskiem — w środku siedzą pinezka i tytuł do
   przepisania, a przycisk w przycisku nie przetrwałby wczytania szablonu.
   Klawiatura dostaje więc to, co przycisk dawał sam. */
document.addEventListener("keydown", (event) => {
  const item = event.target.closest?.(".note");
  if (!item || state.renaming || event.defaultPrevented) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  item.click();
});

document.addEventListener("click", async (event) => {
  // Pinezka na kaflu jest przed kaflem: przypięcie nie ma przy okazji
  // przerzucać edytora na inną notatkę.
  const pin = event.target.closest("[data-note-pin]");
  if (pin) return togglePin(pin.dataset.notePin);

  // W trakcie przepisywania tytułu kliknięcie w niego stawia kursor
  // i nic poza tym — inaczej zabrałoby sobie samo zaznaczenie.
  if (state.renaming && event.target.closest(".note__title")) return;

  /* Szuflady i etykiety — przed kaflem, bo obie rzeczy w nim siedzą,
     a żadna nie ma przy okazji przerzucać edytora na inną notatkę.

     `state.folder === null` znaczy „nic nie wybrano". `""` jest realnym
     wyborem — „Bez szuflady" — więc wszędzie tu stoi to rozróżnienie,
     a nie sama prawdziwość (ten sam powód, co w renderList/renderFolders). */
  if (event.target.closest('[data-act="folders-toggle"]')) {
    state.foldersOpen = !state.foldersOpen;
    state.folder = null;
    renderList();
    translateTree();
    return;
  }
  if (event.target.closest('[data-act="folder-back"]')) {
    state.folder = null;
    state.foldersOpen = true;
    localStorage.removeItem("cribro:notepad-folder");
    renderList();
    translateTree();
    return;
  }
  const colorPick = event.target.closest('[data-act="folder-color"]');
  if (colorPick) {
    const name = colorPick.dataset.folder;
    const key = colorPick.dataset.colorPick;
    if (name && key) await api.settings.save({ notesFolderColors: { [name.trim().toLowerCase()]: key } });
    renderList();
    return;
  }
  const railed = event.target.closest('[data-act="pick-folder"]');
  if (railed) {
    // Klik w kartę WCHODZI do szuflady, zawsze — wyjście ma własny
    // przycisk (folder-back), tak jak w prawdziwym folderze.
    state.folder = railed.dataset.folder ?? null;
    state.foldersOpen = false;
    if (state.folder) localStorage.setItem("cribro:notepad-folder", state.folder);
    else localStorage.removeItem("cribro:notepad-folder");
    renderList();
    translateTree();
    return;
  }
  const tagged = event.target.closest('[data-act="filter-tag"]');
  if (tagged) {
    state.query = `#${tagged.dataset.tag}`;
    const field = $("#search");
    if (field) field.value = state.query;
    renderList();
    translateTree();
    return;
  }

  const group = event.target.closest(".list__group");
  if (group) {
    const key = group.dataset.group;
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    saveCollapsedGroups(GROUPS_KEY, state.collapsed);
    renderList();
    translateTree();
    return;
  }

  const item = event.target.closest(".note");
  if (item) {
    // Zaznaczenie podmieniamy w miejscu: przebudowana lista zabrałaby
    // przeglądarce element, na którym miałaby wywołać podwójne kliknięcie.
    state.selected = item.dataset.id;
    for (const note of document.querySelectorAll(".note")) {
      note.setAttribute("aria-selected", String(note.dataset.id === state.selected));
    }
    renderEditor();
    editor.focus();
    return;
  }

  if (event.target.closest("#listToggle")) {
    state.listOpen = !state.listOpen;
    applyListState();
    return;
  }

  if (event.target.closest("#newNote") || event.target.closest("#firstNote")) {
    // Nowa notatka przy zwiniętej liście: rozkładamy ją, żeby było widać,
    // że coś przybyło — i skąd potem wrócić do poprzedniej.
    if (!state.listOpen) {
      state.listOpen = true;
      applyListState();
    }
    return newNote();
  }

  const note = state.notes.find((item) => item.id === state.selected);
  if (!note) return;

  if (event.target.closest("#dictate")) {
    // Nagrywanie z okna notatki: tekst ma trafić do niej, a nie pod kursor.
    await api.notes.dictate(note.id);
    return;
  }

  if (event.target.closest("#detach")) {
    await api.notes.openWindow(note.id);
    return;
  }

  if (event.target.closest("#stamp")) return insertStamp();

  if (event.target.closest('[data-act="undo-sift"]')) {
    const restored = await api.notes.undoSift(note.id);
    Object.assign(note, restored, { previousText: null });
    render();
    return;
  }

  const align = event.target.closest("[data-align]");
  if (align) {
    closeMenus();
    await setAlign(note, align.dataset.align);
    return;
  }

  const picked = event.target.closest("[data-set-folder]");
  if (picked) {
    closeMenus();
    await setFolder(note, picked.dataset.setFolder);
    return;
  }

  const dropped = event.target.closest('[data-act="drop-tag"]');
  if (dropped) {
    await dropTag(dropped.dataset.tag);
    return;
  }

  if (event.target.closest('[data-act="folder-menu"]')) {
    toggleMenu("#folderMenu", '[data-act="folder-menu"]');
    return;
  }

  if (event.target.closest('[data-act="new-folder"]')) {
    closeMenus();
    // Nazwa wpisuje się w ten sam przycisk, w którym potem stoi — osobne
    // okienko z pytaniem byłoby trzecim oknem dla jednego słowa.
    const field = $("#noteMeta .folder-btn span");
    if (field) {
      renameInPlace(field, {
        text: "",
        onCommit: (name) => setFolder(note, name),
        onEnd: () => renderMeta(),
      });
    }
    return;
  }

  const share = event.target.closest("[data-share]");
  if (share) {
    closeMenus();
    await runShare(share.dataset.share, note);
    return;
  }

  /* Znak specjalny wchodzi jak wpisany z klawiatury. Menu zostaje otwarte:
     znaki wstawia się seriami, a zamykanie po każdym kazałoby otwierać je
     od nowa. */
  const glyph = event.target.closest("[data-char]");
  if (glyph) {
    editor.insertText(glyph.dataset.char);
    return;
  }
  if (event.target.closest("#chars")) {
    toggleMenu("#charsMenu", "#chars");
    return;
  }

  /* ── Dolny pasek czynności ──
     `data-act` niosą też inne rzeczy w tym oknie (cofnięcie sita, etykiety,
     szuflada), więc pytamy o KONKRETNE nazwy, a nie o sam atrybut. */
  const act = event.target.closest("[data-act]")?.dataset.act;
  if (act === "share") {
    toggleMenu('[data-acts-menu="share"]', '[data-act="share"]');
    fitMenu(document.querySelector('[data-acts-menu="share"]'));
    return;
  }
  if (["pin", "desktop", "sift", "delete"].includes(act)) {
    closeMenus();
    try {
      const gone = await runAction(act, note, {
        api,
        say: flash,
        after: () => {
          paintActions(document, note);
          renderList();
          if (act === "sift") render();
        },
      });
      if (gone) {
        state.notes = state.notes.filter((item) => item.id !== note.id);
        state.selected = state.notes[0]?.id ?? null;
        if (state.solo) return api.notes.closeWindow();
        if (!state.notes.length) await newNote();
        else render();
      }
    } catch (error) {
      flash(String(error.message || error));
    }
  }
});

/* ── Menu paska ─────────────────────────────────────────────────
   Cztery menu i jedna zasada dla wszystkich: otwarte jest najwyżej jedno,
   a przycisk, spod którego wyszło, zostaje na ten czas podświetlony
   (aria-expanded — patrz .icon-btn[aria-expanded] w css/notes.css).

   Wspólne miejsce, a nie po jednym warunku przy każdym menu: przy trzech
   menu wyliczanka „zamknij pozostałe" zdążyła się już rozjechać — jedno
   zamykało dwa inne i zapominało o trzecim, więc menu szuflady zostawało
   otwarte pod menu udostępniania. */
const BAR_MENUS = [
  ["#formatMenu", "#format"],
  ["#alignMenu", "#align"],
  ["#charsMenu", "#chars"],
  ['[data-acts-menu="share"]', '[data-act="share"]'],
  ["#folderMenu", '[data-act="folder-menu"]'],
];

function closeMenus(keep = null) {
  for (const [menu, button] of BAR_MENUS) {
    if (menu === keep) continue;
    const element = $(menu);
    if (!element) continue;
    element.hidden = true;
    $(button)?.setAttribute("aria-expanded", "false");
  }
}

function toggleMenu(menu, button) {
  const element = $(menu);
  if (!element) return;
  const open = element.hidden;
  closeMenus(menu);
  element.hidden = !open;
  $(button)?.setAttribute("aria-expanded", String(open));
}

const anyMenuOpen = () => BAR_MENUS.some(([menu]) => $(menu) && !$(menu).hidden);

/* Menu zamyka się przy kliknięciu obok — inaczej zostaje otwarte
   nad tekstem i zasłania to, co się właśnie pisze. */
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) closeMenus();
});

document.addEventListener("click", (event) => {
  if (event.target.closest("#format")) return toggleMenu("#formatMenu", "#format");
  if (event.target.closest("#align")) return toggleMenu("#alignMenu", "#align");
  const item = event.target.closest("[data-format]");
  if (item) {
    closeMenus();
    applyFormat(item.dataset.format);
  }
});

/* Pole etykiety. Enter i przecinek kończą jedną, Backspace w pustym polu
   zdejmuje ostatnią — tak zachowuje się każde pole etykiet. */
document.addEventListener("keydown", (event) => {
  if (event.target.id !== "tagInput") return;
  const field = event.target;
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    const value = field.value;
    field.value = "";
    void addTag(value).then(() => $("#tagInput")?.focus());
    return;
  }
  if (event.key === "Backspace" && !field.value) {
    const last = tagsOf(currentNote()).at(-1);
    if (!last) return;
    event.preventDefault();
    void dropTag(last).then(() => $("#tagInput")?.focus());
    return;
  }
  if (event.key === "Escape") {
    event.stopPropagation();
    field.value = "";
    field.blur();
  }
});

/* Szybka notatka z paska menu, z widgetu albo skrótem — zawsze ląduje tutaj. */
api.notes.onNew?.(() => newNote());

/* Escape zdejmuje po jednej warstwie, od wierzchu: otwarte menu, potem
   trwające nagranie, potem pisanie w polu, potem kartki leżące na pulpicie,
   a na końcu — gdy nie ma już czego przerwać — samo okno. Notatka jest przy
   tym zapisana; okno jest ostatnie właśnie dlatego, że odruchowe „escape"
   w środku pisania nie może go sprzątnąć sprzed nosa.

   Kartki idą przed oknem, bo leżą NAD nim: schowanie okna zostawiłoby je
   na ekranie i Escape wyglądałby na klawisz, który zrobił połowę rzeczy. */
const editingNow = () => {
  const node = document.activeElement;
  return (
    !!node &&
    (node.isContentEditable ||
      node.tagName === "INPUT" ||
      node.tagName === "TEXTAREA" ||
      node.tagName === "SELECT")
  );
};

async function onEscape() {
  if (anyMenuOpen()) return closeMenus();
  // Escape kasuje nagranie w całości — także to zamówione z notatki.
  if (state.runtime === "listening") return api.system.cancelCapture?.();
  if (editingNow()) return document.activeElement.blur();
  // Talia leży w innych oknach, więc pyta się o nią proces główny.
  if (await api.deck.escape()) return;
  api.notes.closeWindow();
}

document.addEventListener("keydown", (event) => {
  // ⌘B i ⌘I obsługuje sam edytor — tu byłoby to drugie przełączenie.
  if (event.defaultPrevented) return;
  if (!event.metaKey) {
    if (event.key === "Escape") void onEscape();
    return;
  }
  if (event.key === "n") {
    event.preventDefault();
    newNote();
  } else if (event.shiftKey && (event.key === "l" || event.key === "L") && !state.solo) {
    event.preventDefault();
    state.listOpen = !state.listOpen;
    applyListState();
  } else if (event.key === "f" && !state.solo) {
    event.preventDefault();
    $("#search").focus();
    $("#search").select();
  } else if (event.key === "t") {
    event.preventDefault();
    insertStamp();
  } else if (event.key === "b") {
    event.preventDefault();
    applyFormat("bold");
  } else if (event.key === "i") {
    event.preventDefault();
    applyFormat("italic");
  } else if (event.shiftKey && (event.key === "H" || event.key === "h")) {
    event.preventDefault();
    // ⌘⇧H zostaje „nagłówkiem" bez numeru — tym, po który sięga ręka.
    // Stopnie mają własne klawisze, bo teraz jest z czego wybierać.
    applyFormat("h2");
  } else if (event.shiftKey && ["1", "!", "2", "@", "3", "#"].includes(event.key)) {
    event.preventDefault();
    applyFormat({ 1: "h1", "!": "h1", 2: "h2", "@": "h2", 3: "h3", "#": "h3" }[event.key]);
  } else if (event.shiftKey && (event.key === "E" || event.key === "e")) {
    event.preventDefault();
    applyFormat("toggle");
  } else if (event.shiftKey && (event.key === "-" || event.key === "_")) {
    event.preventDefault();
    applyFormat("divider");
  } else if (event.shiftKey && (event.key === "J" || event.key === "j")) {
    event.preventDefault();
    // Wyrównanie nie jest blokiem, więc nie idzie do edytora. Drugie
    // naciśnięcie wraca do wyrównania do lewej.
    const note = currentNote();
    if (note) void setAlign(note, note.align === "justify" ? "left" : "justify");
  } else if (event.shiftKey && (event.key === "8" || event.key === "*")) {
    event.preventDefault();
    applyFormat("bullet");
  } else if (event.shiftKey && (event.key === "9" || event.key === "(")) {
    event.preventDefault();
    applyFormat("todo");
  } else if (event.shiftKey && (event.key === "'" || event.key === '"')) {
    event.preventDefault();
    applyFormat("quote");
  }
});

$("#search")?.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderList();
});

/* ── Formatowanie ─────────────────────────────────────────────── */

/* Cała robota siedzi w js/editor.js — tutaj zostaje jedno wywołanie
   i odświeżenie paska, żeby przyciski pokazywały stan kursora. */
function applyFormat(kind) {
  editor.format(kind);
  refreshFormatState();
}

/* Godzina wstawiona w miejscu kursora — w notatce ze spotkania to
   najczęściej potrzebny znacznik, a sięganie po zegar rozprasza. */
function insertStamp() {
  const stamp = new Date().toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" });
  editor.insertText(`${stamp} — `);
}

function flash(message) {
  $("#hint").textContent = message;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => renderEditor(), 2600);
}

/* Wysyłka siedzi w js/notes-core.js — tam, gdzie pasek, który ją wywołuje.
   Trzy okna pokazują tę samą notatkę i mają wysyłać ją tak samo. */
async function runShare(what, note) {
  try {
    await shareNote(what, note, { api, say: flash });
  } catch (error) {
    flash(String(error.message || error));
  }
}

/* ── Wiadomości z procesu głównego ────────────────────────────── */

api.onState(({ state: next }) => {
  state.runtime = next;
  const button = $("#dictate");
  button.dataset.state = next;
  button.querySelector("span").textContent =
    next === "listening" ? "Słucham…" : next === "sifting" ? "Przesiewam…" : "Dyktuj";
});

/* Podyktowany fragment dopisany przez proces główny — przeładowujemy
   notatkę z dysku, żeby okno i plik nigdy się nie rozjechały. */
api.notes.onAppended(async ({ id }) => {
  const fresh = await api.notes.get();
  state.notes = fresh;
  // W osobnym okienku zostajemy przy swojej notatce; w pełnym oknie
  // przeskakujemy do tej, do której właśnie mówiono.
  if (id && !state.solo) state.selected = id;
  render();
  editor.focusEnd();
  $("#hint").textContent = "Dopisane z dyktowania";
  setTimeout(() => ($("#hint").textContent = ""), 2400);
});

/* Ta sama notatka bywa otwarta w kilku oknach naraz — zmiana w jednym
   ma dojść do pozostałych, zamiast czekać na ponowne otwarcie. */
api.notes.onChanged?.(async ({ id }) => {
  const fresh = await api.notes.get();
  state.notes = fresh;
  // `id` puste znaczy „zmieniło się nie wiadomo co" — tak wraca
  // synchronizacja z chmury. Wtedy przerysowujemy zawsze, bo pominięcie
  // dotyczyłoby akurat tej notatki, na którą ktoś patrzy.
  if (state.solo && id && id !== state.selected) return;
  render();
});

api.onError(({ message }) => {
  $("#hint").textContent = message.slice(0, 70);
});

/* ── Start ────────────────────────────────────────────────────── */

/* Sprawdzanie pisowni w tekście notatki. Podkreślanie włącza atrybut przy
   samym polu, a nie przełącznik na całej sesji: pole ma spellcheck="true"
   wpisane w HTML, więc dziedziczenie po dokumencie by go nie ruszyło. */
function applySpellcheck(settings) {
  $("#text").spellcheck = settings.spellcheck?.enabled !== false;
}

(async function boot() {
  const settings = await api.settings.get();
  state.settings = settings;
  setLanguage(settings.uiLanguage ?? "pl");
  applySpellcheck(settings);
  api.settings.onChange((next) => {
    state.settings = next;
    setLanguage(next.uiLanguage ?? "pl");
    applySpellcheck(next);
    render();
  });

  state.notes = await api.notes.get();

  if (state.solo) {
    // Notatka mogła zniknąć, zanim okno zdążyło się otworzyć.
    if (!state.notes.some((note) => note.id === soloId)) return api.notes.closeWindow();
    render();
    editor.focusEnd();
    return;
  }

  if (!state.notes.length) {
    await newNote();
  } else {
    state.selected = sortNotes(state.notes)[0].id;
    render();
  }
})();
