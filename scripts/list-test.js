"use strict";
/**
 * Listy w notatce — prawdziwą klawiaturą, w prawdziwym drzewie.
 *   node scripts/list-test.js
 *
 * Trzy rzeczy, które w edytorze tekstu robi się odruchowo i których
 * Chromium samo w contenteditable NIE ROBI:
 *
 *   „1. " na początku linii zaczyna listę numerowaną (a „- " punktowaną),
 *   Tab i ⇧Tab przesuwają punkt o poziom w głąb i z powrotem,
 *   Enter w pustym punkcie kończy poziom, a na ostatnim — całą listę.
 *
 * Sprawdzamy to tak, jak się tego używa: naciśnięciami klawiszy przez
 * sendInputEvent, a nie wołaniem metod. Metody da się zawołać także wtedy,
 * gdy klawisz do nich nie dochodzi — a właśnie dochodzenie klawisza jest
 * tu całą treścią zmiany.
 *
 * Patrzymy przy tym na MARKDOWN, nie na HTML: liczy się to, co zostaje
 * w pliku. Poziomy numerowania (1. → a. → I.) w pliku nie istnieją — są
 * wcięciem, a znak numeru rysuje CSS (patrz .prose ol w css/prose.css).
 */

const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-list-"));
const url = (...parts) => "file://" + path.join(root, ...parts);

fs.writeFileSync(
  path.join(work, "harness.html"),
  `<!doctype html><html lang="pl"><head><meta charset="utf-8" />
<link rel="stylesheet" href="${url("src/renderer/css/tokens.css")}" />
<link rel="stylesheet" href="${url("src/renderer/css/prose.css")}" />
<style>
  html,body{margin:0;height:100%}
  body{padding:40px;background:#09101c}
  #text{width:520px}
</style>
</head><body>
<div id="text" class="prose"></div>
<script src="${url("src/shared/richtext.js")}"></script>
<script src="${url("src/shared/blockmove.js")}"></script>
<script src="${url("src/renderer/js/editor.js")}"></script>
</body></html>`,
);

const HARNESS = String.raw`
window.__editor = null;

window.__setup = (markdown) => {
  const host = document.createElement("div");
  host.id = "text";
  host.className = "prose";
  document.getElementById("text").replaceWith(host);
  window.__editor = window.CribroEditor.create(host, { onInput: () => {} });
  window.__editor.setMarkdown(markdown);
  /* Kursor na koniec ostatniego SŁOWA, a nie na koniec notatki: tam stoi
     ręka po dopisaniu ostatniej litery i stamtąd naciska się Enter i Tab.
     Kursor postawiony między blokami (focusEnd) nie jest tym samym
     miejscem — przeglądarka nie wie wtedy, w której linii pisać. */
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  host.focus();
  if (last) {
    const range = document.createRange();
    range.setStart(last, last.nodeValue.length);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    window.__editor.focusEnd();
  }
  return true;
};

window.__markdown = () => window.__editor.getMarkdown();

/** Znaki numeracji, jakie WIDAĆ na ekranie — po jednym na poziom. */
window.__markers = () =>
  [...document.querySelectorAll("#text ol")].map((list) => getComputedStyle(list).listStyleType);

/** Co pasek podświetla przy kursorze. */
window.__active = () => window.__editor.activeFormats();
0;
`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, x: -2400, y: 80, width: 900, height: 900, backgroundColor: "#09101c",
  });
  await win.loadURL(${JSON.stringify("file://" + path.join(work, "harness.html"))});
  await win.webContents.executeJavaScript(${JSON.stringify(HARNESS)});
  const js = (code) => win.webContents.executeJavaScript(code);
  const send = (e) => win.webContents.sendInputEvent(e);

  /* Klawisz idzie trzema zdarzeniami, tak jak z prawdziwej klawiatury:
     keyDown niesie klawisz (na niego patrzy edytor), char niesie znak
     (z niego powstaje tekst). Enter bez "char" nie łamie linii, a spacja
     bez "keyDown" nie dochodzi do rozpoznawania znaczników list. */
  const key = async (keyCode, { modifiers = [], char = null } = {}) => {
    send({ type: "keyDown", keyCode, modifiers });
    if (char !== null) send({ type: "char", keyCode: char, modifiers });
    send({ type: "keyUp", keyCode, modifiers });
    await wait(60);
  };
  /* Litery idą samym "char" — keyDown z literą bywa w Electronie tłumaczony
     przez układ klawiatury i wpisywał znak sąsiedni (kropka wychodziła
     przecinkiem). Spacja jest wyjątkiem: ona MUSI mieć keyDown. */
  const type = async (textToType) => {
    for (const ch of textToType) {
      if (ch === " ") await key(" ", { char: " " });
      else {
        send({ type: "char", keyCode: ch });
        await wait(25);
      }
    }
  };
  const fresh = async (markdown) => {
    await js("window.__setup(" + JSON.stringify(markdown) + ")");
    await wait(250);
  };

  /* Pierwsze naciśnięcie po otwarciu okna bywa gubione albo doklejane
     do poprzedniego — okno zdąży się pokazać, zanim zacznie się pisanie. */
  await wait(600);

  const out = {};

  /* ── 1. „1. " robi listę numerowaną ── */
  await fresh("");
  await type("1. pierwszy");
  out.numbered = { markdown: await js("window.__markdown()"), active: await js("window.__active()") };

  /* ── 2. „- " robi listę punktowaną, a „[] " listę zadań ── */
  await fresh("");
  await type("- kawa");
  out.bullet = { markdown: await js("window.__markdown()") };

  await fresh("");
  await type("[] oddzwonić");
  out.todo = { markdown: await js("window.__markdown()") };

  /* ── 3. Znacznik w środku zdania nie porywa linii ── */
  await fresh("Zostało 1. miejsce");
  await type(" wolne");
  out.midline = { markdown: await js("window.__markdown()") };

  /* ── 4. Tab wciąga punkt o poziom głębiej ── */
  await fresh("1. raz\\n2. dwa");
  await key("Tab");
  out.indented = { markdown: await js("window.__markdown()"), markers: await js("window.__markers()") };

  /* ── 5. Drugi poziom i trzeci — trzy różne znaki numeracji ── */
  await fresh("1. raz\\n  1. dwa\\n    1. trzy");
  out.levels = { markers: await js("window.__markers()") };

  /* ── 6. ⇧Tab oddaje poziom z powrotem ── */
  await fresh("1. raz\\n  1. dwa");
  await key("Tab", { modifiers: ["shift"] });
  out.outdented = { markdown: await js("window.__markdown()") };

  /* ── 7. Pierwszy punkt listy nie ma pod co się podczepić ── */
  await fresh("- jedyny");
  await key("Tab");
  out.firstItem = { markdown: await js("window.__markdown()") };

  /* ── 8. Enter w pustym punkcie kończy poziom, potem listę ── */
  await fresh("- plan\\n  - krok");
  await key("Return", { char: String.fromCharCode(13) });
  out.escapedOnce = { markdown: await js("window.__markdown()") };
  await key("Return", { char: String.fromCharCode(13) });
  out.escaped = { markdown: await js("window.__markdown()") };

  await fresh("- jedno");
  await key("Return", { char: String.fromCharCode(13) });
  await key("Return", { char: String.fromCharCode(13) });
  await type("zwykły akapit");
  out.leftList = { markdown: await js("window.__markdown()") };

  console.log("@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@");
  app.exit(0);
});

