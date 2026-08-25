"use strict";

const path = require("path");
const fs = require("fs");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  shell,
  clipboard,
  dialog,
  session,
  systemPreferences,
  globalShortcut,
  nativeTheme,
} = require("electron");

const { Store } = require("./store");
const { Supabase } = require("./supabase");
const { signInWithProvider, PORTS: OAUTH_PORTS, CALLBACK: OAUTH_CALLBACK } = require("./oauth");
const { syncNotes } = require("./sync");
const { HotkeyEngine } = require("./hotkeys");
const { transcribe } = require("./stt");
const { sift, MESH } = require("./sieve");
const { detect: detectCommand, byId: commandById } = require("./commands");
const { keyFor, STT, SIEVE, OCR } = require("./providers");
const { deliver, frontmostApp } = require("./paste");
const { toAppleNotes, toMarkdown } = require("./share");
const { noteToPdf } = require("./pdf");
const { sendNote: sendToNotion, check: checkNotion } = require("./notion");
const { detectConflicts } = require("./shortcuts");
const { grabRegion, readText, compose, stampName } = require("./shot");
const { LANGUAGES, normalize: normalizeLanguage, shortLabel } = require("./languages");
const { translator } = require("../shared/strings");

/* Pasek menu mówi stanem, nie słowami — ale musi być widoczny.
   „Gotowe" jest szablonem: macOS przemaluje je na biało w ciemnym pasku
   i na czarno w jasnym. Stany pracy są kolorowe, żeby rzucały się w oczy. */
const TRAY_ICON = {
  idle: "idleTemplate.png",
  listening: "listening.png",
  sifting: "sifting.png",
  done: "done.png",
};

const TRAY_TOOLTIP = {
  idle: "Cribro Sift — trzymaj ⌃⌥ i mów",
  listening: "Słucham…",
  sifting: "Przesiewam…",
  done: "Gotowe — tekst w schowku",
};

const trayImages = new Map();

function trayIcon(state) {
  if (!trayImages.has(state)) {
    const file = path.join(__dirname, "..", "..", "assets", "tray", TRAY_ICON[state]);
    const image = nativeImage.createFromPath(file);
    // Szablon dostaje przemalowanie od systemu; kolorowe stany mają zostać kolorowe.
    image.setTemplateImage(state === "idle");
    trayImages.set(state, image);
  }
  return trayImages.get(state);
}

let store;
let cloud;
let hotkeys;
let tray;
let mainWindow = null;
let hud = null;
let notesWindow = null;
/** Notatki oderwane do własnych okienek: id notatki → okno. */
const noteWindows = new Map();
let quickWindow = null;
let widget = null;
let state = "idle";
let pendingContext = null;

/**
 * Gdy w środowisku siedzi ELECTRON_RUN_AS_NODE=1, Electron startuje jako
 * zwykły Node: `require("electron")` oddaje ścieżkę do binarki zamiast API,
 * więc `app` jest niezdefiniowane i wszystko pada bez słowa wyjaśnienia.
 * Ustawia ją m.in. zintegrowany terminal VS Code i dziedziczy ją `open`.
 * Lepiej powiedzieć wprost, co się stało, niż zniknąć po cichu.
 */
if (!app || typeof app.setName !== "function") {
  console.error(
    "\nCribro Sift: uruchomiono w trybie Node, nie Electrona.\n" +
      "W środowisku jest ELECTRON_RUN_AS_NODE=" +
      (process.env.ELECTRON_RUN_AS_NODE ?? "?") +
      " — ustawia ją np. terminal VS Code.\n\n" +
      "Uruchom tak:  env -u ELECTRON_RUN_AS_NODE npm start\n" +
      "albo po prostu otwórz aplikację z Findera.\n",
  );
  process.exit(1);
}

app.setName("Cribro Sift");

/* ── Okna ─────────────────────────────────────────────────────── */

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: "#0a0f14",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 22 },
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => (mainWindow = null));

  // Użytkownik wraca z Ustawień systemowych właśnie tędy. Jeśli w międzyczasie
  // przyznał „Dostępność", to jest moment, żeby przejąć prawdziwy skrót.
  mainWindow.on("focus", () => {
    if (hotkeys && hotkeys.backend !== "uiohook") bindHotkeys();
    broadcast("permissions:changed", permissionSnapshot());
  });

  return mainWindow;
}

/**
 * HUD to jedyne, co widać podczas dyktowania. Nie może przejąć fokusu —
 * inaczej ⌘V trafiłoby w nas zamiast w aplikację, do której mówisz.
 */
function createHud() {
  const { workArea } = screen.getPrimaryDisplay();
  // Okno HUD-a jest szersze niż pigułka w środku: pigułka zwęża się po
  // trzech sekundach do samego znaczka i musi mieć dokąd, a okno o stałym
  // rozmiarze nie może być ciaśniejsze niż jej najszerszy stan.
  const width = 380;
  const height = 132;

  hud = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 48),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hud.setAlwaysOnTop(true, "screen-saver");
  hud.setIgnoreMouseEvents(true, { forward: true });
  hud.loadFile(path.join(__dirname, "..", "renderer", "hud.html"));
  return hud;
}

/**
 * Notatnik — własne okno. Panel doklejony do okna głównego dzielił jedną
 * szerokość między listę notatek a to, po co ktoś przyszedł do Cribro,
 * i obie połowy robiły się za ciasne. Notatka ze spotkania ma leżeć obok
 * spotkania, nie w środku innego okna.
 */
function createNotesWindow() {
  if (notesWindow && !notesWindow.isDestroyed()) {
    notesWindow.show();
    notesWindow.focus();
    return notesWindow;
  }

  notesWindow = new BrowserWindow({
    width: 860,
    height: 620,
    minWidth: 620,
    minHeight: 420,
    show: false,
    backgroundColor: "#09101c", // --bg
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notesWindow.loadFile(path.join(__dirname, "..", "renderer", "notes.html"));
  notesWindow.once("ready-to-show", () => notesWindow.show());
  notesWindow.on("closed", () => (notesWindow = null));
  return notesWindow;
}

/**
 * Jedna notatka we własnym okienku — otwiera je podwójne kliknięcie
 * na liście, tu i w zakładce Notatki okna głównego.
 *
 * Notatka ze spotkania ma prawo stać obok rozmowy, a nie w środku okna,
 * które trzeba przełączać. Okienko jest wąskie i celowo bez listy: to jest
 * ta jedna notatka, nie widok na wszystkie.
 */
function openNoteWindow(id) {
  const open = noteWindows.get(id);
  if (open && !open.isDestroyed()) {
    open.show();
    open.focus();
    return open;
  }

  const win = new BrowserWindow({
    width: 520,
    height: 560,
    minWidth: 380,
    minHeight: 320,
    show: false,
    backgroundColor: "#09101c", // --bg
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Kilka okienek naraz nie może wylądować jedno na drugim.
  const offset = noteWindows.size * 26;
  const [x, y] = win.getPosition();
  win.setPosition(x + offset, y + offset);

  win.loadFile(path.join(__dirname, "..", "renderer", "notes.html"), { query: { note: id } });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => noteWindows.delete(id));
  noteWindows.set(id, win);
  return win;
}

/** Nowa notatka z menu: tam, gdzie użytkownik właśnie patrzy. */
function newNoteCommand() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused === mainWindow) {
    mainWindow.webContents.send("note:new");
    return;
  }

  const win = createNotesWindow();
  const send = () => win.webContents.send("note:new");
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}

/**
 * Szybka notatka — jedno małe okno i nic poza polem tekstowym.
 *
 * Osobne od Notatnika celowo: to jest miejsce na jedno zdanie rzucone
 * w trakcie rozmowy. Lista notatek, wyszukiwarka i pasek narzędzi byłyby
 * tu wszystkim, czego się w tej chwili nie potrzebuje. Zapisuje do tej samej
 * szuflady, więc notatka czeka potem w Notatniku.
 */
function createQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.show();
    quickWindow.focus();
    return quickWindow;
  }

  const { workArea } = screen.getPrimaryDisplay();
  const width = 460;
  const height = 300;

  quickWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - 32),
    y: Math.round(workArea.y + 48),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // Bez ramki i bez tła: szybę rysuje sam dokument (patrz #shell
    // w quick.html), a system daje jej rozmycie tego, co pod spodem.
    transparent: true,
    backgroundColor: "#00000000",
    // „under-window" rozmywa to, co leży ZA oknem — pulpit, przeglądarkę,
    // cudzy dokument. „popover" rozjaśniał tylko własne tło i szkło
    // wychodziło z tego matowe. Dokument dokłada do tego swoją warstwę
    // (patrz #shell w quick.html) i trzyma się rzadko, żeby nie zakryć
    // tego, co system właśnie rozmył.
    vibrancy: "under-window",
    visualEffectState: "active",
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickWindow.loadFile(path.join(__dirname, "..", "renderer", "quick.html"));
  quickWindow.once("ready-to-show", () => {
    quickWindow.show();
    quickWindow.focus();
  });
  quickWindow.on("closed", () => (quickWindow = null));
  return quickWindow;
}

function quickNote() {
  createQuickWindow();
  return true;
}

/* ── Tekst z ekranu ────────────────────────────────────────────
   Trzecia droga, którą tekst wchodzi do Cribro: zaznaczasz kawałek ekranu,
   a to, co na nim widać, staje się notatką. Samo zaznaczanie i odczyt
   siedzą w main/shot.js — tutaj jest to, czego tamten moduł wiedzieć nie
   może: gdzie stanie okno z pytaniem, dokąd trafi wynik i co zrobić, gdy
   systemowej zgody na nagrywanie ekranu nie ma.

   Kolejność jest tu odwrotna niż przy dyktowaniu i to jest celowe. Głos
   idzie od razu pod kursor, bo mówiąc, patrzysz w miejsce, w którym tekst
   ma się pojawić. Zrzut robi się patrząc na CUDZE okno — w chwili
   zaznaczania nie wiadomo jeszcze, dokąd rzecz ma trafić. Dlatego pyta.  */

let shotWindow = null;
/* Zrzut czeka tu na decyzję. Bufor NIE jedzie do renderera: okno dostaje
   pomniejszony podgląd, a pełny obrazek zostaje w procesie głównym, bo to
   on go zapisze — i wyłącznie wtedy, gdy padnie na formę z obrazkiem. */
let shot = null;

function shotsDir() {
  const dir = path.join(app.getPath("userData"), "zrzuty");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Podgląd dla okna. Zrzut z ekranu Retiny ma dwa razy więcej pikseli, niż
 * okienko ma miejsca, a przez most jedzie jako tekst (data:) — pomniejszenie
 * skraca tę drogę kilkukrotnie i nie zmienia niczego w tym, co widać.
 */
function shotPreview(buffer) {
  const image = nativeImage.createFromBuffer(buffer);
  const { width } = image.getSize();
  const small = width > 900 ? image.resize({ width: 900, quality: "good" }) : image;
  return small.toDataURL();
}

function createShotWindow() {
  if (shotWindow && !shotWindow.isDestroyed()) {
    shotWindow.show();
    shotWindow.focus();
    return shotWindow;
  }

  /* Okno staje na tym ekranie, na którym stoi kursor — czyli na tym,
     z którego przed chwilą coś zaznaczono. Na drugim monitorze wyglądałoby
     to jak zgubiony zrzut. */
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 460;
  /* Wysokość dobrana tak, żeby wszystko było widać naraz: podgląd, odczyt
     i oba wybory. Okno, w którym trzeba przewijać, żeby znaleźć „Zapisz",
     byłoby wolniejsze niż wklejenie tekstu ręcznie. */
  const height = 640;

  shotWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(24, (workArea.height - height) / 2 - 40)),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // Ta sama szyba co przy szybkiej notatce — patrz createQuickWindow.
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: "under-window",
    visualEffectState: "active",
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  shotWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  shotWindow.loadFile(path.join(__dirname, "..", "renderer", "shot.html"));
  shotWindow.once("ready-to-show", () => {
    shotWindow.show();
    shotWindow.focus();
  });
  shotWindow.on("closed", () => {
    shotWindow = null;
    shot = null; // zamknięte okno znaczy „nie chcę" — obrazek nie ma po co czekać
  });
  return shotWindow;
}

function closeShotWindow() {
  shot = null;
  if (shotWindow && !shotWindow.isDestroyed()) shotWindow.close();
  return true;
}

/**
 * Całe zdarzenie: zaznaczenie, odczyt i pytanie.
 *
 * Okno otwiera się ZANIM odczyt się skończy. Inaczej po zaznaczeniu obszaru
 * przez dwie sekundy nie działoby się nic i wyglądałoby to na zrzut, który
 * przepadł — a odczyt trwa tyle, ile trwa cudze łącze.
 */
async function grabScreenText() {
  if (shot) return false; // jedno zaznaczanie naraz
  const t = translator(store.getSettings().uiLanguage);

  if (process.platform === "darwin") {
    /* Zgody nie da się przyznać z kodu. „not-determined" zostawiamy
       systemowi — sam pokaże swoje okienko przy pierwszym zaznaczeniu.
       Odmowę trzeba cofnąć ręcznie, więc otwieramy właściwy panel. */
    const access = systemPreferences.getMediaAccessStatus("screen");
    if (access === "denied" || access === "restricted") {
      shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
      broadcast("pipeline:error", {
        stage: "zrzut",
        message: t("Brak zgody „Nagrywanie ekranu” — włącz ją w Ustawieniach systemowych."),
      });
      return false;
    }
  }

  const grabbed = await grabRegion();
  if (!grabbed) return false; // Escape w trakcie zaznaczania

  const settings = store.getSettings();
  shot = { image: grabbed.buffer, reading: true, text: "", missingKey: false, error: null };

  const reading = readText(grabbed.buffer, settings)
    .then((result) => ({ text: result.text, missingKey: !!result.missingKey, error: null }))
    .catch((error) => ({ text: "", missingKey: false, error: String(error.message || error) }));

  /* Bez pytania: wynik idzie tam, gdzie okno stało ostatnim razem.
     „Do notatki" znaczy wtedy „do ostatnio ruszanej" — patrz saveShot. */
  if (settings.shot?.ask === false) {
    const done = await reading;
    if (!shot) return false;
    Object.assign(shot, done, { reading: false });
    const form = done.text ? (settings.shot.form ?? "text") : "image";
    const result = await saveShot({ target: settings.shot.target, form, text: done.text });
    shot = null;
    if (result?.error) broadcast("pipeline:error", { stage: "zrzut", message: result.error });
    return result;
  }

  createShotWindow();
  const done = await reading;
  if (!shot) return false; // zdążył zamknąć okno
  Object.assign(shot, done, { reading: false });
  if (shotWindow && !shotWindow.isDestroyed()) {
    shotWindow.webContents.send("shot:text", { ...done, reading: false });
  }
  return true;
}

/** Najświeższa notatka — „dopisz do notatki" bez wskazania której. */
function freshestNote() {
  return [...store.getNotes()].sort(
    (a, b) => Date.parse(b.updatedAt ?? b.at ?? 0) - Date.parse(a.updatedAt ?? a.at ?? 0),
  )[0];
}

/**
 * Decyzja z okna → notatka.
 *
 * Obrazek zapisujemy dopiero tutaj i wyłącznie wtedy, gdy padło na formę,
 * która go pokazuje. Zrzut zrobiony po to, żeby wyjąć z niego zdanie, nie
 * ma powodu zostawać na dysku.
 */
async function saveShot({ target = "new", noteId = null, form = "text", text = "" } = {}) {
  const settings = store.getSettings();
  const t = translator(settings.uiLanguage);
  const buffer = shot?.image ?? null;

  let imagePath = null;
  if ((form === "image" || form === "both") && buffer) {
    try {
      imagePath = path.join(shotsDir(), stampName());
      fs.writeFileSync(imagePath, buffer);
    } catch (error) {
      return { error: `${t("Nie udało się zapisać zrzutu")}: ${error.message}` };
    }
  }

  const body = compose({ form, text, image: imagePath });
  if (!body.trim()) return { error: t("Nie ma czego zapisać.") };

  /* Okno zapamiętuje ostatni wybór — następnym razem stoi tam, gdzie się
     je zostawiło. Klawiszy skrótu ta ścieżka nie rusza, więc nie ma tu
     czego przepinać (patrz bindShotHotkey). */
  store.saveSettings({ shot: { target, form } });
  broadcast("settings:changed", store.getSettings());

  if (settings.shot?.copy !== false && text.trim()) clipboard.writeText(text);

  if (target === "cursor") {
    const result = await deliver(text, { autoPaste: settings.autoPaste });
    return { saved: true, ...result };
  }

  if (target === "note") {
    const note = store.appendToNote(noteId ?? freshestNote()?.id, body);
    if (note) {
      scheduleSync();
      broadcast("note:appended", { id: note.id });
      broadcast("note:changed", { id: note.id });
      syncDeck();
      return { saved: true, noteId: note.id };
    }
    // Nie ma do czego dopisać — zostaje nowa notatka. Milczące zgubienie
    // odczytu byłoby najgorszym z możliwych zakończeń.
  }

  const note = store.createNote({ text: body, kind: "shot" });
  scheduleSync();
  broadcast("note:changed", { id: note.id, created: true });
  syncDeck();
  return { saved: true, noteId: note.id, created: true };
}

