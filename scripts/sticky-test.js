"use strict";
/**
 * Kartka na pulpicie: pasek pisania i wyłącznik talii.
 *   node scripts/sticky-test.js
 *
 * Kartka jest oknem, w którym nikt nie szuka usterek: leży na cudzej pracy,
 * przez większość dnia nikt w nią nie patrzy, a gdy patrzy — to na jedno
 * zdanie w środku. Dlatego trzy rzeczy sprawdzamy tu maszyną, a nie okiem:
 *
 *   1. LISTY DAJĄ SIĘ ZROBIĆ NA KARTCE. Przyciskiem i pisaniem („- ", „1. ",
 *      „[] "), tak samo jak w Notatniku. Kartka na pulpicie to najczęściej
 *      plan dnia, więc kwadraciki do odhaczania są jej treścią podstawową,
 *      a nie ozdobą.
 *   2. PASEK MÓWI PRAWDĘ. Podświetlony punkt listy przy kursorze stojącym
 *      w akapicie jest gorszy niż brak podświetlenia: mówi, że coś jest
 *      włączone, gdy nie jest.
 *   3. „UKRYJ STICKIES" CHOWA TALIĘ, A NIE KASUJE NOTATKI. To ten sam
 *      przycisk, który jednym kliknięciem może zrobić jedno albo drugie —
 *      i tylko jedno z dwojga da się cofnąć.
 *
 * Biegnie w Electronie i w PRAWDZIWEJ kartce: ładujemy sticky.html z atrapą
 * mostka (js/mock-bridge.js), klikamy w prawdziwe przyciski i naciskamy
 * prawdziwe klawisze. Sprawdzanie samego szablonu odpowiedziałoby na
 * pytanie „czy przycisk stoi", a nie „czy robi to, co pisze".
 */
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-sticky-"));
const CARD = "file://" + path.join(root, "src", "renderer", "sticky.html") + "?note=n1";

/* ── 1. Rozmiar kartki nadąża za tym, co w niej stoi ───────────────
   Pas narzędzi i wyłącznik zabierają kartce wysokość. Podłoga zostawiona
   tam, gdzie była, dałaby kartkę złożoną z samej oprawy — i to jest usterka,
   którą widać dopiero po ściągnięciu kartki za róg, czyli prawie nigdy. */

const main = fs.readFileSync(path.join(root, "src", "main", "main.js"), "utf8");
const number = (name, field) =>
  Number(new RegExp(`const ${name} = \\{[^}]*${field}:\\s*(\\d+)`).exec(main)?.[1]);

const minHeight = number("STICKY_MIN", "height");
const cardHeight = number("STICKY_CARD", "height");
/* Belka 43 + narzędzia 29 + stopka 41 + wyłącznik 32. Liczba jest z arkusza
   w sticky.html i ma za nim nadążać — tak samo jak STICKY_HEAD. */
const CHROME = 145;

assert.ok(
  minHeight - CHROME >= 60,
  `najmniejsza kartka (${minHeight}) zostawia na notatkę ${minHeight - CHROME} pikseli — ` +
    "to już nie jest kartka, tylko oprawa ze szparą",
);
assert.ok(
  cardHeight - CHROME >= 180,
  `kartka wykładana na pulpit (${cardHeight}) ma za mało miejsca na treść`,
);
console.log("✓ Kartka ma miejsce na notatkę, a nie tylko na paski");

/* Kartka wraca na pulpit z dźwignią w położeniu „talia leży". Okno nie jest
   zamykane, tylko chowane (patrz hideDeck w main/main.js), więc bez tego
   jednego wiersza wyłącznik wracałby przełożony — mówiąc coś przeciwnego
   niż to, co widać na ekranie. Wyłożenia talii nie da się tu odegrać
   (polecenie przychodzi z procesu głównego), więc pytamy o sam wiersz. */
const sticky = fs.readFileSync(path.join(root, "src", "renderer", "js", "sticky.js"), "utf8");
assert.ok(
  /dir === "out"[^\n]*dataset\.off/.test(sticky),
  "kartka wyłożona na pulpit nie przywraca dźwigni wyłącznika",
);
console.log("✓ Wyłożona kartka wraca z wyłącznikiem w położeniu „talia leży”");

/* ── 2. Wszystko inne — w prawdziwym oknie kartki ─────────────────── */

