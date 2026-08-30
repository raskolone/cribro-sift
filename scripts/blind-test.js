"use strict";
/**
 * Czego zwykły użytkownik NIE ZOBACZY W OKNIE.
 *   node scripts/blind-test.js
 *
 * scripts/owner-test.js pilnuje rozstrzygnięć: co proces główny wysyła
 * i czego nie zapisze. Ten test pilnuje czegoś innego i sprawdza to
 * jedyną drogą, którą da się sprawdzić naprawdę — otwierając okno
 * i czytając to, co się w nim narysowało.
 *
 * Bo wyciek nie wchodzi przez pole, o którym się myśli. Wchodzi bokiem:
 * przez podpowiedź w `title`, przez zdanie w karcie obok, przez podtytuł
 * strony zapowiadający „dostawców". Asercja na kształt obiektu tego nie
 * złapie; przejście po całym drzewie okna — łapie.
 *
 * Okno stoi na atrapie mostu (renderer/js/mock-bridge.js), bo nie chodzi
 * tu o cudze klucze, tylko o to, czy interfejs UMIE takie rzeczy pokazać.
 * Atrapa udaje zwykłego użytkownika; z `?owner` w adresie udaje właściciela
 * i wtedy ten sam test sprawdza rzecz odwrotną: że właścicielowi krok
 * „Silniki" nie zniknął.
 *
 * Biegnie w Electronie, bo tylko tam jest okno.
 */
const { execFileSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const MAIN = `
const { app, BrowserWindow } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();

/* Strażnik czasu: zawieszone okno ma zgłosić awarię, a nie wisieć. */
setTimeout(() => { console.log("WYNIK " + JSON.stringify({ error: "okno nie odpowiedziało" })); app.exit(1); }, 60000);

/** Wszystko, co widać w oknie: teksty, podpowiedzi, wartości pól. */
const HARVEST = \`(async () => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll("*")) {
      if (el.hidden) continue;
      for (const attr of ["title", "placeholder", "aria-label", "value"]) {
        const v = el.getAttribute?.(attr);
        if (v) out.push(v);
      }
      if (el.tagName === "OPTION") out.push(el.textContent);
    }
    out.push(node.innerText || "");
  };
  walk(document.body);
  return {
    text: out.join("\\\\n"),
    engines: !!document.querySelector('[data-setting="stt.provider"], [data-setting="sieve.provider"], [data-setting="shot.provider"]'),
    keys: !!document.querySelector('[data-setting$=".apiKey"]'),
    probes: document.querySelectorAll('[data-act^="test-"]').length,
  };
})()\`;

async function look(win, query) {
  await win.loadFile(path.join(${JSON.stringify(root)}, "src/renderer/index.html"), { query });
  await new Promise((r) => setTimeout(r, 2500));
  const seen = { text: "", engines: false, keys: false, probes: 0 };
  /* Chodzimy po WSZYSTKICH zakładkach, nie tylko po Ustawieniach: nazwa
     modelu potrafi wyjść w karcie „Pierwsze dyktowanie" albo w przewodniku. */
  for (const view of ["start", "sifted", "notes", "meetings", "sieve", "grains", "commands", "settings"]) {
    await win.webContents.executeJavaScript(
      \`document.querySelector('.nav__item[data-view="\${view}"]')?.click()\`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const part = await win.webContents.executeJavaScript(HARVEST);
    seen.text += "\\n" + part.text;
    seen.engines ||= part.engines;
    seen.keys ||= part.keys;
    seen.probes += part.probes;
  }
  /* Przewodnik też jest oknem — a jego ostatni slajd mówił dotąd
     wszystkim „zostaje jedno: klucz". Otwieramy go OD KOŃCA: widać
     zawsze jeden slajd, a chodzi właśnie o ten ostatni (numer większy
     niż liczba slajdów przycina się do ostatniego). */
  await win.webContents.executeJavaScript("window.CribroGuide?.open(99)");
  await new Promise((r) => setTimeout(r, 600));
  seen.text += "\\n" + (await win.webContents.executeJavaScript(HARVEST)).text;
  await win.webContents.executeJavaScript("window.CribroGuide?.close()");
  return seen;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  try {
    const user = await look(win, {});
    const owner = await look(win, { owner: "1" });
    console.log("WYNIK " + JSON.stringify({ user, owner }));
    app.exit(0);
  } catch (problem) {
    console.log("WYNIK " + JSON.stringify({ error: String(problem && problem.message || problem) }));
    app.exit(1);
  }
});
`;

const fs = require("fs");
const os = require("os");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-blind-"));
const entry = path.join(work, "main.js");
fs.writeFileSync(entry, MAIN);
fs.writeFileSync(
  path.join(work, "package.json"),
  JSON.stringify({ name: "blind", main: "main.js" }),
);

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
const { user, owner, error } = JSON.parse(line.slice(6));
if (error) throw new Error(error);

const assert = require("assert");
let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Zwykły użytkownik ────────────────────────────────────────── */

const NAZWY = [
  "Gemini",
  "OpenAI",
  "Anthropic",
  "Claude",
  "GPT",
  "Whisper",
  "gemini-",
  "gpt-",
  "claude-",
  "sk-ant",
  "AIza",
  "aistudio.google.com",
  "platform.openai.com",
  "console.anthropic.com",
];

for (const nazwa of NAZWY) {
  const gdzie = user.text
    .split("\n")
    .find((line) => line.toLowerCase().includes(nazwa.toLowerCase()));
  check(`Nigdzie w oknie nie pada „${nazwa}"`, !gdzie);
}

check("Nie ma z czego wybrać dostawcy ani modelu", !user.engines);
check("Nie ma pola na klucz API", !user.keys);
check("Nie ma przycisku „Sprawdź połączenie”", user.probes === 0);
check("Nie ma nagłówka „Silniki”", !/\bSilniki\b/.test(user.text));
check("Podtytuł Ustawień nie zapowiada dostawców",
  !/Skróty, dostawcy/.test(user.text));
check("Przewodnik nie kończy się prośbą o klucz",
  !/Zostaje jedno: klucz/.test(user.text));
check("…tylko zdaniem, że nie ma tu nic do ustawiania",
  /nie ma tu kluczy do wpisywania/.test(user.text));

/* Okno bez silników nie może być oknem, w którym nic nie ma: zwykły
   użytkownik ma zobaczyć odpowiedź na jedyne pytanie, które zadaje. */
check("Zamiast silników stoi odpowiedź: sito działa",
  /Nie ma tu czego ustawiać|Sito milczy/.test(user.text));

/* ── Właściciel ───────────────────────────────────────────────── */

check("Właścicielowi krok „Silniki” nie zniknął", owner.engines);
check("Właściciel ma gdzie wpisać klucz", owner.keys);
check("Właściciel ma czym sprawdzić połączenie", owner.probes >= 2);
check("…i widzi, co siedzi pod spodem", /Gemini|OpenAI/.test(owner.text));

console.log(`\nOkno: ${passed} sprawdzeń przeszło. Zwykły użytkownik nie widzi silnika, właściciel widzi wszystko.`);
