"use strict";
/**
 * Obrazek w notatce — prawdziwą myszą, w prawdziwym drzewie.
 *   node scripts/image-test.js
 *
 * Zrzut ekranu wchodził do notatki i stawał się w niej rzeczą martwą: nie
 * dało się go zaznaczyć, zmniejszyć, przesunąć ani skasować. Ten test
 * pilnuje wszystkich czterech gestów — i piątej rzeczy, bez której cztery
 * pierwsze są bez znaczenia: czy zmiana DOCHODZI DO PLIKU, czyli czy
 * przeżyje zamknięcie notatki.
 *
 * Myszą, a nie `dispatchEvent` — z tego samego powodu co w drag-test.js:
 * sztuczne zdarzenie omija przechwytywanie wskaźnika i zaznaczanie tekstu,
 * czyli dokładnie to, na czym te gesty się wykładają.
 */

const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-image-"));
const url = (...parts) => "file://" + path.join(root, ...parts);

/* Obrazek do wstawienia. Prawdziwy plik PNG, bo `img` bez wymiarów nie ma
   prostokąta, a cały ten test mierzy prostokąty. 400×300, żeby w kolumnie
   520 px pełna szerokość i połowa różniły się widocznie. */
const png = path.join(work, "zrzut.png");
execFileSync("/usr/bin/sips", ["-s", "format", "png", "--resampleHeightWidth", "300", "400",
  "/System/Library/CoreServices/DefaultDesktop.heic", "--out", png], { stdio: "ignore" });

