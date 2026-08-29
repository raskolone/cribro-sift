"use strict";
/**
 * Przenoszenie linii — prawdziwą myszą, w prawdziwym drzewie.
 *   node scripts/drag-test.js
 *
 * shared/blockmove.js rozstrzyga, CO ma się stać, i sprawdza to
 * scripts/blockmove-test.js bez przeglądarki. Tutaj sprawdzamy drugą
 * połowę — czy gest w ogóle dochodzi do skutku.
 *
 * ── DLACZEGO sendInputEvent, A NIE dispatchEvent ──
 *
 * Pierwsza wersja tego testu składała zdarzenia sama, przez
 * `new PointerEvent(...)` i `dispatchEvent`. Przechodziła w całości przy
 * funkcji, która NIE DZIAŁAŁA — bo sztuczne zdarzenie omija wszystko, co
 * w tym geście jest trudne: przechwytywanie wskaźnika, zdarzenia myszy
 * zgodnościowe i zaznaczanie tekstu, które przeglądarka zaczyna sama.
 * Sprawdzała więc, czy da się wywołać funkcje edytora — a nie to, czy
 * chwycenie uchwytu przenosi linię.
 *
 * `webContents.sendInputEvent` wpuszcza zdarzenie od góry, tam gdzie wchodzi
 * ruch prawdziwej myszy. Przechodzi całą drogę przez Chromium i po drodze
 * robi wszystko to, co robi naprawdę — łącznie z zaznaczaniem, którego ten
 * gest ma właśnie NIE robić. Stąd osobne sprawdzenie na końcu każdego
 * przeciągnięcia: czy po puszczeniu myszy nie zostało zaznaczenie.
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
<style>
  html,body{margin:0;height:100%}
  body{padding:40px 40px 40px 90px;background:#09101c}
  #text{width:520px}
</style>
</head><body>
<div id="text" class="prose"></div>
<script src="${url("src/shared/richtext.js")}"></script>
<script src="${url("src/shared/blockmove.js")}"></script>
<script src="${url("src/renderer/js/editor.js")}"></script>
</body></html>`,
);

/* ── Co biegnie w oknie ─────────────────────────────────────────
   Wyłącznie przygotowanie i odczyt. Sam gest robi proces główny, myszą. */

