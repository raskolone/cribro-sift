"use strict";
/**
 * Nagłówek składany — czyli toggle, jak w Notion.
 *   node scripts/toggle-test.js
 *
 * Pytanie, na które ten test odpowiada, brzmi: CO NALEŻY DO NAGŁÓWKA.
 * Bez odpowiedzi na nie zwinięcie jest ozdobą — chowa strzałkę i nic
 * poza nią. Toggle ma być nadrzędny: wrzuca się do niego akapity, listy,
 * zadania i głębsze nagłówki, a zwinięcie zamyka je wszystkie naraz.
 *
 * Granicę wyznacza stopień nagłówka, tak jak w każdym konspekcie: H2
 * trzyma wszystko aż do następnego H2 albo H1. To jest zarazem jedyny
 * zapis, który przeżywa drogę na dysk — notatka zostaje Markdownem, więc
 * przynależność musi wynikać z kolejności i stopnia, a nie z niewidocznego
 * znacznika obok.
 *
 * Sprawdzamy trzy rzeczy naraz, bo rozjeżdżają się osobno:
 *   1. co edytor CHOWA (data-folded w prawdziwym DOM),
 *   2. co widać po zwinięciu (strzałka i liczba schowanych elementów),
 *   3. co z tego zostaje NA DYSKU i czy wraca w całości.
 *
 * Biegnie w Electronie, bo contenteditable, zaznaczenie i execCommand nie
 * istnieją poza przeglądarką — a to na nich stoi cały edytor.
 */
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-toggle-"));

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body>
  <div id="pole"></div>
  <script src="${path.join(root, "src/shared/blockmove.js")}"></script>
  <script src="${path.join(root, "src/shared/richtext.js")}"></script>
  <script src="${path.join(root, "src/renderer/js/editor.js")}"></script>
</body></html>`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();
setTimeout(() => { console.log("WYNIK " + JSON.stringify({ error: "okno nie odpowiedziało" })); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false });
  await win.loadFile(${JSON.stringify(path.join(work, "strona.html"))});
  await new Promise((r) => setTimeout(r, 800));
  try {
    const out = await win.webContents.executeJavaScript(${JSON.stringify(`(() => {
  const steps = [];
  const say = (name, value) => steps.push({ name, value });

  const pole = document.getElementById("pole");
  const editor = window.CribroEditor.create(pole, {});

  const NOTATKA = [
    "# Spotkanie z Anią",
    "",
    "Zdanie przed pierwszym nagłówkiem.",
    "",
    "## \\u25BE Ustalenia",
    "",
    "Raport idzie w czwartek.",
    "",
    "- pierwszy punkt",
    "- drugi punkt",
    "",
    "### Szczegóły",
    "",
    "- [ ] zadanie do odhaczenia",
    "",
    "> cytat w środku",
    "",
    "## Zadania",
    "",
    "Poza toggle.",
  ].join("\\n");

  editor.setMarkdown(NOTATKA);

  const bloki = () => [...pole.children].map((el) => ({
    tag: el.tagName,
    fold: el.getAttribute("data-toggle"),
    hidden: el.getAttribute("data-folded") === "true",
    inside: el.getAttribute("data-inside") === "true",
    text: (el.textContent || "").trim().slice(0, 30),
  }));

  const toggle = pole.querySelector("[data-toggle]");
  say("nagłówek ze strzałką jest składany", !!toggle && toggle.tagName);
  say("i zaczyna otwarty", toggle && toggle.getAttribute("data-toggle"));
  say("nic nie jest schowane, dopóki jest otwarty", bloki().filter((b) => b.hidden).length);

  /* ── Co należy do toggle ── */
  toggle.setAttribute("data-toggle", "closed");
  editor.applyFolds();
  const schowane = bloki().filter((b) => b.hidden);
  say("po zwinięciu chowa się wszystko aż do następnego H2", schowane.map((b) => b.tag).join(","));
  say("…razem z akapitem", schowane.some((b) => b.text.startsWith("Raport")));
  say("…z listą", schowane.some((b) => b.tag === "UL" && b.text.includes("pierwszy")));
  say("…z głębszym nagłówkiem", schowane.some((b) => b.tag === "H3"));
  say("…z listą zadań", schowane.some((b) => b.tag === "UL" && b.text.includes("zadanie")));
  say("…i z cytatem", schowane.some((b) => b.tag === "BLOCKQUOTE"));

  const poza = bloki().filter((b) => !b.hidden).map((b) => b.text);
  say("nagłówek tego samego stopnia zostaje NA ZEWNĄTRZ", poza.includes("Zadania"));
  say("to, co pod nim, też zostaje", poza.includes("Poza toggle."));
  say("zdanie sprzed toggle nie znika", poza.some((t) => t.startsWith("Zdanie przed")));
  say("sam nagłówek zostaje widoczny", poza.includes("Ustalenia"));

  /* ── Ile jest schowane ── */
  say("zwinięty nagłówek mówi, ile chowa", toggle.getAttribute("data-hidden"));

  /* ── Widać, co jest w środku ── */
  toggle.setAttribute("data-toggle", "open");
  editor.applyFolds();
  const wSrodku = bloki().filter((b) => b.inside).map((b) => b.tag);
  say("po rozwinięciu widać, co należy do nagłówka", wSrodku.join(","));
  say("sam nagłówek nie jest w swoim wnętrzu", toggle.getAttribute("data-inside"));
  say("blok za toggle nie udaje wnętrza", bloki().find((b) => b.text === "Zadania").inside);
  say("rozwinięty nagłówek nie liczy już schowanych", toggle.getAttribute("data-hidden"));

  /* ── Droga na dysk i z powrotem ── */
  const zapis = editor.getMarkdown();
  say("strzałka wraca do pliku", /^## \\u25BE Ustalenia$/m.test(zapis));
  say("…a treść pod nią zostaje w całości", zapis.includes("Raport idzie w czwartek.") &&
    zapis.includes("- [ ] zadanie do odhaczenia") && zapis.includes("> cytat w środku"));

  toggle.setAttribute("data-toggle", "closed");
  editor.applyFolds();
  const zwiniety = editor.getMarkdown();
  say("zwinięcie zapisuje się strzałką w drugą stronę", /^## \\u25B8 Ustalenia$/m.test(zwiniety));
  say("…i NIE gubi tego, czego nie widać", zwiniety.includes("Raport idzie w czwartek.") &&
    zwiniety.includes("### Szczegóły") && zwiniety.includes("> cytat w środku"));

  /* Powrót z dysku: zwinięty ma wrócić zwinięty. Bez tego notatka
     rozkładałaby się w całości przy każdym otwarciu. */
  const drugi = window.CribroEditor.create(document.createElement("div"), {});
  drugi.setMarkdown(zwiniety);
  const wrocil = drugi.root.querySelector("[data-toggle]");
  say("po wczytaniu z pliku zwinięty jest nadal zwinięty", wrocil.getAttribute("data-toggle"));
  say("…i jego treść jest nadal schowana",
    [...drugi.root.children].filter((el) => el.getAttribute("data-folded") === "true").length);

  /* ── Zagnieżdżenie ── */
  drugi.setMarkdown([
    "## \\u25BE Zewnętrzny",
    "",
    "### \\u25B8 Wewnętrzny",
    "",
    "Ukryty głęboko.",
    "",
    "### Drugi wewnętrzny",
    "",
    "Widoczny.",
  ].join("\\n"));
  const stan = [...drugi.root.children].map((el) => ({
    tag: el.tagName,
    hidden: el.getAttribute("data-folded") === "true",
    text: (el.textContent || "").trim(),
  }));
  say("zwinięty toggle w środku otwartego chowa swoje",
    stan.find((b) => b.text === "Ukryty głęboko.").hidden);
  say("…a sąsiada obok już nie", stan.find((b) => b.text === "Widoczny.").hidden);

  return { steps: steps };
})()`)});
    console.log("WYNIK " + JSON.stringify(out));
    app.exit(0);
  } catch (problem) {
    console.log("WYNIK " + JSON.stringify({ error: String(problem && problem.message || problem) }));
    app.exit(1);
  }
});
`;

fs.writeFileSync(path.join(work, "strona.html"), PAGE);
fs.writeFileSync(path.join(work, "main.js"), MAIN);
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "toggle", main: "main.js" }));

