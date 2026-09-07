"use strict";

/**
 * Czy główne okno DA SIĘ UŻYĆ zaraz po otwarciu.
 *
 * Renderer (js/app.js) kończy start funkcją boot(): pyta proces główny
 * o ustawienia, historię i resztę, po czym rysuje okno JEDNYM
 * synchronicznym `render()`. Dopóki ten render trwa, wątek jest zajęty —
 * okno stoi otwarte, narysowane do połowy i głuche na klikanie. Z zewnątrz
 * nie różni się to niczym od zawieszonej aplikacji, bo to JEST zawieszona
 * aplikacja; różnica jest tylko taka, że po chwili sama odmarza.
 *
 * A „po chwili" potrafiło znaczyć pół minuty. Lista historii liczy dla
 * KAŻDEGO wpisu różnicę między surowym a przesianym tekstem (js/diff.js),
 * a to LCS o koszcie n×m. Jedno długie dyktowanie w historii — zmierzone
 * na prawdziwych danych: 32 765 słów — to miliard komórek i piętnaście
 * sekund zajętego wątku PRZY KAŻDYM otwarciu okna, bo wynik nie jest
 * nigdzie zapamiętywany.
 *
 * Dlatego historia jest tu zasiewana Z TAKIM WŁAŚNIE WPISEM. Test bez
 * niego przechodzi zawsze i niczego nie pilnuje.
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/freeze-test.js
 */

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

/* Własny katalog danych: test nie ma prawa dotknąć historii ani ustawień
   człowieka, który go uruchamia. */
const sandbox = path.join(os.tmpdir(), "cribro-freeze");
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
app.setPath("userData", sandbox);

/* ── Zasiew ──────────────────────────────────────────────────────
   Dwieście wpisów zwyczajnych (mediana prawdziwej historii to jakieś
   pięćdziesiąt słów) i jeden taki, jaki potrafi wyjść z dyktowania
   zostawionego bez nadzoru. Surowy i przesiany różnią się co kilka słów,
   bo dwa teksty o wspólnym początku i końcu skracają się do zera i nie
   kosztują nic (patrz js/diff.js). */
const words = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i % 900}`).join(" ");
const sift = (text) =>
  text
    .split(" ")
    .map((word, i) => (i % 3 ? word : `x${i % 900}`))
    .join(" ");

const entry = (id, count) => {
  const raw = words(count, "s");
  const text = sift(raw);
  return {
    id,
    at: new Date(Date.now() - Number(id.slice(1)) * 60000).toISOString(),
    text,
    raw,
    rawWords: count,
    siftedWords: count,
    mesh: "medium",
    app: "Test",
    provider: "mock",
    model: "test",
  };
};

const history = [entry("e0", 33000), ...Array.from({ length: 200 }, (_, i) => entry(`e${i + 1}`, 50))];
fs.writeFileSync(path.join(sandbox, "history.json"), JSON.stringify(history));

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const problems = [];
const ok = (message) => console.log("✓", message);
const bad = (message) => {
  problems.push(message);
  console.log("✗", message);
};

require(path.join(__dirname, "..", "src", "main", "main.js"));

app.whenReady().then(async () => {
  await wait(1500);

  const win = BrowserWindow.getAllWindows().find((w) => (w.webContents.getURL() || "").includes("index.html"));
  if (!win) {
    bad("główne okno w ogóle się nie otworzyło");
    return finish();
  }

  const errors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  /* Sprawdzamy `#titlePill`, bo tę treść wpisuje dopiero render() i tylko
     wtedy, gdy ma już ustawienia — czyli po przejściu boot() do końca.
     Cokolwiek stoi w index.html od zawsze, nadawałoby się do tego równie
     dobrze co nic: byłoby na miejscu także w oknie zamrożonym. */
  const DEADLINE = 5000;
  const started = Date.now();
  let booted = false;
  while (Date.now() - started < DEADLINE) {
    booted = await win.webContents
      .executeJavaScript("!!document.querySelector('#titlePill')?.textContent")
      .catch(() => false);
    if (booted) break;
    await wait(100);
  }
  const took = Date.now() - started;

  /* O WYNIKU DECYDUJE CZAS, nie samo doczekanie się.
     `executeJavaScript` czeka w kolejce zajętego renderera i wraca dopiero,
     gdy ten skończy — pojedyncze wywołanie potrafi więc stać dłużej niż
     całe okno czasu wyżej i wrócić z prawdą (zmierzone: 118 sekund).
     Pętla nie zdąży wtedy sprawdzić terminu ani razu, bo termin mija
     w środku jej jedynego obrotu. Zamrożone okno też się w końcu odmraża;
     usterką jest to, ile trwa „w końcu". */
  if (booted && took < DEADLINE) ok(`Okno jest gotowe do klikania po ${took} ms`);
  else if (booted) bad(`okno odpowiedziało dopiero po ${took} ms — przez ten czas jest zamrożone`);
  else bad(`okno nie odpowiedziało przez ${took} ms — jest zamrożone`);

  if (booted) {
    const switched = await win.webContents
      .executeJavaScript(
        `(() => {
           const target = document.querySelector('#nav [data-view="settings"]');
           if (!target) return "brak pozycji Ustawienia";
           target.click();
           return document.querySelector('#view-settings')?.hidden === false ? true : "widok się nie przełączył";
         })()`,
      )
      .catch((error) => String(error.message || error));
    if (switched === true) ok("Kliknięcie w pasku bocznym przełącza widok — okno reaguje");
    else bad(`okno nie reaguje na kliknięcie: ${switched}`);
  }

  if (errors.length) for (const message of errors) bad(`błąd w konsoli okna: ${message}`);
  else ok("Konsola okna bez błędów");

  finish();
});

/* Wyjście przez app.quit(), a NIE app.exit(): tylko quit puszcza „will-quit",
   a na nim main.js zatrzymuje silnik skrótu (uiohook). Ubity bez tego wątek
   natywny dostawał zdarzenie w trakcie sprzątania i cały proces kończył się
   SIGABRT-em — czyli test przechodził, a mimo to wyglądał na przegrany. */
function finish() {
  console.log(
    problems.length
      ? `\nZamrożenie: ${problems.length} ${problems.length === 1 ? "usterka" : "usterek"}.`
      : "\nZamrożenie: główne okno startuje i reaguje.",
  );
  const code = problems.length ? 1 : 0;
  /* Kod wyjścia trzeba dopisać na samym końcu: app.quit() kończy pętlę,
     ale kodu ustawionego wcześniej nie przenosi — a to on decyduje, czy
     `npm test` pojedzie dalej, czy stanie. */
  app.once("quit", () => process.exit(code));
  app.quit();
}