const HARNESS = String.raw`
/* Talia nigdzie nie odjedzie: podmieniamy jedną metodę mostka na taką,
   która zapisuje, o co ją poproszono. Reszta atrapy zostaje nietknięta —
   sticky.js trzyma sam OBIEKT deck z mostka, więc podmiana metody na nim
   dochodzi do kodu, który już wystartował. */
window.__deck = { hidden: null, dismissed: null, deleted: null };
window.cribro.deck.show = async (open) => (window.__deck.hidden = !open);
window.cribro.deck.dismiss = async (id) => (window.__deck.dismissed = id);
window.cribro.notes.remove = async (id) => (window.__deck.deleted = id);

/** Kursor na koniec ostatniego słowa — tam, gdzie stoi po dopisaniu litery. */
window.__caretEnd = () => {
  const host = document.getElementById("text");
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  host.focus();
  const range = document.createRange();
  if (last) range.setStart(last, last.nodeValue.length);
  else range.selectNodeContents(host);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

/** Pusta notatka, jedna linia — punkt wyjścia dla pisania od zera. */
window.__blank = () => {
  const host = document.getElementById("text");
  host.innerHTML = "<p><br></p>";
  const range = document.createRange();
  range.setStart(host.firstElementChild, 0);
  range.collapse(true);
  host.focus();
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

/** Co widać w notatce — jako kształt drzewa, bo to jego autor ogląda. */
window.__shape = () => ({
  bullet: !!document.querySelector("#text ul:not(.task)"),
  numbered: !!document.querySelector("#text ol"),
  todo: !!document.querySelector("#text ul.task"),
  quote: !!document.querySelector("#text blockquote"),
  items: [...document.querySelectorAll("#text li")].map((li) => li.textContent.trim()),
});

/** Sam tekst notatki — do sprawdzenia, co wstawił znacznik czasu. */
window.__text = () => document.getElementById("text").textContent;

/** Co pasek ma podświetlone. */
window.__pressed = () =>
  Object.fromEntries(
    [...document.querySelectorAll("[data-format]")].map((button) => [
      button.dataset.format,
      button.getAttribute("aria-pressed") === "true",
    ]),
  );

window.__click = (selector) => {
  const node = document.querySelector(selector);
  if (!node) throw new Error("nie ma takiego przycisku: " + selector);
  node.click();
  return true;
};

/** Czy pas jest widoczny — pytamy przeglądarkę, nie arkusza. */
window.__shown = (selector) =>
  getComputedStyle(document.querySelector(selector)).display !== "none";

window.__roll = (on) => {
  document.getElementById("card").dataset.rolled = on ? "true" : "false";
  return true;
};

window.__switch = () => {
  const button = document.getElementById("hideAll");
  return {
    off: button.dataset.off === "true",
    label: button.textContent.trim(),
    // Dźwignia stoi po prawej, dopóki talia leży — i to jest jedyne miejsce,
    // w którym widać położenie wyłącznika.
    lever: getComputedStyle(button.querySelector(".switch__lever")).transform,
    // Wyłącznik NIE JEST czynnością na notatce: gdyby stanął w pasku
    // czynności, czytałby się jako szósta z nich.
    inActs: !!button.closest(".note-acts"),
    belowFoot: !!document.querySelector(".foot ~ .deck-off"),
  };
};
0;
`;