/**
 * Ikona aplikacji w Docku. Domyślnie widoczna; kto woli mieć Cribro wyłącznie
 * w pasku menu, wyłącza ją w Ustawieniach. Ukrycie ikony zamyka też przełącznik
 * ⌘Tab — aplikacja przestaje być „zwykłą" aplikacją w oczach systemu.
 */
function applyDockIcon(show) {
  if (process.platform !== "darwin") return;
  if (show) app.dock?.show();
  else app.dock?.hide();
}

/* ── Widget ───────────────────────────────────────────────────

   Jedyna rzecz, jaką Cribro pokazuje poza swoimi oknami: jeden znaczek
   pływający nad wszystkim.

   Do niedawna były dwie — listwa nad Dockiem od czynności robionych
   w biegu i znaczek od notatek na wierzchu. Dwa pływające paski od jednej
   aplikacji to o jeden za dużo: zabierały dwa miejsca na ekranie, trzeba
   je było ustawiać osobno i za każdym razem przypominać sobie, w którym
   z nich jest to, po co się właśnie sięga. Listwy nie ma; wszystko, co
   robiła, robi teraz znaczek.

   Znaczek jest więc jednym kółkiem i trzema rzeczami naraz:

     STANEM        w czasie nagrywania to on pokazuje mikrofon, oddycha
                   i reaguje na głos — po trzech sekundach HUD chowa się
                   właśnie w nim.
     TACĄ          najechanie kursorem rozkłada w dół cztery czynności
                   robione w biegu (dyktowanie, szybka notatka, gęstość
                   sita, język), a w bok — przejście do notatek.
     DRZWIAMI      do notatek na wierzchu: listy przy znaczku albo kartek
                   na pulpicie, zależnie od widoku.

   Po co to wszystko poza oknem aplikacji: bo Notatnik otwiera się wtedy,
   gdy siada się do notatek, a widget jest na chwile, gdy właśnie robi się
   coś zupełnie innego — trwa rozmowa, ktoś rzuca termin, a przełączanie
   okien kosztuje więcej, niż sama myśl jest warta.

   Stąd trzy cechy, z których żadna nie jest ozdobna:

     NAD WSZYSTKIM     bo inaczej trzeba by go szukać, a szukanie to już
                       przełączanie okien, przed którym ma chronić.
     BEZ FOKUSU        dopóki się w niego nie kliknie. Znaczek, który
                       zabiera kursor z pola, w którym ktoś pisze, jest
                       szkodnikiem.
     MAŁY              widać z niego jedno kółko o średnicy sześćdziesięciu
                       pikseli. Okno jest większe — mieści zwiniętą tacę,
                       żeby jej rozłożenie nie musiało go ruszać — ale poza
                       znaczkiem jest przezroczyste i na wylot klikalne.

   OKNO ZMIENIA ROZMIAR, zamiast być cały czas duże i przezroczyste.
   Pierwsza wersja trzymała stałe okno 340×500 z przezroczystą resztą —
   i miała wadę, której nie dało się obejść: skoro znaczek siedział u dołu
   takiego okna, to nie dało się go postawić wyżej niż 440 pikseli od górnej
   krawędzi ekranu, bo okno nie miało dokąd sięgnąć. Teraz stała jest
   KOTWICA — środek znaczka na ekranie — a okno układa się wokół niej. */

const WIDGET_BADGE = 60; // średnica znaczka
/* Aureola — margines okna wokół tego, co widać.
   Cień i poświata są RYSOWANE, więc potrzebują miejsca w oknie. Bez tego
   okno ucina je na krawędzi znaczka i zamiast miękkiego kółka widać kółko
   z odciętym brzegiem. Pierwsza wersja miała tu 8 pikseli i dokładnie tak
   wyglądała. */
const WIDGET_HALO = 22;
/* Szyba przy znaczku. Domyślnie o piątą część mniejsza od pierwszej wersji
   (320×400): ta zajmowała ćwiartkę wysokości ekranu i zasłaniała okno, obok
   którego miała tylko leżeć. Notatka na wierzchu to jedno zdanie do
   dopisania, nie dokument — a od czytania długich jest Notatnik.

   Rozmiar jest jednak do zmiany uchwytem w rogu szyby i zapamiętany
   (widget.panel w ustawieniach), bo „ile to jest za dużo" zależy od ekranu
   i od tego, co się w tych notatkach trzyma. Klamry są po to, żeby szyba
   nie zeszła poniżej czytelności ani nie urosła w drugie okno aplikacji. */
const WIDGET_PANEL_DEFAULT = { width: 256, height: 320 };
const WIDGET_PANEL_MIN = { width: 208, height: 196 };
const WIDGET_PANEL_MAX = { width: 560, height: 760 };
const WIDGET_GAP = 14; // odstęp znaczek ↔ panel

/* Pole samego znaczka: kółko z aureolą. Od czasu, gdy znaczek i taca dzielą
   jedno okno (patrz placeWidget), nie jest to już rozmiar zwiniętego okna —
   jest to rozmiar startowy i miara, od której liczy się `half`, czyli jak
   daleko od krawędzi ekranu wolno postawić środek znaczka. */
const WIDGET_COLLAPSED = {
  width: WIDGET_BADGE + WIDGET_HALO * 2,
  height: WIDGET_BADGE + WIDGET_HALO * 2,
};

/* ── Taca ──────────────────────────────────────────────────────

   To, co rozkłada się pod znaczkiem po najechaniu kursorem: pięć rzeczy
   kolumną w dół i ikonka notatek z boku.

   W DÓŁ, a nie w bok jak dawna listwa: znaczek stoi zwykle przy krawędzi
   ekranu, więc w poziomie miejsca nie ma, a w pionie jest go zawsze tyle,
   ile trzeba na kilka kółek. Przy dolnej krawędzi kolumna wychodzi
   w górę — kierunek liczy się z miejsca, tak samo jak przy szybie.

   Kolumna jest uporządkowana od tego, co robi się najczęściej i najszybciej,
   do tego, co wyprowadza z biegu: dyktowanie, szybka notatka, gęstość sita,
   język, a na końcu — najdalej od znaczka — okno aplikacji. Ostatnie stoi
   na końcu, bo jako jedyne otwiera duże okno; przypadkowe kliknięcie ma
   trafić w cokolwiek innego.

   Ikonka notatek NIE jest kolejnym kółkiem w kolumnie i to jest celowe:
   czynności robi się „przy okazji", a notatki się otwiera. Stoi więc
   osobno, w bok — w stronę, w którą jest miejsce.

   `room` to miejsce na dymek z nazwą czynności. Bez niego okno ucinałoby
   go na krawędzi, a same ikony nie mówią, co robią — listwa miała te
   dymki i to dzięki nim dawała się poznać bez instrukcji. */
const WIDGET_TRAY = {
  item: 34, // średnica kółka z ikoną
  step: 9, // odstęp między kółkami w kolumnie
  count: 5, // dyktowanie, szybka notatka, gęstość sita, język, okno aplikacji
  gap: 12, // odstęp od krawędzi znaczka
  tip: 8, // odstęp ikona ↔ dymek
  room: 168, // najszerszy dymek kolumny („Gęstość sita — Zgrubne")
  roomNotes: 96, // dymek przy notatkach — jedno słowo, więc węższy
  margin: 10, // zapas na powiększenie pod kursorem i na cień
};

/** Jak daleko od środka znaczka sięga kolumna czynności. */
const trayReach =
  WIDGET_BADGE / 2 +
  WIDGET_TRAY.gap +
  WIDGET_TRAY.count * WIDGET_TRAY.item +
  (WIDGET_TRAY.count - 1) * WIDGET_TRAY.step +
  WIDGET_TRAY.margin;

/** Jak daleko sięga w bok. Dwie rzeczy walczą tu o miejsce i wygrywa
    szersza: dymek przy ikonce notatek (stoi dalej, ale jest krótki) albo
    dymek przy kolumnie (zaczyna się przy samym znaczku, za to bywa długi).
    Okno przycięte na którymkolwiek z nich ucinałoby napis w pół słowa. */
const traySide =
  Math.max(
    WIDGET_BADGE / 2 + WIDGET_TRAY.gap + WIDGET_TRAY.item + WIDGET_TRAY.tip + WIDGET_TRAY.roomNotes,
    WIDGET_TRAY.item / 2 + WIDGET_TRAY.tip + WIDGET_TRAY.room,
  ) + WIDGET_TRAY.margin;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * Rozmiar szyby: zapamiętany, przycięty do granic i do ekranu.
 *
 * Przycięcie do ekranu nie jest ostrożnością na zapas — szyba zapamiętana
 * na dużym monitorze musi się zmieścić na laptopie, na którym aplikacja
 * właśnie wstała, a okno większe od obszaru roboczego przestaje trafiać
 * kotwicą tam, gdzie stoi znaczek.
 */
/* Rozmiar w trakcie ciągnięcia uchwytu. Trzymamy go w pamięci, bo zapis do
   pliku ustawień przy każdej klatce ruchu myszy to sześćdziesiąt zapisów na
   sekundę — a wynik i tak liczy się dopiero wtedy, gdy uchwyt się puści. */
let widgetPanelDrag = null;

function widgetPanel(workArea) {
  const saved = widgetPanelDrag ?? store.getSettings().widget?.panel ?? {};
  let width = clamp(
    Math.round(saved.width ?? WIDGET_PANEL_DEFAULT.width),
    WIDGET_PANEL_MIN.width,
    WIDGET_PANEL_MAX.width,
  );
  let height = clamp(
    Math.round(saved.height ?? WIDGET_PANEL_DEFAULT.height),
    WIDGET_PANEL_MIN.height,
    WIDGET_PANEL_MAX.height,
  );

  if (workArea) {
    const spare = WIDGET_GAP + WIDGET_BADGE + WIDGET_HALO * 2;
    width = Math.max(WIDGET_PANEL_MIN.width, Math.min(width, workArea.width - spare));
    height = Math.max(WIDGET_PANEL_MIN.height, Math.min(height, workArea.height - spare));
  }
  return { width, height };
}

/* W jakim stanie jest okno widgetu. Trzy, i każdy ma inny rozmiar:

     "badge"  sam znaczek,
     "tray"   znaczek z rozłożoną tacą czynności,
     "panel"  znaczek z szybą notatek (lista albo kartka).

   Stan trzyma proces główny, bo to on zmienia rozmiar okna — renderer
   tylko o zmianę prosi i dostaje w odpowiedzi gotową geometrię. */
let widgetView = "badge";
/** Strona, w którą wyszła szyba. Trzymana, żeby nie przeskakiwała w połowie
    ciągnięcia uchwytu — kierunek liczy się z miejsca, a rozmiar go nie zmienia. */
let widgetDir = "up";
/** Środek znaczka WEWNĄTRZ okna. Zmienia się przy rozwijaniu i zwijaniu. */
let widgetAnchorIn = { x: WIDGET_COLLAPSED.width / 2, y: WIDGET_COLLAPSED.height / 2 };
/* Czy okno widgetu przepuszcza w tej chwili kliknięcia na wylot. Renderer
   przełącza to za każdym razem, gdy kursor wchodzi na znaczek albo z niego
   schodzi — czyli „nie przepuszcza" znaczy dokładnie „kursor jest na
   widgecie". Poza samym ustawieniem okna przydaje się to przy pytaniu,
   skąd wzięła się aktywacja aplikacji (patrz reopenIsOurs). */
let widgetPassing = true;

function createWidget() {
  if (widget && !widget.isDestroyed()) return widget;

  widget = new BrowserWindow({
    ...WIDGET_COLLAPSED,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    // Widget musi umieć przyjąć fokus: na kartce się pisze. Nie bierze go
    // jednak sam — okno pokazujemy przez showInactive(), a o fokus prosi
    // renderer dopiero po kliknięciu.
    focusable: true,
    // ══ BEZ TEGO WIDGET WYGLĄDA NA ZEPSUTY ══
    // macOS domyślnie POŁYKA pierwsze kliknięcie w okno nieaktywnej
    // aplikacji — służy ono tylko do jej uaktywnienia. A widget jest
    // z definicji klikany wtedy, gdy pracuje się w czymś innym, więc
    // KAŻDE kliknięcie w niego jest tym pierwszym: znaczek nie reagował,
    // dopiero drugie kliknięcie go otwierało.
    acceptFirstMouse: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  /* Warstwę WYŻEJ niż kartki na pulpicie, a te leżą na „floating".
     Znaczek jest jedynym, czym się talię zbiera — kartka przeciągnięta na
     niego nie może go przykryć, bo wtedy nie ma już czym jej schować. */
  widget.setAlwaysOnTop(true, "floating", 1);
  widget.setIgnoreMouseEvents(true, { forward: true });
  widget.loadFile(path.join(__dirname, "..", "renderer", "widget.html"));
  widget.on("closed", () => {
    widget = null;
    widgetView = "badge";
  });
  return widget;
}

/** Miejsce startowe: prawa górna ćwiartka, pod paskiem menu. */
function widgetHome() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - 64),
    y: Math.round(workArea.y + 96),
  };
}

/** Zapamiętana kotwica albo miejsce startowe. */
function savedAnchor() {
  const saved = store.getSettings().widget ?? {};
  return saved.x === null || saved.x === undefined ? widgetHome() : { x: saved.x, y: saved.y };
}

/**
 * W którą stronę ma wyjść panel.
 *
 * Nie jedna stała strona, tylko ta, w którą jest miejsce — a przy wyborze
 * między dwiema pasującymi ta, która prowadzi do ŚRODKA ekranu. Widget
 * postawiony u góry rozwija się w dół, przy dolnej krawędzi w górę,
 * a wciśnięty w róg, gdzie w pionie nie mieści się nic, wychodzi bokiem.
 */
function widgetDirection(cx, cy, workArea, panel) {
  const half = WIDGET_COLLAPSED.width / 2;
  const room = {
    up: cy - workArea.y,
    down: workArea.y + workArea.height - cy,
    left: cx - workArea.x,
    right: workArea.x + workArea.width - cx,
  };
  const need = {
    up: panel.height + WIDGET_GAP + half,
    down: panel.height + WIDGET_GAP + half,
    left: panel.width + WIDGET_GAP + half,
    right: panel.width + WIDGET_GAP + half,
  };

  // Pion przed poziomem, bo lista notatek jest pionowa. W obrębie każdej
  // pary najpierw ta strona, w którą jest dalej do krawędzi.
  const order = [
    ...(room.down >= room.up ? ["down", "up"] : ["up", "down"]),
    ...(room.right >= room.left ? ["right", "left"] : ["left", "right"]),
  ];

  return (
    order.find((dir) => room[dir] >= need[dir]) ??
    // Nigdzie się nie mieści — bierzemy stronę z największym zapasem.
    order.sort((a, b) => room[b] / need[b] - room[a] / need[a])[0]
  );
}

/**
 * Ustawienie okna wokół kotwicy.
 *
 * Klamrujemy ZNACZEK, nie okno: znaczek ma zostać tam, gdzie go postawiono,
 * także przy samej krawędzi ekranu. Okno układa się wokół niego i to ono
 * ustępuje, gdy brakuje miejsca — a renderer dostaje z powrotem całą
 * geometrię, której sam nie zna: gdzie w oknie wylądował znaczek, gdzie
 * postawić panel i w którą stronę ma wyjść kartka.
 */
