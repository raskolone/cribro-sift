"use strict";

/**
 * Wykrywanie konfliktów skrótów.
 *
 * Da się to zrobić tylko częściowo i lepiej powiedzieć wprost, gdzie leży
 * granica. Są trzy źródła wiedzy i każde widzi co innego:
 *
 *   1. SKRÓTY SYSTEMOWE — macOS trzyma je w com.apple.symbolichotkeys.plist.
 *      Czytamy je przez `plutil` i tłumaczymy z powrotem na klawisze. Haczyk:
 *      w pliku siedzą tylko te, które ktoś ruszał. Fabryczne, nietknięte,
 *      są niewidoczne — dlatego trzymamy dodatkowo krótką listę domyślnych
 *      (DEFAULTS) i pomijamy je, gdy plik mówi, że zostały wyłączone.
 *
 *   2. INNE APLIKACJE — nie ma API, które by je wyliczyło. Jest za to test
 *      wprost: spróbować zarejestrować skrót przez globalShortcut. Jeśli
 *      się nie da, ktoś go już trzyma. Nie dowiemy się kto — system tego
 *      nie zdradza.
 *
 *   3. NASZE WŁASNE — te znamy, więc sprawdzamy je pierwsze.
 *
 * Czego ta funkcja NIE wykryje: skrótów aplikacji, które nasłuchują zdarzeń
 * klawiatury zamiast rejestrować skrót globalny (robi tak wiele narzędzi
 * do dyktowania, w tym Wispr Flow). Tego nie widzi żaden interfejs systemu.
 */

const { execFile } = require("child_process");
const os = require("os");
const path = require("path");

/* Maski modyfikatorów w zapisie macOS-a. */
const MOD = {
  Shift: 131072,
  Ctrl: 262144,
  Alt: 524288,
  Meta: 1048576,
};

/* Kody klawiszy macOS-a → nazwa. Tyle, ile potrzeba, żeby nazwać skrót. */
const KEYCODE = {
  0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V",
  11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T", 31: "O", 32: "U",
  34: "I", 35: "P", 37: "L", 38: "J", 40: "K", 45: "N", 46: "M",
  18: "1", 19: "2", 20: "3", 21: "4", 23: "5", 22: "6", 26: "7", 28: "8", 25: "9", 29: "0",
  36: "Return", 48: "Tab", 49: "Space", 51: "Backspace", 53: "Escape",
  123: "Left", 124: "Right", 125: "Down", 126: "Up",
  122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8",
  101: "F9", 109: "F10", 103: "F11", 111: "F12",
};

/* Nazwy tych skrótów systemowych, które faktycznie wchodzą komuś w drogę. */
const SYMBOLIC_NAMES = {
  27: "Zmiana monitora",
  28: "Zrzut całego ekranu",
  29: "Zrzut ekranu do schowka",
  30: "Zrzut zaznaczenia do schowka",
  31: "Zrzut zaznaczonego obszaru",
  32: "Mission Control",
  33: "Okna programu",
  36: "Pokaż pulpit",
  52: "Ukrywanie Docka",
  60: "Poprzednie źródło wprowadzania",
  61: "Następne źródło wprowadzania",
  64: "Spotlight",
  65: "Wyszukiwanie w Finderze",
  79: "Przejdź o pulpit w lewo",
  81: "Przejdź o pulpit w prawo",
  98: "Menu Pomoc",
  175: "Centrum powiadomień",
  184: "Zrzuty ekranu i nagrania",
};

/* Fabryczne skróty macOS-a, których w pliku ustawień nie widać, dopóki
   nikt ich nie ruszał. Lista krótka i celowo tylko o te, o które łatwo
   się potknąć przy skrócie do dyktowania. */
const DEFAULTS = [
  { id: 64, mods: ["Meta"], key: "Space", name: "Spotlight" },
  { id: 65, mods: ["Alt", "Meta"], key: "Space", name: "Wyszukiwanie w Finderze" },
  { id: 60, mods: ["Ctrl"], key: "Space", name: "Poprzednie źródło wprowadzania" },
  { id: 61, mods: ["Ctrl", "Alt"], key: "Space", name: "Następne źródło wprowadzania" },
  { id: 28, mods: ["Shift", "Meta"], key: "3", name: "Zrzut całego ekranu" },
  { id: 31, mods: ["Shift", "Meta"], key: "4", name: "Zrzut zaznaczonego obszaru" },
  { id: 184, mods: ["Shift", "Meta"], key: "5", name: "Zrzuty ekranu i nagrania" },
  { id: 79, mods: ["Ctrl"], key: "Left", name: "Przejdź o pulpit w lewo" },
  { id: 81, mods: ["Ctrl"], key: "Right", name: "Przejdź o pulpit w prawo" },
];