setTimeout(() => { console.log("@@WYNIK@@" + JSON.stringify({ timeout: true }) + "@@KONIEC@@"); app.exit(0); }, 100000);
`;

fs.writeFileSync(path.join(work, "main.js"), MAIN);

const electron = require("electron");
let stdout = "";
try {
  stdout = execFileSync(electron, [path.join(work, "main.js")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_ENABLE_LOGGING: "" },
    timeout: 120_000,
    killSignal: "SIGKILL",
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
const r = JSON.parse(payload[1]);
assert.ok(!r.timeout, "Okno nie zdążyło — klawisz gdzieś utknął.");

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? `\n  ${detail}` : ""}`);
  console.log("✓", label);
  passed += 1;
};

check(
  "„1. " + '" zaczyna listę numerowaną, a sam znacznik znika z tekstu',
  r.numbered.markdown === "1. pierwszy",
  r.numbered.markdown,
);
check("…i pasek wie, że kursor stoi w liście numerowanej", r.numbered.active.numbered === true);
check("…i nie myli jej z listą punktowaną", r.numbered.active.bullet === false);
check('„- " zaczyna listę punktowaną', r.bullet.markdown === "- kawa", r.bullet.markdown);
check('„[] " zaczyna listę zadań', r.todo.markdown === "- [ ] oddzwonić", r.todo.markdown);
check(
  "Liczba w środku zdania zostaje liczbą",
  r.midline.markdown === "Zostało 1. miejsce wolne",
  r.midline.markdown,
);
check(
  "Tab wciąga punkt w poprzedni",
  r.indented.markdown === "1. raz\n  1. dwa",
  r.indented.markdown,
);
check(
  "…a wciągnięty punkt dostaje własny znak numeracji",
  r.indented.markers.join(",") === "decimal,lower-alpha",
  r.indented.markers.join(","),
);
check(
  "Trzy poziomy numerowania to 1., a. i I. — jak w edytorze tekstu",
  r.levels.markers.join(",") === "decimal,lower-alpha,upper-roman",
  r.levels.markers.join(","),
);
check(
  "⇧Tab oddaje poziom z powrotem",
  r.outdented.markdown === "1. raz\n2. dwa",
  r.outdented.markdown,
);
check(
  "Pierwszy punkt listy nie daje się wciągnąć głębiej",
  r.firstItem.markdown === "- jedyny",
  r.firstItem.markdown,
);
check(
  "Enter w punkcie z treścią dokłada punkt na tym samym poziomie",
  r.escapedOnce.markdown === "- plan\n  - krok\n  -",
  r.escapedOnce.markdown,
);
check(
  "…a drugi Enter, już w pustym punkcie, wyprowadza go o poziom wyżej",
  r.escaped.markdown === "- plan\n  - krok\n-",
  r.escaped.markdown,
);
check(
  "…a na ostatnim poziomie kończy listę i zaczyna akapit",
  r.leftList.markdown === "- jedno\n\nzwykły akapit",
  r.leftList.markdown,
);

fs.rmSync(work, { recursive: true, force: true });
console.log(
  `\nListy w notatce: ${passed} sprawdzeń przeszło. Znacznik robi listę, Tab robi poziom.`,
);