function placeWidget(anchor, view, dirHint = null) {
  if (!widget || widget.isDestroyed()) return null;

  const half = WIDGET_COLLAPSED.width / 2;
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(anchor.x),
    y: Math.round(anchor.y),
  });

  const cx = Math.min(Math.max(anchor.x, workArea.x + half), workArea.x + workArea.width - half);
  const cy = Math.min(Math.max(anchor.y, workArea.y + half), workArea.y + workArea.height - half);

  const size = widgetPanel(workArea);
  const tray = {
    ...WIDGET_TRAY,
    // Kolumna idzie w dół, dopóki jest dokąd. Przy dolnej krawędzi ekranu
    // wychodzi w górę — inaczej cztery kółka wylądowałyby pod pulpitem.
    dir: cy + trayReach <= workArea.y + workArea.height ? "down" : "up",
    // Notatki w bok — w tę stronę, w którą jest miejsce. Przy prawej
    // krawędzi (a tam znaczek stoi domyślnie) w lewo.
    side: cx + traySide <= workArea.x + workArea.width ? "right" : "left",
  };

  const settle = (frame, wanted, extra) => {
    const x = Math.round(
      Math.min(Math.max(cx - wanted.x, workArea.x), workArea.x + workArea.width - frame.width),
    );
    const y = Math.round(
      Math.min(Math.max(cy - wanted.y, workArea.y), workArea.y + workArea.height - frame.height),
    );
    widget.setBounds({ x, y, ...frame });
    widgetAnchorIn = { x: Math.round(cx - x), y: Math.round(cy - y) };
    widgetView = view;
    return {
      view,
      ax: widgetAnchorIn.x,
      ay: widgetAnchorIn.y,
      /* Kotwica na EKRANIE, nie w oknie. Renderer nie ma skąd jej znać —
         a potrzebuje jej dokładnie w jednej chwili: gdy okno już zmieniło
         rozmiar, a odpowiedź z nową kotwicą wewnątrzokienną jeszcze do niego
         nie dojechała. Ze współrzędnej ekranowej odejmuje wtedy własne
         `window.screenX` i znaczek zostaje tam, gdzie stał (patrz „resize"
         w renderer/js/widget.js). */
      sx: Math.round(cx),
      sy: Math.round(cy),
      badge: WIDGET_BADGE,
      tray,
      panelW: size.width,
      panelH: size.height,
      panelX: 0,
      panelY: 0,
      // Granice rozciągania uchwytu. Renderer nie ma skąd ich znać, a to on
      // trzyma mysz — bez nich szyba dałaby się ściągnąć do zera.
      min: WIDGET_PANEL_MIN,
      max: WIDGET_PANEL_MAX,
      ...extra,
    };
  };

  /* ══ ZNACZEK I TACA MAJĄ JEDNO OKNO ══

     I to jest lekarstwo na przeskok, który było widać przy samym zbliżeniu
     kursora do znaczka. Zwinięty widget był wcześniej oknem 104 na 104
     piksele, a najechanie rozciągało je do rozmiaru tacy — w te strony,
     w które taca wychodzi, czyli przy prawej krawędzi ekranu W LEWO.
     Razem z rozmiarem zmieniało się więc miejsce znaczka WEWNĄTRZ okna
     (--ax skakało z 52 na 190).

     Te dwie zmiany nie dzieją się jednocześnie: okno przestawia proces
     główny natychmiast, a nową kotwicę renderer dostaje dopiero odpowiedzią
     na IPC. Przez klatkę albo dwie znaczek był narysowany sto trzydzieści
     osiem pikseli obok miejsca, w którym stał — i wracał. Dokładnie to
     wyglądało jak szarpnięcie animacji.

     Okno ma więc rozmiar tacy także wtedy, gdy taca jest zwinięta.
     Nic to nie zasłania: poza znaczkiem jest przezroczyste i przepuszcza
     kliknięcia na wylot (patrz widget:passthrough), a rozłożenie tacy jest
     od tej pory samym atrybutem w rendererze — bez ruszania okna, bez
     zapytania do procesu głównego i bez ani jednej klatki czekania.

     Okno rośnie WYŁĄCZNIE w te strony, w które taca naprawdę wychodzi —
     po pozostałych zostaje sam znaczek z aureolą. Okno symetryczne byłoby
     o połowę większe i o tę połowę bardziej zasłaniało cudzą pracę. */
  if (view === "badge" || view === "tray") {
    const up = tray.dir === "up" ? trayReach : half;
    const down = tray.dir === "down" ? trayReach : half;
    const left = tray.side === "left" ? traySide : half;
    const right = tray.side === "right" ? traySide : half;
    return settle(
      { width: Math.round(left + right), height: Math.round(up + down) },
      { x: left, y: up },
      { dir: tray.dir },
    );
  }

  const dir = dirHint ?? widgetDirection(cx, cy, workArea, size);
  const sideways = dir === "left" || dir === "right";
  // Odstęp mierzy się od krawędzi ZNACZKA, nie od krawędzi jego pola w oknie:
  // pole jest o aureolę szersze i panel odsunąłby się o nią dodatkowo.
  const rim = WIDGET_BADGE / 2;

  /* OKNO NIE KURCZY SIĘ W TRAKCIE CIĄGNIĘCIA UCHWYTU, tylko po jego
     puszczeniu. Kurczące się okno ucieka spod kursora: uchwyt siedzi
     w rogu, a róg jest tym, co się właśnie cofa — po kilkudziesięciu
     pikselach mysz jest już nad cudzą aplikacją i to ona dostaje resztę
     ruchu. Szyba zwijała się wtedy w połowie gestu zamiast zmienić rozmiar,
     a przeciągnięcie trafiało w przypadkowe okno pod spodem.

     W trakcie ruchu okno trzyma więc największy rozmiar, jaki w tym geście
     miało (`floor`), a szyba jest w nim rysowana mniejsza. Widać dokładnie
     to samo, bo poza szybą okno jest przezroczyste. */
  const hull = widgetPanelDrag
    ? {
        width: Math.max(size.width, widgetPanelDrag.floorW ?? 0),
        height: Math.max(size.height, widgetPanelDrag.floorH ?? 0),
      }
    : size;

  const frame = sideways
    ? { width: hull.width + WIDGET_GAP + WIDGET_BADGE + WIDGET_HALO * 2, height: hull.height + WIDGET_HALO * 2 }
    : { width: hull.width + WIDGET_HALO * 2, height: hull.height + WIDGET_GAP + WIDGET_BADGE + WIDGET_HALO * 2 };

  // Gdzie znaczek siedzi w oknie: zawsze przy tej krawędzi, od której
  // panel się oddala.
  const wanted = {
    up: { x: frame.width / 2, y: frame.height - half },
    down: { x: frame.width / 2, y: half },
    left: { x: frame.width - half, y: frame.height / 2 },
    right: { x: half, y: frame.height / 2 },
  }[dir];

  const spot = settle(frame, wanted, { dir });
  widgetDir = dir;

  // Panel liczymy TUTAJ, a nie w CSS-ie: po przyklamrowaniu okna do ekranu
  // znaczek bywa przesunięty względem swojego miejsca, a wtedy panel liczony
  // z samej kotwicy wyjechałby poza okno.
  //
  // W poprzek szyba stoi na środku OKNA, nie na środku znaczka. To nie jest
  // to samo: przy krawędzi ekranu okno bywa przesunięte względem znaczka,
  // a szyba liczona z samej kotwicy wyjeżdżała wtedy poza okno — i uchwyt
  // w jej rogu lądował poza ekranem. Środek okna działa też wtedy, gdy okno
  // jest chwilowo większe od szyby (patrz `hull` wyżej).
  const panel = {
    x: Math.round((frame.width - size.width) / 2),
    y: Math.round((frame.height - size.height) / 2),
  };
  if (dir === "up") panel.y = widgetAnchorIn.y - rim - WIDGET_GAP - size.height;
  else if (dir === "down") panel.y = widgetAnchorIn.y + rim + WIDGET_GAP;
  else if (dir === "left") panel.x = widgetAnchorIn.x - rim - WIDGET_GAP - size.width;
  else panel.x = widgetAnchorIn.x + rim + WIDGET_GAP;

  spot.panelX = Math.round(panel.x);
  spot.panelY = Math.round(panel.y);
  return spot;
}

/** Kotwica w tej chwili — środek znaczka na ekranie. */
function widgetAnchor() {
  if (!widget || widget.isDestroyed()) return savedAnchor();
  const [x, y] = widget.getPosition();
  return { x: x + widgetAnchorIn.x, y: y + widgetAnchorIn.y };
}

function showWidget(show) {
  if (show) {
    createWidget();
    placeWidget(savedAnchor(), "badge");
    widget.showInactive(); // nigdy .show() — fokus zostaje tam, gdzie był
  } else {
    widget?.hide();
    widgetView = "badge";
    // Kartki na pulpicie żyją z widgetu i gasną razem z nim. Zostawione
    // po wyłączeniu widgetu byłyby oknami, których nie ma czym zamknąć.
    closeDeck();
  }
}

/**
 * Czy to „otwórz aplikację", czy tylko kliknięcie w coś, co i tak leży
 * na wierzchu.
 *
 * macOS zgłasza aplikacji jedno zdarzenie („reopen") na kilka bardzo
 * różnych gestów: kliknięcie ikony w Docku, ponowne uruchomienie i —
 * zależnie od wersji systemu i od tego, co akurat jest widoczne — samo
 * uaktywnienie aplikacji. Cribro odpowiada na nie oknem, bo w Docku to
 * jest właściwa odpowiedź. Kliknięcie w znaczek albo w kartkę leżącą na
 * pulpicie TEŻ uaktywnia aplikację — i tam ta sama odpowiedź jest
 * najgorszą z możliwych: na wierzch cudzej pracy wjeżdża okno, po które
 * nikt nie sięgał.
 *
 * Rozstrzyga miejsce kursora, bo ono rozdziela te gesty bez reszty: nie
 * da się kliknąć ikony w Docku, trzymając kursor na znaczku.
 */
function reopenIsOurs() {
  // Kursor na znaczku albo na jego szybie — renderer mówi to samym faktem,
  // że kazał oknu przestać przepuszczać kliknięcia.
  if (widget && !widget.isDestroyed() && widget.isVisible() && !widgetPassing) return true;

  const point = screen.getCursorScreenPoint();
  for (const win of stickyWindows.values()) {
    if (win.isDestroyed() || !win.isVisible()) continue;
    const b = win.getBounds();
    if (
      point.x >= b.x &&
      point.x <= b.x + b.width &&
      point.y >= b.y &&
      point.y <= b.y + b.height
    ) {
      return true;
    }
  }
  return false;
}

/** Widget zapamiętany na monitorze, którego już nie ma, wraca na swoje miejsce. */
function resetWidget() {
  store.saveSettings({ widget: { x: null, y: null } });
  return placeWidget(widgetHome(), widgetView) ?? true;
}

/* ── Kartki na pulpicie ───────────────────────────────────────

   Drugi widok widgetu — ten, w którym notatki nie siedzą w jednej szybie
   przy znaczku, tylko leżą na pulpicie jak Sticky Notes: każda we własnym
   okienku, każda tam, gdzie się ją położyło.

   Po co dwa widoki, skoro pokazują to samo. Bo to są dwa różne sposoby
   pracy, a nie dwa wyglądy jednego:

     KOMPAKTOWY   notatki są schowane i sięga się po jedną. Zajmuje róg
                  ekranu i znika w całości jednym kliknięciem.
     PULPIT       notatki są na wierzchu cały czas, bo właśnie po to się je
                  tam odłożyło — plan dnia, numer, zdanie do zapamiętania
                  mają być widoczne bez sięgania po cokolwiek.

   Jedno jest wspólne i to jest cała umowa z użytkownikiem: KLIKNIĘCIE
   W ZNACZEK CHOWA WSZYSTKO. Kartki na pulpicie nie mają się rozmnażać
   w coś, czego trzeba potem zamykać po kolei — leżą albo ich nie ma.

   Okienka są trzymane w pamięci między jednym a drugim pokazaniem. Nie
   z oszczędności: kartka ma wracać w to samo miejsce i z tym samym
   przewinięciem, a odtwarzanie okna od zera zaczyna zawsze od góry. */

/** Kartka przy skali 1. Skalę liczy deckScale z rozmiaru ekranu. */
const STICKY_CARD = { width: 268, height: 296 };
/* Granice ręcznej zmiany rozmiaru. Skala z ekranu daje kartce rozmiar
   startowy, ale ostatnie słowo ma człowiek: jedna notatka to numer telefonu,
   druga to plan dnia i te dwie nie potrzebują tego samego prostokąta.
   Klamry są po to, żeby kartka nie zeszła poniżej czytelności ani nie urosła
   w drugie okno Notatnika. */
const STICKY_MIN = { width: 210, height: 150 };
const STICKY_MAX = { width: 760, height: 960 };
/** Aureola — miejsce w oknie na cień i na wyskok animacji poza kartkę. */
const STICKY_HALO = 16;
const STICKY_GAP = 18;
/* Opóźnienie między kolejnymi kartkami. Na tyle małe, żeby cała talia
   zdążyła się rozłożyć zanim wzrok wróci do pulpitu, i na tyle duże, żeby
   było widać, że kartki wychodzą jedna po drugiej, a nie mrugają razem. */
const STICKY_STEP = 55;

/** id notatki → okno kartki. */
const stickyWindows = new Map();
let deckOpen = false;
/* Numer rozdania. Kartka melduje koniec chowania i dopiero wtedy okno
   znika — ale zanim zdąży zameldować, talia bywa już z powrotem na
   pulpicie. Numer odróżnia meldunek z tego rozdania od spóźnionego. */
let deckGen = 0;

const deckMode = () => (store.getSettings().widget?.mode ?? "compact") === "desk";

/* Talia leży w osobnych oknach, a znaczek musi wiedzieć, czy leży — to po
   nim widać, że jest co zbierać, i to on decyduje, co zrobi kolejne
   kliknięcie. Escape na kartce chowa całą talię, a wtedy znaczek nie ma
   skąd się o tym dowiedzieć: nie on o to prosił. Stąd jedna wiadomość
   wysyłana z KAŻDEGO miejsca, które talię otwiera albo chowa. */
const tellDeck = () => broadcast("deck:changed", { open: deckOpen });

/** Notatki na wierzchu, w tej samej kolejności co na liście widgetu. */
function deckNotes() {
  return store
    .getNotes()
    .filter((note) => note.widget === true)
    .sort((a, b) => {
      if (!a.pinned !== !b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt ?? b.at) - new Date(a.updatedAt ?? a.at);
    });
}

/**
 * Skala kartki na tym ekranie.
 *
 * Kartka ma zajmować ten sam ułamek pulpitu na trzynastocalowym laptopie
 * i na dwudziestosiedmiocalowym monitorze — inaczej na jednym jest
 * plakatem, a na drugim znaczkiem pocztowym. Punktem odniesienia jest
 * ekran 1440×900, czyli obszar roboczy typowego MacBooka.
 *
 * Klamry są po to, żeby ekran pomocniczy (albo bardzo wysoki) nie zrobił
 * z kartki czegoś, czego nie da się czytać ani czegoś, co zasłania pulpit.
 */
function deckScale(workArea) {
  const k = Math.min(workArea.width / 1440, workArea.height / 900);
  return Math.min(1.45, Math.max(0.8, Math.round(k * 20) / 20));
}

/** Rozmiar OKNA kartki (z aureolą) przy danej skali. */
function deckCardSize(scale) {
  return {
    width: Math.round(STICKY_CARD.width * scale) + STICKY_HALO * 2,
    height: Math.round(STICKY_CARD.height * scale) + STICKY_HALO * 2,
  };
}

/**
 * Domyślne miejsca dla kartek — kolumnami od lewej krawędzi w dół.
 *
 * Od LEWEJ, choć znaczek startuje po prawej: gdyby talia wychodziła spod
 * znaczka, pierwsza kartka lądowałaby dokładnie na nim i zasłaniałaby
 * jedyne, czym się ją chowa.
 */
function deckSpots(count, workArea) {
  const scale = deckScale(workArea);
  const size = deckCardSize(scale);
  const gap = Math.round(STICKY_GAP * scale);
  const rows = Math.max(1, Math.floor((workArea.height - gap) / (size.height + gap)));
  const columns = Math.max(1, Math.floor((workArea.width - gap) / (size.width + gap)));

  return Array.from({ length: count }, (_, i) => {
    const column = Math.floor(i / rows) % columns;
    const row = i % rows;
    // Kartki ponad pojemność ekranu kładą się schodkami na pierwszej
    // kolumnie — zamiast wyjechać poza pulpit i zniknąć bez śladu.
    const overflow = Math.floor(i / (rows * columns)) * Math.round(26 * scale);
    return {
      x: Math.round(workArea.x + gap + column * (size.width + gap) + overflow),
      y: Math.round(workArea.y + gap + row * (size.height + gap) + overflow),
      ...size,
    };
  });
}

/* ══ KARTKI TRZYMAJĄ SIĘ EKRANU, NA KTÓRYM STOI ZNACZEK ══

   To jest cała odpowiedź na pracę przy dwóch monitorach. Kartka nie ma
   własnego miejsca w układzie wszystkich ekranów naraz — ma miejsce
   NA PULPICIE, przy którym się właśnie siedzi. A o tym, przy którym się
   siedzi, mówi jedno: gdzie postawiono znaczek. Znaczek jest jedyną
   rzeczą, którą przeciąga się świadomie i ręcznie, więc jest jedynym
   wiarygodnym „tu teraz pracuję".

   Miejsce kartki zapamiętujemy więc UŁAMKIEM obszaru roboczego, nie
   współrzędną. Współrzędna jest prawdziwa tylko na tym monitorze, na
   którym powstała: przeniesiona na laptopa wypada poza pulpit, a wracając
   z laptopa na duży monitor zbija wszystkie kartki w lewy górny róg.
   Ułamek przenosi układ, który ktoś ułożył — plan dnia po lewej, numer
   telefonu pod nim — na każdy ekran, jaki akurat jest.

   Zapamiętujemy też SKALĘ ekranu, na którym kartkę ostatnio widziano.
   Bez niej kartka rozciągnięta ręcznie na dużym monitorze wracałaby na
   laptopa w tych samych pikselach i zasłaniała pół pulpitu. */

/** Ułamek obszaru roboczego, w którym stoi lewy górny róg kartki. */
function cardSpot(bounds) {
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  });
  return {
    rx: (bounds.x - workArea.x) / Math.max(1, workArea.width),
    ry: (bounds.y - workArea.y) / Math.max(1, workArea.height),
  };
}

