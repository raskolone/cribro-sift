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
  desktopCapturer,
  powerMonitor,
} = require("electron");

const { Store } = require("./store");
const { Supabase } = require("./supabase");
const admin = require("./admin");
const { signInWithProvider, PORTS: OAUTH_PORTS, CALLBACK: OAUTH_CALLBACK } = require("./oauth");
const { syncNotes } = require("./sync");
const { HotkeyEngine } = require("./hotkeys");
const { transcribe } = require("./stt");
const { sift, MESH } = require("./sieve");
const { detect: detectCommand, byId: commandById } = require("./commands");
const { keyFor, STT, SIEVE, OCR } = require("./providers");
const { deliver, frontmostApp } = require("./paste");
const { toAppleNotes, toMarkdown } = require("./share");
const { noteToPdf, folderToPdf } = require("./pdf");
const { sendNote: sendToNotion, check: checkNotion } = require("./notion");
const { detectConflicts } = require("./shortcuts");
const { grabRegion, readText, compose, stampName, imageLink } = require("./shot");
const { Meetings } = require("./meeting");
const { Watcher: MeetingWatcher, spot: spotMeeting } = require("./detect");
const { speakerFor } = require("./merge");
const { digest, polish, asNote, flipToggle, send: sendToModel } = require("./digest");
const { keepNote } = require("./meetnote");
const agendaSource = require("./agenda");
const { Google } = require("./google");
const briefingSource = require("./briefing");
const { headlines } = require("./rss");
const { LANGUAGES, normalize: normalizeLanguage, shortLabel } = require("./languages");
const { translator } = require("../shared/strings");
const ownership = require("./owner");

/* Pasek menu mówi stanem, nie słowami — ale musi być widoczny.
   „Gotowe" jest szablonem: macOS przemaluje je na biało w ciemnym pasku
   i na czarno w jasnym. Stany pracy są kolorowe, żeby rzucały się w oczy. */
const TRAY_ICON = {
  idle: "idleTemplate.png",
  /* Spotkanie ma własny znak i własny kolor: czerwoną kropkę nagrywania.
     Dyktowanie (fiolet, fala) trwa kilkanaście sekund i nagrywa CIEBIE;
     spotkanie trwa godzinę i nagrywa także wszystkich, których słychać.
     To są dwie różne odpowiedzi na pytanie „co się teraz dzieje" i nie
     wolno ich pokazywać jednym rysunkiem. Ten sam kolor niesie znaczek
     na wierzchu (ON AIR) — patrz --air w css/tokens.css. */
  meeting: "meeting.png",
  listening: "listening.png",
  sifting: "sifting.png",
  done: "done.png",
};

const TRAY_TOOLTIP = {
  idle: "Cribro Sift — trzymaj ⌃⌥ i mów",
  meeting: "Nagrywam spotkanie",
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
let meetings;
let hotkeys;
let tray;
let mainWindow = null;
let hud = null;
let notesWindow = null;
/** Notatki oderwane do własnych okienek: id notatki → okno. */
const noteWindows = new Map();
/** Spotkania oderwane do własnych okien: id spotkania → okno. */
const meetingWindows = new Map();
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

  markAppWindow(mainWindow);
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

  markAppWindow(notesWindow);
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

  markAppWindow(win);
  win.loadFile(path.join(__dirname, "..", "renderer", "notes.html"), { query: { note: id } });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => noteWindows.delete(id));
  noteWindows.set(id, win);
  return win;
}

/**
 * Jedno spotkanie we własnym oknie.
 *
 * Ta sama myśl co przy notatce oderwanej od listy: spotkanie ogląda się
 * W TRAKCIE innej pracy — pisząc z niego maila albo siedząc już na
 * następnym. Wtedy okno główne jest w drodze, bo trzeba je przełączyć
 * i znaleźć w nim zakładkę.
 *
 * Zawartość rysuje ten sam widok, co zakładka w oknie głównym (patrz
 * renderer/meeting.html) — spotkanie ma wyglądać tak samo w obu miejscach,
 * bo jest tym samym spotkaniem.
 */