const MAIN = `
const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, x: -2400, y: 80, width: 420, height: 520, backgroundColor: "#09101c",
  });
  await win.loadURL(${JSON.stringify(CARD)});
  const js = (code) => win.webContents.executeJavaScript(code);
  const send = (e) => win.webContents.sendInputEvent(e);
  /* Kartka wczytuje notatkę i ustawienia po starcie, a po 400 ms rozwija się
     sama (patrz unfoldAnyway w js/sticky.js) — czekamy, aż to wszystko
     przestanie się dziać. */
  await wait(900);
  await js(${JSON.stringify(HARNESS)});

  const key = async (keyCode, { modifiers = [], char = null } = {}) => {
    send({ type: "keyDown", keyCode, modifiers });
    if (char !== null) send({ type: "char", keyCode: char, modifiers });
    send({ type: "keyUp", keyCode, modifiers });
    await wait(70);
  };
  const type = async (text) => {
    for (const ch of text) {
      if (ch === " ") await key(" ", { char: " " });
      else {
        send({ type: "char", keyCode: ch });
        await wait(30);
      }
    }
  };

  const out = {};

  /* Notatka z atrapy ma nagłówek, pogrubienie i listę zadań — jeśli kartka
     rysuje ją jako kształt, to znaczy, że edytor i arkusz są te same. */
  out.loaded = await js("window.__shape()");
  out.tools = await js("window.__shown('.tools')");

  /* ── Przyciskiem: trzy rodzaje listy i cytat ── */
  for (const kind of ["bullet", "numbered", "todo", "quote"]) {
    await js("window.__blank()");
    await type("plan");
    await js("window.__caretEnd()");
    await js("window.__click('[data-format=\\\\'" + kind + "\\\\']')");
    await wait(120);
    out[kind] = { shape: await js("window.__shape()"), pressed: await js("window.__pressed()") };
  }

  /* ── Pisaniem: znaczniki na początku linii ── */
  await js("window.__blank()");
  await type("- kawa");
  out.typedBullet = await js("window.__shape()");

  await js("window.__blank()");
  await type("[] oddzwonić");
  out.typedTodo = await js("window.__shape()");

  await js("window.__blank()");
  await type("1. raz");
  out.typedNumbered = { shape: await js("window.__shape()"), pressed: await js("window.__pressed()") };

  /* ── Skrótem klawiaturowym ── */
  await js("window.__blank()");
  await type("zakupy");
  await js("window.__caretEnd()");
  await key("9", { modifiers: ["command", "shift"], char: "(" });
  out.shortcut = await js("window.__shape()");

  /* ── Znacznik daty i godziny: przyciskiem i skrótem ── */
  await js("window.__blank()");
  await type("ustalenia: ");
  await js("window.__click('#stamp')");
  await wait(150);
  out.stampClick = await js("window.__text()");

  await js("window.__blank()");
  await type("druga notatka ");
  await key("t", { modifiers: ["command"] });
  out.stampKey = await js("window.__text()");

  /* ── Pasek gaśnie poza listą ── */
  await js("window.__blank()");
  await type("zwykłe zdanie");
  out.plain = await js("window.__pressed()");

  /* ── Wyłącznik talii ── */
  out.switchBefore = await js("window.__switch()");
  await js("window.__click('#hideAll')");
  await wait(200);
  out.switchAfter = await js("window.__switch()");
  out.deck = await js("window.__deck");

  /* ── Zwinięta kartka chowa oba pasy ── */
  await js("window.__roll(true)");
  out.rolled = {
    tools: await js("window.__shown('.tools')"),
    switch: await js("window.__shown('.deck-off')"),
  };
  await js("window.__roll(false)");

  console.log("__RESULT__" + JSON.stringify(out) + "__END__");
  app.exit(0);
});

setTimeout(() => {
  console.log("__RESULT__" + JSON.stringify({ timeout: true }) + "__END__");
  app.exit(0);
}, 100000);
`;

fs.writeFileSync(path.join(work, "main.js"), MAIN);
fs.writeFileSync(
  path.join(work, "package.json"),
  JSON.stringify({ name: "sticky-test", main: "main.js" }),
);

