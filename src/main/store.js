"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { normalize: normalizeLanguage } = require("./languages");
const { BUILTINS, DEFAULTS: COMMAND_DEFAULTS } = require("./commands");

/**
 * Wszystko leży lokalnie w ~/Library/Application Support/Cribro Sift/.
 * Nagranie audio jest kasowane zaraz po transkrypcji — zapisujemy tylko
 * przesiany tekst. Surowy transkrypt trzymamy wyłącznie, gdy użytkownik
 * sam to włączy (keepRaw).
 */

const DEFAULTS = {
  // Skrót — dwa klawisze trzymane razem uruchamiają nasłuch (push-to-talk).
  //
  // Celowo dwa modyfikatory, nie modyfikator + znak: trzymanie ⌥+spacji
  // wsypywałoby spacje (a na macOS twarde spacje) do aplikacji, do której
  // właśnie mówisz. ⌃+⌥ trzymane razem nie generują żadnego znaku.
  //
  // Oba gesty — trzymanie i podwójne stuknięcie — są włączone zawsze.
  // Nie ma czego przestawiać: gest sam mówi, o który sposób chodzi.
  hotkey: {
    hold: ["Ctrl", "Alt"], // ⌃ + ⌥
    toggleAccelerator: "Control+Alt+Space", // fallback bez zgody „Dostępność"
    // Szybka notatka ma swoje miejsce w ustawieniach, ale jeszcze nie ma
    // klawiszy: null znaczy „nieprzypisany", nie „domyślny".
    quickNote: null,
  },
  mesh: "srednie", // gęstość sita: zgrubne | srednie | drobne
  // Dyktowanie dwujęzyczne jest domyślne, bo tak wygląda mowa przy pracy:
  // polskie zdanie z angielskim terminem w środku. Szczegóły w languages.js.
  language: { mode: "bilingual", primary: "pl", secondary: "en" },
  uiLanguage: "pl", // język interfejsu: pl | en
  autoPaste: true,
  playSound: true,
  launchAtLogin: false,
  keepRaw: true, // trzymaj surowy transkrypt obok przesianego (do podglądu różnic)
  // Dwa niezależne kroki. Każdy może chodzić na innym dostawcy, ale gdy
  // oba używają tego samego, wystarczy wpisać klucz raz — drugi krok
  // sam go znajdzie (patrz keyFor w providers.js).
  stt: {
    provider: "gemini", // gemini | openai | mock
    // Flash-Lite zamiast Flash: na darmowym poziomie Gemini 3.7 Flash bywa
    // zatłoczony i odbija zapytania limitem, a transkrypcja i tak jest
    // zadaniem odtwórczym, nie wymaga najmocniejszego modelu.
    model: "gemini-3.1-flash-lite",
    apiKey: "",
  },
  sieve: {
    provider: "gemini", // gemini | openai | anthropic
    model: "gemini-3.7-flash",
    apiKey: "",
    customInstruction: "",
  },
  grains: [], // słowa, które sito ma zawsze przepuścić bez zmian

  /* Polecenia — jedyny wyłom w zakazie „sito nie odpowiada".

     Polecenie nie jest instrukcją, którą model postanawia wykonać: jest
     frazą zapisaną tutaj przez użytkownika, która na jedno dyktowanie
     przestawia reguły sita. Rozpoznanie i odcięcie frazy dzieje się
     lokalnie — szczegóły i zestaw startowy w main/commands.js. */
  commands: structuredClone(COMMAND_DEFAULTS),

  // Ikona w Docku. Włączona — aplikacja zachowuje się jak zwykła aplikacja.
  // Wyłączenie zostawia ją wyłącznie w pasku menu.
  showInDock: true,

  /* Widget — jedyne, co aplikacja pokazuje poza swoimi oknami: pływający
     znaczek z notatkami „na wierzchu" i z tacą czynności robionych w biegu.

     `x` i `y` to kotwica, czyli środek znaczka na ekranie; `null` znaczy
     „jeszcze nieprzesunięty" i wtedy widget staje na swoim miejscu
     startowym (patrz widgetHome w main/main.js).

     `mode` mówi, CO robi kliknięcie w znaczek — i to jest jedyna różnica
     między dwoma widokami:

       "compact"  jedna szyba przy znaczku: lista notatek na wierzchu,
                  a wybrana wychodzi z niej kartką. Wszystko w jednym oknie,
                  wszystko znika razem ze znaczkiem.
       "desk"     każda notatka dostaje własną kartkę na pulpicie, jak
                  Sticky Notes. Leżą tam, gdzie się je położyło, i chowają
                  się wszystkie naraz — jednym kliknięciem w znaczek.

     `cards` to miejsce i rozmiar kartek z widoku „desk", notatka po
     notatce. Kartkę przesuwa się raz i ma tam zostać — także po ponownym
     uruchomieniu i po odłączeniu monitora, na którym leżała (wtedy wraca
     na ekran ze znaczkiem, patrz deckSpots w main/main.js). */
  widget: {
    enabled: false,
    mode: "compact",
    x: null,
    y: null,
    /* Rozmiar szyby przy znaczku — zmieniany uchwytem w jej rogu.
       Klamry i przycięcie do ekranu są w widgetPanel w main/main.js. */
    panel: { width: 256, height: 320 },
    cards: {},
  },

  /* Pisownia w notatkach.
     `languages` ma znaczenie tylko tam, gdzie sprawdzaniem zajmuje się
     Chromium (Windows, Linux). macOS ma własny mechanizm systemowy, który
     rozpoznaje język sam i nie da się nim sterować z aplikacji —
     szczegóły w applySpellcheck w main/main.js. */
  spellcheck: { enabled: true, followDictation: true, languages: [] },

  /* Konto i kopia notatek w Supabase. Domyślnie wyłączone i puste:
     Cribro działa bez konta i bez sieci, a chmura jest dodatkiem, który
     się włącza, a nie stanem, z którego się wypisuje.

     `anonKey` to klucz publiczny — wolno mu leżeć w tym pliku. Sesja
     (z tokenem odświeżającym) leży osobno i zaszyfrowana; patrz
     main/supabase.js. */
  cloud: { enabled: false, url: "", anonKey: "", autoSync: true },

  /* Tekst z ekranu — trzecia droga, którą tekst wchodzi do Cribro
     (patrz main/shot.js). Zaznaczasz kawałek ekranu, a to, co na nim widać,
     staje się notatką: tekstem, obrazkiem albo jednym i drugim.

     `hotkey` jest `null`, czyli NIEPRZYPISANY — nie „domyślny". Zrzut
     ekranu ma na macOS trzy fabryczne skróty (⌘⇧3, ⌘⇧4, ⌘⇧5) i cokolwiek
     byśmy tu wpisali, byłoby albo zajęte, albo o włos od zajętego. Klawisze
     wybiera się w Ustawieniach, a do tego czasu funkcja jest w menu.

     `ask` to okno z pytaniem „dokąd i w jakiej formie". Da się je wyłączyć,
     ale wtedy trzeba wiedzieć, gdzie tekst wyląduje — stąd `target` i `form`
     obok: bez pytania decydują one, i są tym, co okno zapamiętało ostatnim
     razem.

     PNG zostaje na dysku wyłącznie wtedy, gdy notatka go pokazuje (forma
     „obrazek" albo „oba"). Sam odczyt tekstu nie zostawia po sobie pliku:
     zrzut spełnił już swoje zadanie i trzymanie go byłoby zbieraniem
     śmieci w cudzym katalogu.

     `copy` to schowek. Odczyt trafia do niego tak samo jak przesiane
     dyktowanie — bo najczęstsze, co się robi z tekstem wyjętym z cudzego
     okna, to wklejenie go gdzie indziej. */
  shot: {
    hotkey: null,
    provider: "openai", // openai | mock
    // Najtańszy z listy. Odczyt jest zadaniem odtwórczym: model ma przepisać
    // cudzy napis, nie zrozumieć go (patrz OCR w main/providers.js).
    model: "gpt-5.6-luna",
    apiKey: "",
    ask: true,
    target: "new", // new | note | cursor
    form: "text", // text | image | both
    copy: true,
  },

  /* Notion. Wyprowadzanie notatek na zewnątrz, nie druga chmura — Cribro
     niczego stamtąd nie czyta i niczego nie uzgadnia.

     `token` to token INTEGRACJI („ntn_…"), nie hasło do konta: sam z siebie
     nie daje dostępu do niczego, dopóki nie udostępni się mu konkretnej
     strony. `parent` to ta strona — adres wklejony z przeglądarki wystarczy.

     `pages` to zakładka: która notatka dostała którą stronę. Zostaje na tym
     komputerze i nie jedzie do chmury, bo mówi o cudzym Notion, a nie
     o treści notatki. Dzięki niej „wyślij ponownie" odświeża stronę,
     zamiast robić drugą obok. */
  notion: { token: "", parent: "", pages: {} },

};