fs.writeFileSync(
  path.join(work, "harness.html"),
  `<!doctype html><html lang="pl"><head><meta charset="utf-8" />
<link rel="stylesheet" href="${url("src/renderer/css/tokens.css")}" />
<link rel="stylesheet" href="${url("src/renderer/css/prose.css")}" />
<style>
  html,body{margin:0;height:100%}
  body{padding:60px 40px 40px 90px;background:#09101c}
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
  window.getSelection().removeAllRanges();
  return true;
};

/** Prostokąt obrazka na ekranie — punkt, w który celuje mysz. */
window.__image = () => {
  const img = document.querySelector("#text img");
  if (!img) return null;
  const box = img.getBoundingClientRect();
  return {
    x: Math.round(box.left + box.width / 2),
    y: Math.round(box.top + box.height / 2),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
};

/* Ramka, pasek i róg — pytamy o to, CO WIDAĆ, a nie o atrybut „hidden”.
   Element z „hidden” ustawionym na prawdę bywa malowany mimo wszystko, gdy reguła arkusza
   bije display:none z przeglądarki; taki błąd przeszedł już raz przy
   uchwycie przenoszenia linii. */
const shown = (node) => !!node && getComputedStyle(node).display !== "none" &&
  node.getBoundingClientRect().width > 0;

window.__pick = () => {
  const pick = document.querySelector(".prose-pick");
  const grab = pick?.querySelector(".prose-pick__grab");
  const bar = pick?.querySelector(".prose-pick__bar");
  if (!shown(pick)) return null;
  const gbox = grab.getBoundingClientRect();
  const bbox = bar.getBoundingClientRect();
  return {
    outlined: !!document.querySelector('#text img[data-picked="true"]'),
    size: pick.querySelector(".prose-pick__size").textContent,
    grab: { x: Math.round(gbox.left + gbox.width / 2), y: Math.round(gbox.top + gbox.height / 2) },
    barShown: shown(bar),
    barTop: Math.round(bbox.top),
  };
};

/** Środek przycisku paska — po nazwie czynności. */
window.__button = (what) => {
  const node = document.querySelector('.prose-pick__bar button[data-do="' + what + '"]');
  if (!shown(node)) return null;
  const box = node.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
};

window.__markdown = () => window.__editor.getMarkdown();

/* Most do procesu głównego, jakiego to okno nie ma. Zapisywanie pliku
   należy do main/main.js („notes:pasteImage") i jest tam sprawdzane inaczej;
   tutaj chodzi o drugą połowę drogi: czy edytor W OGÓLE rozpoznał obrazek
   w schowku i czy wstawił go tam, gdzie trzeba. */
window.__pasted = 0;
window.cribro = {
  notes: {
    pasteImage: async (dataUrl) => {
      window.__pasted += 1;
      window.__lastDataUrl = dataUrl;
      return { markdown: "![wklejony obrazek](file:///tmp/wklejone.png)" };
    },
  },
};

/** Ile procent kolumny zajmuje obrazek NAPRAWDĘ, na ekranie. */
window.__share = () => {
  const img = document.querySelector("#text img");
  const host = document.getElementById("text");
  if (!img) return null;
  /* Względem POLA TREŚCI, nie całej notatki: notatka ma z lewej pasek na
     uchwyt przenoszenia linii, a procent w CSS liczy się już bez niego. */
  const style = getComputedStyle(host);
  const column = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return Math.round((img.getBoundingClientRect().width / column) * 100);
};

window.__altField = () => {
  const node = document.querySelector(".prose-pick__alt");
  return shown(node) ? { value: node.value } : null;
};
0;
`;

const NOTE = `# Zajęcia

![tablica](file://${png})

Zdanie pod obrazkiem.`;

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
  const mouse = (type, x, y) =>
    send({ type, x, y, button: "left", clickCount: type === "mouseDown" ? 1 : 0 });
  const click = async (x, y) => { mouse("mouseMove", x, y); await wait(40);
    mouse("mouseDown", x, y); await wait(40); mouse("mouseUp", x, y); await wait(120); };

  const NOTE = ${JSON.stringify(NOTE)};
  const fresh = async () => { await js("window.__setup(" + JSON.stringify(NOTE) + ")"); await wait(200); };
  const out = {};

  /* ── 1. Kliknięcie zaznacza ── */
  await fresh();
  out.before = { pick: await js("window.__pick()"), share: await js("window.__share()") };
  let img = await js("window.__image()");
  await click(img.x, img.y);
  out.picked = await js("window.__pick()");

  /* ── 2. Pasek zmniejsza, a rozmiar idzie do pliku ── */
  const smaller = await js("window.__button('smaller')");
  if (smaller) {
    await click(smaller.x, smaller.y);
    await click(smaller.x, smaller.y);
  }
  out.smaller = {
    button: !!smaller,
    share: await js("window.__share()"),
    markdown: await js("window.__markdown()"),
    label: (await js("window.__pick()"))?.size ?? null,
  };

  /* ── 3. Ciągnięcie za róg ── */
  await fresh();
  img = await js("window.__image()");
  await click(img.x, img.y);
  const grabbed = await js("window.__pick()");
  if (grabbed) {
    mouse("mouseMove", grabbed.grab.x, grabbed.grab.y);
    await wait(60);
    mouse("mouseDown", grabbed.grab.x, grabbed.grab.y);
    await wait(40);
    // W lewo o 200 px, krokami — skok bywa dla przeglądarki czym innym.
    for (let step = 1; step <= 8; step += 1) {
      mouse("mouseMove", Math.round(grabbed.grab.x - (200 * step) / 8), grabbed.grab.y);
      await wait(25);
    }
    mouse("mouseUp", Math.round(grabbed.grab.x - 200), grabbed.grab.y);
    await wait(200);
  }
  out.dragged = {
    share: await js("window.__share()"),
    markdown: await js("window.__markdown()"),
  };

  /* ── 4. Opis obrazka ── */
  await fresh();
  img = await js("window.__image()");
  await click(img.x, img.y);
  const alt = await js("window.__button('alt')");
  if (alt) {
    await click(alt.x, alt.y);
    out.altOpen = await js("window.__altField()");
    // Pole otwiera się z zaznaczoną dotychczasową treścią, więc pisanie
    // ją ZASTĘPUJE — tak samo jak przy zmianie nazwy pliku.
    for (const ch of "tablica po zajeciach") {
      send({ type: "char", keyCode: ch });
      await wait(12);
    }
    send({ type: "keyDown", keyCode: "Return" });
    send({ type: "keyUp", keyCode: "Return" });
    await wait(150);
  }
  out.alt = { markdown: await js("window.__markdown()") };

  /* ── 5. Przeniesienie obrazka ⌥↑ ── */
  await fresh();
  img = await js("window.__image()");
  await click(img.x, img.y);
  send({ type: "keyDown", keyCode: "Up", modifiers: ["alt"] });
  send({ type: "keyUp", keyCode: "Up", modifiers: ["alt"] });
  await wait(200);
  out.moved = { markdown: await js("window.__markdown()") };

  /* ── 6. Kasowanie klawiszem ── */
  await fresh();
  img = await js("window.__image()");
  await click(img.x, img.y);
  send({ type: "keyDown", keyCode: "Backspace" });
  send({ type: "keyUp", keyCode: "Backspace" });
  await wait(200);
  out.deleted = { markdown: await js("window.__markdown()"), pick: await js("window.__pick()") };

  /* ── 7. ⌘V z obrazkiem w schowku ── */
  await fresh();
  {
    const { clipboard, nativeImage } = require("electron");
    clipboard.clear();
    clipboard.writeImage(nativeImage.createFromPath(${JSON.stringify(png)}));

    // Kursor na końcu zdania pod obrazkiem — tam, gdzie stoi ręka.
    await js(
      "(() => { const host = document.getElementById('text');" +
        " const last = host.lastElementChild;" +
        " const range = document.createRange(); range.selectNodeContents(last); range.collapse(false);" +
        " const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);" +
        " host.focus(); return true; })()",
    );
    await wait(80);
    /* webContents.paste(), a nie ⌘V przez sendInputEvent. Skrót wklejania
       obsługuje w Electronie MENU aplikacji, a to okno testowe żadnego menu
       nie ma — naciśnięcie nie robiło więc nic. paste() wchodzi tą samą
       drogą co wklejanie prawdziwe: rzuca w stronę zdarzenie „paste"
       ze schowkiem systemu w środku. */
    win.webContents.paste();
    await wait(500);
    out.pasted = {
      calls: await js("window.__pasted"),
      dataUrl: await js("(window.__lastDataUrl || '').slice(0, 22)"),
      markdown: await js("window.__markdown()"),
    };
  }

  /* ── 8. Kliknięcie obok zdejmuje zaznaczenie ── */
  await fresh();
  img = await js("window.__image()");
  await click(img.x, img.y);
  const wasPicked = !!(await js("window.__pick()"));
  await click(20, 20);
  out.away = { wasPicked, pick: await js("window.__pick()") };

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
assert.ok(!r.timeout, "Okno nie zdążyło — gest gdzieś utknął.");

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? `\n  ${detail}` : ""}`);
  console.log("✓", label);
  passed += 1;
};

check("Bez kliknięcia obrazek nie ma ramki", r.before.pick === null);
/* Zrzut bez zapisanego rozmiaru zajmuje tyle, ile sam ma — nie rozciąga się
   do kolumny i nie wychodzi poza nią. Ten obrazek ma 400 px przy kolumnie
   520 px, więc siedzi w niej cały. */
check(
  "Zrzut bez rozmiaru wchodzi w swojej własnej szerokości",
  r.before.share > 50 && r.before.share <= 100,
  `jest ${r.before.share}%`,
);

check("Kliknięcie zaznacza obrazek", !!r.picked, "ramka się nie pokazała");
check("…i widać to na samym obrazku", r.picked?.outlined === true);
check("…pasek staje NAD obrazkiem", r.picked?.barShown === true);
check("…a rozmiar jest podpisany", /%/.test(r.picked?.size ?? ""));

check("Pasek ma przycisk zmniejszania", r.smaller.button === true);
check(
  "Dwa naciśnięcia zdejmują dwadzieścia punktów szerokości",
  Math.abs(r.before.share - 20 - r.smaller.share) <= 3,
  `z ${r.before.share}% zrobiło się ${r.smaller.share}%`,
);
const written = /!\[tablica\|(\d{1,3})%\]/.exec(r.smaller.markdown);
check("…rozmiar trafia do pliku", !!written, r.smaller.markdown);
check(
  "…w pliku stoi dokładnie to, co widać na ekranie",
  Math.abs(Number(written?.[1]) - r.smaller.share) <= 2,
  `plik: ${written?.[1]}%, ekran: ${r.smaller.share}%`,
);
check("…i pasek pokazuje go człowiekowi", r.smaller.label === `${written?.[1]}%`);

check(
  "Ciągnięcie za róg zmniejsza obrazek",
  r.dragged.share < r.before.share - 10,
  `z ${r.before.share}% zrobiło się ${r.dragged.share}%`,
);
check(
  "…a nowy rozmiar zostaje w pliku",
  /!\[tablica\|\d{2}%\]/.test(r.dragged.markdown),
  r.dragged.markdown,
);

check("Przycisk „Opis” otwiera pole z dotychczasowym opisem", r.altOpen?.value === "tablica");
check(
  "Wpisany opis zastępuje dotychczasowy i trafia do pliku",
  /!\[tablica po zajeciach\]/.test(r.alt.markdown),
  r.alt.markdown,
);

check(
  "⌥↑ przenosi obrazek nad nagłówek",
  r.moved.markdown.indexOf("![") < r.moved.markdown.indexOf("# Zajęcia"),
  r.moved.markdown,
);

check("Backspace kasuje zaznaczony obrazek", !/!\[/.test(r.deleted.markdown), r.deleted.markdown);
check("…razem z pustym akapitem po nim", !/\n\n\n/.test(r.deleted.markdown), r.deleted.markdown);
check("…i ramka znika razem z nim", r.deleted.pick === null);
check("Reszta notatki zostaje nietknięta", /Zdanie pod obrazkiem\./.test(r.deleted.markdown));

check("Kliknięcie obok zdejmuje zaznaczenie", r.away.wasPicked && r.away.pick === null);

check("⌘V z obrazkiem w schowku trafia do edytora", r.pasted.calls === 1, JSON.stringify(r.pasted));
check(
  "…i niesie bajty obrazka, a nie pustkę",
  /^data:image\//.test(r.pasted.dataUrl ?? ""),
  r.pasted.dataUrl,
);
check(
  "…a obrazek ląduje w notatce jako osobny blok",
  /\n\n!\[wklejony obrazek\]\(file:\/\/\/tmp\/wklejone\.png\)/.test(r.pasted.markdown),
  r.pasted.markdown,
);
check(
  "…nie kasując tego, co w notatce już było",
  /Zdanie pod obrazkiem\./.test(r.pasted.markdown) && /# Zajęcia/.test(r.pasted.markdown),
  r.pasted.markdown,
);

fs.rmSync(work, { recursive: true, force: true });
console.log(`\nObrazek w notatce: ${passed} sprawdzeń przeszło. Da się go zmniejszyć, przesunąć i skasować.`);