function openMeetingWindow(id) {
  const open = meetingWindows.get(id);
  if (open && !open.isDestroyed()) {
    open.show();
    open.focus();
    return open;
  }

  const win = new BrowserWindow({
    width: 640,
    height: 660,
    minWidth: 420,
    minHeight: 360,
    show: false,
    backgroundColor: "#09101c", // --bg
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Kilka okien naraz nie może wylądować jedno na drugim.
  const offset = meetingWindows.size * 26;
  const [x, y] = win.getPosition();
  win.setPosition(x + offset, y + offset);

  markAppWindow(win);
  win.loadFile(path.join(__dirname, "..", "renderer", "meeting.html"), {
    query: { meeting: id },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => meetingWindows.delete(id));
  meetingWindows.set(id, win);
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
/**
 * Ile najdłużej wolno trwać jednemu zaznaczaniu, zanim uznamy je za
 * porzucone. Odczyt z modelu to kilka sekund, zaznaczanie ekranu — tyle,
 * ile ktoś celuje myszą. Dwie minuty to z zapasem jedno i drugie.
 */
const SHOT_STALE_MS = 120_000;

/**
 * ══ JEDNO CZYTANIE NARAZ — ALE NIE NA WIEKI ══
 *
 * `shot` trzyma obrazek w trakcie odczytu i strzeże przed drugim czytaniem
 * w środku pierwszego. Zapomniany zostawał tu na zawsze i skrót przestawał
 * robić COKOLWIEK — cicho, bez komunikatu, do następnego uruchomienia
 * aplikacji. Wystarczył jeden wyjątek na drodze zapisu albo odczyt, który
 * nigdy nie wrócił.
 *
 * Stąd data przy wpisie: po dwóch minutach to nie jest już „trwa czytanie",
 * tylko ślad po czymś, co się nie udało.
 *
 * Straż stoi PRZED wyborem obrazka, nie po nim: dwa krzyżyki na ekranie
 * albo dwa okna wyboru pliku naraz byłyby gorsze niż jedno odrzucone
 * wywołanie.
 */
function shotBusy() {
  if (shot && Date.now() - (shot.at ?? 0) > SHOT_STALE_MS) shot = null;
  return !!shot;
}

async function grabScreenText() {
  if (shotBusy()) return false;
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

  return readShot(grabbed.buffer, "image/png");
}

/**
 * Obrazek z pliku — druga droga do tego samego odczytu.
 *
 * Zaznaczanie ekranu jest dobre, kiedy rzecz do przeczytania jest właśnie
 * na ekranie. Nie jest dobre, kiedy przyszła załącznikiem albo leży
 * w Pobranych — a wtedy jedynym wyjściem było dotąd otworzyć plik
 * i zrobić zrzut z podglądu, czyli przepisać obrazek przez ekran.
 *
 * Zgody na nagrywanie ekranu ta droga NIE potrzebuje: nikt tu niczego nie
 * podgląda, plik wskazuje sam człowiek. Dlatego działa też wtedy, gdy
 * tamtej zgody nie ma.
 *
 * @param {string|null} filePath gotowa ścieżka albo null — wtedy pytamy
 */
async function readImageFile(filePath = null) {
  if (shotBusy()) return false;
  const t = translator(store.getSettings().uiLanguage);

  let chosen = filePath;
  if (!chosen) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: t("Wybierz obrazek do przeczytania"),
      properties: ["openFile"],
      filters: [{ name: t("Obrazki"), extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (canceled || !filePaths?.length) return false;
    chosen = filePaths[0];
  }

  /* Odmowa jest tu zwykłym wynikiem, nie awarią: człowiek wskazał plik,
     który nie jest obrazkiem albo jest za duży, i ma o tym usłyszeć
     zdaniem, które mówi co dalej. */
  let picked;
  try {
    picked = imageFromFile(chosen);
  } catch (problem) {
    tellError("zrzut", problem.message);
    return false;
  }

  return readShot(picked.buffer, picked.mime);
}

/**
 * Odczyt i to, co z nim dalej — wspólne dla obu wejść.
 *
 * Skąd przyszedł obrazek, przestaje mieć znaczenie w tym miejscu: dalej
 * jest jeden tor — pytanie albo zapis bez pytania, okno z podglądem,
 * zwolnienie `shot` na każdej drodze wyjścia.
 */
async function readShot(image, mime) {
  const settings = store.getSettings();
  shot = { image, reading: true, text: "", missingKey: false, error: null, at: Date.now() };

  const reading = readText(image, settings, { mime })
    .then((result) => ({ text: result.text, missingKey: !!result.missingKey, error: null }))
    .catch((error) => ({ text: "", missingKey: false, error: String(error.message || error) }));

  /* Bez pytania: wynik idzie tam, gdzie okno stało ostatnim razem.
     „Do notatki" znaczy wtedy „do ostatnio ruszanej" — patrz saveShot. */
  if (settings.shot?.ask === false) {
    /* `finally` nie jest tu ostrożnością na zapas. Zapis potrafi rzucić
       (brak katalogu, notatka skasowana w międzyczasie), a wyjątek na tej
       drodze zostawiał `shot` ustawiony na zawsze — czyli zabijał skrót
       do końca działania aplikacji. */
    try {
      const done = await reading;
      if (!shot) return false;
      Object.assign(shot, done, { reading: false });
      const form = done.text ? (settings.shot.form ?? "text") : "image";
      const result = await saveShot({ target: settings.shot.target, form, text: done.text });
      if (result?.error) tellError("zrzut", result.error);
      return result;
    } catch (problem) {
      tellError("zrzut", problem.message);
      return false;
    } finally {
      shot = null;
    }
  }

  try {
    createShotWindow();
    const done = await reading;
    if (!shot) return false; // zdążył zamknąć okno
    Object.assign(shot, done, { reading: false });
    if (shotWindow && !shotWindow.isDestroyed()) {
      shotWindow.webContents.send("shot:text", {
        ...done,
        reading: false,
        error: ownership.scrub(done.error, ownerHere()),
        owner: ownerHere(),
      });
    }
    return true;
  } catch (problem) {
    /* Okno się nie otworzyło albo odczyt wywrócił się w miejscu, którego
       nie przewidzieliśmy. Obrazek zwalniamy — inaczej skrót zamilkłby
       na dobre (patrz komentarz wyżej). */
    shot = null;
    tellError("zrzut", problem.message);
    return false;
  }
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
  tellSettings();

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

/* ══ IKONA W DOCKU, CZYLI TAKŻE MIEJSCE W ⌘Tab ══

   To jest w macOS jedno ustawienie, nie dwa: aplikacja bez ikony w Docku
   jest „pomocnicza" (accessory) i przełącznik ⌘Tab jej nie widzi. Cribro
   jest jednak dwiema rzeczami naraz — znaczkiem w pasku menu, który ma tam
   siedzieć cicho, i zwykłym oknem z listą przesianych, notatkami
   i spotkaniami. Do okna trzeba umieć WRÓCIĆ, a wracanie po oknie odbywa
   się w macOS ⌘Tabem.

   Stąd zasada: ikona jest wtedy, gdy jest do czego wracać. Kto ją włączył
   w Ustawieniach, ma ją zawsze; kto ją wyłączył, dostaje ją mimo to na
   czas, w którym stoi otwarte okno aplikacji — i traci razem z ostatnim
   zamkniętym. Znaczek, HUD i kartki na pulpicie się nie liczą: są bez
   ramki, poza przełącznikiem okien i nie ma do nich czego przełączać. */

/** Okno, które jest dla systemu oknem aplikacji — z ramką i miejscem w ⌘Tab. */
function markAppWindow(win) {
  if (!win || win.isDestroyed()) return win;
  win.isAppWindow = true;
  win.on("closed", () => refreshDockIcon());
  refreshDockIcon();
  return win;
}

const someAppWindowOpen = () =>
  BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isAppWindow);

/**
 * Ikona aplikacji w Docku. Domyślnie widoczna; kto woli mieć Cribro wyłącznie
 * w pasku menu, wyłącza ją w Ustawieniach — ale otwarte okno pokazuje ją i tak,
 * żeby dało się do niego wrócić ⌘Tabem.
 */
function applyDockIcon(show) {
  if (process.platform !== "darwin") return;
  if (show || someAppWindowOpen()) app.dock?.show();
  else app.dock?.hide();
}

/* Po zamknięciu okna ikona schodzi dopiero w następnej turze pętli zdarzeń:
   „closed" pada, zanim okno zniknie ze spisu, więc pytanie zadane od razu
   dostałoby odpowiedź sprzed chwili. */
function refreshDockIcon() {
  setImmediate(() => applyDockIcon(store.getSettings().showInDock !== false));
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
/* Ile ręka musi przejechać, zanim uznamy to za przeciąganie, a nie za
   kliknięcie. Poniżej tego progu znaczek stoi — inaczej każde kliknięcie
   przesuwałoby go o piksel. */
const WIDGET_DRAG_MIN = 4;
/* Jak szybko gaśnie odstęp między kursorem a środkiem znaczka po chwyceniu.
   0,7 na klatkę znaczy: po pięciu klatkach (~80 ms) zostaje z trzydziestu
   pikseli mniej niż pięć, a po ośmiu — nic. */
const WIDGET_GRAB_FADE = 0.7;

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
  /* Nowa notatka stoi o jedno kółko DALEJ niż notatki, na tej samej osi
     w bok (patrz .slot--new w widget.html). Dymek ma więc mniej miejsca
     do krawędzi okna niż tamten — stąd osobna liczba i krótki napis
     („Nowa notatka", nie „Nowa notatka na pulpicie", które by się tam
     nie zmieściło). */
  roomNew: 96,
  /* Pytanie o notatki ze spotkania wychodzi w tę samą stronę co ikonka
     notatek i jest z nich wszystkich najszersze — bo jako jedyne ma dwa
     przyciski. Ta sama liczba stoi w widget.html jako --ask-w; okno musi
     być szersze od dymka, inaczej przycięłoby mu „Nie teraz". */
  roomAsk: 200,
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
    /* Nowa notatka: o jedno kółko i jedną przerwę dalej niż notatki,
       plus jej własny dymek. Liczba wychodzi mniejsza od tej przy pytaniu
       o spotkanie, więc dziś okna nie poszerza — ale stoi tu wprost, żeby
       poszerzyła je sama, gdyby napis albo kółka kiedyś urosły. */
    WIDGET_BADGE / 2 +
      WIDGET_TRAY.gap +
      WIDGET_TRAY.item / 2 +
      WIDGET_TRAY.gap +
      WIDGET_TRAY.item +
      WIDGET_TRAY.item / 2 +
      WIDGET_TRAY.tip +
      WIDGET_TRAY.roomNew,
    WIDGET_TRAY.item / 2 + WIDGET_TRAY.tip + WIDGET_TRAY.room,
    // Pytanie o notatki ze spotkania — stoi przy samym znaczku i jest
    // szersze od każdego dymka.
    WIDGET_BADGE / 2 + WIDGET_TRAY.gap + WIDGET_TRAY.roomAsk,
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

/* ══ OKNEM RUSZYŁ PROCES GŁÓWNY — TRZEBA O TYM POWIEDZIEĆ ══

   Renderer zna swoje miejsce w oknie wyłącznie z ODPOWIEDZI na własne
   żądanie (widget:layout). Gdy oknem rusza proces główny — po zmianie
   układu ekranów albo po „Przywróć na miejsce" — takiego żądania nie ma
   i nie ma czym odpowiedzieć.

   To NIE jest kosmetyka. Znaczek rysuje się na kotwicy wewnątrzokiennej,
   a okno przycina swoją zawartość (overflow: hidden w widget.html). Przy
   większym skoku — a odłączenie monitora jest właśnie takim skokiem —
   znaczek ląduje poza oknem i znika z ekranu w całości: okno stoi tam,
   gdzie trzeba, jest widoczne i nieprzezroczyste, tylko puste. Dlatego
   świeża geometria idzie tu sama, bez pytania. */
function tellWidget(spot) {
  if (spot && widget && !widget.isDestroyed()) widget.webContents.send("widget:geometry", spot);
  return spot;
}

/**
 * Znaczek po zmianie układu ekranów.
 *
 * Monitor można odłączyć w każdej chwili — także ten, na którym stoi
 * znaczek. Współrzędnych, na których został, nie ma wtedy na żadnym
 * ekranie. Wracamy więc kotwicą w obszar roboczy najbliższego ekranu
 * (robi to samo przyklamrowanie w placeWidget) i mówimy o tym rendererowi.
 */
function reflowWidget() {
  if (!widget || widget.isDestroyed()) return;
  tellWidget(placeWidget(widgetAnchor(), widgetView));
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
  // O tym przestawieniu prosi okno ustawień, a nie znaczek — więc to on
  // musi dostać nową geometrię osobno (patrz tellWidget).
  return tellWidget(placeWidget(widgetHome(), widgetView)) ?? true;
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
/* Wysokość samej belki z tytułem, przy skali 1 — tyle zostaje z kartki
   zwiniętej do nagłówka. Liczba jest z arkusza sticky.html (.head:
   9 pikseli odstępu u góry, 25-piksslowy rząd ikon, 8 u dołu) i musi za nim
   nadążać: kartka wyższa od belki pokazywałaby pasek pustego papieru.

   Kreski pod belką w tym rachunku NIE MA i to nie jest przeoczenie:
   zwinięta kartka zdejmuje `border-bottom` (patrz [data-rolled] w arkuszu),
   bo nie ma już czego od czego oddzielać. */
const STICKY_HEAD = 42;
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
 * ROŚNIE, ALE NIE MALEJE — i to jest poprawka, nie przeoczenie. Skala
 * ciągnie za sobą WSZYSTKO, razem z krojem pisma (transform: scale
 * w sticky.html), więc na mniejszym ekranie kartka schodziła do 0,8 i tekst
 * z niej robił się dziesięciopikselowy. Tymczasem na małym ekranie kartka
 * nie musi być mniejsza: przy 268 pikselach mieści się wszędzie, a jedyne,
 * co naprawdę przeszkadza, to napis, którego nie da się przeczytać.
 * Podłoga jest więc równa jedności — w dół nie ma po co iść.
 */
function deckScale(workArea) {
  const k = Math.min(workArea.width / 1440, workArea.height / 900);
  return Math.min(1.45, Math.max(1, Math.round(k * 20) / 20));
}

/** Rozmiar OKNA kartki (z aureolą) przy danej skali. */
function deckCardSize(scale) {
  return {
    width: Math.round(STICKY_CARD.width * scale) + STICKY_HALO * 2,
    height: Math.round(STICKY_CARD.height * scale) + STICKY_HALO * 2,
  };
}

/** Wysokość OKNA kartki zwiniętej do samej belki, przy danej skali. */
const rolledHeight = (scale) => Math.round(STICKY_HEAD * scale) + STICKY_HALO * 2;

/**
 * Dolna klamra okna kartki.
 *
 * TU SIEDZIAŁA CAŁA USTERKA „zwinięta kartka jest za duża". Okno ma
 * `minHeight: STICKY_MIN.height` (150) — sensowną podłogę dla kartki, którą
 * ktoś ściąga ręką za róg. Zwinięcie do belki prosi jednak o siedemdziesiąt
 * kilka pikseli, czyli MNIEJ niż ta podłoga, a `setBounds` klamry nie pyta
 * o zdanie: system podnosił wysokość z powrotem do 150 i pod belką zostawał
 * pasek pustego papieru. Wyglądało to jak kartka „prawie zwinięta".
 *
 * Zwinięcie jest stanem, a nie rozmiarem, więc na jego czas podłoga schodzi
 * do wysokości belki i wraca razem z rozwinięciem.
 */
function clampCard(win, rolled, scale) {
  if (!win || win.isDestroyed()) return;
  const floor = rolled ? rolledHeight(scale) : STICKY_MIN.height;
  win.setMinimumSize(STICKY_MIN.width, floor);
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

  /* Zwinięta kartka układa się zwinięta: wysokość bierze się wtedy ze
     stanu, a nie z zapamiętanego rozmiaru. */
  if (saved.rolled) {
    size.height = rolledHeight(deckScale(workArea));
  }

  return placeOn(workArea, spot, size);
}

function rememberCard(id, win) {
  if (!win || win.isDestroyed()) return;
  /* Kartka zwinięta ma wysokość samej belki i nie jest to jej rozmiar,
     tylko jej stan. Zapisany jako rozmiar zastąpiłby ten prawdziwy —
     i kartka rozwinęłaby się do wysokości nagłówka. */
  if (store.getSettings().widget?.cards?.[id]?.rolled) {
    const { x, y } = win.getBounds();
    store.saveSettings({ widget: { cards: { [id]: { x, y, ...cardSpot(win.getBounds()) } } } });
    return;
  }
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
  /* Zwinięta kartka nie ma rozmiaru do przeliczenia — ma stan. Puszczona
     przez ten sam rachunek co rozwinięta, wracała z drugiego monitora
     rozdęta do dolnej klamry (150 pikseli) zamiast do wysokości belki. */
  const rolled = !!store.getSettings().widget?.cards?.[win.noteId]?.rolled;
  clampCard(win, rolled, scale);
  const size = {
    width: clamp(
      Math.round((bounds.width - STICKY_HALO * 2) * k) + STICKY_HALO * 2,
      STICKY_MIN.width,
      STICKY_MAX.width,
    ),
    height: rolled
      ? rolledHeight(scale)
      : clamp(
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

  // Po czyjej notatce jeździ to okno — pyta o to retuneCard, żeby wiedzieć,
  // czy kartka jest zwinięta.
  win.noteId = note.id;
  win.deckScale = deckScaleAt(bounds);
  /* Kartka wyłożona ZWINIĘTA musi mieć od razu obniżoną podłogę: rozmiar
     policzył już deckPlace, ale klamra z konstruktora podniosłaby go
     z powrotem i belka wyszłaby z paskiem pustego papieru pod spodem. */
  const wasRolled = !!store.getSettings().widget?.cards?.[note.id]?.rolled;
  if (wasRolled) {
    clampCard(win, true, win.deckScale);
    win.setBounds({ ...bounds, height: rolledHeight(win.deckScale) });
  }
  win.loadFile(path.join(__dirname, "..", "renderer", "sticky.html"), {
    query: {
      note: note.id,
      scale: String(win.deckScale),
      // Kartka zwinięta ma wrócić zwinięta — inaczej „zwiń" znaczyłoby
      // „schowaj do następnego wyłożenia talii".
      rolled: store.getSettings().widget?.cards?.[note.id]?.rolled ? "1" : "0",
    },
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
      // tutaj zostaje przyjąć skalę do wiadomości (patrz settleScale) oraz
      // obniżyć podłogę, jeśli kartka wraca zwinięta.
      clampCard(
        win,
        !!store.getSettings().widget?.cards?.[note.id]?.rolled,
        deckScaleAt(bounds),
      );
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

/* Ile czekamy, aż macOS skończy przestawiać okna po swojemu. */
const SCREENS_SETTLE_MS = 400;
let screensSettle = null;

/**
 * Jedno wejście na każdą zmianę układu ekranów.
 *
 * Powodów jest trzy i wszystkie kończą się tak samo — czymś naszym poza
 * pulpitem:
 *
 *   ODŁĄCZENIE   znaczek i kartki zostają na współrzędnych, których już
 *                nie ma na żadnym ekranie,
 *   PODŁĄCZENIE  razem z nowym monitorem przesuwa się początek układu
 *                współrzędnych i obszar roboczy tego, na którym stoimy,
 *   ZMIANA EKRANU rozdzielczość, skala, Dock albo pasek menu — obszar
 *                roboczy kurczy się pod stojącym oknem.
 *
 * Znaczek idzie PRZED kartkami, bo to przy jego ekranie się je układa
 * (patrz reflowDeck) — a zanim wróci, ten ekran wskazuje nieistniejący.
 *
 * DRUGIE PRZEJŚCIE PO CHWILI nie jest ostrożnością na zapas: macOS
 * przestawia okna z odłączonego ekranu PO tym, jak ogłosi zmianę, i potrafi
 * przesunąć to, co właśnie ustawiliśmy. Zdarzenia przychodzą przy tym
 * seriami (każdy ekran osobno), więc zwłoka jest jedna na całą serię.
 */
function screensChanged() {
  reflowWidget();
  reflowDeck();
  clearTimeout(screensSettle);
  screensSettle = setTimeout(() => {
    screensSettle = null;
    reflowWidget();
    reflowDeck();
  }, SCREENS_SETTLE_MS);
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
 * Tu mieszka wszystko, co otwiera okno: Notatnik, Start, Ustawienia.
 * Taca widgetu jest od czynności, które robi się w biegu — otwieranie okien
 * zabierałoby na niej miejsce dokładnie tym rzeczom, dla których powstała,
 * a menu i tak jest zawsze pod ręką, z klawiszami skrótu.
 */
/**
 * Pozycja „Nagraj spotkanie" — ta sama w menu aplikacji i w tacy paska.
 *
 * Jedna pozycja, dwa znaczenia, bo tak wygląda ta czynność w głowie: nie
 * ma osobnego „zacznij" i „skończ", jest przełącznik, którego napis mówi,
 * co się stanie po kliknięciu.
 */
function meetingMenuItem(t) {
  const live = !!meetings?.recording;
  return {
    label: live ? t("Zakończ spotkanie") : t("Nagraj spotkanie"),
    click: () => toggleMeeting(),
  };
}

/**
 * Włączenie albo zakończenie nagrywania, razem z tym, co trzeba o tym
 * powiedzieć. Meldunek jest osobno od samej czynności, bo `meeting.js`
 * nie ma prawa wiedzieć nic o oknach.
 */
async function toggleMeeting(about = null) {
  try {
    if (meetings.recording) {
      // Cokolwiek kończy to nagranie, po jego końcu nie ma już czego
      // kończyć razem ze zniknięciem okna rozmowy.
      startedFromSpot = false;
      disarmRoomGone();
      const { discarded, meeting, seconds, coverage } = await meetings.stop();
      if (discarded) {
        broadcast("pipeline:error", {
          stage: "spotkanie",
          message: `Nagranie trwało ${Math.round(seconds)} s i zostało odrzucone jako pomyłka.`,
        });
      } else if (meeting) {
        broadcast("meeting:done", meeting);
        /* Notatka od razu, zanim jeszcze powstanie podsumowanie: zapis
           rozmowy już jest, a to on zastępuje skasowane nagranie. Gdy
           podsumowanie dojdzie, ta sama notatka je do siebie przyjmie. */
        keepMeetingNote(meeting.id);
        /* Reszta leci SAMA i leci w tle. Czekanie na nią zablokowałoby
           przycisk „Koniec" na kilkanaście sekund — a to jest ta jedna
           chwila, w której człowiek właśnie wstaje od biurka. */
        void finishMeeting(meeting.id, coverage);
      }
      return;
    }
    /* Nagranie z menu też zasługuje na nazwę. Najpierw pytamy ekran —
       karta Google Meet niesie nazwę pokoju — a dopiero potem kalendarz. */
    const room = about ? null : await roomOnScreen();
    await meetings.start(about ?? aboutMeeting(room));
    /* ══ NAGRANIE Z RĘKI TEŻ NALEŻY DO ROZMOWY, KTÓRA STOI NA EKRANIE ══

       Bez tej linijki nagranie włączone z menu albo skrótem NIGDY nie
       kończyło się samo — a to jest najczęstszy sposób, w jaki się tu
       nagrywa. Zamiar był inny (patrz komentarz przy startedFromSpot),
       ale droga do niego prowadziła wyłącznie przez meldunek watchera,
       a ten mówi tylko o ZMIANACH: rozmowa, która stała na ekranie już
       przed włączeniem nagrania, nie zmienia się przez to w nic nowego
       i drugiego meldunku nie ma skąd wziąć.

       Pytamy więc wprost, w tej jednej chwili, w której i tak pytamy
       ekran o nazwę pokoju. Trzy drogi, którymi przychodzi `about`
       (znaczek, tryb „sam z siebie", kalendarz), ustawiają to u siebie —
       każda wie o swojej rozmowie więcej niż my tutaj. */
    if (room) startedFromSpot = true;
    /* Od tej chwili pilnowanie ekranu odpowiada na inne pytanie niż przed
       chwilą: nie „czy zaczęła się rozmowa", tylko „czy ta jeszcze trwa".
       Na to drugie nie wolno odpowiadać co pół minuty. */
    watcher?.hurry();
  } catch (problem) {
    tellError("spotkanie", problem.message);
  }
}

/**
 * Co się dzieje PO rozmowie — po kolei i bez pomijania kroków.
 *
 * ══ NAJPIERW CAŁY ZAPIS, POTEM WNIOSEK Z NIEGO ══
 *
 * Kolejność jest tu treścią, a nie porządkiem. Podsumowanie policzone
 * z dziurawego zapisu nie wygląda na dziurawe: model dostaje dwie linijki
 * z godziny zajęć i pisze z nich gładki wniosek, po którym nikt się nie
 * domyśli, że pięćdziesiąt sześć minut rozmowy nie weszło. Właśnie tak
 * wyglądały zajęcia z 31 sierpnia — notatka z porządnym podsumowaniem
 * ostatnich stu sekund i bez śladu po reszcie.
 *
 * Dlatego gdy przepisywanie w biegu czegoś nie dowiozło, rusza przebieg
 * z pliku (nagranie zostaje właśnie na tę okoliczność, patrz stop
 * w main/meeting.js) i dopiero po nim liczy się podsumowanie.
 */
async function finishMeeting(id, coverage) {
  if (coverage && !coverage.complete) {
    const meeting = store.getMeetings().find((item) => item.id === id);
    if (meeting?.tracks?.mic) {
      broadcast("pipeline:error", {
        stage: "spotkanie",
        message: `Zapis obejmuje ${Math.round(coverage.writtenSeconds / 60)} z ${Math.round(
          coverage.spokenSeconds / 60,
        )} minut — dopisuję resztę z nagrania.`,
      });
      try {
        await meetings.retranscribe(id);
        keepMeetingNote(id);
      } catch (problem) {
        // Przebieg naprawczy się nie udał — nagranie zostaje, więc jest do
        // czego wrócić. Podsumowanie liczymy mimo to: lepszy wniosek
        // z części rozmowy niż brak wniosku, o ile wiadomo, że to część.
        tellError("transkrypcja", problem.message);
      }
    }
  }

  if (store.getSettings().meetings?.summarize !== false) {
    await summarizeMeeting(id);
  }
}

/**
 * Wniosek z rozmowy — i nazwa, pod którą da się ją potem znaleźć.
 *
 * Nazwa zmienia się TYLKO wtedy, gdy nie została nadana ręką. Kto wpisał
 * własny tytuł, podjął decyzję; model nie ma jej po co poprawiać.
 */
async function summarizeMeeting(id) {
  const settings = store.getSettings();
  const meeting = store.getMeetings().find((item) => item.id === id);
  if (!meeting) return null;

  store.updateMeeting(id, { summarizing: true, summaryError: null });
  broadcast("meeting:changed", meetingState());

  try {
    /* Poprzednie spotkanie z tej samej serii. Cotygodniowy przegląd jest
       ciągiem dalszym, a nie osobną rozmową — „wracamy do budżetu" znaczy
       coś tylko wtedy, gdy wiadomo, na czym stanęło. Serię poznajemy po
       nazwie, bo tak ją widzi kalendarz. */
    const previousSummary = meeting.title
      ? (store
          .getMeetings()
          .find(
            (item) =>
              item.id !== id &&
              item.summary &&
              item.title &&
              item.title.trim().toLowerCase() === meeting.title.trim().toLowerCase(),
          )?.summary ?? null)
      : null;
    const { title, summary } = await digest({ ...meeting, previousSummary }, settings);
    const patch = { summary, summarizing: false, summaryError: null };
    /* Kod pokoju z okna przeglądarki („jxg-hfsa-qvb") nazwą nie jest —
       i to jest cały powód, dla którego ten krok w ogóle istnieje.
       Nazwy PRZEPISANEJ z okna rozmowy nie ruszamy: „Meet – Przegląd
       tygodnia" to nazwa, którą pokojowi nadał człowiek, a nie brak nazwy.
       Tak samo nie ruszamy nazwy wpisanej ręką. */
    const named = meeting.titleByHand || meeting.titleFrom === "room";
    if (settings.meetings?.rename !== false && title && !named) {
      patch.title = title;
      patch.titleFrom = "model";
    }
    store.updateMeeting(id, patch);
    // Notatka bierze wniosek do siebie — razem z nazwą, która dopiero co
    // powstała z treści rozmowy.
    keepMeetingNote(id);
    return patch;
  } catch (problem) {
    store.updateMeeting(id, { summarizing: false, summaryError: problem.message });
    tellError("podsumowanie", problem.message);
    return null;
  } finally {
    broadcast("meeting:changed", meetingState());
  }
}

/**
 * Notatka ze spotkania — zakładana i odświeżana sama po każdej rozmowie.
 *
 * Rozstrzygnięcia (czego nie wskrzeszać, czego nie nadpisywać, czego nie
 * zakładać z niczego) siedzą w main/meetnote.js i nie znają Electrona.
 * Tutaj zostaje to, czego tamten plik nie ma prawa wiedzieć: kim jest
 * właściciel konta i komu o zmianie powiedzieć.
 *
 * NIE TRAFIA DO ŻADNEJ SZUFLADY. Trafiała wcześniej — a szuflada jest
 * dziś rzeczą, do której trzeba samemu wejść (patrz notes-view.js), więc
 * notatka ze spotkania znikałaby w niej z oczu zamiast być widoczna od
 * razu. Zostaje jej to, co miała od początku i co wystarczy: rodzaj
 * „meeting”, po którym Notatnik sam składa ją do zwijanej przegródki
 * „Notatki ze spotkań” — tej samej mechaniki, którą mają „Szybkie notatki”.
 */
function keepMeetingNote(id) {
  const { note, action } = keepNote(store, id, { me: whoAmI() });
  if (action === "created") broadcast("note:new", note);
  else if (action === "updated") broadcast("note:changed", note);
  return note;
}

/* ── Wykrywanie spotkania ──────────────────────────────────────
   Rozstrzyganie, CZY na ekranie stoi rozmowa, siedzi w main/detect.js
   i nie zna Electrona. Tutaj jest reszta: skąd wziąć spis okien, co
   z odpowiedzią zrobić i komu o niej powiedzieć. */

/**
 * Imię i nazwisko właściciela konta.
 *
 * Potrzebne do jednej rzeczy: żeby w rozmowie we dwoje odróżnić w liście
 * zaproszonych siebie od tej drugiej osoby i podpisać jej imieniem drugi
 * tor (patrz speakerFor w main/merge.js). Pytamy raz — nie zmienia się.
 */
let myName = null;
function whoAmI() {
  if (myName !== null) return myName;
  try {
    myName = require("child_process").execFileSync("id", ["-F"], { encoding: "utf8" }).trim();
  } catch {
    myName = ""; // nie macOS albo konto bez pełnej nazwy
  }
  return myName;
}

/**
 * Wszystko, co wiadomo o spotkaniu, ZANIM się zacznie.
 *
 * Dwa źródła i wyraźne pierwszeństwo, ODWROTNE niż mogłoby się wydawać:
 * NAZWA Z OKNA ROZMOWY WYGRYWA. Karta Google Meet nazywa się tak, jak
 * nazwano pokój („Meet – Przegląd tygodnia") — i to jest nazwa, pod którą
 * ludzie do tej rozmowy przyszli, a nie nazwa wpisu w czyimś kalendarzu.
 * Kalendarz bywa przy tym o jedną rozmowę do tyłu: wpis trwający w tej
 * chwili nie musi być tym, co naprawdę stoi na ekranie.
 *
 * Kod pokoju nazwą nie jest i nie dochodzi tutaj wcale — odsiewa go
 * detect.js, oddając wtedy `title: null`. Kalendarz zostaje więc tym, czym
 * był: nazwą dla rozmów, które nie mają własnego okna, i jedynym źródłem
 * listy zaproszonych.
 */
function aboutMeeting(spot) {
  const live = agendaSource.running(agenda.events, Date.now());
  const people = live?.people ?? [];
  const fromRoom = spot?.title ?? null;
  return {
    title: fromRoom ?? live?.title ?? null,
    /* Skąd wzięliśmy nazwę. Nazwy przepisanej z okna rozmowy podsumowanie
       już nie zmienia (patrz summarizeMeeting): przepisanie znaczy „to się
       tak nazywa", a nie „nie mamy lepszego pomysłu". */
    titleFrom: fromRoom ? "room" : live?.title ? "calendar" : null,
    where: spot?.where ?? (live ? "Kalendarz" : null),
    people,
    speakers: people.length ? { system: speakerFor(people, whoAmI()) } : null,
  };
}

/**
 * Jedno spojrzenie na ekran, tu i teraz — na potrzeby nagrania włączonego
 * RĘKĄ.
 *
 * Pilnowanie ekranu (Watcher) chodzi tylko przy wykrywaniu włączonym
 * w ustawieniach, a wykrywanie bywa wyłączone przez ludzi, którzy nagrywają
 * spotkania z przycisku. Ich rozmowa też ma nazwę — stoi w tytule karty
 * przeglądarki — a bez tego spojrzenia zostawała bezimienna.
 *
 * ZGODY NIE WYPRASZAMY: bez „Nagrywania ekranu" nie ma czego czytać
 * i nagranie ruszy bez nazwy, tak jak dotąd.
 */
async function roomOnScreen() {
  if (spotted) return spotted;
  if (!canSeeScreen()) return null;
  try {
    return spotMeeting(await screenWindows());
  } catch {
    return null; // odmowa zgody albo system w złym humorze — nazwa nie jest tego warta
  }
}

/** Rozmowa wykryta, o którą jeszcze nie zapytano (albo zapytano i czeka). */
let spotted = null;
let watcher = null;
/* ══ CZY TO NAGRANIE NALEŻY DO WYKRYTEJ ROZMOWY ══

   Tylko takie wolno zakończyć razem ze zniknięciem jej okna.

   Wcześniej znaczyło to „ruszyło OD wykrytej rozmowy" i była to granica
   za wąska. Kto włączył nagranie ręką — z menu albo skrótem — w trakcie
   rozmowy, którą aplikacja miała na oku, nie dostawał zakończenia razem
   z nią: rozmowa się kończyła, okno znikało, a nagranie szło dalej do
   wieczora. A to jest najczęstszy sposób, w jaki się tu nagrywa.

   Dziś liczy się WSPÓŁBIEŻNOŚĆ: jeżeli w trakcie nagrywania na ekranie
   stała rozmowa, to nagranie jest jej nagraniem — nieważne, co je włączyło.
   Nagranie zrobione bez żadnej rozmowy na ekranie (dyktafon na spotkaniu
   przy stole) nie jest niczyje i nikt go nie zgasi. */
let startedFromSpot = false;
/* Czy człowiek odmówił nagrywania TEJ rozmowy. Gaśnie razem z jej oknem —
   patrz answerMeeting i meetingSpotted. */
let refusedRoom = false;
/* Odliczanie od zniknięcia okna rozmowy do zakończenia nagrania. */
let roomGoneTimer = null;
/* Od kiedy okna nie widać. Odliczanie potrafi się przedłużyć — bo słychać
   jeszcze rozmowę — a przedłużanie musi mieć koniec (patrz ROOM_GONE_LIMIT). */
let roomGoneSince = 0;

/**
 * Ile czekamy od zniknięcia okna rozmowy do zakończenia nagrania.
 *
 * Watcher melduje zniknięcie dopiero za drugim spojrzeniem, czyli po
 * kilkunastu sekundach — i to wystarcza na przeładowaną kartę. Nie
 * wystarcza na to, co zdarza się naprawdę: wyjście do poczekalni, przejście
 * do pokoju pobocznego, przelogowanie się na inne konto Google w trakcie
 * rozmowy. Wtedy okno znika i wraca po pół minuty.
 *
 * Nagranie ucięte w środku rozmowy jest jedyną stratą w tej aplikacji,
 * której nie da się cofnąć, więc czekamy na drugie potwierdzenie. Minuta
 * nagrania pustego pokoju kosztuje kilka groszy i jedno zdanie w zapisie.
 */
const GRACE = 60_000;

/**
 * Jak długo najdłużej można odwlekać koniec, bo coś jeszcze słychać.
 *
 * Odwlekanie po dźwięku (patrz armRoomGone) jest zabezpieczeniem przed
 * uciętym nagraniem, ale samo w sobie ma dziurę: mikrofon w pokoju
 * z wentylatorem albo przy ulicy słyszy COŚ przez cały czas, a wtedy
 * „jeszcze słychać rozmowę" znaczyłoby „nigdy nie kończymy" — czyli
 * dokładnie tę awarię, przed którą kończenie po oknie miało chronić.
 *
 * Kwadrans, bo tyle wystarcza na najdłuższe realne wyjście do innej karty,
 * a po kwadransie bez okna rozmowy na ekranie nagranie i tak nie jest już
 * nagraniem spotkania.
 */
const ROOM_GONE_LIMIT = 900_000;

/** Wszystko, co znaczek i okno wiedzą o spotkaniach — jedną wiadomością.

    Razem, a nie osobno, bo znaczek rysuje z tego JEDEN stan: albo pyta,
    albo nagrywa, albo nie robi żadnej z tych dwóch rzeczy. Dwa kanały
    znaczyłyby dwa meldunki w różnej kolejności i migotanie na styku. */
function meetingState() {
  return {
    ...meetings.state,
    spotted,
    /* Kalendarz jedzie tą samą wiadomością, bo zakładka rysuje z tego
       jeden widok: co trwa, co zaraz będzie i o co pyta znaczek. */
    agenda: {
      access: agenda.access,
      events: agendaSource.upcoming(agenda.events, Date.now()),
      armed: store.getSettings().meetings?.armed ?? [],
    },
  };
}

function tellMeetings() {
  broadcast("meeting:changed", meetingState());
  applyMeetingTray();
}

/**
 * Spis okien stojących na ekranie — same tytuły.
 *
 * Miniatury zamawiamy zerowe, a ikon nie zamawiamy wcale: nie robimy
 * zrzutu ekranu, tylko czytamy napisy z belek. Bez tego każde spojrzenie
 * (co osiem sekund) rysowałoby obrazek każdego okna w systemie.
 *
 * Wymaga zgody „Nagrywanie ekranu". Bez niej spis wraca pusty i wykrywanie
 * po prostu nic nie znajduje.
 *
 * TO JEST DZIŚ JEDYNA RZECZ W APLIKACJI, KTÓRA TEJ ZGODY POTRZEBUJE.
 * Dawniej dzieliła ją z nagrywaniem dźwięku spotkania (oba szły przez
 * ScreenCaptureKit) — od migracji na Core Audio Process Tap (patrz nagłówek
 * native/tap/main.swift) nagrywanie ma WŁASNĄ, osobną zgodę i tej tu już
 * nie dotyka. Stąd applyDetect musi dziś sam poprosić o „Nagrywanie ekranu"
 * w chwili, w której ktoś włącza wykrywanie — nie ma już innej drogi,
 * którą ta zgoda mogłaby się pojawić.
 */
async function screenWindows() {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.map((source) => source.name);
}

/**
 * Rozmowa pojawiła się albo zniknęła.
 *
 * Pytanie znika razem z rozmową i to jest zamierzone: znaczek dopominający
 * się o notatki z rozmowy, która skończyła się kwadrans temu, pytałby
 * o przeszłość. NAGRANIE natomiast zostaje — patrz komentarz w detect.js
 * o tym, dlaczego nie kończymy go automatycznie.
 */
async function meetingSpotted(meeting) {
  if (!meeting) {
    /* ══ KONIEC ROZMOWY ══

       Okno rozmowy zniknęło. Jeżeli nagranie należy do tej rozmowy, to
       jest właśnie ten moment, w którym się skończyła — i nagranie ma się
       skończyć razem z nią. Bez tego wykryte spotkanie nagrywałoby się do
       wieczora.

       ALE NIE OD RAZU. Zniknięcie okna potwierdzamy minutą (patrz GRACE):
       poczekalnia, pokój poboczny i przeładowana karta wyglądają z tej
       strony dokładnie tak samo jak wyjście z rozmowy, a nagranie ucięte
       w połowie jest stratą nieodwracalną. */
    if (meetings.recording && startedFromSpot) {
      if (store.getSettings().meetings?.stopWithMeeting !== false) armRoomGone();
    }
    /* Rozmowa naprawdę zeszła z ekranu — odmowa dotyczyła jej, więc razem
       z nią przestaje obowiązywać. Następna rozmowa pyta od nowa. */
    refusedRoom = false;
    if (!spotted) return;
    spotted = null;
    tellMeetings();
    return;
  }

  /* Rozmowa stoi na ekranie — więc jeżeli cokolwiek się nagrywa, nagrywa
     się WŁAŚNIE JĄ. Nieważne, czy nagranie włączyło wykrywanie, czy ręka:
     od tej chwili skończy się razem z nią. */
  disarmRoomGone();
  if (meetings.recording) {
    startedFromSpot = true;
    return; // nagrywamy już — nie ma o co pytać
  }

  const how = store.getSettings().meetings?.detect ?? "ask";
  if (how === "auto" && refusedRoom) return; // odmowa wiąże także tryb bez pytania
  if (how === "auto") {
    /* Bez pytania znaczy też: bez wywoływania okna na wierzch. Kto wybrał
       „sam z siebie", wybrał niewidzialność — dowodem, że nagranie ruszyło,
       jest znaczek i znak w pasku menu. */
    startedFromSpot = true;
    await toggleMeeting(aboutMeeting(meeting));
    return;
  }
  if (how !== "ask") return;
  // Odmówiono przy tej rozmowie — nagrywanie zostaje wyłącznie z ręki.
  if (refusedRoom) return;
  spotted = meeting;
  tellMeetings();
}

/**
 * Odliczanie po zniknięciu okna rozmowy.
 *
 * ══ DLACZEGO ZEGAR, A NIE KOLEJNY MELDUNEK ══
 *
 * Watcher mówi o zniknięciu DOKŁADNIE RAZ: po drugim nieudanym spojrzeniu
 * zeruje swój stan i od tej chwili milczy, bo nie ma już czego zgubić.
 * Karencja odmierzana z meldunków nigdy by więc nie dobiegła końca —
 * drugi meldunek nie przyszedłby nigdy.
 *
 * Zegar zagląda więc na ekran SAM, jeden raz, po minucie. I to jest lepsze
 * niż liczenie meldunków także z drugiego powodu: sprawdza stan faktyczny
 * w chwili decyzji, a nie to, co było widać minutę wcześniej.
 */
function armRoomGone() {
  if (roomGoneTimer) return; // odliczanie już biegnie
  if (!roomGoneSince) roomGoneSince = Date.now();
  roomGoneTimer = setTimeout(async () => {
    roomGoneTimer = null;
    if (!meetings.recording || !startedFromSpot) return;
    if (await roomStillOnScreen()) return; // wrócili z poczekalni

    /* ══ OKNO ZNIKŁO, ALE CZY ROZMOWA? ══

       Spis okien pokazuje tytuł AKTYWNEJ KARTY, nie wszystkich otwartych.
       Przełączenie się w przeglądarce na inną kartę — dokument, kalendarz,
       cokolwiek, po co sięga się w trakcie rozmowy — wygląda stąd
       DOKŁADNIE tak samo jak wyjście ze spotkania: „Meet – …" znika
       z listy okien i nie wraca, dopóki ktoś nie kliknie tamtej karty
       z powrotem.

       Nagranie ucięte w takiej chwili jest stratą nieodwracalną, więc
       pytamy jeszcze o jedno — i pytamy o to, co naprawdę rozstrzyga:
       CZY KTOŚ MÓWI. Dźwięku nie da się pomylić z układem kart. Dopóki
       w którymkolwiek torze coś słychać, rozmowa trwa; odliczanie zaczyna
       się wtedy od nowa.

       Cisza dłuższa niż karencja rozstrzyga w drugą stronę: nikogo nie ma
       na ekranie i nikogo nie słychać. */
    if (meetings.quietSeconds * 1000 < GRACE && Date.now() - roomGoneSince < ROOM_GONE_LIMIT) {
      armRoomGone();
      return;
    }
    await endWithRoom(
      meetings.quietSeconds * 1000 < GRACE
        ? "okna rozmowy nie ma na ekranie od kwadransa"
        : "okno rozmowy zniknęło i od minuty nikt nic nie mówi",
    );
  }, GRACE);
}

function disarmRoomGone() {
  clearTimeout(roomGoneTimer);
  roomGoneTimer = null;
  roomGoneSince = 0;
}

/**
 * Czy rozmowa NADAL stoi na ekranie — pytane wprost, bez pamięci.
 *
 * Niepewność liczy się tu na korzyść nagrania: gdy nie wolno nam patrzeć
 * albo spis okien się wywrócił, odpowiadamy „stoi". Nagranie ucięte przez
 * odmowę zgody byłoby stratą wywołaną brakiem wiedzy, a nie wiedzą.
 */
async function roomStillOnScreen() {
  if (!canSeeScreen()) return true;
  try {
    return !!spotMeeting(await screenWindows());
  } catch {
    return true;
  }
}

/**
 * Koniec nagrania, o którym zdecydowała rozmowa, a nie człowiek.
 *
 * Trzy drogi prowadzą tutaj i wszystkie znaczą to samo — „rozmowy już nie
 * ma": zniknęło jej okno, zamilkły oba tory na dziesięć minut albo komputer
 * poszedł spać. Meldunek jest jeden i mówi, po czym poznaliśmy, bo
 * nagranie, które kończy się samo, musi umieć powiedzieć dlaczego.
 */
async function endWithRoom(why) {
  if (!meetings.recording) return;
  disarmRoomGone();
  startedFromSpot = false;
  broadcast("pipeline:error", {
    stage: "spotkanie",
    message: `Spotkanie zakończone samo — ${why}.`,
  });
  await toggleMeeting();
}

/**
 * Odpowiedź na pytanie znaczka.
 *
 * „Tak" wywołuje okno na zakładkę Spotkania — bo od tej chwili jest tam co
 * oglądać, a człowiek właśnie powiedział, że chce te notatki mieć. „Nie"
 * chowa pytanie do końca tej rozmowy: to samo pytanie zadane drugi raz
 * w trakcie tego samego spotkania byłoby dopominaniem się.
 */
async function answerMeeting(yes) {
  const meeting = spotted;
  spotted = null;
  tellMeetings();
  if (!yes || !meeting) {
    /* ══ „NIE NAGRYWAJ" ZNACZY NIE, A NIE „NIE TERAZ" ══

       Samo wyzerowanie `spotted` chowało pytanie na tyle długo, ile trwało
       jedno spojrzenie watchera — czyli osiem sekund. Potem tytuł okna
       rozmowy drgał (Google Meet dopisuje do niego liczbę uczestników
       i wyciszenie), watcher uznawał to za NOWĄ rozmowę i pytał jeszcze
       raz. Odmowa co osiem sekund przez godzinę zajęć.

       Odmowa zostaje więc zapamiętana do KOŃCA TEJ ROZMOWY: dopóki okno
       rozmowy stoi na ekranie, nikt o nic nie pyta, a nagrywanie zostaje
       dostępne wyłącznie z ręki — z tacy, z menu i skrótem. Pamięć gaśnie
       dopiero wtedy, gdy rozmowa naprawdę zniknie z ekranu (patrz
       meetingSpotted) — czyli następna rozmowa pyta od nowa. */
    refusedRoom = true;
    return false;
  }
  startedFromSpot = true;
  await toggleMeeting(aboutMeeting(meeting));
  createMainWindow().webContents.send("view:go", "meetings");
  return true;
}

/* ── Kalendarz ─────────────────────────────────────────────────
   Wykrywanie po oknach mówi, że rozmowa TRWA. Kalendarz mówi, co ma się
   zacząć — i jako jedyny zna nazwę spotkania, zanim ono się zacznie.
   Rozstrzygnięcia („czy ten wpis to w ogóle rozmowa") siedzą w agenda.js
   i nie znają Electrona. */

/** Co widać w kalendarzu i jaki był stan zgody. */
let agenda = { access: "unknown", events: [] };
let agendaWatch = null;
/** Kiedy patrzyliśmy ostatnio — do pytania „co ruszyło od tamtej pory". */
let agendaSeenAt = null;

/**
 * Jak często pytamy kalendarz w tle.
 *
 * Nie minuta. Samo zapytanie (patrz main/calendar-osa.js) zmierzone na
 * koncie z dziesięcioma kalendarzami trwa 15–40 sekund — a przy odstępie
 * jednej minuty dwa takie zapytania potrafiłyby się nałożyć. Kalendarz.app
 * SERIALIZUJE żądania Apple Events wewnętrznie (zmierzone: dziesięć
 * zapytań puszczonych naraz trwało DŁUŻEJ niż te same dziesięć puszczone
 * po kolei), więc nałożenie się dwóch odczytów nie przyspiesza niczego —
 * tylko podwaja czas, aż oba przekroczą PATIENCE i oba przepadną.
 *
 * Trzy minuty dają zapas nawet przy najwolniejszym zmierzonym przebiegu,
 * a `GRACE` w main/agenda.js (dziesięć minut tolerancji na spóźniony
 * start) i tak nie wymaga częstszego spojrzenia.
 */
const AGENDA_EVERY = 180_000;

/* Zapytanie trwa do kilkudziesięciu sekund — zegar w tle potrafi więc
   odpalić następne, zanim poprzednie wróci. Bez tej blokady dwa
   nakładające się zapytania do Kalendarz.app spowalniają się nawzajem
   (patrz komentarz przy AGENDA_EVERY) i żadne nie zdąży na czas. */
let agendaBusy = false;

async function lookAtAgenda({ force = false, patience } = {}) {
  const settings = store.getSettings();
  /* `force` znaczy: pytam, bo człowiek właśnie kliknął. Wtedy ustawienie
     „Pokaż kalendarz" nie ma nic do rzeczy — kliknięcie JEST włączeniem.
     Kliknięcie też ma prawo wejść PRZED zapytaniem w tle, które akurat
     trwa — człowiek czeka na odpowiedź, tło może poczekać na następną
     turę. */
  if (!force && !settings.meetings?.calendar) return;
  if (!force && agendaBusy) return;

  agendaBusy = true;
  let fresh;
  try {
    /* `force` znaczy „człowiek kliknął" — i tylko wtedy wolno obudzić
       Kalendarz.app oraz czekać minutami na okno zgody. */
    fresh = await agendaSource.read(
      force ? { patience: patience ?? undefined, launch: true } : {},
    );
  } finally {
    agendaBusy = false;
  }
  agenda = fresh;
  const now = Date.now();
  const started = agendaSource.justStarted(fresh.events, now, { since: agendaSeenAt });
  agendaSeenAt = now;
  broadcast("meeting:changed", meetingState());

  if (meetings.recording) return;

  /* Wpis, przy którym powiedziano „notuj", zaczyna się sam. Reszta idzie
     zwykłą drogą wykrywania — czyli pytaniem znaczka, gdy na ekranie
     naprawdę pojawi się okno rozmowy. Kalendarz mówi tylko, że coś MIAŁO
     się zacząć; to, czy się zaczęło, widać po oknie. */
  const armed = new Set(settings.meetings?.armed ?? []);
  const mine = started.find((event) => armed.has(event.id));
  if (!mine) return;

  startedFromSpot = true;
  await toggleMeeting({
    ...aboutMeeting(null),
    title: mine.title,
    titleFrom: "calendar",
    where: "Kalendarz",
  });
}

function watchAgenda(settings = store.getSettings()) {
  clearInterval(agendaWatch);
  agendaWatch = null;
  if (!settings.meetings?.calendar) {
    agenda = { access: "unknown", events: [] };
    agendaSeenAt = null;
    return;
  }
  agendaWatch = setInterval(() => void lookAtAgenda(), AGENDA_EVERY);
  void lookAtAgenda();
}

/**
 * Pilnowanie ekranu włącza się i wyłącza razem z ustawieniem.
 *
 * TA FUNKCJA SAMA O ZGODĘ NIE PROSI. Wywoływana z uśpienia, z odblokowania
 * ekranu czy przy starcie aplikacji, prosiłaby o „Nagrywanie ekranu" przy
 * PIERWSZYM URUCHOMIENIU — zanim ktokolwiek w ogóle otworzył zakładkę
 * Spotkania. Dopóki zgody nie ma, wykrywanie po prostu śpi.
 *
 * O ZGODĘ PROSI TEN, KTO WŁĄCZA USTAWIENIE — patrz „settings:save" niżej,
 * dokładnie przy `patch.meetings?.detect`. To jest dziś JEDYNA droga, którą
 * ta zgoda może się pojawić: nagrywanie dźwięku spotkania nie idzie już
 * przez ScreenCaptureKit (patrz nagłówek native/tap/main.swift) i nie
 * prosi o nią przy okazji, tak jak robiło to dawniej.
 */
function applyDetect(settings = store.getSettings()) {
  const how = settings.meetings?.detect ?? "ask";
  if (how === "off" || !canSeeScreen()) {
    watcher?.stop();
    return;
  }
  if (!watcher) {
    watcher = new MeetingWatcher({
      list: screenWindows,
      onChange: (meeting) => void meetingSpotted(meeting),
      /* Awaria to prawie zawsze odmowa zgody „Nagrywanie ekranu". Nie ma
         co o niej krzyczeć przy każdym spojrzeniu — nagrywanie spotkania
         i tak powie o niej wprost, gdy ktoś je włączy. */
      onError: () => {},
    });
  }
  watcher.start();
}

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
        /* Ta sama funkcja, drugie wejście — i dlatego stoi tuż obok,
           a nie w osobnym miejscu menu. Obrazek, który już leży na dysku,
           nie ma powodu przechodzić przez ekran. */
        { label: `${t("Tekst z obrazka")}…`, click: () => readImageFile() },
        { type: "separator" },
        { label: t("Notatnik"), accelerator: "Command+Shift+O", click: () => createNotesWindow() },
        { type: "separator" },
        {
          label: t("Dyktuj"),
          accelerator: "Command+D",
          click: () => toggleCapture("menu"),
        },
        /* Bez klawiszy i to jest decyzja: spotkanie zaczyna się raz na
           godzinę, a skrót zajęty na zawsze kosztuje tyle samo co używany
           co chwilę. Klawisze dostanie, gdy będzie o co prosić. */
        meetingMenuItem(t),
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
        { label: t("Notatki"), accelerator: "Command+2", click: go("notes") },
        { label: t("Funkcja sita"), accelerator: "Command+3", click: go("sieve") },
        { label: t("Ziarna"), accelerator: "Command+4", click: go("grains") },
        { label: t("Ustawienia"), accelerator: "Command+5", click: go("settings") },
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
    tellSettings();
    refreshMenus();
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("Otwórz Cribro Sift"), click: () => createMainWindow() },
      { label: t("Start"), click: () => createMainWindow().webContents.send("view:go", "start") },
      { label: t("Notatnik"), click: () => createNotesWindow() },
      { label: t("Szybka notatka"), click: () => quickNote() },
      { label: `${t("Tekst z ekranu")}…`, click: () => grabScreenText() },
      { label: `${t("Tekst z obrazka")}…`, click: () => readImageFile() },
      meetingMenuItem(t),
      /* Poranek pokazuje się sam raz dziennie, ale bywa zamknięty odruchowo
         razem z resztą okien — a wtedy jedyną drogą z powrotem byłoby
         czekanie do jutra. Pozycja pojawia się wyłącznie wtedy, gdy poranek
         jest włączony i podłączony: menu nie ma prawa wystawiać czegoś,
         co po kliknięciu powie „nie mam konta". */
      ...(briefingMine() ? [{ label: t("Poranek"), click: () => void showBriefing({ force: true }) }] : []),
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
            tellSettings();
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
          tellSettings();
        },
      },
      { type: "separator" },
      { label: t("Zakończ"), role: "quit" },
    ]),
  );
}


/* ── Poranek ───────────────────────────────────────────────────

   Jedno okno raz dziennie, przy pierwszym siadaniu do komputera: co
   w poczcie wymaga uwagi i co jest w planie dnia. Rozstrzygnięcia — które
   maile, w jakiej kolejności i dlaczego — siedzą osobno, w main/briefing.js,
   i są sprawdzane bez sieci (scripts/briefing-test.js). Tutaj zostaje to,
   czego tamten plik nie widzi: konto, kalendarz, okno i pora.

   ══ DLACZEGO TO JEST PRZYPISANE DO JEDNEGO KONTA ══

   Poranek czyta CUDZĄ POCZTĘ — cudzą w tym sensie, że nie należy do
   aplikacji, tylko do człowieka przy klawiaturze. Dlatego pokazuje się
   wyłącznie wtedy, gdy podłączone konto Google zgadza się z adresem
   zapisanym w ustawieniach jako właściciel. Zalogowanie innego konta nie
   przełącza poranka na inną skrzynkę — odmawia i mówi dlaczego.

   Prawdziwa granica leży zresztą wcześniej i nie jest w naszych rękach:
   klient OAuth zakłada użytkownik u siebie, a klient w trybie „Testing"
   z jednym adresem na liście testerów nie wpuści nikogo innego (patrz
   main/google.js).

   ══ KIEDY SIĘ POKAZUJE ══

   „Pierwsze zalogowanie w ciągu dnia" ma w macOS dwa różne znaczenia i oba
   trzeba obsłużyć, bo aplikacja żyje w pasku menu i bywa włączona tygodniami:

     PIERWSZE URUCHOMIENIE   komputer był wyłączony, aplikacja wstaje razem
                             z sesją.
     PIERWSZE ODBLOKOWANIE   komputer stał uśpiony, aplikacja przeżyła noc.

   Obie drogi pytają o to samo (patrz `due` w main/briefing.js): czy dziś
   ktoś już ten poranek widział. Data ostatniego pokazania leży
   w ustawieniach, więc przeżywa jedno i drugie. */

let google = null;
let briefingWindow = null;
let briefingBusy = false;

const briefingConfig = () => store.getSettings().briefing ?? {};

/**
 * Czy poranek jest dla tego, kto siedzi przy komputerze.
 *
 * Trzy warunki i wszystkie trzy są konieczne: ma być włączony, ma mieć
 * właściciela i podłączone konto ma być właśnie jego.
 */
function briefingMine() {
  const config = briefingConfig();
  if (!config.enabled) return false;
  const owner = String(config.owner ?? "").trim().toLowerCase();
  if (!owner) return false;
  google?.restore();
  const account = String(google?.snapshot().email ?? "").toLowerCase();
  return !!account && account === owner;
}

/** Stan poranka dla interfejsu — bez sekretów, z powodem, gdy nie działa. */
function briefingState() {
  const config = briefingConfig();
  google?.restore();
  const account = google?.snapshot() ?? { configured: false, signedIn: false, email: null };
  const owner = String(config.owner ?? "").trim();
  return {
    enabled: !!config.enabled,
    owner,
    feeds: config.feeds ?? [],
    lastAt: config.lastAt ?? null,
    account,
    /* „Cudze konto" to osobny stan, a nie błąd logowania: zalogowanie się
       udało, tylko nie temu, do kogo ten poranek należy. */
    mismatch:
      !!account.email && !!owner && account.email.toLowerCase() !== owner.toLowerCase(),
  };
}

/**
 * Materiał na poranek: poczta, plan dnia, kanały — i zdanie od sita.
 *
 * Każde z trzech źródeł ma prawo zawieść SAMO. Kalendarz bez zgody, konto
 * bez sieci, kanał, który milczy — żadne z tego nie może zabrać całego
 * okna, bo pozostałe dwie rzeczy nadal są warte pokazania. Dlatego każdy
 * kawałek łapie swój błąd i oddaje go jako tekst obok treści.
 */
async function gatherBriefing() {
  const settings = store.getSettings();
  const config = settings.briefing ?? {};
  const now = new Date();
  const problems = [];

  /* Kalendarz sięga od północy, a nie od „teraz": poranek otwarty
     o czternastej ma opisać cały dzień, także to, co już było. */
  const sinceMidnight = now.getHours() + now.getMinutes() / 60;
  let plan = briefingSource.dayPlan([], now);
  try {
    const read = await agendaSource.read({ hours: 24, back: Math.max(1, sinceMidnight) });
    if (read.access === "granted") plan = briefingSource.dayPlan(read.events, now);
    /* Każdy stan poza „granted" znaczy tu to samo: planu dnia nie będzie.
       Mówimy o tym RÓŻNIE, bo różne są wyjścia — „nie pytano" naprawia się
       jednym kliknięciem w zakładce Spotkania, „odmówiono" wymaga wizyty
       w Ustawieniach systemowych. Wcześniej stan „nie pytano" nie mówił tu
       nic i poranek milczał o brakującym planie dnia. */
    else if (read.access === "denied") {
      problems.push("Brak zgody na czytanie Kalendarza — przyznaj ją w zakładce Spotkania.");
    } else if (read.access === "notDetermined") {
      problems.push("Kalendarz nie był jeszcze pytany o zgodę — poproś o nią w zakładce Spotkania.");
    } else if (read.access === "restricted") {
      problems.push("Kalendarz jest zablokowany zasadami tego komputera.");
    } else if (read.access === "timeout") {
      problems.push("Kalendarz nie odpowiedział na czas.");
    }
  } catch (error) {
    problems.push(`Kalendarz: ${error.message}`);
  }

  let picks = [];
  try {
    const mails = await google.mail({ days: 7 });
    picks = briefingSource.needsAttention(mails, {
      plan,
      owner: google.snapshot().email ?? config.owner,
      now,
    });
  } catch (error) {
    problems.push(`Poczta: ${error.message}`);
  }

  let feeds = [];
  try {
    feeds = await headlines(config.feeds ?? [], { now: now.getTime() });
  } catch (error) {
    problems.push(`Kanały: ${error.message}`);
  }

  /* Zdanie od sita jest DODATKIEM, nie treścią. Lista maili i plan dnia są
     kompletne bez niego — model dokłada do nich jedno zdanie na pozycję.
     Dlatego brak klucza albo odmowa dostawcy nie może zabrać okna. */
  let words = null;
  try {
    const provider = settings.sieve?.provider ?? "gemini";
    const apiKey = keyFor(provider, settings);
    if (apiKey || provider === "mock") {
      const { system, user } = briefingSource.buildPrompt({ picks, plan, feeds, now });
      const raw = await sendToModel({
        provider,
        model: settings.sieve?.model,
        apiKey,
        system,
        user,
      });
      words = briefingSource.readAnswer(raw);
    }
  } catch (error) {
    problems.push(`Sito: ${error.message}`);
  }

  return {
    at: now.toISOString(),
    owner: config.owner ?? "",
    plan,
    picks,
    feeds,
    words,
    problems,
  };
}

/** Okno poranka. Jedno na raz — drugie byłoby drugim tym samym. */
function openBriefingWindow() {
  if (briefingWindow && !briefingWindow.isDestroyed()) {
    briefingWindow.show();
    briefingWindow.focus();
    return briefingWindow;
  }

  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(880, Math.round(workArea.width * 0.62));
  const height = Math.min(720, Math.round(workArea.height * 0.78));

  briefingWindow = new BrowserWindow({
    width,
    height,
    minWidth: 520,
    minHeight: 420,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2.6),
    show: false,
    backgroundColor: "#09101c", // --bg
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  markAppWindow(briefingWindow);
  briefingWindow.loadFile(path.join(__dirname, "..", "renderer", "briefing.html"));
  briefingWindow.once("ready-to-show", () => briefingWindow.show());
  briefingWindow.on("closed", () => (briefingWindow = null));
  return briefingWindow;
}

/**
 * Pokazanie poranka.
 *
 * @param {object}  options
 * @param {boolean} [options.force] z menu albo z Ustawień — bez pytania o porę
 */
async function showBriefing({ force = false } = {}) {
  if (briefingBusy) return false;
  if (!briefingMine()) return false;
  const config = briefingConfig();
  if (!force && !briefingSource.due({ lastAt: config.lastAt, now: new Date(), notBefore: config.notBefore ?? 4 })) {
    return false;
  }

  briefingBusy = true;
  const win = openBriefingWindow();
  try {
    const data = await gatherBriefing();
    if (!win.isDestroyed()) win.webContents.send("briefing:data", data);
    /* Datę zapisujemy DOPIERO PO ZEBRANIU materiału. Zapisana wcześniej
       oznaczałaby dzień jako „już pokazany" także wtedy, gdy zbieranie
       padło i człowiek nie zobaczył niczego. */
    store.saveSettings({ briefing: { lastAt: new Date().toISOString() } });
    tellSettings();
  } catch (error) {
    if (!win.isDestroyed()) {
      win.webContents.send("briefing:data", { problems: [error.message], picks: [], feeds: [] });
    }
  } finally {
    briefingBusy = false;
  }
  return true;
}

/**
 * Pilnowanie pory.
 *
 * Zegar co kwadrans, a nie o stałej godzinie: komputer bywa włączany
 * o różnych porach, a poranek ma się pokazać przy PIERWSZYM siadaniu do
 * niego, nie o ósmej. Pytanie „czy dziś już był" jest tanie (porównanie
 * dwóch dat), więc może padać często.
 */
let briefingClock = null;
function watchBriefing() {
  clearInterval(briefingClock);
  briefingClock = null;
  if (!briefingConfig().enabled) return;
  briefingClock = setInterval(() => void showBriefing(), 15 * 60 * 1000);
  // Odblokowanie ekranu to drugie „zalogowanie się do komputera" — patrz
  // komentarz na górze sekcji.
  void showBriefing();
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
  tellSettings(settings);
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

/* ── Czyja to instalacja ────────────────────────────────────────
   Krok „Silniki" — dostawca, model, klucz — należy do właściciela i tylko
   on go widzi. Dlaczego akurat tak i czym to NIE jest, mówi nagłówek
   main/owner.js. Tutaj są trzy rzeczy: kto pyta, co mu wolno zobaczyć
   i czym to wysyłamy. */

/** Czy ta instalacja należy do właściciela. */
function ownerHere() {
  return ownership.isOwner({
    email: cloud?.user?.email ?? null,
    userData: app.getPath("userData"),
  });
}

/** Czy ten krok potoku ma czym działać — bez mówienia, czym. */
function engineReady(stage, settings = store.getSettings()) {
  const step = settings[stage] ?? {};
  if (!step.provider) return false;
  if (step.provider === "mock") return true;
  return !!keyFor(step.provider, settings);
}

/**
 * Ustawienia w postaci, w której wolno je pokazać temu, kto pyta.
 *
 * JEDYNA droga ustawień do renderera. Nie ma drugiej i nie może być:
 * `store.getSettings()` wysłane wprost jest wyciekiem klucza, a klucz
 * w odpowiedzi mostu leży w oknie, którego nikt już potem nie sprawdza.
 */
/* ══ CO WOLNO POKAZAĆ TEMU KONTU ══

   Kody funkcji, które serwer wpuścił dla zalogowanego użytkownika (patrz
   main/admin.js). `null` znaczy „nie pytaliśmy albo nie było jak zapytać"
   i wtedy widać wszystko — decyzją jest wyłączenie, nie milczenie. */
let myFeatures = null;

/**
 * Ponowne pytanie serwera, co temu kontu wolno.
 *
 * Woła się to przy starcie, po zalogowaniu i po przestawieniu przełącznika
 * w panelu — czyli w tych trzech chwilach, w których odpowiedź może się
 * zmienić. Nie w kółko: to jest żądanie sieciowe, a stan zmienia się raz
 * na tygodnie.
 */
async function refreshFeatures() {
  const before = JSON.stringify(myFeatures);
  myFeatures = await admin.mine(cloud);
  if (JSON.stringify(myFeatures) !== before) tellSettings();
  return myFeatures;
}

function visibleSettings(settings = store.getSettings()) {
  const shown = ownership.publicSettings(settings, ownerHere(), (stage) =>
    engineReady(stage, settings),
  );
  return {
    ...shown,
    /* Czego w tym oknie nie ma. Renderer dostaje gotową odpowiedź, a nie
       regułę do policzenia — reguła („on / off / tylko zaproszeni") mieszka
       w bazie i ma mieszkać w jednym miejscu. */
    features: Object.fromEntries(
      admin.FEATURES.map((item) => [item.code, admin.allowed(myFeatures, item.code)]),
    ),
  };
}

/** Zmiana ustawień do wszystkich okien — zawsze w postaci publicznej. */
function tellSettings(settings = store.getSettings()) {
  broadcast("settings:changed", visibleSettings(settings));
}

/**
 * Awaria do okna — bez nazw dostawców i modeli.
 *
 * Komunikat błędu potrafi powiedzieć więcej niż całe Ustawienia: dość, że
 * raz padnie „Brak klucza API dla dostawcy «gemini»". Patrz scrub
 * w main/owner.js.
 */
function tellError(stage, message) {
  broadcast("pipeline:error", { stage, message: ownership.scrub(message, ownerHere()) });
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

/**
 * Znak nagrywania spotkania w pasku menu.
 *
 * Ustawiany osobno od setState, bo spotkanie i dyktowanie to dwa niezależne
 * stany tej samej aplikacji. Dyktowanie ma pierwszeństwo: trwa kilkanaście
 * sekund i to o nim mówi pigułka, a spotkanie i tak trwa dalej pod spodem.
 */
function applyMeetingTray() {
  if (!tray || state !== "idle") return;
  const live = !!meetings?.recording;
  tray.setImage(trayIcon(live ? "meeting" : "idle"));
  tray.setToolTip(live ? TRAY_TOOLTIP.meeting : TRAY_TOOLTIP.idle);
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
    // Dyktowanie skończone, ale spotkanie mogło się nie skończyć — znak
    // w pasku menu ma wtedy wrócić na fiolet, a nie zgasnąć.
    applyMeetingTray();
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
    tellError(stage, message);
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
     więc skróty własne rejestrujemy PO nim. Odwrotnie znikałyby przy
     każdym przepięciu klawiszy dyktowania — cicho, bez śladu. */
  bindShotHotkey();
  bindQuickNoteHotkey();
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
/** Czy klawisze do zrzutu są w tej chwili nasze. Dla Ustawień i dla
    komunikatu, gdy okazuje się, że nie są. */
let shotHotkeyHeld = null;

function bindShotHotkey() {
  const accelerator = store.getSettings().shot?.hotkey;
  shotHotkeyHeld = null;
  if (!accelerator) return false;

  let held = false;
  try {
    held = globalShortcut.register(accelerator, () => grabScreenText());
  } catch {
    // Zapis, którego Electron nie rozumie („Cmd+”, sam modyfikator).
    held = false;
  }
  shotHotkeyHeld = held;

  /* Nieudana rejestracja to jedyny sposób, w jaki ta funkcja może umrzeć
     po cichu: klawisze zajął ktoś inny, a aplikacja wygląda na sprawną.
     Mówimy o tym raz, zamiast zostawiać człowieka z pytaniem, czemu nic
     się nie dzieje. */
  if (!held) {
    broadcast("pipeline:error", {
      stage: "zrzut",
      message: `Skrót ${accelerator} do tekstu z ekranu jest zajęty przez inną aplikację — wybierz inny w Ustawieniach.`,
    });
  }
  return held;
}

/**
 * Skrót do szybkiej notatki.
 *
 * Domyślnie nie ma go wcale, tak samo jak przy zrzucie i z tego samego
 * powodu: klawisze wybrane za użytkownika byłyby albo zajęte, albo o włos
 * od zajętych. ⌘⇧N zostaje w menu i działa, gdy Cribro jest z przodu —
 * ten skrót jest po to, żeby działało, gdy nie jest.
 *
 * @returns {boolean} czy klawisze udało się zająć
 */
/** Czy klawisze do szybkiej notatki są w tej chwili nasze. */
let quickNoteHotkeyHeld = null;

function bindQuickNoteHotkey() {
  const accelerator = store.getSettings().hotkey?.quickNote;
  quickNoteHotkeyHeld = null;
  if (!accelerator) return false;

  let held = false;
  try {
    held = globalShortcut.register(accelerator, () => quickNote());
  } catch {
    // Zapis, którego Electron nie rozumie („Cmd+", sam modyfikator).
    held = false;
  }
  quickNoteHotkeyHeld = held;

  /* Zajęte klawisze to jedyny sposób, w jaki ten skrót może umrzeć po
     cichu — mówimy o tym raz, zamiast zostawiać człowieka z pytaniem,
     czemu nic się nie dzieje. Menu działa dalej, więc funkcja nie ginie. */
  if (!held) {
    broadcast("pipeline:error", {
      stage: "notatka",
      message: `Skrót ${accelerator} do szybkiej notatki jest zajęty przez inną aplikację — wybierz inny w Ustawieniach. Z menu (⌘⇧N) działa dalej.`,
    });
  }
  return held;
}

/* ── Zgody systemowe ──────────────────────────────────────────── */

/** Jedno źródło prawdy o zgodach — dla IPC i dla obserwatora poniżej. */
function permissionSnapshot() {
  return {
    backend: hotkeys?.backend ?? "none",
    // null = skrótu nie ma wcale; false = klawisze zajął ktoś inny.
    shotHotkey: shotHotkeyHeld,
    quickNoteHotkey: quickNoteHotkeyHeld,
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
/** Czy wolno nam czytać spis okien — czyli czy jest zgoda „Nagrywanie ekranu". */
const canSeeScreen = () =>
  process.platform !== "darwin" || systemPreferences.getMediaAccessStatus("screen") === "granted";

let lastScreenAccess = null;

function watchPermissions() {
  clearInterval(permissionWatch);
  lastAccessibility = permissionSnapshot().accessibility;
  lastScreenAccess = canSeeScreen();

  permissionWatch = setInterval(() => {
    /* Zgoda „Nagrywanie ekranu" przychodzi zwykle przy pierwszym nagraniu
       spotkania — i dopiero od tej chwili wykrywanie ma czym patrzeć.
       Bez tego trzeba by po nią zrestartować aplikację. */
    const screenAccess = canSeeScreen();
    if (screenAccess !== lastScreenAccess) {
      lastScreenAccess = screenAccess;
      applyDetect();
    }

    const accessibility = permissionSnapshot().accessibility;
    if (accessibility === lastAccessibility) return;
    lastAccessibility = accessibility;
    bindHotkeys(); // zgoda przyszła albo zniknęła — silnik skrótu na nowo
    broadcast("permissions:changed", permissionSnapshot());
  }, 2000);
}

/* ── IPC ──────────────────────────────────────────────────────── */

function registerIpc() {
  /* Ustawienia wychodzą do okna WYŁĄCZNIE przez visibleSettings: krok
     „Silniki" należy do właściciela i nikt inny nie dostaje go nawet
     mostem (patrz main/owner.js). */
  ipcMain.handle("settings:get", () => visibleSettings());

  ipcMain.handle("settings:save", (_e, raw) => {
    // Drugie sito, po stronie zapisu: interfejs tych pól nie pokazuje, ale
    // most jest mostem i przez most da się wysłać cokolwiek.
    const patch = ownership.sealPatch(raw, ownerHere());
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
    // Wykrywanie rusza i staje razem z ustawieniem — a nie dopiero po
    // przeładowaniu aplikacji.
    if (patch.meetings?.detect !== undefined) {
      applyDetect(settings);
      /* Włączenie wykrywania jest tym momentem, w którym system ma zapytać
         o zgodę „Nagrywanie ekranu" — dokładnie tak samo jak kalendarz kilka
         linii niżej pyta o swoją przy pierwszym włączeniu. Bez tego
         wywołania ta zgoda nie miałaby już SKĄD się wziąć (patrz komentarz
         przy applyDetect). `screenWindows()` samym wywołaniem
         `desktopCapturer.getSources` stawia systemowe okienko, gdy stan jest
         jeszcze nierozstrzygnięty — a gdy zgody już odmówiono, jest po
         prostu tanim wywołaniem bez skutku, nie drugim pytaniem. */
      if (settings.meetings?.detect !== "off" && !canSeeScreen()) void screenWindows();
    }
    // Kalendarz włącza się i gaśnie razem z przełącznikiem — a pierwsze
    // włączenie jest tym momentem, w którym system pyta o zgodę.
    if (patch.meetings?.calendar !== undefined) watchAgenda(settings);
    /* Poranek. Zmiana klienta OAuth unieważnia sesję (patrz configure
       w main/google.js), więc przepinamy konto przy każdej zmianie —
       a zegar tylko wtedy, gdy przełącznik naprawdę drgnął. */
    if (patch.briefing?.google) google?.configure(settings.briefing?.google);
    if (patch.briefing?.enabled !== undefined) watchBriefing();
    if (patch.cloud) {
      cloud.configure(settings.cloud);
      watchCloud();
      cloudChanged();
    }
    if (patch.launchAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
    }
    refreshMenus();
    tellSettings(settings);
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

  /* Katalog dostawców — nazwy modeli i adresy, spod których bierze się
     klucze. Dla zwykłego użytkownika pusty, i to nie na niby: pusty
     katalog znaczy, że renderer nie ma czym narysować kroku „Silniki",
     nawet gdyby ktoś kazał mu spróbować. */
  ipcMain.handle("providers:get", () =>
    ownerHere() ? { stt: STT, sieve: SIEVE, shot: OCR } : {},
  );

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
  ipcMain.handle("shot:file", (_e, filePath = null) => readImageFile(filePath));
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
      // Awaria odczytu potrafi wymienić dostawcę z nazwy — patrz scrub
      // w main/owner.js.
      error: ownership.scrub(shot.error, ownerHere()),
      owner: ownerHere(),
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
   * Cała szuflada jako jeden PDF.
   *
   * JEDEN PLIK, NIE KATALOG. Szuflada wyeksportowana w całości jedzie
   * zwykle dalej — do skrzynki albo na papier — a tam jeden załącznik jest
   * jedną rzeczą do otwarcia. Notatki zostają osobnymi kartkami, każda
   * z własną metryczką i od nowej strony (patrz toBook w main/pdf.js).
   *
   * Kolejność jest TA SAMA, co na liście w Notatniku: od najnowszej.
   * Kolejność inna niż na ekranie byłaby niespodzianką w gotowym pliku,
   * czyli wtedy, kiedy najtrudniej ją poprawić.
   *
   * Puste notatki wypadają po drodze, ale ich obecność nie jest błędem —
   * w szufladzie z dwudziestoma notatkami jedna pusta nie ma prawa
   * przerwać eksportu pozostałych dziewiętnastu.
   *
   * @param {string|null} folder nazwa szuflady; null znaczy „bez szuflady"
   */
  ipcMain.handle("notes:exportFolder", async (_e, folder) => {
    const wanted = folder === null || folder === undefined ? "" : String(folder).trim();
    const items = store
      .getNotes()
      .filter((note) => String(note.folder ?? "").trim() === wanted)
      .filter((note) => String(note.text ?? "").trim())
      .sort((a, b) => Date.parse(b.updatedAt ?? b.at ?? 0) - Date.parse(a.updatedAt ?? a.at ?? 0))
      .map((note) => ({ note, title: noteTitle(note) }));

    if (!items.length) throw new Error("W tej szufladzie nie ma nic do zapisania.");

    const label = wanted || "Bez szuflady";
    const safeName = label.slice(0, 60).replace(/[\\/:*?"<>|]/g, "-");
    const { canceled, filePath } = await dialog.showSaveDialog(notesWindow ?? mainWindow, {
      title: "Zapisz szufladę jako PDF",
      defaultPath: `${safeName}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { canceled: true };

    await folderToPdf(items, {
      filePath,
      documentTitle: label,
      locale: store.getSettings().uiLanguage === "en" ? "en-GB" : "pl-PL",
    });
    return { canceled: false, filePath, notes: items.length };
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
  /**
   * Zrzut ze schowka → plik na dysku → znacznik do wstawienia w notatce.
   *
   * ══ DWIE DROGI DO TEGO SAMEGO OBRAZKA ══
   *
   * Zwykłe ⌘V w notatce niesie obrazek w zdarzeniu wklejania i renderer
   * podaje go tutaj jako `data:`. Ale zrzut zrobiony systemowym ⌃⌘⇧4 ląduje
   * w schowku jako obraz, którego zdarzenie wklejania w Chromium czasem nie
   * pokazuje wcale — a to jest DOKŁADNIE ten sposób, w jaki ludzie robią
   * zrzuty. Dlatego przy pustym wejściu zaglądamy do schowka systemowego
   * sami, przez Electrona, który widzi go w całości.
   *
   * Obrazek zapisujemy tam, gdzie zrzuty z „Tekstu z ekranu" (`zrzuty/`) —
   * jedno miejsce na obrazki notatek, a nie drugie obok pierwszego. Notatka
   * trzyma do niego adres, tak samo jak tamte.
   */
  ipcMain.handle("notes:pasteImage", (_event, dataUrl = null) => {
    let image = null;
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
      image = nativeImage.createFromDataURL(dataUrl);
    }
    if (!image || image.isEmpty()) image = clipboard.readImage();
    if (!image || image.isEmpty()) return { error: "W schowku nie ma obrazka." };

    try {
      const file = path.join(shotsDir(), stampName());
      fs.writeFileSync(file, image.toPNG());
      /* Oddajemy gotowy znacznik Markdowna, a nie samą ścieżkę: zakodowanie
         adresu (katalog „Application Support" ma spację w nazwie) siedzi
         w main/shot.js i ma zostać w jednym miejscu. */
      return { markdown: imageLink(file, "wklejony obrazek"), file };
    } catch (problem) {
      return { error: `Nie udało się zapisać obrazka: ${problem.message}` };
    }
  });

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
      tellSettings(settings);
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
      tellSettings(settings);
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
  /* ══ PRZECIĄGANIE ZNACZKA LICZY PROCES GŁÓWNY ══

     I to jest trzecie podejście do tej samej animacji — dwa poprzednie
     szarpały, bo obliczały położenie tam, gdzie prawdy o nim nie ma.

     Renderer wie o kursorze tylko tyle, ile powie mu zdarzenie myszy,
     a `event.screenX` powstaje w Chromium jako `clientX + window.screenX`.
     W trakcie przeciągania okno JEDZIE ZA KURSOREM, więc `window.screenX`
     zmienia się co klatkę — i renderer dostaje zdarzenie policzone ze
     STAREGO położenia okna. Im szybciej ręka, tym większy rozjazd: znaczek
     zostaje w tyle za kursorem, potem go dogania, potem przeskakuje.
     Do tego proces główny przycina kotwicę do krawędzi ekranu, a renderer
     o tym przycięciu nie wie i liczy dalej swoje.

     Tutaj takiej niepewności nie ma. `screen.getCursorScreenPoint()` pyta
     system, gdzie NAPRAWDĘ jest kursor, i odpowiedź nie zależy od tego,
     gdzie stoi okno. Renderer mówi więc tylko „zaczynam" i „kończę";
     resztę — łącznie z odstępem między kursorem a środkiem znaczka —
     trzyma i liczy proces główny, co klatkę, z jednego źródła. */
  let widgetDrag = null;
  let widgetDragTimer = null;

  const dragWidget = () => {
    if (!widgetDrag || !widget || widget.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    if (!widgetDrag.moved) {
      const away = Math.hypot(cursor.x - widgetDrag.from.x, cursor.y - widgetDrag.from.y);
      if (away < WIDGET_DRAG_MIN) return;
      widgetDrag.moved = true;
    }

    /* ══ ZNACZEK PRZYCHODZI POD PALEC ══

       Chwyt bierze się gdzie popadnie — za brzeg, za róg aureoli — i przez
       całe przeciąganie znaczek zostawałby wtedy do trzydziestu pikseli
       OBOK kursora. Rachunkowo jest to poprawne („trzymam go tam, gdzie
       złapałem"), ale wygląda jak coś, co się urwało i leci obok ręki.

       Odstęp chwytu gaśnie więc w kilka klatek: znaczek dojeżdża pod
       kursor przez jedną dziesiątą sekundy i od tej chwili siedzi dokładnie
       pod nim. Skok na starcie byłby szarpnięciem; zanik jest ruchem. */
    widgetDrag.dx = Math.abs(widgetDrag.dx) < 1 ? 0 : widgetDrag.dx * WIDGET_GRAB_FADE;
    widgetDrag.dy = Math.abs(widgetDrag.dy) < 1 ? 0 : widgetDrag.dy * WIDGET_GRAB_FADE;
    /* Odstęp chwytu zostaje nietknięty przez całe przeciągnięcie: znaczek
       trzyma się ręki w tym miejscu, w którym go złapano, a nie skacze
       środkiem pod kursor.

       Świeża geometria idzie do okna KAŻDĄ klatkę. Okno bywa w trakcie
       przeciągania przycięte do krawędzi ekranu albo przestawione na drugą
       stronę (szyba wychodzi w tę stronę, w którą jest miejsce) — a wtedy
       znaczek siedzi w oknie gdzie indziej niż przed chwilą. Renderer,
       który by o tym nie wiedział, rysowałby go w starym miejscu: to jest
       ten przeskok, który widać było ręką, a nie w automacie. */
    tellWidget(placeWidget({ x: cursor.x - widgetDrag.dx, y: cursor.y - widgetDrag.dy }, widgetView));
  };

  ipcMain.handle("widget:grab", () => {
    if (!widget || widget.isDestroyed()) return false;
    const cursor = screen.getCursorScreenPoint();
    const anchor = widgetAnchor();
    widgetDrag = {
      dx: cursor.x - anchor.x,
      dy: cursor.y - anchor.y,
      from: cursor,
      display: screen.getDisplayNearestPoint(anchor).id,
      moved: false,
    };
    clearInterval(widgetDragTimer);
    // Co klatkę ekranu. Częściej nie ma czego pokazać, rzadziej widać skok.
    widgetDragTimer = setInterval(dragWidget, 16);
    return true;
  });

  ipcMain.handle("widget:release", () => {
    clearInterval(widgetDragTimer);
    widgetDragTimer = null;
    const held = widgetDrag;
    widgetDrag = null;
    if (!held) return { moved: false, spot: null };

    // Ostatnie spojrzenie na kursor: między ostatnią klatką a puszczeniem
    // ręka zdążyła jeszcze kawałek przejechać.
    if (held.moved) {
      const cursor = screen.getCursorScreenPoint();
      placeWidget({ x: cursor.x - held.dx, y: cursor.y - held.dy }, widgetView);
      store.saveSettings({ widget: widgetAnchor() });
      /* Znaczek przeniesiony na drugi monitor zabiera talię ze sobą. Kartki
         leżą przy tym pulpicie, przy którym się siedzi — a przeciągnięcie
         znaczka jest jedynym momentem, w którym człowiek mówi wprost, przy
         którym to jest. Bez tego notatki zostawały na porzuconym ekranie
         i trzeba je było przenosić po jednej. */
      if (deckOpen && screen.getDisplayNearestPoint(widgetAnchor()).id !== held.display) {
        reflowDeck();
      }
    }
    return { moved: held.moved, spot: placeWidget(widgetAnchor(), widgetView) };
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
  /* ══ KARTKA ZWINIĘTA DO NAGŁÓWKA ══

     Roleta, nie zamknięcie. Zwinięta kartka zostaje na pulpicie, w swoim
     miejscu i w swojej kolejności — po to się ją zwija: żeby plan dnia
     leżał OBOK pracy, a nie na niej. Zdjęcie z wierzchu to osobny gest
     (deck:dismiss) i znaczy co innego.

     Wysokość liczy proces główny, bo tylko on może zmienić okno. Pełną
     zapamiętujemy PRZED zwinięciem — bez tego rozwinięcie musiałoby zgadnąć
     rozmiar, a kartka rozciągnięta ręką wracałaby domyślna. */
  ipcMain.handle("deck:roll", (event, { id, rolled } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const bounds = win.getBounds();
    const cards = store.getSettings().widget?.cards ?? {};
    const scale = win.deckScale ?? deckScaleAt(bounds);

    if (rolled) {
      // Podłoga PRZED zmianą rozmiaru — inaczej system podniósłby wysokość
      // z powrotem do 150 i belka wyszłaby z paskiem pustego papieru.
      clampCard(win, true, scale);
      win.setBounds({ ...bounds, height: rolledHeight(scale) });
      store.saveSettings({
        widget: { cards: { [id]: { rolled: true, fullHeight: bounds.height } } },
      });
      return true;
    }

    const full = cards[id]?.fullHeight ?? deckCardSize(scale).height;
    clampCard(win, false, scale);
    win.setBounds({ ...bounds, height: clamp(full, STICKY_MIN.height, STICKY_MAX.height) });
    store.saveSettings({ widget: { cards: { [id]: { rolled: false } } } });
    return true;
  });

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

  /* Spotkania. Na tym etapie tyle, ile naprawdę jest: przełącznik, stan
     i spis. Transkrypcja i podsumowanie dojdą własnymi kanałami. */
  ipcMain.handle("meetings:toggle", () => toggleMeeting());
  ipcMain.handle("meetings:state", () => meetingState());
  // Odpowiedź na pytanie znaczka: „Tak" zaczyna notatki, „Nie" chowa
  // pytanie do końca tej rozmowy.
  ipcMain.handle("meetings:answer", (_e, yes) => answerMeeting(!!yes));
  ipcMain.handle("meetings:list", () => meetings.list());
  ipcMain.handle("meetings:delete", (_e, id) => {
    store.deleteMeeting(id);
    // Okno tego spotkania nie ma już czego pokazywać.
    const solo = meetingWindows.get(id);
    if (solo && !solo.isDestroyed()) solo.close();
    broadcast("meeting:changed", meetingState());
    return true;
  });
  /* Notatki pisane ręką w trakcie rozmowy. Nie rozsyłamy ich z powrotem
     do okien: pisze je jedno okno i podmiana tekstu pod palcami piszącego
     byłaby jedyną rzeczą, jaką taki meldunek mógłby zrobić. */
  ipcMain.handle("meetings:note", (_e, { id, text } = {}) => {
    store.updateMeeting(id, { notes: String(text ?? "") });
    return true;
  });
  /* Podsumowanie na żądanie: z przycisku w zakładce. Ta sama droga, którą
     idzie po zakończeniu rozmowy — bo to ta sama czynność, tylko wywołana
     ręką. Da się ją powtórzyć w nieskończoność, transkrypcja leży. */
  ipcMain.handle("meetings:summarize", (_e, id) => summarizeMeeting(id));
  /* Przepisanie nagrania jeszcze raz, z plików. Jedyny krok w tym module,
     który da się powtórzyć — i jedyny ratunek dla rozmowy nagranej bez
     klucza API albo bez sieci. */
  /* ══ SPOTKANIE WYCHODZI Z APLIKACJI PRZEZ NOTATNIK ══

     I to jest jedyna droga wyjścia, celowo. Notatka umie już PDF, Notion,
     Apple Notes, chmurę i schowek; drugi zestaw tych samych przycisków
     przy spotkaniu byłby drugim miejscem do poprawiania przy każdej
     zmianie. Zadania z podsumowania stają się przy okazji listą do
     odhaczenia — bo taka jest ich natura, a w podsumowaniu były akapitem. */
  /* Przycisk „Pokaż notatkę" prowadzi do notatki, która i tak już powstała
     sama (patrz keepMeetingNote). Zakłada ją tylko wtedy, gdy jej nie ma —
     bo ktoś ją skasował albo bo rozmowa nagrała się jeszcze przed tym, jak
     notatki zaczęły powstawać same. Drugiej kopii tej samej rozmowy ten
     przycisk nie robi. */
  ipcMain.handle("meetings:toNote", (_e, { id } = {}) => {
    const meeting = store.getMeetings().find((item) => item.id === id);
    if (!meeting) return null;

    const known = meeting.noteId
      ? store.getNotes().find((note) => note.id === meeting.noteId)
      : null;
    if (known) return known;

    /* Notatki skasowanej ręką keepMeetingNote nie wskrzesza — ale
       kliknięcie w „Pokaż notatkę" jest właśnie prośbą o nową. Zdejmujemy
       więc wskazanie na nagrobek i zakładamy kartkę od nowa. */
    if (meeting.noteId) store.updateMeeting(id, { noteId: null });
    const note = keepMeetingNote(id);
    broadcast("meeting:changed", meetingState());
    return note;
  });

  /* Rozmowa przesiana przez sito — trzecia postać tej samej rozmowy.
     Zapis mówi, co padło; podsumowanie, co z tego wynika; to jest
     pomiędzy: rozmowa bez szumu, która wciąż jest rozmową. */
  ipcMain.handle("meetings:polish", async (_e, id) => {
    const meeting = store.getMeetings().find((item) => item.id === id);
    if (!meeting) return false;
    store.updateMeeting(id, { sifting: true, talkError: null });
    broadcast("meeting:changed", meetingState());
    try {
      const talk = await polish(meeting, store.getSettings());
      store.updateMeeting(id, { talk, sifting: false, talkError: null });
      return true;
    } catch (problem) {
      store.updateMeeting(id, { sifting: false, talkError: problem.message });
      tellError("sito", problem.message);
      return false;
    } finally {
      broadcast("meeting:changed", meetingState());
    }
  });

  /* Samo podsumowanie do schowka — najkrótsza droga do czatu i do maila. */
  ipcMain.handle("meetings:copy", (_e, id) => {
    const meeting = store.getMeetings().find((item) => item.id === id);
    if (!meeting) return false;
    clipboard.writeText(asNote(meeting, { transcript: false, me: whoAmI() }));
    return true;
  });

  ipcMain.handle("meetings:retranscribe", async (_e, id) => {
    try {
      const transcript = await meetings.retranscribe(id);
      // Świeży zapis idzie do notatki od razu — a jeśli podsumowanie ma
      // powstać, dopisze się do tej samej kartki chwilę później.
      keepMeetingNote(id);
      /* Skoro jest już tekst, jest z czego zrobić wniosek. Robimy go sami,
         bo po to się przepisuje drugi raz. */
      if (transcript?.length && store.getSettings().meetings?.summarize !== false) {
        void summarizeMeeting(id);
      }
      return true;
    } catch (problem) {
      tellError("transkrypcja", problem.message);
      return false;
    }
  });
  /* „Notuj to spotkanie" przy wpisie z kalendarza. Zgoda zapada RAZ,
     przed spotkaniem — a nie w chwili, w której trzeba już słuchać. */
  ipcMain.handle("meetings:arm", (_e, { id, on } = {}) => {
    const armed = new Set(store.getSettings().meetings?.armed ?? []);
    if (on) armed.add(id);
    else armed.delete(id);
    /* Trzymamy tylko to, co jeszcze przed nami: identyfikatory wpisów,
       które dawno minęły, rosłyby w ustawieniach bez końca. */
    const alive = new Set(agenda.events.map((event) => event.id));
    const kept = [...armed].filter((item) => alive.has(item));
    store.saveSettings({ meetings: { armed: kept } });
    broadcast("meeting:changed", meetingState());
    return kept;
  });
  /* Zwinięcie nagłówka w podsumowaniu. Strzałka stoi w treści, nie obok
     niej (patrz flipToggle w main/digest.js), więc kliknięcie w nią jest
     zmianą podsumowania — i dlatego przeżywa przerysowanie zakładki,
     które w trakcie rozmowy przychodzi co dwie minuty. */
  ipcMain.handle("meetings:fold", (_e, { id, index, open } = {}) => {
    const meeting = store.getMeetings().find((item) => item.id === id);
    if (!meeting?.summary) return false;
    const summary = flipToggle(meeting.summary, Number(index), !!open);
    if (summary === meeting.summary) return false;
    store.updateMeeting(id, { summary });
    /* Notatki NIE ruszamy. Zwinięcie jest sposobem czytania podsumowania
       tutaj; notatka ma własną strzałkę przy własnym nagłówku i własnego
       człowieka, który ją przestawia. */
    broadcast("meeting:changed", meetingState());
    return true;
  });

  /* ══ ZGODA NA KALENDARZ ══

     Kalendarz czyta program pomocniczy (main/agenda.js → cribro-tap), więc
     zgody nie da się tu wyprosić żadnym API Electrona — okno systemowe
     pokazuje się dopiero wtedy, gdy TEN program o nią poprosi. Prośbą jest
     więc zwyczajne spytanie o kalendarz: helper widzi stan „nie pytano",
     woła EventKit i macOS stawia okno.

     Trzy czynności, bo trzy różne sytuacje mają trzy różne wyjścia
     (patrz agendaCard w renderer/js/meetings-view.js). */
  ipcMain.handle("meetings:calendar", async (_e, how) => {
    if (how === "open") {
      /* AUTOMATYZACJA, nie „Kalendarze”. Kalendarz czytamy przez
         Kalendarz.app (patrz main/calendar-osa.js), więc zgoda leży pod
         „Cribro Sift → Kalendarz" w sekcji Automatyzacja. Odsyłanie do
         sekcji Kalendarze było odsyłaniem po przełącznik, którego tam nie
         ma — i to był jeden z powodów, dla których ta funkcja nie dawała
         się włączyć. */
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
      );
      return meetingState().agenda;
    }

    /* „ask" i „retry" to ta sama czynność: spytać kalendarz jeszcze raz.
       Przy pierwszym pytaniu system stawia przy okazji swoje okno zgody —
       i dlatego czekamy TRZY MINUTY, a nie osiem sekund. Człowiek musi
       zdążyć przeczytać okno i sięgnąć po mysz; zabicie programu w połowie
       tego wyglądało dotąd jak awaria kalendarza.

       Okno aplikacji idzie przy tym na wierzch: pytanie systemu potrafi
       stanąć za nim, a wtedy nie widać ani go, ani powodu, dla którego nic
       się nie dzieje. */
    createMainWindow().show();
    await lookAtAgenda({ force: true, patience: 180_000 });
    return meetingState().agenda;
  });

  /* ══ PRZEGLĄD TYGODNIA ══

     Klik w „Nadchodzące” otwiera coś więcej niż pięć najbliższych wpisów:
     całe okno, które da się przewijać tydzień po tygodniu, w obie strony.

     JEDNO SZEROKIE ZAPYTANIE, NIE JEDNO NA TYDZIEŃ. Koszt odczytu przez
     Kalendarz.app (main/calendar-osa.js) leży niemal w całości w SAMEJ
     ENUMERACJI — w przejściu przez wszystkie wydarzenia każdego kalendarza,
     żeby ustalić, które mieszczą się w oknie. Ten koszt NIE ZALEŻY od tego,
     jak szerokie jest okno: zapytanie o dobę i zapytanie o dwa miesiące
     kosztują to samo, bo oba przechodzą przez te same wydarzenia. Zapytanie
     o pojedynczy tydzień przy każdej zmianie tygodnia płaciłoby więc ten
     sam rachunek (piętnaście do czterdziestu sekund) za KAŻDE przewinięcie
     — a szerokie, jedno, płaci go raz i oddaje tygodnie do przewijania
     za darmo, bo reszta dzieje się w przeglądarce.

     `detail: 0` pomija listę zaproszonych — przegląd tygodnia pyta tylko
     o to, co ma link do Google Meet albo Zoom (patrz `isMeeting` w
     main/agenda.js, sprawdzenie `link` idzie przed sprawdzeniem gości),
     więc goście nie są tu do niczego potrzebni, a ich pominięcie zdejmuje
     drugi, kosztowny etap tego samego zapytania.

     CACHE NA PIĘĆ MINUT. Okno kontekstowe otwiera się i zamyka w trakcie
     jednej sesji patrzenia w kalendarz — drugie otwarcie w tym czasie ma
     dostać to, co pierwsze, a nie każdorazowo czekać pół minuty na to samo. */
  /* Miesiąc wstecz, dwa miesiące w przód — z zapasem w obie strony, żeby
     przewijanie tygodni starczyło na CAŁY miesiąc, licząc od dzisiaj, zanim
     trafi na pustkę. Szerzej niż trzeba: koszt i tak nie zależy od okna
     (patrz komentarz wyżej), więc zapas nic nie kosztuje. */
  const WEEK_SPAN = { back: 31 * 24, hours: 62 * 24 };
  const WEEK_CACHE_FOR = 5 * 60_000;
  let weekAgenda = null;
  let weekAgendaAt = 0;

  ipcMain.handle("meetings:week", async (_e, { fresh = false } = {}) => {
    if (!fresh && weekAgenda && Date.now() - weekAgendaAt < WEEK_CACHE_FOR) {
      return weekAgenda;
    }
    createMainWindow().show();
    weekAgenda = await agendaSource.read({
      ...WEEK_SPAN,
      detail: 0,
      launch: true,
      patience: 180_000,
    });
    weekAgendaAt = Date.now();
    return weekAgenda;
  });

  /* Tytuł wpisany ręką. Znacznik `titleByHand` chroni go przed inteligentną
     zmianą nazwy: kto nazwał spotkanie sam, podjął decyzję. */
  ipcMain.handle("meetings:openWindow", (_e, id) => (openMeetingWindow(id), true));

  ipcMain.handle("meetings:rename", (_e, { id, title } = {}) => {
    const name = String(title ?? "").trim();
    store.updateMeeting(id, {
      title: name || null,
      titleByHand: !!name,
      titleFrom: name ? "hand" : null,
    });
    broadcast("meeting:changed", meetingState());
    return true;
  });

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
  /* Sprawdzenie połączenia woła dostawcę naprawdę i mówi, kto odpowiedział.
     To jest część kroku „Silniki" i należy do właściciela razem z nim —
     przycisku nie ma na ekranie, a most odmawia. */
  const onlyOwner = (what) => {
    if (!ownerHere()) throw new Error(`${what} jest w tej wersji niedostępne.`);
  };

  ipcMain.handle("test:sieve", async () => {
    onlyOwner("Sprawdzanie silnika");
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
    onlyOwner("Sprawdzanie silnika");
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
    onlyOwner("Sprawdzanie silnika");
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
    // Co temu kontu wolno zobaczyć, wie serwer — a od tej chwili jest kogo
    // spytać (patrz main/admin.js).
    void refreshFeatures();
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
    /* Bez konta nie ma kogo pytać — a „nie wiadomo" znaczy „pokaż
       wszystko". Aplikacja bez zalogowania ma działać tak samo jak przed
       wprowadzeniem przełączników. */
    myFeatures = null;
    cloudChanged();
    tellSettings();
    return cloudState();
  });

  ipcMain.handle("cloud:reset", (_e, email) => cloud.resetPassword(email));

  /* ── Panel admina ───────────────────────────────────────────────
     Bramka jest DWUKROTNA i to nie jest nadmiar. Tutaj sprawdzamy, czy
     w ogóle wysyłać pytanie — żeby okno nie próbowało czegoś, na co i tak
     nie ma prawa, i żeby odmowa brzmiała po ludzku. Prawdziwa granica leży
     w bazie: `admin_users` i polityki zapisu pytają o adres z tokenu
     i cudzemu oddają pustkę (patrz supabase/schema.sql). Zdjęcie tej
     bramki tutaj niczego nie odblokowuje. */
  const asAdmin = (what) => async (...args) => {
    if (!ownerHere()) throw new Error("Panel admina nie należy do tego konta.");
    if (!cloud.signedIn) throw new Error("Panel admina wymaga zalogowania w chmurze.");
    return what(...args);
  };

  ipcMain.handle(
    "admin:state",
    asAdmin(async () => ({
      users: await admin.users(cloud),
      features: await admin.features(cloud),
      me: cloud.user?.email ?? null,
    })),
  );

  ipcMain.handle(
    "admin:setFeature",
    asAdmin(async (_e, { code, state } = {}) => {
      const done = await admin.setState(cloud, code, state);
      // Właściciel widzi wszystko, więc jemu samemu nic to nie zmienia —
      // ale okno rysuje z tego stan przełącznika, a ten ma być świeży.
      await refreshFeatures();
      return done;
    }),
  );

  ipcMain.handle(
    "admin:grant",
    asAdmin(async (_e, { code, userId, on } = {}) => admin.grant(cloud, code, userId, on)),
  );

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
      void refreshFeatures();
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

  /* ── Poranek ─────────────────────────────────────────────────
     Interfejs pyta o stan, prosi o pokazanie i podłącza konto. Reszta —
     kiedy, komu i z czego — jest wyżej, w sekcji „Poranek". */

  ipcMain.handle("briefing:state", () => briefingState());

  ipcMain.handle("briefing:show", async () => {
    const shown = await showBriefing({ force: true });
    if (!shown) {
      const state = briefingState();
      if (state.mismatch) {
        throw new Error(
          `Podłączone konto to ${state.account.email}, a poranek należy do ${state.owner}.`,
        );
      }
      if (!state.account.signedIn) throw new Error("Konto Google nie jest podłączone.");
      if (!state.owner) throw new Error("Poranek nie ma właściciela — podłącz konto Google.");
      throw new Error("Poranek jest wyłączony.");
    }
    return true;
  });

  /* Podłączenie konta. Wygląda jak logowanie do chmury i idzie tą samą
     drogą (pętla zwrotna, PKCE), ale kończy się inaczej: sprawdzeniem,
     CZYJE konto właśnie przyszło. */
  ipcMain.handle("briefing:connect", async () => {
    if (oauthPending) throw new Error("Logowanie już trwa — dokończ je w przeglądarce.");
    google.configure(store.getSettings().briefing?.google);

    const owner = String(store.getSettings().briefing?.owner ?? "").trim();
    const attempt = google.signIn({
      openExternal: (url) => shell.openExternal(url),
      hint: owner || undefined,
    });
    oauthPending = { provider: "google-mail", cancel: attempt.cancel };

    try {
      const account = await attempt.result;
      oauthPending = null;

      /* Właściciel zapisuje się przy PIERWSZYM podłączeniu i od tej chwili
         jest warunkiem, a nie notatką: kolejne konto albo się z nim zgadza,
         albo zostaje odrzucone razem z sesją. Inaczej wystarczyłoby zalogować
         się swoim kontem na cudzym komputerze, żeby poranek zaczął czytać
         cudzą skrzynkę. */
      if (!owner) {
        store.saveSettings({ briefing: { owner: account.email ?? "" } });
      } else if ((account.email ?? "").toLowerCase() !== owner.toLowerCase()) {
        google.forget();
        throw new Error(
          `To konto (${account.email}) nie jest tym, do którego należy poranek (${owner}).`,
        );
      }

      tellSettings();
      return briefingState();
    } catch (error) {
      oauthPending = null;
      throw error;
    }
  });

  ipcMain.handle("briefing:disconnect", () => {
    google.forget();
    return briefingState();
  });

  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:close", () => mainWindow?.hide());
}

/* ── Start ────────────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createMainWindow());

/**
 * Content-Security-Policy dla wszystkich okien naraz.
 *
 * ── PO CO, SKORO WSZYSTKO JEST LOKALNE ──
 *
 * Bo nie wszystko. Do okien wchodzi tekst, którego NIE NAPISALIŚMY: to,
 * co wróciło z sita (czyli od cudzego modelu językowego), to, co przyszło
 * z Notion, i to, co ktoś wkleił ze schowka. Ten tekst jest renderowany
 * jako treść bogata — z pogrubieniami, listami i obrazkami (patrz
 * shared/richtext.js). Gdyby kiedykolwiek przeciekła tamtędy choć jedna
 * pominięta ścieżka, atakujący dostaje wykonanie kodu w oknie, które ma
 * most do procesu głównego. CSP nie naprawia takiej dziury, ale odbiera
 * jej wartość: wstrzyknięty skrypt nie ma skąd się wczytać ani dokąd
 * wysłać tego, co znajdzie.
 *
 * Electron ostrzegał o braku tej polityki w konsoli każdego okna.
 *
 * ── SKĄD TE KONKRETNE ŹRÓDŁA ──
 *
 *   script-src   tylko własne pliki. Renderer nie ma ani jednego `eval`
 *                ani `new Function` — sprawdzone, więc nie ma tu
 *                'unsafe-eval'.
 *   style-src    'unsafe-inline' jest potrzebne naprawdę: szerokość
 *                obrazka w notatce siedzi w atrybucie `style` (richtext.js),
 *                a kartka i okno spotkania mają własne bloki <style>.
 *                fonts.googleapis.com — stamtąd idzie arkusz z krojami.
 *   font-src     fonts.gstatic.com — stamtąd idą same pliki krojów.
 *   img-src      `file:` NIE JEST nadmiarem: obrazki wklejone do notatki
 *                leżą na dysku i wchodzą jako `file://…` (patrz fileUrl
 *                w main/shot.js). `data:` — podgląd przed zapisem.
 *   media-src    nagrania spotkań, tą samą drogą co obrazki.
 *   connect-src  'self' i tyle. Renderer nie dzwoni NIGDZIE sam —
 *                sprawdzone, ani jednego `fetch`; wszystkie rozmowy
 *                z Google, OpenAI i Notion prowadzi proces główny,
 *                a okno rozmawia z nim mostem, nie siecią.
 *
 * `file:` w script-src i default-src bierze się stąd, że okna ładują się
 * z dysku (`loadFile`), a dokument spod `file://` ma w Chromium źródło
 * nieprzezroczyste — samo 'self' nie dopuściłoby wtedy nawet własnych
 * skryptów obok. Sprawdzone uruchomieniem każdego okna po kolei:
 * scripts/csp-test.js.
 */
function guardWindows() {
  const POLICY = [
    "default-src 'none'",
    /* `blob:` NIE JEST tu luzem na wszelki wypadek — bez niego nie działa
       DYKTOWANIE, czyli jedyna rzecz, dla której ta aplikacja istnieje.

       Nagrywanie liczy próbki w AudioWorklecie, a moduł workletu powstaje
       w locie: kod leży jako tekst w js/hud.js, robi się z niego Blob
       i `audioWorklet.addModule(blob:…)`. Moduł workletu jest dla CSP
       SKRYPTEM, więc polityka bez `blob:` odrzucała go — a jedyne, co
       widział człowiek, to „Nie udało się uruchomić nagrywania: Unable to
       load a worklet's module". Dokładnie to zepsuła pierwsza wersja tej
       polityki i dlatego jest tu dziś test, który nagrywanie naprawdę
       uruchamia, a nie tylko wczytuje okno (scripts/csp-test.js).

       Bezpieczeństwa to nie rozmienia: `blob:` może utworzyć wyłącznie
       kod już działający w tym oknie, więc nie otwiera drogi z zewnątrz. */
    "script-src 'self' file: blob:",
    /* Worklety i workery bywają sprawdzane osobną dyrektywą, zależnie od
       wersji silnika. Wpisujemy ją wprost, żeby nie zależeć od tego,
       na którą trafi kolejny Chromium. */
    "worker-src 'self' file: blob:",
    "child-src 'self' blob:",
    "style-src 'self' file: 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' file: https://fonts.gstatic.com",
    "img-src 'self' file: data: blob:",
    "media-src 'self' file: data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, done) => {
    done({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [POLICY],
      },
    });
  });
}

  app.whenReady().then(() => {
    store = new Store();

    guardWindows();

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

    /* Konto Google — wyłącznie do porannego podsumowania. Powstaje zawsze,
       bo bez identyfikatora klienta jest tylko wyłączone, a nie nieobecne;
       reszta kodu nie musi wtedy sprawdzać, czy w ogóle istnieje. Sesji
       z dysku NIE wczytuje przy starcie — patrz nagłówek main/google.js. */
    google = new Google();
    google.configure(store.getSettings().briefing?.google);

    /* Spotkania chodzą OBOK dyktowania, nie zamiast niego: to dwa różne
       stany i dwa różne mikrofony (Core Audio w cribro-tap kontra
       getUserMedia w oknie HUD-a). Dyktowanie notatki w trakcie rozmowy
       ma działać. */
    meetings = new Meetings(store, {
      onChange: () => {
        tellMeetings();
        refreshMenus();
      },
      onLevel: (level) => {
        // Ten sam kanał, którym poziom głosu dochodzi do znaczka przy
        // dyktowaniu — znaczek nie musi wiedzieć, skąd mówią.
        if (state === "idle") widget?.webContents.send("widget:level", level);
      },
      /* Przybył odcinek zapisu. Okna mają się o tym dowiedzieć, ale pasek
         menu i menu aplikacji nie mają się o co przebudowywać. */
      onTranscript: () => broadcast("meeting:changed", meetingState()),
      /* Tor, w którym nic nie słychać, to najkosztowniejsza cicha awaria
         w całym module: godzina nagrana z jednej strony rozmowy, a wiadomo
         o tym dopiero na końcu. Mówimy o tym raz, w trakcie. */
      onSilence: (lane) =>
        broadcast("pipeline:error", {
          stage: "spotkanie",
          message:
            lane === "mic"
              ? "Od pięciu minut nie słychać Twojego mikrofonu — sprawdź, czy nie jest wyciszony."
              : "Od pięciu minut nie słychać drugiej strony — sprawdź, czy dźwięk rozmowy nie idzie do słuchawek Bluetooth.",
        }),
      /* ══ DRUGA DROGA DO KOŃCA ROZMOWY ══

         Okno rozmowy bywa nieśmiertelne: karta Meet zostaje otwarta po
         wyjściu wszystkich, Zoom potrafi wisieć w pokoju z jedną osobą,
         a spotkanie przy stole nie ma okna w ogóle. Wtedy jedynym śladem
         końca jest to, że OD DZIESIĘCIU MINUT NIKT NIC NIE MÓWI.

         Kończymy tym tylko nagrania należące do wykrytej rozmowy — z tego
         samego powodu, dla którego robi to zniknięcie okna: dyktafon
         położony na stole ma prawo przeleżeć kwadrans w ciszy. */
      onIdle: () => {
        if (!startedFromSpot) return;
        if (store.getSettings().meetings?.stopWithMeeting === false) return;
        void endWithRoom("od dziesięciu minut nikt nic nie mówi");
      },
      onError: (message) => tellError("spotkanie", message),
    });

    /* Nagrania, które nie miały jak się skończyć — bo aplikacja zginęła
       w połowie rozmowy. Domykamy je zaraz po starcie: pliki bez nagłówka
       są bajtami, których nic nie otworzy, a wpis w stanie „recording"
       wisiałby w spisie na zawsze. */
    meetings.recover();

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
    applyDetect();
    watchAgenda();
    watchPermissions();
    createMainWindow();

    /* ══ SESJA KONTA WRACA DOPIERO TERAZ ══

       Leży na dysku zaszyfrowana kluczem z pęku kluczy, a odszyfrowanie
       jest wywołaniem synchronicznym, które macOS potrafi zatrzymać na
       pytaniu „czy pozwolić tej aplikacji sięgnąć po zapisane hasło?".
       Pytanie pada po każdej zmianie podpisu, czyli po każdej własnej
       instalacji. Zrobione przed oknami, zatrzymywało całe uruchamianie:
       proces stał, okien nie było, a okienko systemu wisiało na ekranie
       bez niczego, z czym dałoby się je powiązać.

       Teraz najgorsze, co może się stać, to że przez chwilę po starcie
       Cribro jest niezalogowane — a to jest stan, który interfejs umie
       pokazać, i który mija sam, gdy tylko pęk kluczy odpowie. */
    setTimeout(() => {
      /* Pytamy pęk kluczy WYŁĄCZNIE wtedy, gdy jest po co: bez adresu
         projektu żadnej sesji i tak nie ma do czego przyłożyć, a okienko
         systemu pytające o hasło do czegoś, czego się nie używa, jest
         samym niepokojem. */
      if (cloud.configured && cloud.restore()) {
        cloudChanged();
        /* Co temu kontu wolno zobaczyć — pytamy RAZ, przy starcie. Odpowiedź
           trzyma się do końca uruchomienia; przełącznik przestawiony
           w panelu działa u ludzi od następnego otwarcia aplikacji i tak
           jest to pomyślane (patrz main/admin.js). */
        void refreshFeatures();
      }
      watchCloud();
    }, 400);
    if (store.getSettings().widget?.enabled) showWidget(true);
    applyDockIcon(store.getSettings().showInDock !== false);

    /* Znaczek i kartki zapamiętane na monitorze, którego już nie ma, wracają
       w obszar roboczy — tak samo po podłączeniu monitora i po zmianie
       samego ekranu. Co dokładnie robi każde z tych zdarzeń i dlaczego
       wszystkie trzy prowadzą w to samo miejsce: patrz screensChanged. */
    /* Poranek. Zegar pilnuje pory, a odblokowanie ekranu jest drugą drogą
       do tego samego pytania: „czy dziś ktoś to już widział". Zwłoka jest
       po to, żeby okno nie wyskoczyło w tej samej sekundzie, w której
       odsłania się pulpit — wtedy wygląda jak usterka, a nie jak coś,
       co ktoś położył na wierzchu. */
    watchBriefing();
    /* ══ TRZECIA DROGA: KOMPUTER POSZEDŁ SPAĆ ══

       Zamknięta klapa kończy każdą rozmowę, jaka na niej trwała — a przy
       uśpieniu program nagrywający i tak przestaje dostawać dźwięk. Bez
       tego wpis zostawał w stanie „recording" do rana i domykał go dopiero
       ratunek przy następnym starcie (patrz recover w main/meeting.js),
       czyli z błędem zamiast z podsumowaniem.

       Zamykamy PORZĄDNIE i od razu: zapis, notatka, podsumowanie — tak samo
       jak po naciśnięciu „Koniec". Uśpienie daje na to chwilę, a nagranie
       domknięte ma nagłówek WAV i da się je otworzyć. */
    powerMonitor.on("suspend", () => {
      if (meetings?.recording) void endWithRoom("komputer poszedł spać");
      /* Uśpiony komputer nie ma okien do oglądania, a spis okien kosztuje
         kilkadziesiąt milisekund procesu głównego. Budzenie maszyny co osiem
         sekund po to, żeby usłyszeć „nic tu nie ma", jest wydatkiem bez
         odbiorcy — i widać go na baterii. */
      watcher?.stop();
    });
    powerMonitor.on("resume", () => applyDetect());
    /* Zablokowany ekran to nie to samo co uśpiony komputer — rozmowa potrafi
       trwać dalej, gdy blokada zapadła sama. Dlatego przy blokadzie nagrania
       NIE KOŃCZYMY; zwalniamy tylko pilnowanie, a nagranie chroni cisza
       w obu torach (onIdle) i zniknięcie okna. */
    powerMonitor.on("lock-screen", () => {
      if (!meetings?.recording) watcher?.stop();
    });
    powerMonitor.on("unlock-screen", () => applyDetect());
    powerMonitor.on("unlock-screen", () => setTimeout(() => void showBriefing(), 2500));
    powerMonitor.on("resume", () => setTimeout(() => void showBriefing(), 4000));

    screen.on("display-removed", screensChanged);
    screen.on("display-added", screensChanged);
    screen.on("display-metrics-changed", screensChanged);

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
  app.on("will-quit", (event) => {
    hotkeys?.stop();
    /* Nagrywanie trzeba domknąć, zanim proces zniknie. Program pomocniczy
       przeżyłby zamknięcie okna, a pliki WAV zostałyby bez nagłówka —
       czyli jako bajty, których nic nie otworzy. */
    if (meetings?.recording) {
      event.preventDefault();
      meetings.shutdown().finally(() => app.exit(0));
    }
  });
}
