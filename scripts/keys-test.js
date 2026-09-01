"use strict";
/**
 * Skróty wybierane ręką — jeden nasłuch, wiele celów.
 *   node scripts/keys-test.js
 *
 * ══ O CO TU CHODZI ══
 *
 * Do niedawna klawisze wybierało się w Cribro w jednym miejscu (tekst
 * z ekranu), więc „czy łapiemy klawisze” było zwykłym tak/nie. Odkąd
 * szybka notatka też ma własny skrót, to samo pytanie ma trzy odpowiedzi:
 * nie łapiemy, łapiemy do zrzutu, łapiemy do notatki. I dokładnie tu leży
 * pułapka, przed którą stoi ten test.
 *
 * DWA NASŁUCHY NARAZ ZAPISAŁYBY TE SAME KLAWISZE W DWÓCH MIEJSCACH.
 * Gdyby każdy wiersz miał własną flagę, kliknięcie „Ustaw klawisze” w obu
 * zostawiłoby oba czekające — a naciśnięcie ⌃⌥N trafiłoby w oba, bo
 * nasłuch klawiatury jest wspólny i wisi na dokumencie. Skrót ustawiony
 * przez przypadek w drugim miejscu jest gorszy niż skrót nieustawiony:
 * nie widać go tam, gdzie się go szuka, a mimo to zajmuje klawisze.
 *
 * Dlatego stan trzyma ŚCIEŻKĘ ustawienia, nie flagę, a ten test pilnuje
 * trzech rzeczy, których asercja na kształt obiektu nie złapie:
 *
 *   1. że kliknięcie w drugi cel PRZENOSI nasłuch, zamiast dodawać drugi,
 *   2. że naciśnięte klawisze lądują w tym polu, które o nie prosiło,
 *   3. że każda ścieżka z katalogu prowadzi do prawdziwego ustawienia —
 *      literówka w niej zapisywałaby skrót w nowe, niczyje miejsce
 *      i nie miałaby jak się ujawnić.
 *
 * Okno stoi na atrapie mostu (renderer/js/mock-bridge.js), bo nie chodzi
 * o prawdziwe zajmowanie klawiszy w systemie, tylko o to, czy interfejs
 * odkłada je tam, gdzie mówi. Biegnie w Electronie, bo tylko tam jest okno.
 */
const { execFileSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const MAIN = `
const { app, BrowserWindow } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

/* Strażnik czasu: zawieszone okno ma zgłosić awarię, a nie wisieć. */
setTimeout(() => {
  console.log("WYNIK " + JSON.stringify({ error: "okno nie odpowiedziało" }));
  app.exit(1);
}, 60000);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Naciśnięcie klawiszy tak, jak je widzi nasłuch.
 *
 * Literę czyta z \`code\`, bo nasłuch patrzy na układ FIZYCZNY — „N" na
 * polskiej i amerykańskiej klawiaturze ma znaczyć to samo. Ale Escape
 * rozpoznaje po \`key\`, więc klawisze nazwane muszą przyjść pod własną
 * nazwą, a nie zjechać do małych liter razem z literami.
 */
const PRESS = (code, mods) => \`
  (() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      code: \${JSON.stringify(code)},
      key: \${JSON.stringify(code.startsWith("Key") ? code.slice(3).toLowerCase() : code)},
      ctrlKey: \${!!mods.ctrl}, altKey: \${!!mods.alt},
      shiftKey: \${!!mods.shift}, metaKey: \${!!mods.meta},
      bubbles: true, cancelable: true,
    }));
    return true;
  })()
\`;

/** Kto w tej chwili czeka na klawisze i co stoi w polach. */
const LOOK = \`
  (async () => {
    const s = await window.cribro.settings.get();
    const btn = (keys) => document.querySelector('[data-act="keys-record"][data-keys="' + keys + '"]');
    const waiting = (keys) => {
      const el = btn(keys);
      return !!el && el.textContent.trim().startsWith("Czekam");
    };
    return {
      quickNote: s.hotkey.quickNote ?? null,
      shot: s.shot?.hotkey ?? null,
      waitingQuick: waiting("quickNote"),
      waitingShot: waiting("shot"),
      hasQuickButton: !!btn("quickNote"),
      hasShotButton: !!btn("shot"),
      /* Czy w ustawieniach domyślnych jest w ogóle miejsce na te skróty.
         Ścieżka z literówką zapisałaby się obok, a nie w nich. */
      slotQuick: "quickNote" in (s.hotkey ?? {}),
      slotShot: !!s.shot && "hotkey" in s.shot,
      clearQuick: !!document.querySelector('[data-act="keys-clear"][data-keys="quickNote"]'),
      hold: (s.hotkey.hold ?? []).join("+"),
      waitingHold: waiting("hold"),
      /* „Przywróć ⌃⌥" pokazuje się tylko wtedy, gdy jest co przywracać. */
      restoreHold: !!document.querySelector('[data-act="keys-clear"][data-keys="hold"]'),
    };
  })()
\`;

const click = (selector) =>
  \`(() => { const el = document.querySelector(\${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()\`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  const step = {};
  try {
    await win.loadFile(path.join(${JSON.stringify(root)}, "src/renderer/index.html"));
    await wait(2500);
    await win.webContents.executeJavaScript(click('.nav__item[data-view="settings"]'));
    await wait(800);

    step.start = await win.webContents.executeJavaScript(LOOK);

    /* 1. Proszymy o klawisze dla szybkiej notatki. */
    await win.webContents.executeJavaScript(click('[data-act="keys-record"][data-keys="quickNote"]'));
    await wait(400);
    step.armedQuick = await win.webContents.executeJavaScript(LOOK);

    /* 2. …i zaraz o klawisze dla zrzutu. Nasłuch ma się PRZENIEŚĆ. */
    await win.webContents.executeJavaScript(click('[data-act="keys-record"][data-keys="shot"]'));
    await wait(400);
    step.movedToShot = await win.webContents.executeJavaScript(LOOK);

    /* 3. Wracamy na notatkę i naciskamy ⌃⌥N. */
    await win.webContents.executeJavaScript(click('[data-act="keys-record"][data-keys="quickNote"]'));
    await wait(400);
    await win.webContents.executeJavaScript(PRESS("KeyN", { ctrl: true, alt: true }));
    await wait(700);
    step.pressed = await win.webContents.executeJavaScript(LOOK);

    /* 4. Sam modyfikator nie jest skrótem — nie ma prawa nic zapisać. */
    await win.webContents.executeJavaScript(click('[data-act="keys-record"][data-keys="quickNote"]'));
    await wait(400);
    await win.webContents.executeJavaScript(PRESS("ControlLeft", { ctrl: true }));
    await wait(500);
    step.modifierOnly = await win.webContents.executeJavaScript(LOOK);

    /* 5. Klawisz bez modyfikatora też nie — zabrałby literę całemu systemowi. */
    await win.webContents.executeJavaScript(PRESS("KeyJ", {}));
    await wait(500);
    step.bareKey = await win.webContents.executeJavaScript(LOOK);

    /* 6. Escape przerywa ustawianie i nie rusza tego, co już zapisane. */
    await win.webContents.executeJavaScript(PRESS("Escape", {}));
    await wait(500);
    step.escaped = await win.webContents.executeJavaScript(LOOK);

    /* 7. Skasowanie zdejmuje klawisze, ale nie funkcję. */
    await win.webContents.executeJavaScript(click('[data-act="keys-clear"][data-keys="quickNote"]'));
    await wait(600);
    step.cleared = await win.webContents.executeJavaScript(LOOK);

    /* ── Trzymanie: inny kształt, ta sama droga ────────────────── */

    /* 8. Litera pod modyfikatorami nie ma prawa wejść do trzymania. */
    await win.webContents.executeJavaScript(click('[data-act="keys-record"][data-keys="hold"]'));
    await wait(400);
    step.armedHold = await win.webContents.executeJavaScript(LOOK);
    await win.webContents.executeJavaScript(PRESS("KeyS", { ctrl: true, alt: true }));
    await wait(500);
    step.holdWithLetter = await win.webContents.executeJavaScript(LOOK);

    /* 9. Jeden modyfikator to za mało — ruszałby nagranie przy pisaniu. */
    await win.webContents.executeJavaScript(PRESS("ShiftLeft", { shift: true }));
    await wait(500);
    step.holdOne = await win.webContents.executeJavaScript(LOOK);

    /* 10. Dwa modyfikatory zapisują się i to w ustalonej kolejności —
           naciśnięte ⇧⌃ mają wyjść jako Ctrl+Shift, nie Shift+Ctrl. */
    await win.webContents.executeJavaScript(PRESS("ShiftLeft", { shift: true, ctrl: true }));
    await wait(700);
    step.holdTwo = await win.webContents.executeJavaScript(LOOK);

    /* 11. Przywrócenie wraca do ⌃⌥, a nie do pustki. */
    await win.webContents.executeJavaScript(click('[data-act="keys-clear"][data-keys="hold"]'));
    await wait(600);
    step.holdRestored = await win.webContents.executeJavaScript(LOOK);

    console.log("WYNIK " + JSON.stringify(step));
    app.exit(0);
  } catch (problem) {
    console.log("WYNIK " + JSON.stringify({ error: String((problem && problem.message) || problem) }));
    app.exit(1);
  }
});
`;

const fs = require("fs");
const os = require("os");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-keys-"));
fs.writeFileSync(path.join(work, "main.js"), MAIN);
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "keys", main: "main.js" }));