const HARNESS = String.raw`
window.__editor = null;
window.__inputs = 0;

window.__setup = (markdown) => {
  /* Świeży element na każdy przypadek — tak samo, jak Notatnik przebudowuje
     swój szkielet (root.innerHTML = SKELETON). Element użyty ponownie
     trzymałby nasłuchy poprzedniego edytora i ⌥↓ przesuwałoby linię tyle
     razy, ilu edytorów zdążyło się na nim zapisać. */
  const host = document.createElement("div");
  host.id = "text";
  host.className = "prose";
  document.getElementById("text").replaceWith(host);
  window.__inputs = 0;
  window.__editor = window.CribroEditor.create(host, { onInput: () => { window.__inputs += 1; } });
  window.__editor.setMarkdown(markdown);
  window.getSelection().removeAllRanges();
  return true;
};

window.__lines = () => {
  const host = document.getElementById("text");
  const out = [];
  for (const block of host.children) {
    if (block.getAttribute("data-folded") === "true") continue;
    if (block.tagName === "UL" || block.tagName === "OL") out.push(...block.children);
    else out.push(block);
  }
  return out;
};

window.__find = (needle) =>
  window.__lines().find((node) => node.textContent.trim() === needle) ?? null;

/** Punkt w środku tekstu linii — tam, gdzie stanie kursor, żeby wywołać uchwyt. */
window.__onLine = (needle) => {
  const line = window.__find(needle);
  if (!line) return null;
  const box = line.getBoundingClientRect();
  return { x: Math.round(box.left + 20), y: Math.round(box.top + 6) };
};

/**
 * Środek uchwytu — o ile w ogóle go WIDAĆ — i pasek, w którym stoi.
 *
 * Pytamy o display, nie o grip.hidden — pytanie o atrybut brzmiałoby
 * „czy kod ustawił hidden", czyli o to samo, co kod ustawia — i tak
 * przeszedł niezauważony uchwyt, który miał hidden=true i mimo to był
 * malowany, bo reguła display:grid bije display:none z arkusza
 * przeglądarki. Sześć kropek wisiało wtedy nad zupełnie inną zakładką.
 */
window.__grip = () => {
  const grip = document.querySelector(".prose-grip");
  if (!grip || getComputedStyle(grip).display === "none") return null;
  const box = grip.getBoundingClientRect();
  const host = document.getElementById("text");
  const note = host.getBoundingClientRect();
  const gutter = parseFloat(getComputedStyle(host).paddingLeft) || 0;
  return {
    x: Math.round(box.left + box.width / 2),
    y: Math.round(box.top + box.height / 2),
    left: Math.round(box.left),
    right: Math.round(box.right),
    noteLeft: Math.round(note.left),
    gutter: Math.round(gutter),
  };
};

/** Krawędź, w którą celujemy: górna linii docelowej albo jej dolna. */
window.__edge = (needle, below) => {
  const line = window.__find(needle);
  if (!line) return null;
  const box = line.getBoundingClientRect();
  return { x: Math.round(box.left + 20), y: Math.round(below ? box.bottom : box.top) };
};

window.__mark = () => {
  const mark = document.querySelector(".prose-drop");
  return !!mark && !mark.hidden;
};

/** Kursor w pierwszym znaku linii — punkt wyjścia dla ⌥↑ i ⌥↓. */
window.__caret = (needle) => {
  const line = window.__find(needle);
  if (!line) return false;
  const range = document.createRange();
  range.setStart(line.firstChild || line, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.getElementById("text").focus();
  return true;
};

window.__result = () => ({
  markdown: window.__editor.getMarkdown(),
  inputs: window.__inputs,
  // Zaznaczenie po przeciągnięciu znaczy, że gest poszedł w przeglądarkę
  // zamiast w edytor — i to jest dokładnie ten błąd, którego sztuczne
  // zdarzenia nie potrafiły zobaczyć.
  selected: (window.getSelection()?.toString() ?? "").trim(),
});
0;
`;

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
    // Klawiaturą, nie myszą: akapit uchwytu nie dostaje (niżej osobny
    // przypadek), ale ⌥↓ rusza nim dalej — i po wylądowaniu w liście
    // zadań musi dostać stan odhaczenia, bo bez niego byłby punktem,
    // którego nie da się odhaczyć.
    name: "Akapit wciągnięty ⌥↓ w listę zadań staje się zadaniem nieodhaczonym",
    markdown: "zadzwonić do Ani\n\n- [ ] kupić mleko\n- [x] wysłać raport",
    move: { grab: "zadzwonić do Ani", key: "Down" },
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
    /* Treść pod zwiniętym nagłówkiem jest schowana, więc w spisie linii jej
       nie ma — i właśnie dlatego łatwo ją zostawić w miejscu. Zostawiona
       rozsypuje notatkę tam, gdzie autor jej nie widzi. */
    name: "Zwinięty nagłówek jedzie razem ze swoją schowaną treścią",
    markdown: "## ▸ Ustalenia\n\nAnia robi raport.\n\n## Inne",
    move: { grab: "Ustalenia", key: "Down" },
    expect: "## Inne\n\n## ▸ Ustalenia\n\nAnia robi raport.",
  },
  {
    name: "Krótkie przeciągnięcie w dolną połowę sąsiada też przenosi",
    markdown: "- pierwszy\n- drugi\n- trzeci",
    move: { grab: "pierwszy", over: "drugi", below: true },
    expect: "- drugi\n- pierwszy\n- trzeci",
  },
  {
    name: "⌥↓ przesuwa punkt o jedno miejsce w dół",
    markdown: "- pierwszy\n- drugi\n- trzeci",
    move: { grab: "pierwszy", key: "Down" },
    expect: "- drugi\n- pierwszy\n- trzeci",
  },
  {
    name: "⌥↑ z pierwszej linii nie robi nic",
    markdown: "- pierwszy\n- drugi",
    move: { grab: "pierwszy", key: "Up" },
    expect: "- pierwszy\n- drugi",
    quiet: true,
  },

  /* ── Komu wolno dać uchwyt ────────────────────────────────────
     Notatka to w większości akapity. Uchwyt przy każdym z nich znaczy
     sześć kropek chodzących za kursorem przez cały czas pisania — ruch
     w kącie oka przy czynności, która wymaga skupienia. Przestawia się
     zaś głównie punkty list, bo to one są listą rzeczy do zrobienia. */
  {
    name: "Akapit uchwytu nie dostaje",
    markdown: "Zwykły akapit, którego nikt nie przestawia.\n\n- punkt listy",
    hover: "Zwykły akapit, którego nikt nie przestawia.",
    grip: false,
  },
  {
    name: "Nagłówek też nie — od przestawiania rozdziałów są ⌥↑ i ⌥↓",
    markdown: "## Ustalenia\n\n- punkt listy",
    hover: "Ustalenia",
    grip: false,
  },
  {
    name: "Punkt listy uchwyt dostaje",
    markdown: "Wstęp.\n\n- punkt listy",
    hover: "punkt listy",
    grip: true,
  },
  {
    name: "Zadanie do odhaczenia też — to ta sama lista, innym punktorem",
    markdown: "Wstęp.\n\n- [ ] kupić mleko",
    hover: "kupić mleko",
    grip: true,
  },
];