/** Numer układu ustawień. Podniesienie znaczy: przy starcie coś poprawiamy. */
const SCHEMA = 6;

/** Zakładka synchronizacji: dokąd doszliśmy i czyje to konto. */
const CLOUD_STATE = { userId: null, cursor: null, lastSyncAt: null };

/**
 * Dopisanie przesianego tekstu do notatki.
 *
 * Notatka ma wyglądać jak notatka, a nie jak zlepek zdań doklejanych jedno
 * do drugiego. Stąd trzy reguły, wszystkie o formie, żadna o treści:
 *
 *   — nowy fragment to nowy akapit, oddzielony pustą linią;
 *   — jeśli notatka kończy się punktem listy, dyktowanie dokłada punkt,
 *     zamiast rozbijać listę akapitem (zaznaczone zadanie startuje puste);
 *   — puste dopisanie nie rusza notatki i nie zostawia po sobie pustych linii.
 */
function joinNote(existing, addition) {
  const text = String(addition ?? "").trim();
  if (!text) return String(existing ?? "");

  const base = String(existing ?? "").trimEnd();
  if (!base) return text;

  const lastLine = base.slice(base.lastIndexOf("\n") + 1);
  const bullet = lastLine.match(/^(\s*)([-*] \[[ xX]\] |[-*] |> )/);
  if (bullet) {
    const mark = bullet[2].replace(/\[[xX]\]/, "[ ]");
    return `${base}\n${bullet[1]}${mark}${text}`;
  }

  return `${base}\n\n${text}`;
}

