"use strict";
/**
 * Test maszyny stanów skrótu. Podstawia Electrona i uiohooka, więc chodzi
 * bez uprawnień i bez klawiatury.
 *   node scripts/hotkey-test.js
 */
const assert = require("assert");
const Module = require("module");

/* ── Podstawienia ─────────────────────────────────────────────── */

const listeners = {};
const fakeUiohook = {
  uIOhook: {
    on: (event, handler) => ((listeners[event] ??= []).push(handler), fakeUiohook.uIOhook),
    start: () => {},
    stop: () => {},
    removeAllListeners: () => {},
  },
};

const fakeElectron = {
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return fakeElectron;
  if (request === "uiohook-napi") return fakeUiohook;
  return load.call(this, request, ...rest);
};

const { HotkeyEngine } = require("../src/main/hotkeys");

/* ── Pomocnicze ───────────────────────────────────────────────── */

const CTRL = 29;
const ALT = 56;
const ESC = 1;

const fire = (event, keycode) => (listeners[event] ?? []).forEach((fn) => fn({ keycode }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Między przypadkami trzeba odczekać dłużej niż okno podwójnego stuknięcia,
   inaczej ostatnie stuknięcie jednego testu paruje się z pierwszym następnego. */
const settle = () => wait(600);

const events = [];
const engine = new HotkeyEngine({
  onStart: (meta) => events.push(`start:${meta.trigger}`),
  onStop: (meta) => events.push(`stop:${meta.trigger}`),
  onCancel: () => events.push("cancel"),
  isRecording: () => engine.recording,
});

/* Konfiguracja to sam komplet klawiszy. Trzymanie i podwójne stuknięcie
   są w silniku zawsze — nie ma ustawienia, które by je włączało. */
const backend = engine.start({ hold: ["Ctrl", "Alt"] });
assert.equal(backend, "uiohook", "silnik powinien wybrać uiohook");

const press = () => {
  fire("keydown", CTRL);
  fire("keydown", ALT);
};
const release = () => {
  fire("keyup", ALT);
  fire("keyup", CTRL);
};

(async () => {
  /* 1. Trzymanie: wciśnięcie ponad próg → nagrywa; puszczenie → koniec */
  events.length = 0;
  press();
  await wait(300);
  release();
  assert.deepEqual(events, ["start:hold", "stop:hold-release"], `trzymanie: ${events}`);
  console.log("✓ Trzymanie startuje po progu i kończy się na puszczeniu");

  await settle();

  /* 2. Pojedyncze stuknięcie nie robi nic */
  events.length = 0;
  press();
  await wait(60);
  release();
  await wait(60);
  assert.deepEqual(events, [], `pojedyncze stuknięcie nie powinno nic robić: ${events}`);
  console.log("✓ Pojedyncze stuknięcie jest ignorowane");

  await settle();

  /* 3. Podwójne stuknięcie → nagrywanie bez trzymania */
  events.length = 0;
  press();
  await wait(60);
  release();
  await wait(100);
  press();
  await wait(60);
  release();
  assert.deepEqual(events, ["start:hands-off"], `podwójne stuknięcie: ${events}`);
  assert.equal(engine.mode, "handsfree");
  console.log("✓ Podwójne stuknięcie włącza tryb bez trzymania");

  await settle();

  /* 4. Kolejne stuknięcie kończy — i nie startuje niczego nowego */
  events.length = 0;
  press();
  await wait(60);
  release();
  await wait(300);
  assert.deepEqual(events, ["stop:hands-off"], `zakończenie hands-off: ${events}`);
  assert.equal(engine.mode, "idle");
  console.log("✓ Kolejne stuknięcie kończy nagrywanie bez trzymania");

  await settle();

  /* 5. Escape kasuje nagranie zamiast je kończyć */
  events.length = 0;
  press();
  await wait(300); // nagrywa (trzymanie)
  fire("keydown", ESC);
  release();
  await wait(50);
  assert.deepEqual(events, ["start:hold", "cancel"], `escape: ${events}`);
  assert.equal(engine.mode, "idle", "po anulowaniu stan wraca do spoczynku");
  console.log("✓ Escape kasuje nagranie i nie wywołuje transkrypcji");

  await settle();

  /* 6. Escape w trybie bez trzymania też kasuje */
  events.length = 0;
  press();
  await wait(60);
  release();
  await wait(100);
  press();
  await wait(60);
  release();
  fire("keydown", ESC);
  await wait(50);
  assert.deepEqual(events, ["start:hands-off", "cancel"], `escape hands-off: ${events}`);
  console.log("✓ Escape działa też w trybie bez trzymania");

  await settle();

  /* 7. Zbyt wolne stuknięcia to nie jest podwójne stuknięcie */
  events.length = 0;
  press();
  await wait(60);
  release();
  await wait(700); // dłużej niż okno
  press();
  await wait(60);
  release();
  await wait(50);
  assert.deepEqual(events, [], `wolne stuknięcia: ${events}`);
  console.log("✓ Zbyt wolne stuknięcia nie włączają hands-off");

  await settle();

  /* 8. Nagranie z przycisku przejmowane przez skrót */
  events.length = 0;
  engine.adopt();
  press();
  await wait(60);
  release();
  await wait(50);
  assert.deepEqual(events, ["stop:hands-off"], `przejęcie z przycisku: ${events}`);
  console.log("✓ Nagranie uruchomione przyciskiem kończy się skrótem");

  console.log("\nMaszyna stanów skrótu działa poprawnie.");
  process.exit(0);
})().catch((error) => {
  console.error("✗", error.message);
  process.exit(1);
});