/** „Ctrl+Alt+Space" → { mods: Set{Ctrl,Alt}, key: "SPACE" } */
function parse(accelerator) {
  const parts = String(accelerator || "")
    .split("+")
    .map((piece) => piece.trim())
    .filter(Boolean);

  const mods = new Set();
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (["cmd", "command", "meta", "super"].includes(lower)) mods.add("Meta");
    else if (["ctrl", "control"].includes(lower)) mods.add("Ctrl");
    else if (["alt", "option"].includes(lower)) mods.add("Alt");
    else if (lower === "shift") mods.add("Shift");
    else key = part.toUpperCase();
  }
  return { mods, key };
}

const sameCombo = (a, b) =>
  a.key === b.key && a.mods.size === b.mods.size && [...a.mods].every((m) => b.mods.has(m));

const fromParts = (mods, key) => ({ mods: new Set(mods), key: key.toUpperCase() });

/** Odczyt skrótów systemowych. Zwraca [] przy każdym potknięciu — to podpowiedź,
    nie źródło prawdy, więc nie ma prawa wywrócić sprawdzenia. */
function readSymbolicHotkeys() {
  const file = path.join(os.homedir(), "Library", "Preferences", "com.apple.symbolichotkeys.plist");
  return new Promise((resolve) => {
    execFile("plutil", ["-convert", "json", "-o", "-", file], (error, stdout) => {
      if (error) return resolve([]);
      try {
        const raw = JSON.parse(stdout)?.AppleSymbolicHotKeys ?? {};
        const found = [];
        for (const [id, entry] of Object.entries(raw)) {
          const params = entry?.value?.parameters;
          if (!Array.isArray(params) || params.length < 3) continue;
          const key = KEYCODE[params[1]];
          if (!key) continue;
          const mods = Object.entries(MOD)
            .filter(([, mask]) => (params[2] & mask) === mask)
            .map(([name]) => name);
          found.push({
            id: Number(id),
            enabled: entry.enabled !== false,
            combo: fromParts(mods, key),
            name: SYMBOLIC_NAMES[id] ?? `skrót systemowy #${id}`,
          });
        }
        resolve(found);
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * @param {string} accelerator  np. "Control+Alt+Space"
 * @param {object} options
 * @param {Array<{name:string, accelerator:string}>} options.own  skróty samej aplikacji
 * @param {(acc:string)=>boolean|null} options.probe  próba rejestracji; null = nie sprawdzaj
 * @returns {Promise<{accelerator:string, conflicts:Array, checked:string[], blind:string[]}>}
 */
async function detectConflicts(accelerator, { own = [], probe = null } = {}) {
  const target = parse(accelerator);
  const conflicts = [];

  if (!target.key) {
    return {
      accelerator,
      conflicts: [],
      unknown: true,
      note: "Skrót z samych modyfikatorów (⌃⌥) nie jest skrótem w rozumieniu systemu — nikt go nie rejestruje, więc nie ma z czym kolidować.",
    };
  }

  for (const mine of own) {
    if (mine.accelerator && sameCombo(target, parse(mine.accelerator))) {
      conflicts.push({ source: "cribro", name: mine.name });
    }
  }

  if (process.platform === "darwin") {
    const system = await readSymbolicHotkeys();
    const touched = new Set(system.map((item) => item.id));

    for (const item of system) {
      if (item.enabled && sameCombo(target, item.combo)) {
        conflicts.push({ source: "system", name: item.name });
      }
    }
    // Fabryczne — tylko te, których użytkownik nie ruszał (nie ma ich w pliku).
    for (const item of DEFAULTS) {
      if (touched.has(item.id)) continue;
      if (sameCombo(target, fromParts(item.mods, item.key))) {
        conflicts.push({ source: "system", name: item.name });
      }
    }
  }

  if (probe) {
    const free = probe(accelerator);
    if (free === false) {
      conflicts.push({ source: "app", name: "inna aplikacja trzyma ten skrót" });
    }
  }

  return {
    accelerator,
    conflicts,
    blind: [
      "aplikacje, które podsłuchują klawiaturę zamiast rejestrować skrót (np. narzędzia do dyktowania)",
      "skróty działające tylko wewnątrz jednej aplikacji",
    ],
  };
}

module.exports = { detectConflicts, parse, sameCombo };