const electron = path.join(root, "node_modules", ".bin", "electron");
if (!fs.existsSync(electron)) {
  console.log("· Electron nie jest zainstalowany — pomijam.");
  process.exit(0);
}

let raw;
try {
  raw = execFileSync(electron, [work], {
    encoding: "utf8",
    timeout: 90000,
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
const { steps, error } = JSON.parse(line.slice(6));
if (error) throw new Error(error);

const oczekiwane = [
  ["nagłówek ze strzałką jest składany", "H2"],
  ["i zaczyna otwarty", "open"],
  ["nic nie jest schowane, dopóki jest otwarty", 0],
  ["po zwinięciu chowa się wszystko aż do następnego H2", "P,UL,H3,UL,BLOCKQUOTE"],
  ["…razem z akapitem", true],
  ["…z listą", true],
  ["…z głębszym nagłówkiem", true],
  ["…z listą zadań", true],
  ["…i z cytatem", true],
  ["nagłówek tego samego stopnia zostaje NA ZEWNĄTRZ", true],
  ["to, co pod nim, też zostaje", true],
  ["zdanie sprzed toggle nie znika", true],
  ["sam nagłówek zostaje widoczny", true],
  ["zwinięty nagłówek mówi, ile chowa", "5"],
  ["po rozwinięciu widać, co należy do nagłówka", "P,UL,H3,UL,BLOCKQUOTE"],
  ["sam nagłówek nie jest w swoim wnętrzu", null],
  ["blok za toggle nie udaje wnętrza", false],
  ["rozwinięty nagłówek nie liczy już schowanych", null],
  ["strzałka wraca do pliku", true],
  ["…a treść pod nią zostaje w całości", true],
  ["zwinięcie zapisuje się strzałką w drugą stronę", true],
  ["…i NIE gubi tego, czego nie widać", true],
  ["po wczytaniu z pliku zwinięty jest nadal zwinięty", "closed"],
  ["…i jego treść jest nadal schowana", 5],
  ["zwinięty toggle w środku otwartego chowa swoje", true],
  ["…a sąsiada obok już nie", false],
];

let passed = 0;
for (const [name, want] of oczekiwane) {
  const step = steps.find((item) => item.name === name);
  assert.ok(step, `krok „${name}" w ogóle się nie wykonał`);
  assert.deepStrictEqual(step.value, want, `„${name}": ${JSON.stringify(step.value)}`);
  console.log("✓", name);
  passed += 1;
}

console.log(`\nNagłówek składany: ${passed} sprawdzeń przeszło. Toggle jest nadrzędny i zwija wszystko, co pod nim.`);