/** Ten sam ułamek przełożony na konkretny ekran, przycięty do jego brzegów. */
function placeOn(workArea, spot, size) {
  return {
    x: Math.round(
      clamp(
        workArea.x + spot.rx * workArea.width,
        workArea.x,
        Math.max(workArea.x, workArea.x + workArea.width - size.width),
      ),
    ),
    y: Math.round(
      clamp(
        workArea.y + spot.ry * workArea.height,
        workArea.y,
        Math.max(workArea.y, workArea.y + workArea.height - size.height),
      ),
    ),
    ...size,
  };
}

/** Skala właściwa dla ekranu, na którym kartka faktycznie wylądowała. */
function deckScaleAt(bounds) {
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  });
  return deckScale(workArea);
}

/**
 * Miejsce dla jednej kartki na WSKAZANYM ekranie.
 *
 * @param {string} id        identyfikator notatki
 * @param {object} fallback  miejsce z talii, gdy kartki jeszcze nikt nie ruszał
 * @param {object} workArea  obszar roboczy ekranu, na którym stoi znaczek
 */
function deckPlace(id, fallback, workArea) {
  const saved = store.getSettings().widget?.cards?.[id];
  if (!saved) return fallback;

  /* Zapisy sprzed tej zmiany mają same współrzędne. Ułamek liczymy z nich
     względem ekranu, na którym wtedy leżały — a jeśli tego ekranu już nie
     ma, getDisplayNearestPoint wskaże najbliższy istniejący i wyjdzie
     miejsce sensowne, a nie zero. */
  const spot =
    Number.isFinite(saved.rx) && Number.isFinite(saved.ry)
      ? { rx: saved.rx, ry: saved.ry }
      : Number.isFinite(saved.x) && Number.isFinite(saved.y)
        ? cardSpot({
            x: saved.x,
            y: saved.y,
            width: saved.width ?? fallback.width,
            height: saved.height ?? fallback.height,
          })
        : null;
  if (!spot) return fallback;

  /* Rozmiar przeliczamy z ekranu na ekran tak samo jak retuneCard: aureola
     jest stała w pikselach, więc rośnie samo wnętrze kartki. */
  const was = Number.isFinite(saved.scale) ? saved.scale : deckScale(workArea);
  const k = deckScale(workArea) / (was || 1);
  const size = {
    width: clamp(
      Math.round((Math.round(saved.width ?? fallback.width) - STICKY_HALO * 2) * k) + STICKY_HALO * 2,
      STICKY_MIN.width,
      STICKY_MAX.width,
    ),
    height: clamp(
      Math.round((Math.round(saved.height ?? fallback.height) - STICKY_HALO * 2) * k) + STICKY_HALO * 2,
      STICKY_MIN.height,
      STICKY_MAX.height,
    ),
  };

  return placeOn(workArea, spot, size);
}

function rememberCard(id, win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const { x, y, width, height } = bounds;
  store.saveSettings({
    widget: {
      cards: {
        // Współrzędne zostają obok ułamka: po nich poznaje się, że kartka
        // wróciła w to samo miejsce na tym samym ekranie, i po nich czyta
        // się ten plik ludzkim okiem.
        [id]: { x, y, width, height, ...cardSpot(bounds), scale: deckScaleAt(bounds) },
      },
    },
  });
}

/**
 * Tytuł notatki tak, jak widzi go lista: pierwsza niepusta linia, bez
 * znaczników Markdownu.
 *
 * Powtórzenie tego, co robi titleOf w renderer/js/notes-core.js — i to
 * jest świadome. Tamten plik należy do przeglądarki (woła t(), uiLocale()
 * i pół okna wokół), a tutaj potrzebne jest jedno zdanie do nazwy pliku
 * i tytułu strony w Notion. Wspólny plik dla tych dwóch linijek kosztowałby
 * więcej, niż jest wart.
 */
