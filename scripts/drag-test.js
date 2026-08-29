"use strict";
/**
 * Przenoszenie linii w prawdziwym drzewie.
 *   node scripts/drag-test.js
 *
 * shared/blockmove.js rozstrzyga, CO ma się stać, i sprawdza to
 * scripts/blockmove-test.js bez przeglądarki. Ten test sprawdza drugą
 * połowę: czy js/editor.js robi to, co tamten rozstrzygnął — a to wymaga
 * układu strony, bo szczeliny między liniami są współrzędnymi na ekranie,
 * a nie liczbami w tablicy.
 *
 * Stąd Electron, nie atrapa drzewa: to jest ten sam Chromium, w którym
 * notatka stoi naprawdę. Test składa stronę wyłącznie z prawdziwych
 * plików źródłowych i steruje edytorem tak, jak steruje nim ręka —
 * zdarzeniami wskaźnika, nie wywołaniem funkcji wewnętrznej.
 */

const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-drag-"));
const url = (...parts) => "file://" + path.join(root, ...parts);

/* ── Strona ─────────────────────────────────────────────────────
   Same prawdziwe źródła. Gdyby test miał własną kopię edytora, sprawdzałby
   tę kopię — i przechodziłby jeszcze długo po tym, jak edytor by się zepsuł. */

fs.writeFileSync(
  path.join(work, "harness.html"),
  `<!doctype html><html lang="pl"><head><meta charset="utf-8" />
<link rel="stylesheet" href="${url("src/renderer/css/tokens.css")}" />
<link rel="stylesheet" href="${url("src/renderer/css/prose.css")}" />
<style>body{margin:0;padding:40px}#text{width:600px}</style>
</head><body>
<div id="text" class="prose"></div>
<script src="${url("src/shared/richtext.js")}"></script>
<script src="${url("src/shared/blockmove.js")}"></script>
<script src="${url("src/renderer/js/editor.js")}"></script>
</body></html>`,
);

/* ── Sterowanie ─────────────────────────────────────────────────
   Wszystko poniżej biegnie W OKNIE, nie tutaj: `drive` dostaje treść
   notatki i opis ruchu, oddaje Markdown po ruchu. */