fs.writeFileSync(
  path.join(work, "cases.json"),
  JSON.stringify(cases.map(({ markdown, move, hover }) => ({ markdown, move, hover }))),
);

/* ── Proces główny: gest ────────────────────────────────────────
   Ruch myszy idzie krokami, nie skokiem. Przeciągnięcie złożone z jednego
   przeskoku bywa dla przeglądarki czymś innym niż przeciągnięcie — a my
   sprawdzamy właśnie to, co robi przeglądarka. */

const MAIN = `
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
app.disableHardwareAcceleration();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, x: -2400, y: 80, width: 900, height: 760, backgroundColor: "#09101c",
  });
  await win.loadURL(${JSON.stringify("file://" + path.join(work, "harness.html"))});
  await win.webContents.executeJavaScript(${JSON.stringify(HARNESS)});
  const js = (code) => win.webContents.executeJavaScript(code);
  const send = (event) => win.webContents.sendInputEvent(event);

  const mouse = (type, x, y) =>
    send({ type, x, y, button: "left", clickCount: type === "mouseDown" ? 1 : 0 });

  const out = [];
  for (const item of JSON.parse(fs.readFileSync(${JSON.stringify(path.join(work, "cases.json"))}, "utf8"))) {
    await js("window.__setup(" + JSON.stringify(item.markdown) + ")");
    await wait(60);
    const note = { grip: null, marked: false };

    /* Sonda: czy przy tej linii w ogóle pojawia się uchwyt. Mysz najpierw
       idzie w róg okna — inaczej liczyłoby się to, co zostało po
       poprzednim przypadku. */
    if (item.hover) {
      mouse("mouseMove", 4, 4);
      await wait(70);
      const spot = await js("window.__onLine(" + JSON.stringify(item.hover) + ")");
      if (!spot) { out.push({ error: "nie ma takiej linii: " + item.hover }); continue; }
      mouse("mouseMove", spot.x, spot.y);
      await wait(120);
      out.push({ gripVisible: !!(await js("window.__grip()")) });
      continue;
    }

    if (item.move.key) {
      /* Kursor stawiamy przed KAŻDYM naciśnięciem. Przeprowadzka wyjmuje
         linię z drzewa i wkłada z powrotem gdzie indziej; zaznaczenie tego
         nie przeżywa niezawodnie, a drugie ⌥↓ bez kursora nie miałoby
         czym ruszyć. Ręka robi zresztą to samo — patrzy, gdzie stoi. */
      for (let press = 0; press < (item.move.times ?? 1); press += 1) {
        await js("window.__caret(" + JSON.stringify(item.move.grab) + ")");
        await wait(40);
        send({ type: "keyDown", keyCode: item.move.key, modifiers: ["alt"] });
        send({ type: "keyUp", keyCode: item.move.key, modifiers: ["alt"] });
        await wait(90);
      }
    } else {
      // 1. mysz wjeżdża na linię — uchwyt ma się pokazać
      const on = await js("window.__onLine(" + JSON.stringify(item.move.grab) + ")");
      mouse("mouseMove", on.x, on.y);
      await wait(80);
      const grip = await js("window.__grip()");
      note.grip = grip;
      if (!grip) { out.push({ error: "uchwyt się nie pokazał" }); continue; }

      /* 2. mysz PRZECHODZI po uchwyt, krok po kroku.
         Skok prosto na jego środek jest tym, czego ręka nigdy nie robi —
         i właśnie dlatego pierwsza wersja tego testu przepuściła błąd,
         w którym uchwyt znikał w połowie drogi po niego. Kursor musi
         przejść przez pasek notatki, tak jak przechodzi naprawdę. */
      const reach = 6;
      for (let step = 1; step <= reach; step += 1) {
        mouse("mouseMove",
          Math.round(on.x + ((grip.x - on.x) * step) / reach),
          Math.round(on.y + ((grip.y - on.y) * step) / reach));
        await wait(25);
      }
      note.survived = await js("!!window.__grip()");
      if (!note.survived) { out.push({ error: "uchwyt zniknął w drodze po niego" }); continue; }

      mouse("mouseDown", grip.x, grip.y);
      await wait(40);

      // 3. przeciągnięcie krokami do krawędzi linii docelowej
      const to = await js("window.__edge(" + JSON.stringify(item.move.over) + "," + (item.move.below ? "true" : "false") + ")");
      const steps = 8;
      for (let step = 1; step <= steps; step += 1) {
        mouse("mouseMove",
          Math.round(grip.x + ((to.x - grip.x) * step) / steps),
          Math.round(grip.y + ((to.y - grip.y) * step) / steps));
        await wait(20);
      }
      note.marked = await js("window.__mark()");

      // 4. puszczenie
      mouse("mouseUp", to.x, to.y);
      await wait(120);
    }

    const result = await js("window.__result()");
    out.push({ ...result, ...note });
  }

  /* Na koniec: mysz schodzi z notatki i pytamy, czy uchwyt NAPRAWDĘ
     zniknął z ekranu. Nie o atrybut — o to, czy cokolwiek jest malowane. */
  mouse("mouseMove", 4, 4);
  await wait(200);
  out.push({
    parked: await js("(() => { const g = document.querySelector('.prose-grip');" +
      " const cs = getComputedStyle(g); const b = g.getBoundingClientRect();" +
      " return { attr: g.hidden, display: cs.display, area: Math.round(b.width * b.height) }; })()"),
  });

  process.stdout.write("\\n@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@\\n");
  app.exit(0);
});
`;