function noteTitle(note) {
  const plain = (line) =>
    String(line ?? "")
      .replace(/^\s*(#{1,6}\s+|[-*]\s+\[[ xX]\]\s+|[-*]\s+|>\s?|\d+\.\s+)/, "")
      .replace(/^[\u25B8\u25BE]\s*/, "")
      .replace(/[*_`]/g, "")
      .trim();

  const first = String(note?.text ?? "")
    .split("\n")
    .map(plain)
    .find((line) => line && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(line));
  return first ? first.slice(0, 60) : "Notatka";
}

/* Zakładka Notion po notatce, której już nie ma. Ta sama sprawa co
   forgetCard niżej: zapis ustawień scala gałęzie, więc klucz zdejmujemy
   wprost i prosimy o sam zapis. */
function forgetNotionPage(id) {
  const pages = store.getSettings().notion?.pages;
  if (!pages || !(id in pages)) return;
  delete pages[id];
  store.saveSettings({});
}

/* Miejsce po notatce, której już nie ma na wierzchu. Zapis ustawień scala
   gałęzie, więc skasowania klucza nie da się przez niego przemycić —
   zdejmujemy go wprost i prosimy o sam zapis. */
function forgetCard(id) {
  const cards = store.getSettings().widget?.cards;
  if (!cards || !(id in cards)) return;
  delete cards[id];
  store.saveSettings({});
}

/**
 * Kartka przeciągnięta na inny monitor.
 *
 * Ekrany różnią się nie tylko liczbą pikseli, ale i tym, ile pikseli
 * przypada na centymetr — kartka przeniesiona z laptopa na duży monitor
 * zostałaby w tych samych pikselach i zrobiłaby się znaczkiem. Rośnie więc
 * razem z ekranem, trzymając się lewego górnego rogu, żeby nie uciekła
 * spod kursora, którym się ją właśnie odłożyło.
 */
/**
 * Skala przyjęta do wiadomości, bez ruszania rozmiaru.
 *
 * Kartka postawiona przez deckPlace ma rozmiar już przeliczony pod ekran,
 * na który trafiła. Puszczenie po niej retuneCard przeliczyłoby go DRUGI
 * RAZ — kartka rosła wtedy z każdym otwarciem talii na większym monitorze.
 */
function settleScale(win) {
  if (!win || win.isDestroyed()) return;
  const scale = deckScaleAt(win.getBounds());
  win.deckScale = scale;
  win.webContents.send("sticky:scale", scale);
}

function retuneCard(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const scale = deckScaleAt(bounds);
  const was = win.deckScale ?? scale;
  if (scale === was) return;
  win.deckScale = scale;

  /* Rozmiar PRZELICZAMY, a nie ustawiamy od nowa. Kartka rozciągnięta ręcznie
     ma zostać tą samą kartką po przeniesieniu na drugi monitor — powrót do
     rozmiaru domyślnego kasowałby decyzję, którą ktoś właśnie podjął. Aureola
     jest stała w pikselach, więc przeliczamy samo wnętrze. */
  const k = scale / was;
  const size = {
    width: clamp(
      Math.round((bounds.width - STICKY_HALO * 2) * k) + STICKY_HALO * 2,
      STICKY_MIN.width,
      STICKY_MAX.width,
    ),
    height: clamp(
      Math.round((bounds.height - STICKY_HALO * 2) * k) + STICKY_HALO * 2,
      STICKY_MIN.height,
      STICKY_MAX.height,
    ),
  };
  win.setBounds({ x: bounds.x, y: bounds.y, ...size });
  win.webContents.send("sticky:scale", scale);
}

function createStickyWindow(note, bounds) {
  const win = new BrowserWindow({
    ...bounds,
    minWidth: STICKY_MIN.width,
    minHeight: STICKY_MIN.height,
    maxWidth: STICKY_MAX.width,
    maxHeight: STICKY_MAX.height,
    show: false,
    frame: false,
    // Okno jest przezroczyste, ale KARTKA W NIM NIE JEST — przezroczysta
    // notatka na cudzym tle jest nieczytelna, a tło pulpitu zmienia się
    // pod nią co ekran. Przezroczysty jest wyłącznie margines, w którym
    // kartka rysuje sobie cień i z którego wychodzi przy rozwijaniu.
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Kartka jest do pisania, więc musi umieć wziąć fokus — ale bierze go
    // dopiero po kliknięciu, tak samo jak znaczek. Talia wychodzi na
    // pulpit przez showInactive i nie rusza tego, w czym ktoś pisze.
    focusable: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    /* ══ KARTKA JEST NAD WSZYSTKIM, DOPÓKI SIĘ JEJ NIE SCHOWA ══

       Wcześniej było odwrotnie: kartka leżała na pulpicie jak karteczka
       przyklejona do biurka i kliknięcie w cudze okno przykrywało ją tak
       samo, jak przykryłoby każdą inną. Brzmiało to uczciwie, a w pracy
       znaczyło, że notatka odłożona na wierzch znikała przy pierwszym
       przełączeniu okna — czyli dokładnie wtedy, gdy zaczynała być
       potrzebna. Plan dnia, numer i zdanie do zapamiętania odkłada się na
       wierzch po to, żeby były widoczne PRZY pracy w czymś innym.

       Kartki zostają więc na wierzchu i schodzą z niego tylko na wyraźny
       gest — kliknięcie w znaczek albo Escape. Nic innego ich nie zdejmuje:
       ani kliknięcie w cudze okno, ani przełączenie pulpitu. Talia jest
       widoczna albo jej nie ma, a o tym, które z dwojga, decyduje człowiek.

       Znaczek stoi warstwę wyżej (patrz createWidget) — inaczej kartka
       przeciągnięta na niego przykryłaby jedyną rzecz, którą się ją
       chowa. */
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  /* „Na wierzchu" ma znaczyć na wierzchu wszędzie: także na drugim pulpicie
     i nad cudzym oknem rozwiniętym na pełny ekran. Kartka, która gubi się
     przy przełączeniu przestrzeni, wraca do bycia oknem, którego trzeba
     szukać — a wtedy równie dobrze mogłaby być zwykłą notatką w Notatniku.
     Poziom „floating" jest o warstwę niżej niż znaczek, patrz createWidget. */
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.deckScale = deckScaleAt(bounds);
  win.loadFile(path.join(__dirname, "..", "renderer", "sticky.html"), {
    query: { note: note.id, scale: String(win.deckScale) },
  });

  // Przesunięta i przeskalowana kartka ma tam zostać — także po ponownym
  // uruchomieniu. Zapisujemy po zdarzeniu końcowym, nie w trakcie ruchu:
  // „moved" i „resized" przychodzą raz, „move" i „resize" co klatkę.
  win.on("moved", () => {
    retuneCard(win);
    rememberCard(note.id, win);
  });
  win.on("resized", () => {
    rememberCard(note.id, win);
    win.webContents.send("sticky:scale", deckScaleAt(win.getBounds()));
  });
  win.on("closed", () => stickyWindows.delete(note.id));

  stickyWindows.set(note.id, win);
  return win;
}

/**
 * Rozłożenie talii. Kartki wychodzą jedna po drugiej — kolejność jest
 * kolejnością listy, więc przypięte pokazują się pierwsze.
 *
 * Animację dostają WYŁĄCZNIE kartki, które właśnie wychodzą. Ta sama
 * funkcja dokłada bowiem kartkę do talii już leżącej na pulpicie (patrz
 * syncDeck) — a notatka odłożona na wierzch nie jest powodem, żeby wszystko
 * inne mrugnęło i ułożyło się od nowa.
 */
function openDeck() {
  const notes = deckNotes();
  if (!notes.length) {
    deckOpen = false;
    tellDeck();
    return false;
  }

  const gen = ++deckGen;
  deckOpen = true;

  const { workArea } = screen.getDisplayNearestPoint(widgetAnchor());
  const spots = deckSpots(notes.length, workArea);
  let shown = 0;

  notes.forEach((note, index) => {
    let win = stickyWindows.get(note.id);
    if (win && !win.isDestroyed() && win.isVisible()) return;

    const bounds = deckPlace(note.id, spots[index], workArea);
    if (!win || win.isDestroyed()) {
      win = createStickyWindow(note, bounds);
    } else {
      // Kartka schowana na jednym ekranie bywa wykładana na innym: monitor
      // odłączono, znaczek przeciągnięto. Rozmiar policzył już deckPlace —
      // tutaj zostaje przyjąć skalę do wiadomości (patrz settleScale).
      win.setBounds(bounds);
      settleScale(win);
    }

    const delay = shown++ * STICKY_STEP;
    const fold = () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      win.webContents.send("sticky:fold", { dir: "out", delay, gen });
    };
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", fold);
    else fold();
  });

  tellDeck();
  return true;
}

/**
 * Schowanie talii. Okien nie zamykamy — kartka ma wrócić w to samo miejsce
 * i z tym samym przewinięciem. Znikają dopiero wtedy, gdy zwiną się na
 * ekranie; inaczej talia gasłaby w jednej klatce, a wychodziła płynnie.
 */
function hideDeck() {
  const gen = ++deckGen;
  deckOpen = false;
  tellDeck();
  const windows = [...stickyWindows.values()].filter((win) => !win.isDestroyed() && win.isVisible());

  windows.forEach((win, index) => {
    // Chowa się w odwrotnej kolejności — ostatnia wyłożona idzie pierwsza.
    const delay = (windows.length - 1 - index) * STICKY_STEP;
    win.webContents.send("sticky:fold", { dir: "in", delay, gen });
  });

  // Bezpiecznik na okno, które nie odpowie (przeładowanie, zawieszony
  // renderer): po czasie całej animacji chowamy resztę bez pytania.
  const wait = windows.length * STICKY_STEP + 420;
  setTimeout(() => {
    if (deckGen !== gen) return;
    for (const win of stickyWindows.values()) if (!win.isDestroyed()) win.hide();
  }, wait);

  return false;
}

const toggleDeck = () => (deckOpen ? hideDeck() : openDeck());

/** Talia znika na dobre — przy wyłączeniu widgetu albo zmianie widoku. */
function closeDeck() {
  deckGen += 1;
  deckOpen = false;
  for (const win of stickyWindows.values()) if (!win.isDestroyed()) win.destroy();
  stickyWindows.clear();
  tellDeck();
}

/**
 * Escape zdejmuje kartki z wierzchu — także wtedy, gdy nikt nie patrzy
 * w okno Cribro.
 *
 * Kartki leżą nad cudzą pracą, więc muszą dać się zdjąć stamtąd, gdzie się
 * właśnie pracuje: bez szukania znaczka i bez sięgania po mysz. To jest ta
 * druga połowa umowy o Escape — pierwszą, tę wewnątrz naszych okien,
 * obsługuje każde okno u siebie (patrz „Escape" w renderer/js/*.js).
 *
 * WARUNEK JEST JEDEN i pilnuje granicy między tymi połowami: robimy to
 * tylko wtedy, gdy fokusu nie ma żadne nasze okno. Inaczej Escape w kartce
 * albo w Notatniku zdejmowałby dwie warstwy naraz — swoją i talię.
 *
 * Drogę do tego klawisza daje uiohook, czyli zgoda „Dostępność" (patrz
 * onEscape w main/hotkeys.js). Bez niej Escape działa w oknach Cribro
 * i tyle; zabranie go całemu systemowi na stałe zamykałoby cudze okna
 * dialogowe zamiast naszych kartek.
 */
function escapeElsewhere() {
  if (!deckOpen) return;
  if (BrowserWindow.getFocusedWindow()) return;
  hideDeck();
}

/**
 * Talia po zmianie układu ekranów.
 *
 * Monitor można odłączyć w każdej chwili, także wtedy, gdy leżą na nim
 * notatki. Kartka zostaje wtedy w tych samych współrzędnych — tyle że tych
 * współrzędnych nie ma już na żadnym ekranie i notatka po prostu znika,
 * choć aplikacja twierdzi, że jest na wierzchu. Wracamy więc każdą, która
 * wypadła poza pulpit, i dopasowujemy ją do ekranu, na który wróciła.
 */
function reflowDeck() {
  if (!stickyWindows.size) return;
  const home = screen.getDisplayNearestPoint(widgetAnchor());
  const spots = deckSpots(stickyWindows.size, home.workArea);

  [...stickyWindows].forEach(([id, win], index) => {
    if (win.isDestroyed()) return;

    // Kartka już na ekranie znaczka zostaje dokładnie tam, gdzie leży.
    // Przekładanie jej „na to samo miejsce" byłoby drgnięciem bez powodu.
    const bounds = win.getBounds();
    const on = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    });
    const stray =
      on.id !== home.id ||
      bounds.x + bounds.width / 2 < home.workArea.x ||
      bounds.x + bounds.width / 2 > home.workArea.x + home.workArea.width ||
      bounds.y + bounds.height / 2 < home.workArea.y ||
      bounds.y + bounds.height / 2 > home.workArea.y + home.workArea.height;

    if (stray) {
      // Rozmiar policzył już deckPlace pod ekran znaczka — zostaje przyjąć
      // skalę do wiadomości, bez drugiego przeliczania (patrz settleScale).
      win.setBounds(deckPlace(id, spots[index], home.workArea));
      settleScale(win);
    } else {
      retuneCard(win);
    }
    // Ustawienie z kodu nie wywołuje „moved", więc zapisujemy sami —
    // inaczej po restarcie kartka wróciłaby na nieistniejący monitor.
    rememberCard(id, win);
  });
}

/**
 * Talia po zmianie w notatkach: notatka zdjęta z wierzchu (albo skasowana)
 * zabiera swoją kartkę, notatka odłożona na wierzch dostaje własną — bez
 * ruszania tych, które już leżą.
 */
function syncDeck() {
  if (!deckOpen) return;
  const notes = deckNotes();
  const live = new Set(notes.map((note) => note.id));

  for (const [id, win] of [...stickyWindows]) {
    if (live.has(id)) continue;
    if (!win.isDestroyed()) win.destroy();
    stickyWindows.delete(id);
  }

  if (!notes.length) {
    deckOpen = false;
    tellDeck();
    return;
  }
  if (notes.some((note) => !stickyWindows.get(note.id)?.isVisible())) openDeck();
}


function createTray() {
  tray = new Tray(trayIcon("idle"));
  tray.setToolTip(TRAY_TOOLTIP.idle);
  // Dwuklik w znaczek to dla systemu osobne zdarzenie. Bez tego drugie
  // kliknięcie zamyka dopiero co rozwinięte menu i wygląda na zacięcie.
  tray.setIgnoreDoubleClickEvents(true);
  refreshTrayMenu();
  // Kliknięcie w znaczek rozwija menu i nic poza tym — menu robi to samo,
  // co robił własny listener „click", tylko bez zaskoczenia. Cribro jest
  // aplikacją paska menu: po znaczek sięga się po gęstość sita, język albo
  // szybką notatkę, a otwarcie całego okna to jedna z pozycji tego menu
  // („Otwórz Cribro Sift"), nie skutek uboczny sięgnięcia po resztę.
}

/** Lista języków do wyboru w pasku menu — nazwy w języku interfejsu. */
function languageRadios(settings, language, field, apply) {
  const key = settings.uiLanguage === "en" ? "en" : "pl";
  return Object.entries(LANGUAGES).map(([code, meta]) => ({
    label: meta[key],
    type: "radio",
    checked: language[field] === code,
    click: () => apply({ [field]: code }),
  }));
}

/**
 * Główne menu aplikacji.
 *
 * Tu mieszka wszystko, co otwiera okno: Notatnik, Przesiane, Ustawienia.
 * Taca widgetu jest od czynności, które robi się w biegu — otwieranie okien
 * zabierałoby na niej miejsce dokładnie tym rzeczom, dla których powstała,
 * a menu i tak jest zawsze pod ręką, z klawiszami skrótu.
 */
function buildAppMenu() {
  const settings = store.getSettings();
  const t = translator(settings.uiLanguage);
  const go = (view) => () => createMainWindow().webContents.send("view:go", view);
  const name = "Cribro Sift";

  const template = [
    {
      label: name,
      submenu: [
        { role: "about", label: `${t("O programie")} ${name}` },
        { type: "separator" },
        { label: `${t("Ustawienia")}…`, accelerator: "Command+,", click: go("settings") },
        { type: "separator" },
        { role: "services", label: t("Usługi") },
        { type: "separator" },
        { role: "hide", label: `${t("Ukryj")} ${name}` },
        { role: "hideOthers", label: t("Ukryj pozostałe") },
        { role: "unhide", label: t("Pokaż wszystko") },
        { type: "separator" },
        { role: "quit", label: t("Zakończ") },
      ],
    },
    {
      label: t("Plik"),
      submenu: [
        { label: t("Nowa notatka"), accelerator: "Command+N", click: () => newNoteCommand() },
        { label: t("Szybka notatka"), accelerator: "Command+Shift+N", click: () => quickNote() },
        /* Bez klawiszy w menu i to nie jest przeoczenie: zrzut robi się,
           patrząc na CUDZE okno, a skrót z menu działa tylko wtedy, gdy
           z przodu jest Cribro. Klawisze, które działają zawsze, ustawia
           się w Ustawieniach (patrz bindShotHotkey). */
        { label: `${t("Tekst z ekranu")}…`, click: () => grabScreenText() },
        { type: "separator" },
        { label: t("Notatnik"), accelerator: "Command+Shift+O", click: () => createNotesWindow() },
        { type: "separator" },
        {
          label: t("Dyktuj"),
          accelerator: "Command+D",
          click: () => toggleCapture("menu"),
        },
        { type: "separator" },
        { role: "close", label: t("Zamknij okno") },
      ],
    },
    {
      label: t("Edycja"),
      submenu: [
        { role: "undo", label: t("Cofnij") },
        { role: "redo", label: t("Ponów") },
        { type: "separator" },
        { role: "cut", label: t("Wytnij") },
        { role: "copy", label: t("Kopiuj") },
        { role: "paste", label: t("Wklej") },
        { role: "pasteAndMatchStyle", label: t("Wklej jako zwykły tekst") },
        { role: "delete", label: t("Usuń") },
        { role: "selectAll", label: t("Zaznacz wszystko") },
        { type: "separator" },
        {
          label: t("Sprawdzaj pisownię"),
          type: "checkbox",
          checked: settings.spellcheck?.enabled !== false,
          click: (item) => saveSpellcheck({ enabled: item.checked }),
        },
      ],
    },
    {
      label: t("Widok"),
      submenu: [
        { label: t("Start"), accelerator: "Command+1", click: go("start") },
        { label: t("Przesiane"), accelerator: "Command+2", click: go("sifted") },
        { label: t("Notatki"), accelerator: "Command+3", click: go("notes") },
        { label: t("Sito"), accelerator: "Command+4", click: go("sieve") },
        { label: t("Ziarna"), accelerator: "Command+5", click: go("grains") },
        { label: t("Ustawienia"), accelerator: "Command+6", click: go("settings") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("Pełny ekran") },
      ],
    },
    {
      label: t("Okno"),
      submenu: [
        { role: "minimize", label: t("Zminimalizuj") },
        { role: "zoom", label: t("Powiększ") },
        { type: "separator" },
        { label: t("Otwórz Cribro Sift"), click: () => createMainWindow() },
        /* Przewodnik jest w oknie (przycisk na dole paska), ale kto go
           zamknął i nie pamięta gdzie, szuka go w menu — i tam też ma być. */
        { label: t("Przewodnik"), click: () => go("guide")() },
        { role: "front", label: t("Ustaw wszystko na wierzchu") },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function refreshMenus() {
  buildAppMenu();
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const settings = store.getSettings();
  const t = translator(settings.uiLanguage);
  const language = normalizeLanguage(settings.language);

  const setLanguage = (patch) => {
    store.saveSettings({ language: { ...language, ...patch } });
    broadcast("settings:changed", store.getSettings());
    refreshMenus();
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("Otwórz Cribro Sift"), click: () => createMainWindow() },
      { label: t("Przesiane"), click: () => createMainWindow().webContents.send("view:go", "sifted") },
      { label: t("Notatnik"), click: () => createNotesWindow() },
      { label: t("Szybka notatka"), click: () => quickNote() },
      { label: `${t("Tekst z ekranu")}…`, click: () => grabScreenText() },
      { label: t("Ustawienia"), click: () => createMainWindow().webContents.send("view:go", "settings") },
      { type: "separator" },
      {
        label: t("Gęstość sita"),
        submenu: Object.entries(MESH).map(([key, mesh]) => ({
          label: `${t(mesh.name)} — ${t(mesh.hint)}`,
          type: "radio",
          checked: settings.mesh === key,
          click: () => {
            store.saveSettings({ mesh: key });
            broadcast("settings:changed", store.getSettings());
            refreshMenus();
          },
        })),
      },
      {
        // Tryb rozpoznawania jest tu, a nie tylko w Ustawieniach, bo zmienia
        // się go w trakcie rozmowy — dokładnie wtedy, gdy okno jest schowane.
        label: `${t("Język dyktowania")} — ${shortLabel(language)}`,
        submenu: [
          {
            label: t("Dwujęzycznie — dwa języki naraz"),
            type: "radio",
            checked: language.mode === "bilingual",
            click: () => setLanguage({ mode: "bilingual" }),
          },
          {
            label: t("Jeden język"),
            type: "radio",
            checked: language.mode === "single",
            click: () => setLanguage({ mode: "single" }),
          },
          {
            label: t("Rozpoznaj automatycznie"),
            type: "radio",
            checked: language.mode === "auto",
            click: () => setLanguage({ mode: "auto" }),
          },
          { type: "separator" },
          {
            label: t("Pierwszy język"),
            submenu: languageRadios(settings, language, "primary", setLanguage),
          },
          {
            label: t("Drugi język"),
            enabled: language.mode === "bilingual",
            submenu: languageRadios(settings, language, "secondary", setLanguage),
          },
        ],
      },
      {
        label: t("Wklejaj automatycznie"),
        type: "checkbox",
        checked: settings.autoPaste,
        click: (item) => {
          store.saveSettings({ autoPaste: item.checked });
          broadcast("settings:changed", store.getSettings());
        },
      },
      { type: "separator" },
      { label: t("Zakończ"), role: "quit" },
    ]),
  );
}


/* ── Pisownia ─────────────────────────────────────────────────── */

/**
 * Sprawdzanie pisowni w notatkach.
 *
 * Dwa różne mechanizmy pod jednym przełącznikiem — i to jest cała trudność:
 *
 *   macOS       sprawdza system. Rozpoznaje język sam, ma własny słownik
 *               nauczonych słów wspólny z resztą aplikacji i nie przyjmuje
 *               listy języków z zewnątrz (setSpellCheckerLanguages jest tam
 *               pustym wywołaniem). Dlatego na macOS nie pokazujemy wyboru
 *               języków — pokazywanie pokrętła, które nic nie robi, jest
 *               gorsze niż jego brak.
 *
 *   Windows,    sprawdza Chromium i musi dostać języki wprost. Bierzemy je
 *   Linux       z ustawień dyktowania, bo to ten sam człowiek i te same
 *               dwa języki: kto dyktuje po polsku z angielskimi wtrąceniami,
 *               ten tak samo pisze.
 *
 * Podkreślenie to jedno, a poprawka to drugie: bez menu pod prawym
 * przyciskiem czerwona fala mówi „jest błąd" i nie daje nic zrobić.
 * Menu buduje attachContextMenu poniżej.
 */

/* Kody dyktowania (languages.js) na kody Chromium. Kolejność w tablicy to
   kolejność prób — pierwszy wariant obecny w systemie wygrywa. */
const SPELL_CODES = {
  pl: ["pl-PL", "pl"],
  en: ["en-US", "en-GB", "en"],
  de: ["de-DE", "de"],
  fr: ["fr-FR", "fr"],
  es: ["es-ES", "es"],
  it: ["it-IT", "it"],
  uk: ["uk-UA", "uk"],
  cs: ["cs-CZ", "cs"],
};

/** Języki sprawdzania: albo z dyktowania, albo wybrane ręcznie. */
function spellLanguages(settings) {
  const spell = settings.spellcheck ?? {};
  const language = normalizeLanguage(settings.language);

  const wanted =
    spell.followDictation === false
      ? spell.languages ?? []
      : [language.primary, ...(language.mode === "bilingual" ? [language.secondary] : [])];

  const available = session.defaultSession.availableSpellCheckerLanguages ?? [];
  const codes = [];
  for (const code of wanted) {
    const hit = (SPELL_CODES[code] ?? [code]).find((variant) => available.includes(variant));
    if (hit && !codes.includes(hit)) codes.push(hit);
  }
  return codes;
}

function applySpellcheck(settings) {
  const enabled = settings.spellcheck?.enabled !== false;
  try {
    session.defaultSession.setSpellCheckerEnabled(enabled);
    if (enabled && process.platform !== "darwin") {
      const codes = spellLanguages(settings);
      if (codes.length) session.defaultSession.setSpellCheckerLanguages(codes);
    }
  } catch (error) {
    // Sprawdzanie pisowni jest wygodą, nie warunkiem działania aplikacji.
    console.warn("Pisownia:", error.message);
  }
}

/**
 * Menu pod prawym przyciskiem.
 *
 * Aplikacja nie miała żadnego, więc prawy przycisk w notatce nie robił nic —
 * łącznie z poprawieniem słowa, które sam system podkreślił. Menu jest
 * wspólne dla wszystkich okien i pokazuje wyłącznie to, co w danym miejscu
 * ma sens: podpowiedzi tylko nad błędem, wklejanie tylko w polu do pisania.
 */
function attachContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const t = translator(store.getSettings().uiLanguage);
    const items = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
        items.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
      }
      if (!params.dictionarySuggestions.length) {
        items.push({ label: t("Brak podpowiedzi"), enabled: false });
      }
      items.push({ type: "separator" });
      items.push({
        label: t("Naucz się tego słowa"),
        click: () =>
          win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: "separator" });
    }

    if (params.isEditable) {
      items.push({ role: "undo", label: t("Cofnij") });
      items.push({ role: "redo", label: t("Ponów") });
      items.push({ type: "separator" });
    }
    if (params.isEditable && params.selectionText) items.push({ role: "cut", label: t("Wytnij") });
    if (params.selectionText) items.push({ role: "copy", label: t("Kopiuj") });
    if (params.isEditable) {
      items.push({ role: "pasteAndMatchStyle", label: t("Wklej") });
      items.push({ role: "selectAll", label: t("Zaznacz wszystko") });
    }

    // Nad zwykłym tekstem, bez zaznaczenia i bez pola, nie ma czego pokazać.
    if (!items.length) return;

    if (params.isEditable) {
      items.push({ type: "separator" });
      items.push({
        label: t("Sprawdzaj pisownię"),
        type: "checkbox",
        checked: store.getSettings().spellcheck?.enabled !== false,
        click: (item) => saveSpellcheck({ enabled: item.checked }),
      });
    }

    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

/** Jedna droga do zmiany ustawień pisowni — z menu i z Ustawień. */
function saveSpellcheck(patch) {
  const settings = store.saveSettings({ spellcheck: patch });
  applySpellcheck(settings);
  broadcast("settings:changed", settings);
  return settings;
}

/* ── Chmura ───────────────────────────────────────────────────── */

/* Jeden przebieg naraz. Dwa równoległe robiłyby ten sam ruch dwa razy
   i mogłyby nadpisać sobie kursor. */
let syncing = false;
let syncTimer = null;
let syncEvery = null;

/* Trwające logowanie przez Google. Jedno naraz: dwa otwarte okna
   przeglądarki to dwa kody i dwie sesje, z których jedna od razu jest
   martwa — a człowiek widzi dwie karty i nie wie, w której klikać. */
let oauthPending = null;

function cloudState(extra = {}) {
  const settings = store.getSettings().cloud ?? {};
  const state = store.getCloudState();
  return {
    ...cloud.snapshot(),
    enabled: !!settings.enabled,
    autoSync: settings.autoSync !== false,
    lastSyncAt: state.lastSyncAt,
    syncing,
    // Czekanie na przeglądarkę jest stanem, który widać w oknie aplikacji:
    // bez tego okno wygląda tak, jakby kliknięcie nic nie zrobiło.
    waitingFor: oauthPending?.provider ?? null,
    ...extra,
  };
}

/** Adresy powrotne do wpisania w panelu Supabase — pokazuje je karta konta. */
const oauthRedirects = () => OAUTH_PORTS.map((port) => `http://127.0.0.1:${port}${OAUTH_CALLBACK}`);

function cloudChanged(extra) {
  broadcast("cloud:changed", cloudState(extra));
}

/**
 * Przebieg synchronizacji. Błąd wraca do interfejsu i tam zostaje na
 * ekranie — cicha porażka synchronizacji jest gorsza od jej braku, bo
 * wygląda jak kopia zapasowa, której nie ma.
 */
async function runSync({ force = false } = {}) {
  const settings = store.getSettings();
  // Przycisk „Synchronizuj teraz" pomija zegar, ale nie pomija zamka:
  // dwa przebiegi naraz nadpisałyby sobie kursor.
  if (syncing) return null;
  if (!force && !settings.cloud?.enabled) return null;
  if (!cloud.signedIn) throw new Error("Nie jesteś zalogowany.");

  syncing = true;
  cloudChanged();
  try {
    const report = await syncNotes({ client: cloud, store });
    // Notatki mogły przyjechać z drugiego komputera — każde otwarte okno
    // ma je pokazać, nie dopiero po ponownym otwarciu.
    if (report.taken) broadcast("note:changed", { id: null, synced: true });
    cloudChanged({ error: null });
    return report;
  } catch (error) {
    cloudChanged({ error: String(error.message || error) });
    throw error;
  } finally {
    syncing = false;
    cloudChanged();
  }
}

/** Zmiana w notatce nie jedzie od razu — pisanie to seria zmian. */
function scheduleSync(delay = 5000) {
  const settings = store.getSettings();
  if (!settings.cloud?.enabled || settings.cloud.autoSync === false || !cloud.signedIn) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync().catch(() => {}), delay);
}

/** Zegar na zmiany z drugiego urządzenia — te same nie zapukają. */
function watchCloud() {
  clearInterval(syncEvery);
  const settings = store.getSettings();
  if (!settings.cloud?.enabled || settings.cloud.autoSync === false) return;
  syncEvery = setInterval(() => runSync().catch(() => {}), 5 * 60 * 1000);
  scheduleSync(1500);
}

/* ── Stan ─────────────────────────────────────────────────────── */

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/* Ta sama notatka bywa otwarta w kilku oknach naraz. Okno, które właśnie
   pisze, wie o zmianie z pierwszej ręki — wiadomość jest dla pozostałych. */
function broadcastExcept(sender, channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents !== sender) win.webContents.send(channel, payload);
  }
}

/** Nagrywanie z przycisku, z menu albo z widgetu — jeden tor dla wszystkich. */
async function toggleCapture(trigger) {
  if (state === "idle") {
    await startCapture({ trigger });
    return "listening";
  }
  if (state === "listening") {
    stopCapture();
    return "sifting";
  }
  return state;
}

function setState(next, detail = {}) {
  state = next;
  if (tray) {
    tray.setImage(trayIcon(TRAY_ICON[next] ? next : "idle"));
    tray.setToolTip(TRAY_TOOLTIP[next] ?? TRAY_TOOLTIP.idle);
  }
  broadcast("state", { state: next, ...detail });

  if (next === "idle") {
    hotkeys?.release();
    // Puste nagranie ma jeszcze coś do powiedzenia — smutna mina w HUD-zie
    // (patrz nothingHeard). Stan wraca do „idle" od razu, żeby powtórzenie
    // dyktowania nie musiało czekać na koniec komunikatu; chowamy więc samo
    // okno, z opóźnieniem, i tylko wtedy, gdy nikt w międzyczasie nie mówi.
    // Zapas ponad czas komunikatu: pigułka najpierw gaśnie u siebie
    // (EMPTY_MS w js/hud.js), a dopiero potem znika okno pod nią. Bez tego
    // okno zabrałoby własne zanikanie w połowie.
    if (detail.empty) setTimeout(() => state === "idle" && hud?.hide(), NOTHING_HEARD_MS + 400);
    else hud?.hide();
  } else if (hud && !hud.isVisible()) {
    hud.showInactive(); // nigdy .show() — fokus musi zostać tam, gdzie jest kursor
  }
}

/* ── Ścieżka: głos → tekst → schowek ──────────────────────────── */

/**
 * Nagranie, z którego nic nie wyszło — cisza, szum albo muśnięcie klawiszy.
 *
 * To nie jest awaria i nie ma tak wyglądać. Czerwony pasek „Nie udało się —
 * etap: transkrypcja" mówi, że coś się zepsuło, a nie zepsuło się nic:
 * mikrofon działał, sito działało, po prostu nie było czego przesiać.
 * Stąd smutna mina i jedno zdanie zamiast komunikatu o błędzie.
 *
 * Zdanie jest jedno dla wszystkich takich przypadków — z punktu widzenia
 * mówiącego nie ma różnicy między „za krótko" a „za cicho": w obie strony
 * znaczy to samo i w obie strony robi się to samo, czyli mówi jeszcze raz.
 */
const NOTHING_HEARD = "Nie mogę pomóc, bo nic nie usłyszałem";
const NOTHING_HEARD_MS = 2800;

function nothingHeard(stage = "transkrypcja") {
  broadcast("pipeline:error", { stage, empty: true, message: NOTHING_HEARD });
  setState("idle", { empty: true });
}

async function startCapture(meta) {
  if (state !== "idle") return;
  pendingContext = {
    app: await frontmostApp(),
    startedAt: Date.now(),
    trigger: meta.trigger,
    // Gdy dyktowanie ruszyło z okna notatki, tekst ma trafić do niej,
    // a nie pod kursor w aplikacji, która akurat była na wierzchu.
    note: meta.note ?? null,
  };
  setState("listening", { trigger: meta.trigger });
  if (meta.trigger !== "hold" && meta.trigger !== "hands-off") hotkeys?.adopt();
  // Pigułka HUD-a mówi przez trzy sekundy „słucham", a potem chowa się
  // w znaczku widgetu — ale tylko wtedy, gdy widget jest na ekranie.
  // Bez niego nie ma dokąd, więc HUD zostaje sam jako małe kółko.
  hud?.webContents.send("rec:start", {
    trigger: meta.trigger,
    handoff: !!(widget && !widget.isDestroyed() && widget.isVisible()),
  });
  hotkeys?.armCancelKey();
}

function stopCapture() {
  if (state !== "listening") return;
  hotkeys?.disarmCancelKey();
  setState("sifting");
  hud?.webContents.send("rec:stop");
}

function cancelCapture() {
  if (state === "idle") return;
  hotkeys?.disarmCancelKey();
  hud?.webContents.send("rec:cancel");
  widget?.webContents.send("widget:level", 0);
  pendingContext = null;
  setState("idle", { cancelled: true });
}

async function runPipeline(audioBuffer, durationMs) {
  const settings = store.getSettings();
  const context = pendingContext ?? { app: null, startedAt: Date.now() };
  pendingContext = null;

  // Etap trzymamy osobno, żeby komunikat mówił, co konkretnie zawiodło.
  // „Nie udało się" bez wskazania miejsca jest bezużyteczne przy pierwszym teście.
  let stage = "transkrypcja";

  try {
    setState("sifting");

    if (!audioBuffer?.length && settings.stt.provider !== "mock") {
      throw new Error("Nagranie jest puste. Sprawdź, czy mikrofon działa i czy mówiłeś dostatecznie długo.");
    }

    const t0 = Date.now();
    const { text: raw, provider, model: sttModel } = await transcribe(audioBuffer, settings);
    const tTranscribed = Date.now();

    if (!raw.trim()) {
      nothingHeard();
      return;
    }

    /* Polecenie rozpoznane lokalnie — fraza znika z materiału jeszcze przed
       wywołaniem sita, a HUD pokazuje jego nazwę, zanim tekst gdziekolwiek
       trafi. Rozpoznanie jest czystym dopasowaniem, więc nie ma tu własnego
       etapu: nie ma czego zepsuć poza samym sitem. */
    const cue = detectCommand(raw, settings.commands);
    if (cue.command) setState("sifting", { command: cue.command.name });

    stage = "sito";
    const result = await sift({
      raw: cue.body,
      settings,
      command: cue.command,
      // Zamknięta lista jedzie do sita tylko wtedy, gdy lokalnie nic nie
      // trafiło i nikt nie powiedział „cytuję".
      detect: !cue.command && !cue.bypassed,
    });
    const text = result.text || cue.body;
    const tSifted = Date.now();

    /* Które polecenie ostatecznie zadziałało i skąd o tym wiemy.
       Rozpoznanie po stronie sita ma mniejsze prawa niż dopasowanie
       dokładne — patrz outletFor. */
    const fired = cue.command ?? (result.command ? commandById(settings.commands, result.command) : null);

    stage = "dostarczenie";

    const outlet = outletFor(fired, result.commandBy, context);
    const delivery = await deliverBy(outlet, text, context, settings);

    const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
    const entry = store.addEntry({
      text,
      raw: settings.keepRaw ? raw : null,
      rawWords: words(raw),
      siftedWords: words(text),
      // Gęstość, którą sito NAPRAWDĘ dostało: polecenie trafione lokalnie może
      // ją narzucić. Rozpoznane po stronie sita nie może — do niego jedzie sam
      // katalog reguł, a gęstość jest już wtedy ustalona.
      mesh: cue.command?.mesh ?? settings.mesh,
      app: context.app,
      durationMs,
      timings: {
        transcribe: tTranscribed - t0,
        sift: tSifted - tTranscribed,
        total: Date.now() - t0,
      },
      provider,
      sttModel,
      note: delivery.noteId ?? context.note ?? null,
      model: result.model,
      refused: result.refused,
      pasted: delivery.pasted,
      /* Co zadziałało i skąd. Bez tego polecenie byłoby jedyną rzeczą,
         którą aplikacja robi sama z siebie i której nie widać w zapisie —
         a stąd bierze się przycisk „Bez polecenia" w Przesianych. */
      command: fired ? { id: fired.id, name: fired.name, by: result.commandBy } : null,
    });

    broadcast("entry:new", entry);
    setState("done", { entry });
    setTimeout(() => state === "done" && setState("idle"), 1600);
  } catch (error) {
    const message = String(error.message || error);
    broadcast("pipeline:error", { stage, message });
    setState("idle", { error: `${stage}: ${message}` });
  }
}

/**
 * Dokąd trafia wynik.
 *
 * Dwie zasady, obie o tym samym — żeby tekst nie wylądował tam, gdzie go nie
 * widać:
 *
 *   1. Dyktowanie ZAMÓWIONE Z NOTATKI wygrywa z ujściem polecenia. Kto
 *      nacisnął mikrofon w oknie notatki, ten chciał pisać do tej notatki.
 *      Wyjątkiem jest „nowa notatka", bo to nie jest to samo miejsce.
 *   2. Ujście słucha WYŁĄCZNIE dopasowania dokładnego. Sito rozpoznające
 *      wariant frazy może zmienić formę tekstu, ale nigdy jego miejsca:
 *      rozmycie nie ma prawa przenieść wypowiedzi tam, gdzie jej nie widać.
 */
function outletFor(command, by, context) {
  const want = by === "exact" ? (command?.outlet ?? "cursor") : "cursor";
  if (want === "new-note") return "new-note";
  if (context.note) return "note";
  if (want === "note") return "new-note"; // nie ma do której dopisać
  return want === "clipboard" ? "clipboard" : "cursor";
}

async function deliverBy(outlet, text, context, settings) {
  if (outlet === "note") return deliverToNote(context.note, text);
  if (outlet === "new-note") return deliverToNewNote(text);
  // Notatka: dopisujemy na jej końcu i kopiujemy do schowka, ale nie
  // wklejamy nigdzie indziej — użytkownik celowo mówił „do notatnika".
  return deliver(text, { autoPaste: outlet === "cursor" && settings.autoPaste });
}

/** Polecenie z ujściem „nowa notatka" — tekst zakłada własną kartkę. */
async function deliverToNewNote(text) {
  const note = store.createNote({ text });
  clipboard.writeText(text);
  scheduleSync();
  broadcast("note:changed", { id: note.id, created: true });
  syncDeck();
  return { copied: true, pasted: false, note: true, noteId: note.id };
}

/** Dopisanie przesianego tekstu do otwartej notatki. */
async function deliverToNote(noteId, text) {
  const note = store.appendToNote(noteId, text);
  clipboard.writeText(text);
  scheduleSync();
  // Notatka może być otwarta w Notatniku, w oknie głównym, we własnym
  // okienku i w szybkiej notatce naraz — każde z nich ma pokazać dopisany
  // tekst, więc wiadomość idzie do wszystkich.
  if (note) broadcast("note:appended", { id: note.id });
  return { copied: true, pasted: false, note: !!note, noteId: note?.id ?? null };
}

/** Minimalny poprawny plik WAV (16 kHz mono, cisza) — materiał na test łącza. */
function silentWav(seconds) {
  const rate = 16000;
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

/* ── Skróty ───────────────────────────────────────────────────── */

function bindHotkeys() {
  hotkeys?.stop();
  hotkeys = new HotkeyEngine({
    onStart: startCapture,
    onStop: stopCapture,
    onCancel: cancelCapture,
    onEscape: escapeElsewhere,
    isRecording: () => state === "listening",
  });
  const backend = hotkeys.start(store.getSettings().hotkey);
  /* Kolejność ma znaczenie: silnik skrótu zaczyna od unregisterAll(),
     więc skrót do zrzutu rejestrujemy PO nim. Odwrotnie zniknąłby przy
     każdym przepięciu klawiszy dyktowania — cicho, bez śladu. */
  bindShotHotkey();
  broadcast("hotkey:backend", { backend });
  return backend;
}

/**
 * Skrót do zaznaczania ekranu.
 *
 * Domyślnie nie ma go wcale i to nie jest niedoróbka: macOS trzyma na
 * zrzuty trzy fabryczne skróty (⌘⇧3, ⌘⇧4, ⌘⇧5), a czwarty wybrany za
 * użytkownika byłby albo zajęty, albo o włos od zajętego. Klawisze
 * wybiera się w Ustawieniach; do tego czasu funkcja siedzi w menu.
 *
 * @returns {boolean} czy klawisze udało się zająć
 */
function bindShotHotkey() {
  const accelerator = store.getSettings().shot?.hotkey;
  if (!accelerator) return false;
  try {
    return globalShortcut.register(accelerator, () => grabScreenText());
  } catch {
    // Zapis, którego Electron nie rozumie („Cmd+”, sam modyfikator).
    return false;
  }
}

/* ── Zgody systemowe ──────────────────────────────────────────── */

/** Jedno źródło prawdy o zgodach — dla IPC i dla obserwatora poniżej. */
function permissionSnapshot() {
  return {
    backend: hotkeys?.backend ?? "none",
    accessibility:
      process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    microphone:
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("microphone")
        : "granted",
  };
}

let permissionWatch = null;
let lastAccessibility = null;

/**
 * Zmiany zgody „Dostępność" nie da się złapać zdarzeniem — system żadnego
 * nie wysyła. Dlatego pytamy co dwie sekundy; to jedno wywołanie
 * AXIsProcessTrusted, więc kosztuje tyle co nic.
 *
 * Bez tego użytkownik wraca z Ustawień systemowych do okna, które dalej
 * twierdzi, że zgody nie ma, i dalej ma głuchy skrót — bo przepięcie
 * silnika działo się tylko przy fokusie okna głównego.
 */
function watchPermissions() {
  clearInterval(permissionWatch);
  lastAccessibility = permissionSnapshot().accessibility;

  permissionWatch = setInterval(() => {
    const accessibility = permissionSnapshot().accessibility;
    if (accessibility === lastAccessibility) return;
    lastAccessibility = accessibility;
    bindHotkeys(); // zgoda przyszła albo zniknęła — silnik skrótu na nowo
    broadcast("permissions:changed", permissionSnapshot());
  }, 2000);
}

/* ── IPC ──────────────────────────────────────────────────────── */

function registerIpc() {
  ipcMain.handle("settings:get", () => store.getSettings());

  ipcMain.handle("settings:save", (_e, patch) => {
    const settings = store.saveSettings(patch);
    if (patch.hotkey) bindHotkeys();
    // Sam zapamiętany wybór okna (dokąd, w jakiej formie) skrótu nie rusza —
    // przepinamy wyłącznie wtedy, gdy zmieniły się klawisze.
    if (patch.shot?.hotkey !== undefined) bindHotkeys();
    if (patch.widget?.enabled !== undefined) showWidget(patch.widget.enabled);
    // Zmiana widoku zbiera to, co zostało po poprzednim: przełączenie na
    // kompaktowy zdejmuje kartki z pulpitu, przełączenie na pulpit zwija
    // szybę przy znaczku (robi to sam widget, gdy dostanie nowe ustawienia).
    if (patch.widget?.mode !== undefined) closeDeck();
    if (patch.showInDock !== undefined) applyDockIcon(patch.showInDock);
    if (patch.spellcheck || patch.language) applySpellcheck(settings);
    if (patch.cloud) {
      cloud.configure(settings.cloud);
      watchCloud();
      cloudChanged();
    }
    if (patch.launchAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
    }
    refreshMenus();
    broadcast("settings:changed", settings);
    return settings;
  });

  // Interfejs pyta o katalog dostawców zamiast trzymać własną kopię,
  // która zdążyłaby się rozjechać z tym, co naprawdę obsługuje backend.
  // Link do konsoli dostawcy ma otworzyć przeglądarkę, a nie zastąpić
  // sobą interfejs aplikacji.
  ipcMain.handle("link:open", (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.handle("providers:get", () => ({ stt: STT, sieve: SIEVE, shot: OCR }));

  /* ── Notatnik ── */
  ipcMain.handle("notes:get", () => store.getNotes());
  ipcMain.handle("notes:create", (event, patch) => {
    const note = store.createNote(patch);
    scheduleSync();
    // Notatka założona w szybkiej notatce ma się pokazać w otwartej liście.
    broadcastExcept(event.sender, "note:changed", { id: note.id, created: true });
    syncDeck();
    return note;
  });
  ipcMain.handle("notes:update", (event, { id, patch }) => {
    const note = store.updateNote(id, patch);
    scheduleSync();
    // Ta sama notatka bywa otwarta w kilku oknach naraz — reszta ma zobaczyć
    // zmianę od razu, a nie przy następnym otwarciu.
    broadcastExcept(event.sender, "note:changed", { id });
    // „Widoczna w widgecie" przełączona w Notatniku ma od razu położyć
    // kartkę na pulpicie albo ją stamtąd zabrać.
    if (patch.widget !== undefined || patch.pinned !== undefined) syncDeck();
    return note;
  });

  ipcMain.handle("notes:delete", (event, id) => {
    noteWindows.get(id)?.close();
    stickyWindows.get(id)?.destroy();
    forgetCard(id);
    forgetNotionPage(id);
    const done = store.deleteNote(id);
    scheduleSync();
    broadcastExcept(event.sender, "note:changed", { id, deleted: true });
    syncDeck();
    return done;
  });

  ipcMain.handle("notes:open", () => (createNotesWindow(), true));

  /* Podwójne kliknięcie w notatkę: własne okienko dla tej jednej notatki. */
  ipcMain.handle("notes:openWindow", (_e, id) => (openNoteWindow(id), true));
  ipcMain.on("notes:closeWindow", (event) => BrowserWindow.fromWebContents(event.sender)?.close());

  ipcMain.handle("notes:quick", () => quickNote());
  ipcMain.on("quick:close", () => quickWindow?.close());

  /* ── Tekst z ekranu ── */
  ipcMain.handle("shot:grab", () => grabScreenText());
  /* Okno melduje się samo, gdy jest gotowe je przyjąć. Wysyłanie zrzutu
     w chwili tworzenia okna trafiałoby w dokument, który jeszcze nie ma
     nasłuchu — a zrzut jest jeden i nie ma go skąd powtórzyć. */
  ipcMain.handle("shot:ready", () => {
    if (!shot) return null;
    const settings = store.getSettings();
    return {
      image: shotPreview(shot.image),
      reading: shot.reading,
      text: shot.text,
      missingKey: shot.missingKey,
      error: shot.error,
      target: settings.shot?.target ?? "new",
      form: settings.shot?.form ?? "text",
    };
  });
  ipcMain.handle("shot:save", async (_e, choice) => {
    const result = await saveShot(choice ?? {});
    // Chwila na potwierdzenie w oknie — patrz save() w renderer/js/shot.js.
    if (!result?.error) setTimeout(closeShotWindow, 900);
    return result;
  });
  ipcMain.on("shot:cancel", () => closeShotWindow());

  /** Wysłanie notatki do Notatek Apple. Pierwsza linia zostaje tytułem. */
  ipcMain.handle("notes:toAppleNotes", async (_e, id) => {
    const note = store.getNotes().find((item) => item.id === id);
    if (!note) throw new Error("Nie ma takiej notatki.");
    await toAppleNotes(note.text);
    return { ok: true };
  });

  ipcMain.handle("notes:markdown", (_e, id) => {
    const note = store.getNotes().find((item) => item.id === id);
    return note ? toMarkdown(note.text) : "";
  });

  /** Zapis notatki jako plik .md — z okienkiem wyboru miejsca. */
  ipcMain.handle("notes:export", async (_e, id) => {
    const note = store.getNotes().find((item) => item.id === id);
    if (!note) throw new Error("Nie ma takiej notatki.");

    const safeName = noteTitle(note).slice(0, 60).replace(/[\\/:*?"<>|]/g, "-");

    const { canceled, filePath } = await dialog.showSaveDialog(notesWindow ?? mainWindow, {
      title: "Zapisz notatkę",
      defaultPath: `${safeName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "Tekst", extensions: ["txt"] }],
    });
    if (canceled || !filePath) return { canceled: true };

    require("fs").writeFileSync(filePath, toMarkdown(note.text), "utf8");
    return { canceled: false, filePath };
  });

  /**
   * Notatka jako PDF — z tym samym okienkiem wyboru miejsca, co zapis .md.
   *
   * Kartka jest jasna, choć aplikacja jest ciemna: PDF wychodzi z Cribro
   * na zewnątrz i tam trafia na papier albo do cudzego czytnika. Dlaczego
   * dokładnie tak — patrz main/pdf.js.
   */
  ipcMain.handle("notes:pdf", async (_e, id) => {
    const note = store.getNotes().find((item) => item.id === id);
    if (!note) throw new Error("Nie ma takiej notatki.");
    if (!note.text.trim()) throw new Error("Notatka jest pusta — nie ma czego zapisywać.");

    const title = noteTitle(note);
    const safeName = title.slice(0, 60).replace(/[\\/:*?"<>|]/g, "-");
    const { canceled, filePath } = await dialog.showSaveDialog(notesWindow ?? mainWindow, {
      title: "Zapisz notatkę jako PDF",
      defaultPath: `${safeName}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { canceled: true };

    await noteToPdf(note, {
      filePath,
      title,
      locale: store.getSettings().uiLanguage === "en" ? "en-GB" : "pl-PL",
    });
    return { canceled: false, filePath };
  });

  /**
   * Notatka na stronę w Notion.
   *
   * Ta sama notatka wysłana drugi raz odświeża swoją stronę, a nie zakłada
   * drugiej — zakładka „która notatka dostała którą stronę" leży
   * w ustawieniach tego komputera (patrz `notion.pages` w main/store.js).
   */
  ipcMain.handle("notes:toNotion", async (_e, id) => {
    const note = store.getNotes().find((item) => item.id === id);
    if (!note) throw new Error("Nie ma takiej notatki.");
    if (!note.text.trim()) throw new Error("Notatka jest pusta — nie ma czego wysyłać.");

    const notion = store.getSettings().notion ?? {};
    const result = await sendToNotion({
      token: notion.token,
      parent: notion.parent,
      title: noteTitle(note),
      text: note.text,
      page: notion.pages?.[id] ?? null,
    });
    store.saveSettings({ notion: { pages: { [id]: result.id } } });
    return result;
  });

  ipcMain.handle("notion:check", async (_e, patch) => {
    const notion = { ...(store.getSettings().notion ?? {}), ...(patch ?? {}) };
    return checkNotion({ token: notion.token, parent: notion.parent });
  });

  /**
   * Przesianie całej notatki — ta sama warstwa co przy dyktowaniu, tylko
   * na wejściu jest gotowy tekst zamiast transkrypcji. Przydaje się, gdy
   * notatka powstała w biegu i jest posklejana z urywków.
   */
  ipcMain.handle("notes:sift", async (event, id) => {
    const note = store.getNotes().find((item) => item.id === id);
    if (!note?.text.trim()) throw new Error("Notatka jest pusta.");

    const result = await sift({ raw: note.text, settings: store.getSettings() });
    if (!result.text) throw new Error("Sito nic nie zwróciło.");

    // Poprzednia wersja zostaje pod ręką — przesianie ma być odwracalne.
    const updated = store.updateNote(id, { text: result.text, previousText: note.text });
    broadcastExcept(event.sender, "note:changed", { id });
    return updated;
  });

  ipcMain.handle("notes:undoSift", (event, id) => {
    const note = store.getNotes().find((item) => item.id === id);
    if (!note?.previousText) throw new Error("Nie ma do czego wracać.");
    const restored = store.updateNote(id, { text: note.previousText, previousText: null });
    broadcastExcept(event.sender, "note:changed", { id });
    return restored;
  });

  /** Nagrywanie zamówione z okna notatki — wynik wróci do tej notatki. */
  ipcMain.handle("notes:dictate", async (_e, noteId) => {
    if (state === "listening") {
      stopCapture();
      return "sifting";
    }
    if (state !== "idle") return state;
    await startCapture({ trigger: "notatnik", note: noteId });
    return "listening";
  });

  /* ── Widget ── */
  ipcMain.handle("widget:show", (_e, show) => (showWidget(show), true));
  ipcMain.handle("widget:settings", () => store.getSettings().widget ?? {});
  ipcMain.handle("widget:reset", () => resetWidget());

  /* Zmiana stanu widgetu to zmiana rozmiaru OKNA, nie tylko CSS-u. Renderer
     prosi o stan ("badge", "tray", "panel") i dostaje w odpowiedzi geometrię,
     której sam nie zna: gdzie w oknie wylądował znaczek, w którą stronę
     wychodzi taca i gdzie postawić szybę. */
  ipcMain.handle("widget:layout", (_e, view) =>
    placeWidget(widgetAnchor(), ["badge", "tray", "panel"].includes(view) ? view : "badge"),
  );

  /* ══ CZYNNOŚCI Z TACY ══

     Wszystkie robi się W BIEGU i to jest reguła, nie opis: żadna nie ma
     prawa wywołać okna aplikacji sama z siebie. Taca rozkłada się pod
     kursorem, więc jej kółka bywają klikane przez pomyłkę — a okno
     wyskakujące na wierzch cudzej pracy jest najgorszą rzeczą, jaką może
     zrobić pomyłkowe kliknięcie w coś, co miało tylko przełączyć pokrętło.

     JEDEN WYJĄTEK jest podpisany wprost i po to został dodany: gniazdo
     „Otwórz Cribro Sift". Okno otwiera się wtedy, gdy ktoś o nie poprosił,
     a nie przy okazji czegoś innego. */
  ipcMain.handle("widget:run", async (_e, action) => {
    if (action === "dictate") {
      await toggleCapture("widget");
      return true;
    }
    if (action === "quick-note") return quickNote();

    /* Tryb rozpoznawania krąży: dwa języki → jeden → automat. */
    if (action === "language") {
      const language = normalizeLanguage(store.getSettings().language);
      const order = ["bilingual", "single", "auto"];
      const next = order[(order.indexOf(language.mode) + 1) % order.length];
      const settings = store.saveSettings({ language: { ...language, mode: next } });
      broadcast("settings:changed", settings);
      refreshMenus();
      return shortLabel(settings.language);
    }
    /* Gęstość sita krąży tak samo jak język: zgrubne → średnie → drobne.

       Wcześniej to gniazdo wołało CAŁE OKNO APLIKACJI na widok „Sito"
       i było jedynym miejscem w tacy, które to robiło — stąd brało się
       okno wyskakujące „czasem po kliknięciu w widget". Argument za oknem
       brzmiał: pokrętło ma trzy położenia i opis przy każdym, a to nie
       mieści się w kółku. Mieści się: położenie widać po gęstości siatki
       na ikonie, a opis stoi w dymku obok. */
    if (action === "sieve") {
      const order = Object.keys(MESH);
      const now = store.getSettings().mesh;
      const next = order[(order.indexOf(now) + 1) % order.length] ?? order[0];
      const settings = store.saveSettings({ mesh: next });
      broadcast("settings:changed", settings);
      refreshMenus();
      return next;
    }

    /* Okno aplikacji — jedyna droga z tacy do pełnego okna i jedyne
       gniazdo, które je otwiera. Poza widgetem prowadzi tam znaczek
       w pasku menu; tutaj jest po to, żeby nie trzeba było celować
       w pasek, gdy widget stoi na drugim końcu ekranu. */
    if (action === "app") {
      createMainWindow();
      return true;
    }
    return false;
  });

  /* Rozciąganie szyby uchwytem w rogu. Renderer przysyła żądany rozmiar
     SAMEJ SZYBY, bo tyle widzi; przycięcie do granic i do ekranu, przeliczenie
     okna wokół kotwicy i zapis należą tutaj (patrz widgetPanel). Zapisujemy
     dopiero na puszczenie uchwytu — zapis co klatkę pisałby plik ustawień
     sześćdziesiąt razy na sekundę. */
  ipcMain.handle("widget:resize", (_e, { width, height, commit } = {}) => {
    // Podłogę zaczynamy od rozmiaru SPRZED gestu, nie od pierwszego żądania:
    // inaczej pierwszy ruch do środka od razu kurczyłby okno i cała rzecz,
    // przed którą podłoga ma chronić, działaby się w pierwszej klatce.
    const floor = widgetPanelDrag ?? widgetPanel();
    widgetPanelDrag = {
      width,
      height,
      floorW: Math.max(floor.floorW ?? floor.width, width),
      floorH: Math.max(floor.floorH ?? floor.height, height),
    };
    // Kierunek podajemy z pamięci: przeliczony od nowa mógłby się odwrócić
    // w połowie gestu, gdy szyba przestanie się mieścić po swojej stronie.
    const spot = placeWidget(widgetAnchor(), widgetView, widgetView === "panel" ? widgetDir : null);
    if (commit) {
      // Zapisujemy to, co naprawdę wyszło po przycięciu — nie to, o co
      // renderer poprosił. Inaczej rozmiar odrzucony przez klamrę wracałby
      // przy każdym otwarciu i szyba „skakała" po pierwszym rozwinięciu.
      store.saveSettings({ widget: { panel: { width: spot.panelW, height: spot.panelH } } });
      widgetPanelDrag = null;
      // Drugi przebieg już bez podłogi — dopiero teraz okno kurczy się do
      // szyby, gdy uchwyt ją zmniejszył.
      return placeWidget(widgetAnchor(), widgetView, widgetView === "panel" ? widgetDir : null);
    }
    return spot;
  });

  ipcMain.on("widget:passthrough", (_e, ignore) => {
    widgetPassing = !!ignore;
    widget?.setIgnoreMouseEvents(widgetPassing, { forward: true });
  });

  /* Przeciąganie liczy renderer, bo tylko on widzi kursor. Przysyła jednak
     KOTWICĘ, czyli miejsce dla środka znaczka, a nie róg okna: przy rozwiniętym
     widgecie róg zależy od kierunku panelu i renderer musiałby powtarzać
     rachunek, który i tak jest tutaj. */
  ipcMain.on("widget:move", (_e, { anchor, dir }) => {
    placeWidget(anchor, widgetView, dir);
  });

  ipcMain.on("widget:drop", (_e, { anchor, dir }) => {
    const before = screen.getDisplayNearestPoint(widgetAnchor()).id;
    const spot = placeWidget(anchor, widgetView, dir);
    if (spot) store.saveSettings({ widget: widgetAnchor() });
    /* Znaczek przeniesiony na drugi monitor zabiera talię ze sobą. Kartki
       leżą przy tym pulpicie, przy którym się siedzi — a przeciągnięcie
       znaczka jest jedynym momentem, w którym człowiek mówi wprost, przy
       którym to jest. Bez tego notatki zostawały na porzuconym ekranie
       i trzeba je było przenosić po jednej. */
    if (deckOpen && screen.getDisplayNearestPoint(widgetAnchor()).id !== before) reflowDeck();
  });

  /* Fokus na żądanie. Widget bierze go wyłącznie wtedy, gdy ktoś w niego
     kliknął i zaraz będzie pisał — i oddaje, gdy kartka się zamyka, żeby
     kursor wrócił tam, gdzie był przed sięgnięciem po notatkę. */
  ipcMain.on("widget:focus", () => widget?.focus());

  /* ── Kartki na pulpicie ──
     Kliknięcie w znaczek w widoku „pulpit" nie rozwija szyby, tylko wykłada
     albo zbiera całą talię. Odpowiedź mówi rendererowi, jak jest teraz —
     żeby znaczek nie musiał trzymać własnej kopii tego stanu. */
  ipcMain.handle("deck:toggle", () => toggleDeck());
  ipcMain.handle("deck:show", (_e, show) => (show ? openDeck() : hideDeck()));
  ipcMain.handle("deck:state", () => ({ open: deckOpen, count: deckNotes().length }));

  /* Escape w oknie, które samo nie ma już czego zdjąć. Talia jest ostatnią
     warstwą przed schowaniem okna, więc pytanie brzmi „czy było co chować" —
     odpowiedź decyduje, czy Escape ma iść dalej. */
  ipcMain.handle("deck:escape", () => {
    if (!deckOpen) return false;
    hideDeck();
    return true;
  });

  /* Kartka melduje, że skończyła się zwijać — dopiero teraz jej okno może
     zniknąć. Numer rozdania odsiewa meldunki z talii, która w międzyczasie
     zdążyła wrócić na pulpit. */
  ipcMain.on("deck:folded", (event, { gen } = {}) => {
    if (gen !== deckGen || deckOpen) return;
    BrowserWindow.fromWebContents(event.sender)?.hide();
  });

  /* Zamknięcie jednej kartki zdejmuje notatkę z wierzchu — bo to jest to,
     co użytkownik właśnie powiedział. Samo schowanie okna zostawiałoby
     notatkę „na wierzchu", której nie widać, i przy następnym rozłożeniu
     talii kartka wracałaby jak duch. */
  ipcMain.handle("deck:dismiss", (_e, id) => {
    store.updateNote(id, { widget: false });
    scheduleSync();
    broadcast("note:changed", { id });
    stickyWindows.get(id)?.destroy();
    stickyWindows.delete(id);
    forgetCard(id);
    if (!deckNotes().length) {
      deckOpen = false;
      tellDeck();
    }
    return true;
  });

  /* Kartka bierze fokus dopiero wtedy, gdy ktoś w nią kliknął — tak samo
     jak znaczek. Talia wychodzi na pulpit, nie przerywając pisania. */
  ipcMain.on("deck:focus", (event) => BrowserWindow.fromWebContents(event.sender)?.focus());

  /* Przesuwanie kartki liczy renderer, bo tylko on widzi kursor — tak samo
     jak przy znaczku.

     Dlaczego nie systemowym `-webkit-app-region: drag`, skoro kartka ma
     pasek u góry i to by wystarczyło: bo obszar przeciągania POŁYKA
     kliknięcia. Tytuł leży właśnie w nim, a ma się dać przepisać podwójnym
     kliknięciem — z app-region podwójne kliknięcie nigdy do niego nie
     dochodzi. Własne przeciąganie z progiem ruchu godzi jedno z drugim:
     ruch przesuwa kartkę, samo kliknięcie zostaje kliknięciem. */
  ipcMain.on("deck:move", (event, point) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.setPosition(Math.round(point.x), Math.round(point.y));
  });

  ipcMain.on("deck:drop", (event, id) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    // Ustawienie z kodu nie zawsze wywołuje „moved", więc zapisujemy sami.
    retuneCard(win);
    if (id) rememberCard(id, win);
  });

  /* Rozciąganie kartki uchwytem w jej rogu.

     Okno jest bez ramki, a jego brzeg leży w przezroczystej aureoli — czyli
     tam, gdzie nikt nie szuka uchwytu i gdzie trudno trafić. Uchwyt jest więc
     narysowany w rogu kartki, a rachunek zostaje tutaj: renderer widzi tylko
     kursor, a klamry i zapis należą do tej strony.

     Lewy górny róg zostaje na miejscu — kartka rośnie w prawo i w dół, a nie
     ucieka spod ręki, która ją właśnie ciągnie. */
  ipcMain.on("deck:resize", (event, { id, width, height, commit } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const { x, y } = win.getBounds();
    win.setBounds({
      x,
      y,
      width: clamp(Math.round(width), STICKY_MIN.width, STICKY_MAX.width),
      height: clamp(Math.round(height), STICKY_MIN.height, STICKY_MAX.height),
    });
    // Zapis dopiero na puszczenie uchwytu: w trakcie ruchu byłoby ich
    // sześćdziesiąt na sekundę, a liczy się dopiero to, co zostało.
    if (commit && id) rememberCard(id, win);
  });
  // Samo blur, bez app.hide(): schowanie całej aplikacji zabrałoby przy
  // okazji Notatnik i okno główne, których nikt nie prosił o zniknięcie.
  ipcMain.on("widget:blur", () => widget?.blur());

  ipcMain.handle("history:get", () => store.getHistory());
  ipcMain.handle("history:update", (_e, { id, patch }) => store.updateEntry(id, patch));
  ipcMain.handle("history:delete", (_e, id) => (store.deleteEntry(id), true));
  ipcMain.handle("history:clear", () => (store.clearHistory(), store.getHistory()));
  ipcMain.handle("stats:get", () => store.stats());

  ipcMain.handle("clipboard:copy", (_e, text) => (clipboard.writeText(text ?? ""), true));

  ipcMain.handle("hotkey:status", () => permissionSnapshot());

  /* Sprawdzenie, czy skrót nie wchodzi komuś w drogę. Wynik jest podpowiedzią,
     nie wyrokiem — granice tego, co da się wykryć, opisuje shortcuts.js. */
  ipcMain.handle("hotkey:check", async (_e, accelerator) => {
    const hotkey = store.getSettings().hotkey ?? {};
    const own = [
      { name: "Przełącznik dyktowania", accelerator: hotkey.toggleAccelerator },
      { name: "Szybka notatka", accelerator: hotkey.quickNote },
      { name: "Tekst z ekranu", accelerator: store.getSettings().shot?.hotkey },
    ].filter((item) => item.accelerator && item.accelerator !== accelerator);

    // Test wprost: co system pozwoli zarejestrować. Skrótu, który już trzymamy,
    // nie ruszamy — inaczej sprawdzenie zabrałoby nam własny skrót.
    const probe = (acc) => {
      if (globalShortcut.isRegistered(acc)) return null;
      let free = false;
      try {
        free = globalShortcut.register(acc, () => {});
      } catch {
        free = false;
      }
      if (free) globalShortcut.unregister(acc);
      return free;
    };

    return detectConflicts(accelerator, { own, probe });
  });

  ipcMain.handle("permissions:request", async (_e, kind) => {
    if (process.platform !== "darwin") return true;
    if (kind === "microphone") return systemPreferences.askForMediaAccess("microphone");

    // Zgody „Dostępność" nie da się przyznać z kodu, ale można poprosić system,
    // żeby sam pokazał swoje okienko. To nie jest kosmetyka: przy tej prośbie
    // macOS zapisuje aplikację na liście z jej AKTUALNYM podpisem. Wpis, który
    // został po poprzedniej wersji, wskazuje na inny podpis i jest martwy —
    // przełącznik wygląda na włączony, a zgody faktycznie nie ma.
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    if (!trusted) {
      shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    }
    return trusted;
  });

  /**
   * Przesiej ponownie zapisany surowy transkrypt — inną gęstością sita
   * albo bez polecenia.
   *
   * `plain` to droga powrotna z polecenia, które ruszyło niechcący: bierze
   * cały surowy transkrypt razem z frazą wywołania i traktuje go jak zwykły
   * tekst. Bez tego wykrywanie poleceń byłoby jedyną rzeczą w aplikacji,
   * której nie da się cofnąć.
   */
  ipcMain.handle("sift:redo", async (_e, { id, mesh, plain = false }) => {
    const entry = store.getHistory().find((item) => item.id === id);
    if (!entry?.raw) throw new Error("Ten wpis nie ma zachowanego surowego transkryptu.");
    const settings = store.getSettings();
    const cue = plain
      ? { command: null, body: entry.raw, bypassed: true }
      : detectCommand(entry.raw, settings.commands);

    const result = await sift({
      raw: cue.body,
      settings: { ...settings, mesh: mesh ?? settings.mesh },
      command: cue.command,
      detect: !plain && !cue.command && !cue.bypassed,
    });
    const fired = cue.command ?? (result.command ? commandById(settings.commands, result.command) : null);
    const text = result.text || cue.body;

    return store.updateEntry(id, {
      text,
      mesh: mesh ?? settings.mesh,
      siftedWords: text.trim().split(/\s+/).filter(Boolean).length,
      command: fired ? { id: fired.id, name: fired.name, by: result.commandBy } : null,
    });
  });

  /**
   * Próba polecenia — karta „Polecenia", pole na zdanie testowe.
   *
   * Sprawdza SAMO rozpoznanie: czy fraza trafia, które polecenie wygrywa
   * i co zostaje po odcięciu wywołania. Sita nie woła, więc odpowiada
   * natychmiast i nic nie kosztuje — a to jest ta część, której nie da się
   * przewidzieć okiem.
   */
  ipcMain.handle("commands:probe", (_e, text) => {
    const cue = detectCommand(text, store.getSettings().commands);
    return {
      id: cue.command?.id ?? null,
      name: cue.command?.name ?? null,
      trigger: cue.trigger,
      body: cue.body,
      bypassed: cue.bypassed,
    };
  });

  /**
   * Nagrywanie z okna aplikacji. Ten sam tor co skrót klawiszowy, więc
   * pierwszy test da się zrobić bez przyznawania zgody „Dostępność".
   */
  ipcMain.handle("capture:toggle", () => toggleCapture("button"));

  /** Sprawdzenie kluczy zanim ktokolwiek cokolwiek powie. */
  ipcMain.handle("test:sieve", async () => {
    const settings = store.getSettings();
    const t0 = Date.now();
    const probe = "yyy no wiesz to to znaczy chciałem powiedzieć że że to działa eee";
    const result = await sift({ raw: probe, settings });
    return {
      ok: result.model !== "brak-klucza",
      text: result.text,
      model: result.model,
      ms: Date.now() - t0,
    };
  });

  /**
   * Test transkrypcji: syntetyczny WAV (200 ms ciszy) przechodzi całą drogę
   * do dostawcy. Sprawdza klucz, nazwę modelu i sieć naraz — czyli dokładnie
   * to, co potrafi się wysypać przy pierwszym dyktowaniu.
   */
  /* Sprawdzenie odczytu potrzebuje obrazka z tekstem — a jedyny obrazek,
     jaki aplikacja umie zrobić sama z siebie, to jej własne okno. Rysujemy
     więc zdanie w oknie, którego nikt nie zobaczy, robimy z niego zrzut
     i pytamy model, co widzi. Sprawdza to całą drogę naraz: klucz, model
     i to, czy obrazek w ogóle do niego dojechał — czego samo wysłanie
     tekstu nie potwierdzi, bo odczyt jedzie innym kanałem niż sito. */
  ipcMain.handle("test:shot", async () => {
    const settings = store.getSettings();
    const probe = "Cribro Sift czyta ekran";
    const page = `<body style="margin:0;overflow:hidden;background:#fff"><p style="font:600 34px/1.4 -apple-system,Helvetica,sans-serif;color:#111;padding:40px 32px">${probe}</p></body>`;

    const win = new BrowserWindow({
      show: false,
      width: 640,
      height: 180,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    let png;
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
      png = (await win.webContents.capturePage()).toPNG();
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }

    const t0 = Date.now();
    const result = await readText(png, settings);
    if (result.missingKey) return { ok: false, note: "Brak klucza — odczyt nie ruszy." };

    const got = result.text.replace(/\s+/g, " ").trim();
    const ok = got.toLowerCase().includes("cribro");
    return {
      ok,
      note: ok
        ? `${result.model} odczytał w ${Date.now() - t0} ms: „${got}"`
        : `Model odpowiedział czymś innym niż napis na obrazku: „${got}"`,
    };
  });

  ipcMain.handle("test:stt", async () => {
    const settings = store.getSettings();
    const { provider, model } = settings.stt;
    if (provider === "mock") return { ok: true, note: "Atrapa — klucz niepotrzebny." };
    if (!keyFor(provider, settings)) {
      throw new Error("Brak klucza dla wybranego dostawcy transkrypcji.");
    }

    const t0 = Date.now();
    await transcribe(silentWav(0.2), settings);
    return { ok: true, note: `${provider} / ${model} odpowiedział w ${Date.now() - t0} ms.` };
  });

  /** Przejście całej ścieżki bez mikrofonu — do pokazu i do testów. */
  ipcMain.handle("demo:run", async () => {
    pendingContext = { app: "Demo", startedAt: Date.now(), trigger: "demo" };
    await runPipeline(Buffer.alloc(0), 3200);
    return true;
  });

  ipcMain.on("hud:audio", async (_e, { buffer, durationMs }) => {
    await runPipeline(Buffer.from(buffer), durationMs);
  });

  /* Poziom głosu wędruje z HUD-a do widgetu: mikrofon ma tylko HUD,
     a po trzech sekundach widać już tylko znaczek. Wiadomość jest lekka
     (jedna liczba), ale i tak nie ma po co jej wysyłać, gdy nie ma czego
     animować. */
  ipcMain.on("hud:level", (_e, level) => {
    if (widget && !widget.isDestroyed() && widget.isVisible()) {
      widget.webContents.send("widget:level", level);
    }
  });

  /* Escape z okna aplikacji. Globalny Escape obsługuje silnik skrótu;
     to jest droga dla okien, które akurat mają fokus. */
  ipcMain.handle("capture:cancel", () => {
    cancelCapture();
    return true;
  });

  ipcMain.on("hud:error", (_e, message) => {
    broadcast("pipeline:error", { message });
    setState("idle", { error: message });
  });

  /* Nagranie za krótkie, żeby cokolwiek w nim było. Wie o tym wyłącznie HUD,
     bo tylko on liczy próbki — ale komunikat ma być ten sam co przy pustej
     transkrypcji, więc wraca tą samą drogą. */
  ipcMain.on("hud:empty", () => nothingHeard("nagranie"));


  /* ── Konto i chmura ──
     Warstwa jest cienka celowo: wszystko, co wie o Supabase, siedzi
     w main/supabase.js i main/sync.js, a tutaj są same drzwi. */

  ipcMain.handle("cloud:state", () => cloudState());

  ipcMain.handle("cloud:signUp", async (_e, { email, password }) => {
    const result = await cloud.signUp(email, password);
    cloudChanged();
    // Zalogowanie od razu zdarza się tylko przy wyłączonym potwierdzaniu
    // adresu — wtedy pierwsza synchronizacja może ruszyć teraz.
    if (!result.needsConfirmation) scheduleSync(500);
    return { ...cloudState(), ...result };
  });

  ipcMain.handle("cloud:signIn", async (_e, { email, password }) => {
    await cloud.signIn(email, password);
    cloudChanged();
    scheduleSync(500);
    return cloudState();
  });

  ipcMain.handle("cloud:signOut", async () => {
    // Logowanie w przeglądarce trwające w chwili wylogowania skończyłoby się
    // sesją założoną tuż po tym, jak człowiek prosił, żeby jej nie było.
    oauthPending?.cancel();
    oauthPending = null;
    await cloud.signOut();
    // Kursor idzie razem z sesją: po ponownym zalogowaniu ma się policzyć
    // wszystko od nowa, bo w międzyczasie mogło się zmienić po obu stronach.
    store.saveCloudState({ userId: null, cursor: null });
    cloudChanged();
    return cloudState();
  });

  ipcMain.handle("cloud:reset", (_e, email) => cloud.resetPassword(email));

  /* Logowanie przez Google (a kiedyś przez Apple).

     Uchwyt czeka na zakończenie całego tańca — od otwarcia przeglądarki po
     gotową sesję — więc renderer dostaje jedną odpowiedź: udało się albo
     nie. Stan „czekam" idzie osobno, rozgłoszeniem, bo w tym czasie okno
     aplikacji ma coś pokazywać, a nie zamarzać z klepsydrą. */
  ipcMain.handle("cloud:oauth", async (_e, provider) => {
    if (oauthPending) throw new Error("Logowanie już trwa — dokończ je w przeglądarce.");

    const attempt = signInWithProvider({
      client: cloud,
      provider: provider ?? "google",
      openExternal: (url) => shell.openExternal(url),
    });
    oauthPending = { provider: provider ?? "google", cancel: attempt.cancel };
    cloudChanged({ error: null, note: null });

    try {
      await attempt.result;
      oauthPending = null;
      cloudChanged();
      scheduleSync(500);
      return cloudState();
    } catch (error) {
      oauthPending = null;
      cloudChanged();
      throw error;
    }
  });

  ipcMain.handle("cloud:oauthCancel", () => {
    oauthPending?.cancel();
    oauthPending = null;
    cloudChanged();
    return cloudState();
  });

  /* Adresy powrotne do wklejenia w panelu Supabase. Liczy je proces główny,
     bo to on zna listę portów — przepisana ręcznie do interfejsu rozjechałaby
     się przy pierwszej zmianie. */
  ipcMain.handle("cloud:redirects", () => oauthRedirects());

  ipcMain.handle("cloud:sync", async () => {
    const report = (await runSync({ force: true })) ?? { taken: 0, pushed: 0 };
    return { ...cloudState(), report };
  });

  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:close", () => mainWindow?.hide());
}

/* ── Start ────────────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createMainWindow());

  app.whenReady().then(() => {
    store = new Store();

    // Cribro ma jedną paletę i jest nocna. Materiał szkła w oknie szybkiej
    // notatki (vibrancy) bierze się natomiast od systemu — w jasnym motywie
    // byłby mleczny i jasny, a na nim jasny tekst notatki zniknąłby zupełnie.
    // Dlatego mówimy systemowi wprost, w jakim motywie jesteśmy.
    nativeTheme.themeSource = "dark";

    // Okna ładowane z file:// nie dostają mediów automatycznie. Wpuszczamy
    // wyłącznie mikrofon i wyłącznie naszym własnym oknom.
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      const ours = BrowserWindow.getAllWindows().some((win) => win.webContents === contents);
      callback(ours && (permission === "media" || permission === "audioCapture"));
    });

    // Konto i kopia notatek. Klient powstaje zawsze — bez adresu projektu
    // jest tylko wyłączony, a nie nieobecny, więc reszta kodu nie musi
    // sprawdzać, czy w ogóle istnieje.
    cloud = new Supabase();
    cloud.configure(store.getSettings().cloud);

    applySpellcheck(store.getSettings());
    // Menu pod prawym przyciskiem dostaje każde okno, także to otwarte
    // później — dopinanie go w każdej funkcji tworzącej okno z osobna
    // kończyłoby się pominięciem tego, które dopisano jako ostatnie.
    app.on("browser-window-created", (_event, win) => attachContextMenu(win));

    registerIpc();
    createTray();
    buildAppMenu();
    createHud();
    bindHotkeys();
    watchPermissions();
    createMainWindow();
    watchCloud();
    if (store.getSettings().widget?.enabled) showWidget(true);
    applyDockIcon(store.getSettings().showInDock !== false);

    // Widget zapamiętany na monitorze, którego już nie ma, wraca w obszar roboczy.
    screen.on("display-removed", () => widget && placeWidget(widgetAnchor(), widgetView));
    // To samo z kartkami na pulpicie — z tą różnicą, że jest ich kilka i że
    // każda musi jeszcze urosnąć albo zmaleć do ekranu, na który wróciła.
    screen.on("display-removed", reflowDeck);
    screen.on("display-metrics-changed", reflowDeck);
    /* Podłączony monitor też przestawia talię — bo razem z nim przestawia
       się obszar roboczy tego, na którym stoi znaczek (pasek menu, Dock,
       rozdzielczość zależna od układu). Bez tego kartki zostawały na
       współrzędnych sprzed podłączenia i część wychodziła poza pulpit. */
    screen.on("display-added", reflowDeck);

    if (process.platform === "darwin") {
      systemPreferences.askForMediaAccess("microphone").catch(() => {});
    }

    app.on("activate", () => {
      if (reopenIsOurs()) return;
      createMainWindow();
    });
  });

  // Aplikacja żyje w pasku menu. Sam fakt, że ten listener istnieje,
  // powstrzymuje Electrona przed zamknięciem jej po zamknięciu okien.
  app.on("window-all-closed", () => {});
  app.on("will-quit", () => hotkeys?.stop());
}