const electron = path.join(root, "node_modules", ".bin", "electron");
if (!fs.existsSync(electron)) {
  console.log("· Electron nie jest zainstalowany — pomijam test okna.");
  process.exit(0);
}

let raw;
try {
  raw = execFileSync(electron, [work], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const line = raw.split("\n").find((row) => row.startsWith("WYNIK "));
if (!line) {
  console.error(raw);
  throw new Error("okno nie oddało wyniku");
}
const step = JSON.parse(line.slice(6));
if (step.error) throw new Error(step.error);

const assert = require("assert");
let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Miejsce na skrót istnieje po obu stronach ─────────────────── */

check("Ustawienia mają pole na skrót szybkiej notatki", step.start.slotQuick);
check("Ustawienia mają pole na skrót tekstu z ekranu", step.start.slotShot);
check("Szybka notatka ma czym poprosić o klawisze", step.start.hasQuickButton);
check("Tekst z ekranu ma czym poprosić o klawisze", step.start.hasShotButton);
check("Bez klawiszy nie ma czego kasować", !step.start.clearQuick);

/* ── Nasłuch jest JEDEN ────────────────────────────────────────── */

check("Kliknięcie „Ustaw klawisze” ustawia nasłuch na tym wierszu", step.armedQuick.waitingQuick);
check("…i tylko na tym", !step.armedQuick.waitingShot);
check("Kliknięcie w drugi wiersz przenosi nasłuch do niego", step.movedToShot.waitingShot);
check(
  "…i zdejmuje go z pierwszego — dwa pola nigdy nie czekają razem",
  !step.movedToShot.waitingQuick,
);

/* ── Klawisze lądują tam, gdzie o nie proszono ─────────────────── */

check("⌃⌥N zapisuje się jako skrót szybkiej notatki", step.pressed.quickNote === "Control+Alt+N");
check("…i nie dotyka skrótu tekstu z ekranu", step.pressed.shot === null);
check("Po zapisaniu nasłuch gaśnie sam", !step.pressed.waitingQuick);
check("Zapisany skrót daje się skasować", step.pressed.clearQuick);

/* ── Czego zapisać nie wolno ───────────────────────────────────── */

check(
  "Sam modyfikator nie jest skrótem — nie zmienia zapisanego",
  step.modifierOnly.quickNote === "Control+Alt+N",
);
check("…i nasłuch dalej czeka na prawdziwy klawisz", step.modifierOnly.waitingQuick);
check(
  "Klawisz bez modyfikatora nie zabiera litery całemu systemowi",
  step.bareKey.quickNote === "Control+Alt+N",
);

/* ── Wyjścia ───────────────────────────────────────────────────── */

check("Escape przerywa ustawianie", !step.escaped.waitingQuick);
check("…i nie rusza tego, co było zapisane", step.escaped.quickNote === "Control+Alt+N");
check("Skasowanie zdejmuje klawisze", step.cleared.quickNote === null);
check("…i wraca przycisk „Ustaw klawisze”", step.cleared.hasQuickButton);

/* ── Trzymanie ─────────────────────────────────────────────────── */

check("Domyślnie trzymanie to ⌃⌥", step.start.hold === "Ctrl+Alt");
check("Przy domyślnym komplecie nie ma czego przywracać", !step.start.restoreHold);
check("Trzymanie daje się poprosić o klawisze", step.armedHold.waitingHold);
check("…i nasłuch schodzi wtedy z pozostałych", !step.armedHold.waitingQuick);
check(
  "Litera pod modyfikatorami nie wchodzi do trzymania",
  step.holdWithLetter.hold === "Ctrl+Alt" && step.holdWithLetter.waitingHold,
);
check(
  "Jeden modyfikator to za mało — nasłuch czeka dalej",
  step.holdOne.hold === "Ctrl+Alt" && step.holdOne.waitingHold,
);
/* Naciśnięte zostało ⇧, a potem ⌃ pod spodem — zapis ma wyjść w kolejności
   z HOLD_KEYS, nie w kolejności palców. Silnik dopasowuje komplet, ale zapis
   trafia też człowiekowi przed oczy i „Shift+Ctrl" raz, a „Ctrl+Shift" innym
   razem wyglądałoby jak dwa różne skróty. */
check(
  "Dwa modyfikatory zapisują się w ustalonej kolejności, nie w kolejności palców",
  step.holdTwo.hold === "Ctrl+Shift",
);
check("Po zapisaniu nasłuch gaśnie", !step.holdTwo.waitingHold);
check("Zmienione trzymanie da się przywrócić", step.holdTwo.restoreHold);
check("Przywrócenie wraca do ⌃⌥, nie do pustki", step.holdRestored.hold === "Ctrl+Alt");

console.log(
  `\nSkróty ręczne: ${passed} sprawdzeń przeszło. Jeden nasłuch, klawisze tam, gdzie proszono.`,
);
