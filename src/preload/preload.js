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
    toNotion: (id) => ipcRenderer.invoke("notes:toNotion", id),
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
    move: (payload) => ipcRenderer.send("widget:move", payload),
    drop: (payload) => ipcRenderer.send("widget:drop", payload),
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
    state: () => ipcRenderer.invoke("deck:state"),
    /* Escape: schowaj talię, jeśli leży. Odpowiedź mówi, czy było co chować —
       okno pyta o to, zanim zdejmie następną własną warstwę. */
    escape: () => ipcRenderer.invoke("deck:escape"),
    /* Talię chowa się z kilku miejsc — ze znaczka, z kartki, Escape'em spoza
       aplikacji. Znaczek musi o każdym z nich wiedzieć, bo to on ją zbiera. */
    onChange: on("deck:changed"),
    // Zamknięcie kartki zdejmuje notatkę z wierzchu — patrz deck:dismiss.
    dismiss: (id) => ipcRenderer.invoke("deck:dismiss", id),
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
    folded: (gen) => ipcRenderer.send("deck:folded", { gen }),
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
