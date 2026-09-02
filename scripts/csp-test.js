"use strict";

/**
 * Czy polityka bezpieczeństwa nie zabija własnej aplikacji.
 *
 * CSP jest tym rodzajem zabezpieczenia, które łatwo napisać za ciasno:
 * skrypt się nie wczyta, krój nie przyjdzie, obrazek zostanie pustą ramką
 * — a nic z tego nie wywala aplikacji z hukiem. Widać to dopiero w konsoli
 * okna, do której nikt nie zagląda, albo jako „coś dziwnie wygląda".
 *
 * Ten skrypt otwiera każde okno po kolei z polityką NAŁOŻONĄ TAK SAMO jak
 * w aplikacji i czyta jego konsolę. Każde naruszenie CSP to błąd.
 *
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/csp-test.js
 */

const { app, BrowserWindow, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const renderer = path.join(root, "src", "renderer");

const sandbox = path.join(os.tmpdir(), "cribro-csp");
fs.rmSync(sandbox, { recursive: true, force: true });
app.setPath("userData", sandbox);

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/* Ta sama lista co w main/guardWindows. Kopiujemy ją tu ŚWIADOMIE: test ma
   sprawdzać politykę, a nie ufać, że plik, który ją niesie, da się wczytać
   bez całego procesu głównego. Rozjazd między tą listą a tamtą wyłapuje
   sprawdzenie na końcu. */
const POLICY = [
  "default-src 'none'",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' file: https://fonts.gstatic.com",
  "img-src 'self' file: data: blob:",
  "media-src 'self' file: data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/* Wszystkie okna, jakie aplikacja otwiera. Kolejność bez znaczenia —
   każde dostaje własne okno i własną konsolę. */
const WINDOWS = [
  "index.html",
  "notes.html",
  "sticky.html",
  "meeting.html",
  "widget.html",
  "hud.html",
  "quick.html",
  "briefing.html",
  "shot.html",
];

let passed = 0;
const problems = [];

function check(what, ok, detail = "") {
  if (ok) {
    console.log(`✓ ${what}`);
    passed += 1;
  } else {
    console.log(`✗ ${what}${detail ? `\n    ${detail}` : ""}`);
    problems.push(what);
  }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, done) => {
    done({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [POLICY] },
    });
  });

  /* JEDNO okno na wszystkie pliki po kolei, a nie okno na plik.
     Zamknięcie ostatniego okna gasi aplikację (`window-all-closed`), więc
     pętla tworząca i niszcząca okna kończyła się po pierwszym przebiegu
     — i to cicho, z kodem zero, czyli wyglądała na sukces. */
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });

  let complaints = [];
  win.webContents.on("console-message", (_event, _level, message) => {
    /* Ostrzeżenie Electrona o BRAKU polityki jest tym, co ta zmiana
       usuwa — gdyby padło, znaczyłoby, że nagłówek nie doszedł. */
    if (/Content.Security.Policy/i.test(message) || /Refused to/i.test(message)) {
      complaints.push(message.split("\n")[0].slice(0, 160));
    }
  });

  for (const file of WINDOWS) {
    complaints = [];
    /* Okno bywa przerwane w trakcie wczytywania (kartka na pulpicie sama
       się przenosi, HUD sam się chowa) i `loadFile` odrzuca wtedy obietnicę
       z ERR_ABORTED. To nie jest awaria polityki, więc idziemy dalej. */
    try {
      await win.loadFile(path.join(renderer, file));
    } catch (problem) {
      console.log(`  (${file}: wczytywanie przerwane — ${String(problem.message).slice(0, 60)})`);
    }
    await wait(1600);
    check(
      `${file}: nic nie odbiło się od polityki`,
      complaints.length === 0,
      complaints.join("\n    "),
    );
  }

  /* Polityka ma nie być pusta w miejscach, na których naprawdę zależy. */
  /* Patrzymy na SAMĄ dyrektywę, nie na cały łańcuch: `https` pada dalej,
     przy krojach, i wcześniejsza wersja tego sprawdzenia łapała tamto. */
  const directive = (name) =>
    POLICY.split("; ").find((rule) => rule.startsWith(`${name} `)) ?? "";
  check("Skrypty nie mogą przyjść z sieci", !/https?:/.test(directive("script-src")));
  check("…ani style", !/https?:\/\/(?!fonts\.googleapis\.com)/.test(directive("style-src")));
  check("Renderer nie ma prawa dzwonić na zewnątrz", POLICY.includes("connect-src 'self'"));
  check("Wtyczki i osadzone obiekty odpadają", POLICY.includes("object-src 'none'"));
  check("Formularze nie mają dokąd wysłać", POLICY.includes("form-action 'none'"));
  check("Okna nie dają się osadzić w cudzej ramce", POLICY.includes("frame-ancestors 'none'"));

  /* Ta sama polityka tu i w aplikacji — inaczej test sprawdza co innego,
     niż działa u człowieka. */
  const source = fs.readFileSync(path.join(root, "src", "main", "main.js"), "utf8");
  const same = POLICY.split("; ").every((rule) => source.includes(`"${rule}"`));
  check("Polityka w teście jest tą samą, co w main.js", same);

  console.log(
    `\nCSP: ${passed} sprawdzeń przeszło.${problems.length ? ` ${problems.length} PADŁO.` : " Okna działają, sieć jest zamknięta."}`,
  );
  app.exit(problems.length ? 1 : 0);
});