const HARNESS = `
window.__run = (markdown, move) => {
  /* Świeży element na każdy przypadek — tak samo, jak Notatnik przebudowuje
     swój szkielet (root.innerHTML = SKELETON). Element użyty ponownie
     trzymałby nasłuchy poprzedniego edytora i ⌥↓ przesuwałoby linię tyle
     razy, ilu edytorów zdążyło się na nim zapisać. */
  const host = document.createElement("div");
  host.id = "text";
  host.className = "prose";
  document.getElementById("text").replaceWith(host);
  let inputs = 0;
  const editor = window.CribroEditor.create(host, { onInput: () => { inputs += 1; } });
  editor.setMarkdown(markdown);

  const lines = () => {
    const out = [];
    for (const block of host.children) {
      if (block.getAttribute("data-folded") === "true") continue;
      if (block.tagName === "UL" || block.tagName === "OL") out.push(...block.children);
      else out.push(block);
    }
    return out;
  };

  const find = (needle) => lines().find((node) => node.textContent.trim() === needle);
  const point = (type, target, y) =>
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: 20, clientY: y,
    }));

  if (move.key) {
    // Kursor w linii, potem skrót — dokładnie jak przy pisaniu.
    const line = find(move.grab);
    const range = document.createRange();
    range.setStart(line.firstChild || line, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    host.dispatchEvent(new KeyboardEvent("keydown", {
      key: move.key, altKey: true, bubbles: true, cancelable: true,
    }));
  } else {
    const line = find(move.grab);
    // 1. kursor wjeżdża na linię — pokazuje się uchwyt
    point("pointermove", line, line.getBoundingClientRect().top + 4);
    const grip = document.querySelector(".prose-grip");
    if (!grip || grip.hidden) return { error: "uchwyt się nie pokazał" };

    // 2. celujemy w krawędź linii docelowej: nad nią albo pod nią
    const target = find(move.over);
    const box = target.getBoundingClientRect();
    const y = move.below ? box.bottom : box.top;

    // 3. chwyt, przeciągnięcie, puszczenie
    point("pointerdown", grip, box.top);
    point("pointermove", grip, y);
    const mark = document.querySelector(".prose-drop");
    const marked = mark && !mark.hidden;
    point("pointerup", grip, y);
    return { markdown: editor.getMarkdown(), inputs, marked };
  }

  return { markdown: editor.getMarkdown(), inputs };
};
/* Wartość ostatniego wyrażenia wraca przez IPC, a funkcji nie da się
   przesłać („An object could not be cloned”). Stąd zero na końcu. */
0;
`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 800 });
  await win.loadURL(${JSON.stringify("file://" + path.join(work, "harness.html"))});
  await win.webContents.executeJavaScript(${JSON.stringify(HARNESS)});
  const out = [];
  for (const item of JSON.parse(require("fs").readFileSync(${JSON.stringify(path.join(work, "cases.json"))}, "utf8"))) {
    out.push(await win.webContents.executeJavaScript(
      "window.__run(" + JSON.stringify(item.markdown) + "," + JSON.stringify(item.move) + ")",
    ));
  }
  process.stdout.write("\\n@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@\\n");
  app.exit(0);
});
`;

fs.writeFileSync(path.join(work, "main.js"), MAIN);

/* ── Przypadki ──────────────────────────────────────────────────
   Połowa z nich to takie, w których coś ma NIE ruszyć albo ma zmienić
   rodzaj — bo przeciąganie, które tylko przestawia sąsiadów, jest łatwe;
   psuje się dopiero na granicach list. */

const cases = [
  {
    name: "Zadanie z końca listy ląduje na jej początku, ze swoim stanem",
    markdown: "- [ ] kupić mleko\n- [ ] wysłać raport\n- [x] zadzwonić do Ani",
    move: { grab: "zadzwonić do Ani", over: "kupić mleko" },
    expect: "- [x] zadzwonić do Ani\n- [ ] kupić mleko\n- [ ] wysłać raport",
  },
  {
    name: "Punkt listy upuszczony przy akapicie wychodzi z listy i staje się akapitem",
    markdown: "Wstęp.\n\n- pierwszy\n- drugi",
    move: { grab: "drugi", over: "Wstęp." },
    expect: "drugi\n\nWstęp.\n\n- pierwszy",
  },
  {
    name: "Akapit wciągnięty w listę zadań staje się zadaniem nieodhaczonym",
    markdown: "zadzwonić do Ani\n\n- [ ] kupić mleko\n- [x] wysłać raport",
    move: { grab: "zadzwonić do Ani", over: "wysłać raport" },
    expect: "- [ ] kupić mleko\n- [ ] zadzwonić do Ani\n- [x] wysłać raport",
  },
  {
    name: "Ostatni punkt zabrany z listy zabiera ze sobą pustą listę",
    markdown: "Wstęp.\n\n- sam jeden",
    move: { grab: "sam jeden", over: "Wstęp." },
    expect: "sam jeden\n\nWstęp.",
  },
  {
    name: "Odłożenie linii na jej własne miejsce nie jest zmianą",
    markdown: "- pierwszy\n- drugi\n- trzeci",
    move: { grab: "drugi", over: "drugi" },
    expect: "- pierwszy\n- drugi\n- trzeci",
    quiet: true,
  },
  {
    name: "Zwinięty nagłówek jedzie razem ze swoją schowaną treścią",
    markdown: "## ▸ Ustalenia\n\nAnia robi raport.\n\n## Inne\n\nDrobiazgi.",
    move: { grab: "Ustalenia", over: "Drobiazgi.", below: true },
    expect: "## Inne\n\nDrobiazgi.\n\n## ▸ Ustalenia\n\nAnia robi raport.",
  },
  {
    name: "⌥↓ przesuwa punkt o jedno miejsce w dół",
    markdown: "- pierwszy\n- drugi\n- trzeci",
    move: { grab: "pierwszy", key: "ArrowDown" },
    expect: "- drugi\n- pierwszy\n- trzeci",
  },
  {
    name: "⌥↑ z pierwszej linii nie robi nic",
    markdown: "- pierwszy\n- drugi",
    move: { grab: "pierwszy", key: "ArrowUp" },
    expect: "- pierwszy\n- drugi",
    quiet: true,
  },
];

fs.writeFileSync(
  path.join(work, "cases.json"),
  JSON.stringify(cases.map(({ markdown, move }) => ({ markdown, move }))),
);

/* ── Przebieg ───────────────────────────────────────────────── */

const electron = require("electron");
let stdout = "";
try {
  stdout = execFileSync(electron, [path.join(work, "main.js")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Powłoka rozszerzeń VS Code eksportuje ELECTRON_RUN_AS_NODE=1, przez co
    // Electron startuje jako zwykły Node i cicho ginie z kodem 0.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_ENABLE_LOGGING: "" },
    timeout: 90_000,
  });
} catch (problem) {
  console.error(problem.stdout ?? "");
  console.error(problem.stderr ?? "");
  throw new Error("Electron nie dokończył testu.");
}

const payload = /@@WYNIK@@([\s\S]*?)@@KONIEC@@/.exec(stdout);
if (!payload) {
  console.error(stdout);
  throw new Error("Okno nie oddało wyniku.");
}
const results = JSON.parse(payload[1]);

let passed = 0;
for (const [index, item] of cases.entries()) {
  const got = results[index];
  assert.ok(got, `${item.name} — brak wyniku`);
  assert.ok(!got.error, `${item.name} — ${got.error}`);
  assert.strictEqual(got.markdown, item.expect, item.name);
  if (item.quiet) {
    assert.strictEqual(got.inputs, 0, `${item.name} — notatka zapisała się bez powodu`);
  }
  console.log("✓", item.name);
  passed += 1;
}

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} przypadków przeszło.`);