const electron = require("electron");
let stdout = "";
try {
  stdout = execFileSync(electron, [path.join(work, "main.js")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    /* Bez zdjęcia ELECTRON_RUN_AS_NODE Electron startuje jako sam Node —
       bez okna, bez `app` i bez niczego, o co ten test pyta. */
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_ENABLE_LOGGING: "" },
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
} catch (problem) {
  console.error(problem.stdout ?? "");
  console.error(problem.stderr ?? "");
  throw new Error("Electron nie dokończył testu kartki.");
}

const raw = /__RESULT__([\s\S]*?)__END__/.exec(stdout);
assert.ok(raw, `okno kartki nie odesłało wyniku:\n${stdout}`);
const out = JSON.parse(raw[1]);

let passed = 0;
const ok = (label) => (console.log(`✓ ${label}`), (passed += 1));

/* ── Notatka wygląda jak notatka ── */
assert.ok(out.loaded.todo, "kartka nie narysowała listy zadań z notatki — to ten sam arkusz co w Notatniku");
assert.ok(out.tools, "paska narzędzi na kartce nie widać");
ok("Kartka rysuje notatkę kształtem i ma pasek narzędzi");

/* ── Przyciski robią to, co rysują ── */
assert.ok(out.bullet.shape.bullet, "przycisk listy nie zrobił listy punktowanej");
assert.ok(out.bullet.pressed.bullet, "punkt listy jest, a pasek go nie podświetla");
assert.ok(out.numbered.shape.numbered, "przycisk nie zrobił listy numerowanej");
assert.ok(out.numbered.pressed.numbered, "lista numerowana nie jest podświetlona w pasku");
assert.ok(out.todo.shape.todo, "przycisk nie zrobił listy zadań — a to po nią sięga się na kartce najczęściej");
assert.ok(out.todo.pressed.todo, "lista zadań nie jest podświetlona w pasku");
assert.ok(out.quote.shape.quote, "przycisk nie zrobił cytatu");
ok("Trzy rodzaje listy i cytat powstają z paska kartki");

/* ── Pisanie robi listę samo ── */
assert.ok(out.typedBullet.bullet, "„- ” na początku linii nie zrobiło listy punktowanej");
assert.deepEqual(out.typedBullet.items, ["kawa"], "znacznik „-” został w treści punktu");
assert.ok(out.typedTodo.todo, "„[] ” na początku linii nie zrobiło listy zadań");
assert.deepEqual(out.typedTodo.items, ["oddzwonić"], "znacznik „[]” został w treści punktu");
assert.ok(out.typedNumbered.shape.numbered, "„1. ” na początku linii nie zrobiło listy numerowanej");
assert.ok(out.typedNumbered.pressed.numbered, "lista zrobiona pisaniem nie zapaliła przycisku w pasku");
ok("Wypunktowanie rozpoznaje się w trakcie pisania, tak jak w Notatniku");

assert.ok(out.shortcut.todo, "⌘⇧9 nie zrobiło listy zadań na kartce");
ok("Skróty formatowania działają w kartce tak samo jak w Notatniku");

/* Znacznik niesie DATĘ I GODZINĘ, a nie samą godzinę: notatka żyjąca dłużej
   niż jeden dzień nie odpowiada nazajutrz na pytanie, którego dnia padło
   „14:30". Zapis idzie przez locale, więc pytamy o kształt, nie o napis. */
/* Odstępy jako \s, nie spacja: locale wstawia między godziną a myślnikiem
   spację nierozdzielającą, a ta nie jest tym samym znakiem co spacja. */
const STAMP = /\d{2}[./]\d{2}[./]\d{4},?\s\d{2}:\d{2}\s—\s$/;
assert.ok(
  out.stampClick.startsWith("ustalenia: ") && STAMP.test(out.stampClick),
  `przycisk nie wstawił daty i godziny w miejscu kursora — dostałem: ${JSON.stringify(out.stampClick)}`,
);
assert.ok(
  STAMP.test(out.stampKey),
  `⌘T nie wstawiło znacznika na kartce — dostałem: ${JSON.stringify(out.stampKey)}`,
);
ok("Data i godzina wchodzą w miejscu kursora — przyciskiem i skrótem ⌘T");

assert.ok(
  !out.plain.bullet && !out.plain.numbered && !out.plain.todo && !out.plain.quote,
  "pasek podświetla listę przy kursorze stojącym w zwykłym akapicie",
);
ok("Pasek gaśnie tam, gdzie żadnej listy nie ma");

/* ── Wyłącznik talii ── */
assert.equal(out.switchBefore.label, "Ukryj stickies", "wyłącznik ma się nazywać „Ukryj stickies”");
assert.ok(!out.switchBefore.off, "wyłącznik startuje w położeniu „talia leży”");
assert.ok(!out.switchBefore.inActs, "wyłącznik nie jest czynnością na notatce i nie stoi w ich pasku");
assert.ok(out.switchBefore.belowFoot, "wyłącznik stoi POD stopką, na samym dole kartki");
assert.notEqual(
  out.switchBefore.lever,
  out.switchAfter.lever,
  "dźwignia nie drgnęła — wyłącznik ma się przełożyć, zanim kartki się złożą",
);
assert.ok(out.switchAfter.off, "po naciśnięciu wyłącznik zostaje w położeniu „zgaszone”");
assert.strictEqual(out.deck.hidden, true, "„Ukryj stickies” nie schowało talii");
assert.strictEqual(out.deck.dismissed, null, "„Ukryj stickies” zdjęło notatkę z wierzchu — a miało tylko zgasić talię");
assert.strictEqual(out.deck.deleted, null, "„Ukryj stickies” ruszyło samą notatkę");
ok("„Ukryj stickies” chowa całą talię i nie rusza ani jednej notatki");

assert.ok(!out.rolled.tools && !out.rolled.switch, "kartka zwinięta do belki zostawia widoczne pasy");
ok("Kartka zwinięta do nagłówka chowa i narzędzia, i wyłącznik");

fs.rmSync(work, { recursive: true, force: true });
console.log(`\nKartka na pulpicie: ${passed} sprawdzeń.`);