class Store {
  constructor() {
    const dir = app.getPath("userData");
    this.settingsPath = path.join(dir, "settings.json");
    this.historyPath = path.join(dir, "history.json");
    this.notesPath = path.join(dir, "notes.json");
    this.cloudPath = path.join(dir, "cloud.json");
    const stored = this.#read(this.settingsPath, DEFAULTS);
    const wasSchema = stored.schema ?? 1;
    this.settings = migrate(stored);
    // Poprawki zapisujemy od razu. Inaczej biegłyby przy każdym starcie
    // i przykrywałyby to, co użytkownik zdążył wybrać sam.
    if (wasSchema !== SCHEMA) this.#write(this.settingsPath, this.settings);
    this.history = this.#read(this.historyPath, []);
    this.notes = this.#read(this.notesPath, []);
    this.cloud = this.#read(this.cloudPath, CLOUD_STATE);
  }

  #read(file, fallback) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(fallback) ? raw : deepMerge(structuredClone(fallback), raw);
    } catch {
      return structuredClone(fallback);
    }
  }

  #write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(patch) {
    this.settings = deepMerge(this.settings, patch);
    this.#write(this.settingsPath, this.settings);
    return this.settings;
  }

  getHistory() {
    return this.history;
  }

  addEntry(entry) {
    const record = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      pinned: false,
      ...entry,
    };
    this.history.unshift(record);
    if (this.history.length > 1000) this.history.length = 1000;
    this.#write(this.historyPath, this.history);
    return record;
  }

  updateEntry(id, patch) {
    const entry = this.history.find((e) => e.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);
    this.#write(this.historyPath, this.history);
    return entry;
  }

  deleteEntry(id) {
    this.history = this.history.filter((e) => e.id !== id);
    this.#write(this.historyPath, this.history);
  }

  clearHistory() {
    this.history = this.history.filter((e) => e.pinned);
    this.#write(this.historyPath, this.history);
  }

  /* ── Notatki ─────────────────────────────────────────────────
     Osobny plik od historii, bo to co innego: historia jest zapisem
     tego, co powiedziałeś, a notatka jest dokumentem, który redagujesz. */

  /**
   * Notatki do pokazania. Nagrobki po skasowanych zostają w pliku
   * (potrzebuje ich synchronizacja — patrz main/sync.js), ale nikomu poza
   * nią się nie należą.
   */
  getNotes() {
    return this.notes.filter((note) => !note.deletedAt);
  }

  /** Wszystko, razem z nagrobkami. Tylko dla synchronizacji. */
  rawNotes() {
    return this.notes;
  }

  /** Zapis listy notatek bez przechodzenia przez pojedynczą zmianę. */
  persistNotes() {
    this.#write(this.notesPath, this.notes);
  }

  /**
   * Notatka przyjęta z serwera — wstawiana wprost, bez podbijania
   * `updatedAt`. Podbicie robiłoby z każdego pobrania nową zmianę
   * i dwa urządzenia odsyłałyby sobie tę samą notatkę bez końca.
   */
  putRawNote(note) {
    const index = this.notes.findIndex((item) => item.id === note.id);
    if (index === -1) this.notes.unshift(note);
    else this.notes[index] = { ...this.notes[index], ...note };
    return note;
  }

  /** Nagrobek starszy niż `days` nikomu już nic nie mówi. */
  pruneTombstones(days = 30) {
    const edge = Date.now() - days * 86_400_000;
    const before = this.notes.length;
    this.notes = this.notes.filter(
      (note) => !note.deletedAt || Date.parse(note.deletedAt) > edge,
    );
    return before - this.notes.length;
  }

  /* Kursor synchronizacji leży osobno od ustawień: to nie jest wybór
     użytkownika, tylko zakładka w książce. */
  getCloudState() {
    return this.cloud;
  }

  saveCloudState(patch) {
    this.cloud = { ...this.cloud, ...patch };
    this.#write(this.cloudPath, this.cloud);
    return this.cloud;
  }

  createNote(patch = {}) {
    const note = {
      id: `n${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      text: "",
      pinned: false,
      // Kolor karteczki na pulpicie. „default" znaczy granat — ten sam,
      // co reszta aplikacji (patrz [data-color] w renderer/css/tokens.css).
      color: "default",
      /* Szuflada i etykiety. Dwie różne rzeczy, choć obie porządkują:
         SZUFLADA jest jedna i mówi, GDZIE notatka leży („Klient Nowak").
         ETYKIETY są dowolnej liczby i mówią, CZEGO dotyczy („#pilne",
         „#rozliczenia"). Notatka ze spotkania należy do jednego projektu
         i dotyczy trzech spraw naraz — jedno pole nie uniesie obu. */
      folder: null,
      tags: [],
      /* Wyrównanie tekstu: left | center | right | justify. Cecha całej
         notatki, a nie zaznaczonego akapitu — patrz [data-align]
         w renderer/css/prose.css. */
      align: "left",
      deletedAt: null,
      // null znaczy „serwer jeszcze tego nie widział".
      syncedAt: null,
      ...patch,
    };
    this.notes.unshift(note);
    this.#write(this.notesPath, this.notes);
    return note;
  }

  updateNote(id, patch) {
    const note = this.notes.find((item) => item.id === id && !item.deletedAt);
    if (!note) return null;
    Object.assign(note, patch, { updatedAt: new Date().toISOString() });
    this.#write(this.notesPath, this.notes);
    return note;
  }

  /**
   * Kasowanie zostawia nagrobek: id, czas skasowania i nic więcej.
   *
   * Treść znika od razu — nagrobek ma powiedzieć „tej notatki nie ma",
   * a nie przechować ją pod flagą. Bez nagrobka notatka skasowana na
   * jednym komputerze wracałaby z drugiego przy najbliższej
   * synchronizacji, bo „skasowana" i „jeszcze niewysłana" wyglądają
   * z drugiej strony tak samo.
   */
  deleteNote(id) {
    const note = this.notes.find((item) => item.id === id);
    if (!note) return true;
    note.text = "";
    note.previousText = null;
    note.pinned = false;
    note.deletedAt = new Date().toISOString();
    note.updatedAt = note.deletedAt;
    this.#write(this.notesPath, this.notes);
    return true;
  }

  /** Dopisanie podyktowanego fragmentu na końcu notatki. */
  appendToNote(id, text) {
    const note = this.notes.find((item) => item.id === id && !item.deletedAt);
    if (!note) return null;
    note.text = joinNote(note.text, text);
    note.updatedAt = new Date().toISOString();
    this.#write(this.notesPath, this.notes);
    return note;
  }

  /** Liczby na kaflu „Przesiane" — ile szumu faktycznie odpadło. */
  stats() {
    const words = (s) => (s ? s.trim().split(/\s+/).filter(Boolean).length : 0);
    let raw = 0;
    let kept = 0;
    for (const e of this.history) {
      raw += e.rawWords ?? words(e.raw);
      kept += e.siftedWords ?? words(e.text);
    }
    return {
      sessions: this.history.length,
      wordsKept: kept,
      wordsSifted: Math.max(0, raw - kept),
      // 45 słów/min pisania na klawiaturze vs 150 słów/min mówienia
      minutesSaved: Math.round((kept / 45 - kept / 150) * 10) / 10,
    };
  }
}

/**
 * Ustawienia zapisane starszą wersją aplikacji mogą wskazywać dostawcę,
 * którego już nie ma (np. „groq"), albo nie mieć pola provider w ogóle.
 * Cichy błąd 404 przy pierwszym dyktowaniu byłby gorszy niż reset.
 */
function migrate(settings) {
  const KNOWN_STT = ["gemini", "openai", "mock"];
  const KNOWN_SIEVE = ["gemini", "openai", "anthropic"];

  // Skrót nie ma już trybów. „hold", „toggle" i „double-tap" były wyborem
  // między gestami, które dziś działają obok siebie; przełącznik hands-off
  // dało się wyłączyć i wtedy podwójne stuknięcie milczało bez wyjaśnienia.
  // Zapisane wartości po prostu znikają — klawisze zostają te same.
  delete settings.hotkey?.mode;
  delete settings.hotkey?.handsFree;

  // Do 0.1 język był jednym napisem („auto" albo kod). Teraz to trzy pola,
  // bo dwujęzyczności nie da się zapisać jednym kodem.
  settings.language = normalizeLanguage(settings.language);

  if (!KNOWN_STT.includes(settings.stt?.provider)) {
    settings.stt = structuredClone(DEFAULTS.stt);
  }
  /* Listwy nad Dockiem nie ma — jej cztery czynności przejęła taca widgetu
     (patrz WIDGET_TRAY w main/main.js). Kto miał listwę włączoną, ten chciał
     mieć te czynności pod ręką: włączamy mu więc widget, zamiast zabierać
     wszystko bez słowa. Miejsce listwy nie przechodzi — widget ma własne
     i stoi gdzie indziej. */
  if (settings.dockBar?.enabled && settings.widget) settings.widget.enabled = true;
  delete settings.dockBar;

  // Pływająca ikonka szybkiej notatki była i jej nie ma. Wpis po niej nic już
  // nie robi, ale zostawiony w pliku wygląda jak ustawienie, którego nie da
  // się nigdzie znaleźć — a plik ustawień czyta się także oczami.
  delete settings.floater;

  // Widget dostał drugi widok. Ustawienia sprzed niego nie mają pola `mode`
  // — a nierozpoznana wartość (z nowszej wersji albo z ręcznej edycji pliku)
  // zostawiałaby znaczek, który po kliknięciu nie robi nic.
  if (settings.widget && !["compact", "desk"].includes(settings.widget.mode)) {
    settings.widget.mode = "compact";
  }
  if (settings.widget && (!settings.widget.cards || typeof settings.widget.cards !== "object")) {
    settings.widget.cards = {};
  }

  /* Polecenia doszły w schemacie 5. Wbudowane dokładamy PO ID, a nie
     podmieniając całą listę: inaczej każda aktualizacja kasowałaby własne
     polecenia użytkownika. Skasowane ręcznie nie wracają — od tego jest
     removedBuiltins, bo zapisana lista wygrywa z domyślną (patrz deepMerge)
     i bez zakładki nie dałoby się odróżnić „skasowane" od „jeszcze nie ma". */
  if (!settings.commands || typeof settings.commands !== "object") {
    settings.commands = structuredClone(COMMAND_DEFAULTS);
  } else {
    const commands = settings.commands;
    if (!Array.isArray(commands.items)) commands.items = [];
    if (!Array.isArray(commands.bypass)) commands.bypass = [...COMMAND_DEFAULTS.bypass];
    if (!Array.isArray(commands.removedBuiltins)) commands.removedBuiltins = [];
    if (typeof commands.enabled !== "boolean") commands.enabled = true;
    for (const builtin of BUILTINS) {
      if (commands.removedBuiltins.includes(builtin.id)) continue;
      if (commands.items.some((item) => item?.id === builtin.id)) continue;
      commands.items.push(structuredClone(builtin));
    }
  }

  /* Tekst z ekranu doszedł w schemacie 6. Nierozpoznany dostawca albo
     forma spoza trójki zostawiłyby okno, które po kliknięciu „Zapisz"
     nie robi nic — a to jest gorsze niż cofnięcie się do domyślnych. */
  if (!settings.shot || typeof settings.shot !== "object") {
    settings.shot = structuredClone(DEFAULTS.shot);
  } else {
    const shot = settings.shot;
    if (!["openai", "mock"].includes(shot.provider)) shot.provider = DEFAULTS.shot.provider;
    if (!shot.model) shot.model = DEFAULTS.shot.model;
    if (!["new", "note", "cursor"].includes(shot.target)) shot.target = DEFAULTS.shot.target;
    if (!["text", "image", "both"].includes(shot.form)) shot.form = DEFAULTS.shot.form;
    if (typeof shot.ask !== "boolean") shot.ask = true;
    if (typeof shot.copy !== "boolean") shot.copy = true;
  }

  settings.schema = SCHEMA;

  if (!KNOWN_SIEVE.includes(settings.sieve?.provider)) {
    settings.sieve = {
      ...structuredClone(DEFAULTS.sieve),
      // klucz i własną wytyczną warto zachować, jeśli tam były
      apiKey: settings.sieve?.apiKey ?? "",
      customInstruction: settings.sieve?.customInstruction ?? "",
    };
  }
  return settings;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      base[key] = deepMerge(base[key] ?? {}, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

module.exports = { Store, DEFAULTS, CLOUD_STATE, joinNote };