fs.writeFileSync(path.join(work, "main.js"), MAIN);

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
    timeout: 120_000,
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

  if (item.hover) {
    assert.strictEqual(
      got.gripVisible,
      item.grip,
      item.grip
        ? `${item.name} — uchwyt się nie pokazał`
        : `${item.name} — uchwyt pokazał się tam, gdzie nie ma czego chwytać`,
    );
    console.log("✓", item.name);
    passed += 1;
    continue;
  }

  assert.strictEqual(got.markdown, item.expect, item.name);
  if (item.quiet) {
    assert.strictEqual(got.inputs, 0, `${item.name} — notatka zapisała się bez powodu`);
  }
  if (!item.move.key) {
    // Chwytanie za uchwyt nie ma prawa zaznaczać treści notatki.
    assert.strictEqual(
      got.selected,
      "",
      `${item.name} — gest zaznaczył tekst („${got.selected}") zamiast przenieść linię`,
    );
  }
  console.log("✓", item.name);
  passed += 1;
}

/* Uchwyt ma mieścić się W NOTATCE — w pasku wolnym po jej lewej stronie,
   a nie obok kartki. Wymiar bierzemy z tego samego przebiegu, w którym
   linia naprawdę się przeniosła. */
const withGrip = results.find((item) => item.grip);
assert.ok(withGrip, "żaden przypadek nie pokazał uchwytu");
const { left, right, noteLeft, gutter } = withGrip.grip;
assert.ok(gutter > 0, "notatka nie ma paska na uchwyt (--grip-gutter)");
assert.ok(
  left >= noteLeft,
  `uchwyt wystaje poza notatkę w lewo (${left} < ${noteLeft})`,
);
assert.ok(
  right <= noteLeft + gutter,
  `uchwyt wchodzi na tekst (kończy się na ${right}, tekst zaczyna ${noteLeft + gutter})`,
);
console.log(
  `✓ Uchwyt mieści się w pasku notatki (${left - noteLeft}…${right - noteLeft} z ${gutter} px)`,
);
passed += 1;

/* Uchwyt schowany ma zniknąć Z EKRANU, a nie tylko z atrybutu.

   Atrybut `hidden` chowa przez arkusz przeglądarki, a ten przegrywa
   z każdą regułą autorską ustawiającą display — także z tą, która daje
   uchwytowi siatkę na sześć kropek. Uchwyt zostawał więc namalowany
   w miejscu ostatniej linii i wisiał tam nad inną zakładką. */
const { parked } = results[results.length - 1];
assert.ok(parked, "test nie sprawdził, czy schowany uchwyt znika");
assert.strictEqual(parked.attr, true, "uchwyt nie schował się po zejściu myszy z notatki");
assert.strictEqual(
  parked.display,
  "none",
  `schowany uchwyt jest nadal malowany (display: ${parked.display}) — hidden przegrał z regułą autorską`,
);
assert.strictEqual(parked.area, 0, "schowany uchwyt nadal zajmuje miejsce na ekranie");
console.log("✓ Schowany uchwyt naprawdę znika z ekranu, nie tylko z atrybutu");
passed += 1;

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} przypadków przeszło.`);
