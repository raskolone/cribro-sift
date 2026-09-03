"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Jedyny most między interfejsem a systemem. Renderer nie dotyka Node'a.
 */

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("cribro", {
  isDesktop: true,
  // Interfejs musi wiedzieć, na czym stoi: na macOS pisownią zarządza
  // system i wybór języków nie ma tam czym sterować.
  platform: process.platform,

  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (patch) => ipcRenderer.invoke("settings:save", patch),
    onChange: on("settings:changed"),
  },

  history: {
    get: () => ipcRenderer.invoke("history:get"),
    update: (id, patch) => ipcRenderer.invoke("history:update", { id, patch }),
    remove: (id) => ipcRenderer.invoke("history:delete", id),
    clear: () => ipcRenderer.invoke("history:clear"),
    stats: () => ipcRenderer.invoke("stats:get"),
    // `plain` przesiewa surowy transkrypt bez polecenia — droga powrotna
    // z wykrywania, które ruszyło niechcący.
    resift: (id, mesh, plain) => ipcRenderer.invoke("sift:redo", { id, mesh, plain }),
    onNew: on("entry:new"),
  },

  /* Notatnik. Te same notatki widzi zakładka w oknie głównym, okno
     Notatnika i pojedyncze okienko jednej notatki — most jest jeden. */
  notes: {
    get: () => ipcRenderer.invoke("notes:get"),
    create: (patch) => ipcRenderer.invoke("notes:create", patch),
    update: (id, patch) => ipcRenderer.invoke("notes:update", { id, patch }),
    remove: (id) => ipcRenderer.invoke("notes:delete", id),
    open: () => ipcRenderer.invoke("notes:open"),
    // Podwójne kliknięcie: jedna notatka we własnym okienku.
    openWindow: (id) => ipcRenderer.invoke("notes:openWindow", id),
    closeWindow: () => ipcRenderer.send("notes:closeWindow"),
    quick: () => ipcRenderer.invoke("notes:quick"),
    closeQuick: () => ipcRenderer.send("quick:close"),
    dictate: (id) => ipcRenderer.invoke("notes:dictate", id),
    toAppleNotes: (id) => ipcRenderer.invoke("notes:toAppleNotes", id),
    markdown: (id) => ipcRenderer.invoke("notes:markdown", id),
    export: (id) => ipcRenderer.invoke("notes:export", id),
    // Notatka na zewnątrz: kartka do wydrukowania i strona w cudzym Notion.
    pdf: (id) => ipcRenderer.invoke("notes:pdf", id),
    // Cała szuflada w jednym PDF-ie, kartka na notatkę.
    exportFolder: (folder) => ipcRenderer.invoke("notes:exportFolder", folder),
    toNotion: (id) => ipcRenderer.invoke("notes:toNotion", id),
    /* Zrzut ze schowka wprost do notatki.

       Bajty jadą jako data: — most nie przepuszcza Buffera, a obrazek
       ze schowka to i tak zwykle kilkaset kilobajtów. `null` znaczy
       „w schowku nie ma obrazka" i wtedy proces główny zagląda do schowka
       systemowego sam: zrzut zrobiony ⌃⌘⇧4 bywa tam, gdzie zdarzenie
       wklejania go nie widzi. */
    pasteImage: (dataUrl = null) => ipcRenderer.invoke("notes:pasteImage", dataUrl),
    sift: (id) => ipcRenderer.invoke("notes:sift", id),
    undoSift: (id) => ipcRenderer.invoke("notes:undoSift", id),
    onAppended: on("note:appended"),
    onChanged: on("note:changed"),
    onNew: on("note:new"),
  },

  /* Tekst z ekranu — zaznaczony fragment cudzego okna jako notatka.

     Renderer nie widzi samego obrazka: dostaje pomniejszony podgląd
     (data:) i odczytany tekst, a pełny PNG zostaje w procesie głównym,
     bo to on go zapisze — i tylko wtedy, gdy padnie na formę z obrazkiem. */
  shot: {
    // Zaznaczanie z okna albo z Ustawień; klawiszami wywołuje je proces główny.
    grab: () => ipcRenderer.invoke("shot:grab"),
    // Okno melduje, że jest gotowe przyjąć zrzut — w odpowiedzi dostaje wszystko.
    ready: () => ipcRenderer.invoke("shot:ready"),
    save: (choice) => ipcRenderer.invoke("shot:save", choice),
    cancel: () => ipcRenderer.send("shot:cancel"),
    // Odczyt przychodzi osobno, bo okno stanęło przed nim.
    onText: on("shot:text"),
  },

  /* Konto i kopia notatek w Supabase.

     Renderer nie widzi ani klucza, ani tokenu sesji — dostaje wyłącznie
     odpowiedź na pytanie „czy jestem zalogowany i kiedy była ostatnia
     synchronizacja". Hasło idzie w jedną stronę i nie wraca. */
  cloud: {
    state: () => ipcRenderer.invoke("cloud:state"),
    signUp: (email, password) => ipcRenderer.invoke("cloud:signUp", { email, password }),
    signIn: (email, password) => ipcRenderer.invoke("cloud:signIn", { email, password }),
    signOut: () => ipcRenderer.invoke("cloud:signOut"),
    /* Logowanie przez cudze konto. Odpowiedź przychodzi dopiero po powrocie
       z przeglądarki — a stan „czekam" w międzyczasie idzie przez
       cloud:changed, tym samym kanałem co reszta. */
    signInWith: (provider) => ipcRenderer.invoke("cloud:oauth", provider),
    cancelSignIn: () => ipcRenderer.invoke("cloud:oauthCancel"),
    redirects: () => ipcRenderer.invoke("cloud:redirects"),
    resetPassword: (email) => ipcRenderer.invoke("cloud:reset", email),
    sync: () => ipcRenderer.invoke("cloud:sync"),
    onChange: on("cloud:changed"),
  },

  /* Widget — jedyne, co Cribro pokazuje poza swoimi oknami.

     Notatki bierze tym samym mostem co reszta okien (api.notes), więc tutaj
     jest wyłącznie to, czego nie ma nigdzie indziej: własne okno, jego
     miejsce na ekranie i czynności rozkładane na tacy pod znaczkiem. */
  widget: {
    show: (visible) => ipcRenderer.invoke("widget:show", visible),
    settings: () => ipcRenderer.invoke("widget:settings"),
    passthrough: (ignore) => ipcRenderer.send("widget:passthrough", ignore),
    /* Stan okna: "badge", "tray" albo "panel". Każdy ma inny rozmiar, więc
       zmienia go proces główny — w odpowiedzi wraca gotowa geometria. */
    layout: (view) => ipcRenderer.invoke("widget:layout", view),
    /* Ta sama geometria, ale bez pytania — gdy oknem ruszył proces główny
       (odłączony monitor, „Przywróć na miejsce"). Bez niej znaczek zostałby
       narysowany względem starego okna, czyli poza nowym: niewidoczny. */
    onGeometry: on("widget:geometry"),
    /* Czynności z tacy: dyktowanie, szybka notatka, gęstość sita, język. */
    run: (action) => ipcRenderer.invoke("widget:run", action),
    /* Poziom głosu z HUD-a: znaczek reaguje na mowę, kiedy pigułka HUD-a
       schowała się już po trzech sekundach. */
    onLevel: on("widget:level"),
    // Rozciąganie szyby uchwytem. `commit` znaczy „uchwyt puszczony" —
    // dopiero wtedy rozmiar idzie na dysk.
    resize: (payload) => ipcRenderer.invoke("widget:resize", payload),
    /* Przeciąganie znaczka: renderer mówi tylko „zaczynam" i „kończę".
       Gdzie jest kursor, wie proces główny — i tylko on wie to na pewno,
       bo pyta o to system, a nie zdarzenie myszy policzone względem okna,
       które właśnie jedzie. Patrz widget:grab w main/main.js. */
    dragStart: () => ipcRenderer.invoke("widget:grab"),
    dragEnd: () => ipcRenderer.invoke("widget:release"),
    reset: () => ipcRenderer.invoke("widget:reset"),
    // Znaczek nie ma prawa zabierać fokusu sam z siebie; prosi o niego
    // dopiero wtedy, gdy człowiek w niego kliknął i chce pisać.
    grabFocus: () => ipcRenderer.send("widget:focus"),
    release: () => ipcRenderer.send("widget:blur"),
  },

  /* Kartki na pulpicie — drugi widok widgetu.

     Znaczek nie zarządza tymi oknami sam: prosi o wyłożenie albo zebranie
     talii, a rachunek (ile kartek, gdzie, na którym ekranie) należy do
     procesu głównego, bo tylko on widzi wszystkie monitory. */
  deck: {
    toggle: () => ipcRenderer.invoke("deck:toggle"),
    show: (open) => ipcRenderer.invoke("deck:show", open),
    /* Wyłóż talię i postaw WSKAZANĄ kartkę pod kursorem. Woła to plusik:
       notatka właśnie powstała i ma być gotowa do pisania. */
    reveal: (id) => ipcRenderer.invoke("deck:reveal", id),
    state: () => ipcRenderer.invoke("deck:state"),
    /* Escape: schowaj talię, jeśli leży. Odpowiedź mówi, czy było co chować —
       okno pyta o to, zanim zdejmie następną własną warstwę. */
    escape: () => ipcRenderer.invoke("deck:escape"),
    /* Talię chowa się z kilku miejsc — ze znaczka, z kartki, Escape'em spoza
       aplikacji. Znaczek musi o każdym z nich wiedzieć, bo to on ją zbiera. */
    onChange: on("deck:changed"),
    // Zamknięcie kartki zdejmuje notatkę z wierzchu — patrz deck:dismiss.
    dismiss: (id) => ipcRenderer.invoke("deck:dismiss", id),
    /* Zwinięcie do nagłówka — roleta, nie zamknięcie. Kartka zostaje na
       pulpicie i wraca jednym kliknięciem, także po ponownym wyłożeniu. */
    roll: (id, rolled) => ipcRenderer.invoke("deck:roll", { id, rolled }),
    grabFocus: () => ipcRenderer.send("deck:focus"),
    // Przeciąganie kartki: renderer liczy nowy róg okna, proces główny go
    // stawia. Patrz deck:move w main/main.js — dlaczego nie app-region.
    move: (point) => ipcRenderer.send("deck:move", point),
    drop: (id) => ipcRenderer.send("deck:drop", id),
    // Rozciąganie uchwytem w rogu kartki. `commit` znaczy „uchwyt puszczony"
    // — dopiero wtedy rozmiar idzie na dysk.
    resize: (payload) => ipcRenderer.send("deck:resize", payload),
    // Rozwijanie i zwijanie kartki rysuje renderer; proces główny mówi
    // tylko kiedy i z jakim opóźnieniem, a kartka melduje, gdy skończy.
    onFold: on("sticky:fold"),
    onScale: on("sticky:scale"),
    // „Masz tu pisać" — kartka założona plusikiem dostaje kursor od razu.
    onWrite: on("sticky:write"),
    folded: (gen) => ipcRenderer.send("deck:folded", { gen }),
  },

  /* Spotkania — nagranie rozmowy, nie dyktowanie.

     Most jest wąski, bo na tym etapie moduł naprawdę robi tyle: włącza,
     wyłącza i mówi, co już nagrał. Transkrypcja i podsumowanie dojdą
     własnymi kanałami, gdy będą czym. */
  meetings: {
    toggle: () => ipcRenderer.invoke("meetings:toggle"),
    state: () => ipcRenderer.invoke("meetings:state"),
    list: () => ipcRenderer.invoke("meetings:list"),
    remove: (id) => ipcRenderer.invoke("meetings:delete", id),
    /* Odpowiedź na pytanie znaczka „notować to spotkanie?". Pyta go
       widget, gdy proces główny rozpozna rozmowę na ekranie. */
    answer: (yes) => ipcRenderer.invoke("meetings:answer", yes),
    // Notatki pisane ręką w trakcie rozmowy — obok transkrypcji.
    note: (id, text) => ipcRenderer.invoke("meetings:note", { id, text }),
    // Podsumowanie na żądanie i własna nazwa spotkania.
    summarize: (id) => ipcRenderer.invoke("meetings:summarize", id),
    // Przepisanie nagrania jeszcze raz, z plików na dysku.
    retranscribe: (id) => ipcRenderer.invoke("meetings:retranscribe", id),
    /* Droga wyjścia: spotkanie jako notatka. Notatka powstaje sama po każdej
       rozmowie (patrz keepMeetingNote w main/main.js), więc to jest prośba
       „pokaż mi ją" — a nie „zrób ją". Drugiej kopii nie zakłada. */
    toNote: (id) => ipcRenderer.invoke("meetings:toNote", { id }),
    copy: (id) => ipcRenderer.invoke("meetings:copy", id),
    // Rozmowa bez szumu — to samo sito, co przy dyktowaniu, tylko materiał
    // ma dwie strony zamiast jednej.
    polish: (id) => ipcRenderer.invoke("meetings:polish", id),
    rename: (id, title) => ipcRenderer.invoke("meetings:rename", { id, title }),
    /* Jedno spotkanie we własnym oknie — do postawienia obok rozmowy,
       tak samo jak notatka (notes.openWindow). */
    openWindow: (id) => ipcRenderer.invoke("meetings:openWindow", id),
    // Kalendarz: „notuj to spotkanie", zgoda zapadająca przed czasem.
    arm: (id, on) => ipcRenderer.invoke("meetings:arm", { id, on }),
    /* Zgoda systemowa na czytanie kalendarza. `how` mówi, o co prosimy:
       "ask" — niech system zapyta, "open" — otwórz właściwy panel Ustawień,
       "retry" — spytaj kalendarz jeszcze raz. W odpowiedzi wraca świeży
       stan, więc okno nie musi zgadywać, czy się udało. */
    calendar: (how) => ipcRenderer.invoke("meetings:calendar", how),
    /* Przegląd tygodnia: pięć tygodni naraz, jednym zapytaniem (patrz
       main/main.js po powód). `fresh: true` pomija pięciominutowy cache —
       używa go tylko przycisk „Odśwież" w oknie przeglądu. */
    week: (fresh = false) => ipcRenderer.invoke("meetings:week", { fresh }),
    /* Zwinięcie nagłówka w podsumowaniu. Strzałka stoi w treści, więc to
       jest zmiana podsumowania — a nie stan okna, który ginie przy
       najbliższym przerysowaniu. */
    fold: (id, index, open) => ipcRenderer.invoke("meetings:fold", { id, index, open }),
    onChange: on("meeting:changed"),
    onDone: on("meeting:done"),
  },

  /* Poranek — jedno okno raz dziennie. Interfejs pyta o stan, prosi
     o pokazanie i podłącza konto Google; kiedy i z czego, decyduje proces
     główny (sekcja „Poranek" w main/main.js). */
  briefing: {
    state: () => ipcRenderer.invoke("briefing:state"),
    show: () => ipcRenderer.invoke("briefing:show"),
    connect: () => ipcRenderer.invoke("briefing:connect"),
    disconnect: () => ipcRenderer.invoke("briefing:disconnect"),
    onData: on("briefing:data"),
  },

  /* Panel admina — spis kont i przełączniki funkcji.

     Most jest tu tylko drogą. O tym, czy wolno, decyduje najpierw proces
     główny (czy to konto właściciela), a naprawdę — baza, sprawdzając adres
     z tokenu (patrz supabase/schema.sql). Wywołanie z cudzego konta wraca
     odmową albo pustką, nie danymi. */
  admin: {
    state: () => ipcRenderer.invoke("admin:state"),
    setFeature: (code, state) => ipcRenderer.invoke("admin:setFeature", { code, state }),
    grant: (code, userId, on) => ipcRenderer.invoke("admin:grant", { code, userId, on }),
  },

  system: {
    copy: (text) => ipcRenderer.invoke("clipboard:copy", text),
    status: () => ipcRenderer.invoke("hotkey:status"),
    checkHotkey: (accelerator) => ipcRenderer.invoke("hotkey:check", accelerator),
    request: (kind) => ipcRenderer.invoke("permissions:request", kind),
    capture: () => ipcRenderer.invoke("capture:toggle"),
    providers: () => ipcRenderer.invoke("providers:get"),
    openExternal: (url) => ipcRenderer.invoke("link:open", url),
    testSieve: () => ipcRenderer.invoke("test:sieve"),
    // Próba polecenia: samo rozpoznanie, bez wywołania sita.
    probeCommand: (text) => ipcRenderer.invoke("commands:probe", text),
    // „Sprawdź" przy ustawieniach Notion: czy token działa i czy integracja
    // naprawdę widzi wskazaną stronę.
    checkNotion: (patch) => ipcRenderer.invoke("notion:check", patch),
    testStt: () => ipcRenderer.invoke("test:stt"),
    // Odczyt ekranu sprawdza się na obrazku, który aplikacja rysuje sama.
    testShot: () => ipcRenderer.invoke("test:shot"),
    // Zaznaczanie ekranu wywołane z Ustawień („Przechwyć teraz").
    grabShot: () => ipcRenderer.invoke("shot:grab"),
    /* Obrazek z dysku — bez ścieżki proces główny sam zapyta o plik.
       Ścieżka przydaje się przy przeciągnięciu obrazka na okno. */
    readShotFile: (filePath = null) => ipcRenderer.invoke("shot:file", filePath),
    demo: () => ipcRenderer.invoke("demo:run"),
    // Escape: nagranie ma zniknąć bez śladu, bez transkrypcji i bez wpisu.
    cancelCapture: () => ipcRenderer.invoke("capture:cancel"),
    minimize: () => ipcRenderer.send("window:minimize"),
    close: () => ipcRenderer.send("window:close"),
  },

  onState: on("state"),
  onGoToView: on("view:go"),
  onError: on("pipeline:error"),
  onBackend: on("hotkey:backend"),
  onPermissions: on("permissions:changed"),

  // Kanały wyłącznie dla HUD-a
  hud: {
    onStart: on("rec:start"),
    onStop: on("rec:stop"),
    onCancel: on("rec:cancel"),
    sendAudio: (buffer, durationMs) => ipcRenderer.send("hud:audio", { buffer, durationMs }),
    sendLevel: (level) => ipcRenderer.send("hud:level", level),
    sendError: (message) => ipcRenderer.send("hud:error", message),
    // Nagranie bez treści — osobno od błędu, bo to nie awaria, tylko cisza.
    sendEmpty: () => ipcRenderer.send("hud:empty"),
  },
});
