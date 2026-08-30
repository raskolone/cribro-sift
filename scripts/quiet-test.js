"use strict";
/**
 * Nagrywanie ma być NIEWIDOCZNE Z DRUGIEJ STRONY ROZMOWY.
 *   node scripts/quiet-test.js
 *
 * ══ O CO TU CHODZI ══
 *
 * Narzędzia do notatek ze spotkań dzielą się na dwa gatunki i to jest
 * różnica gatunkowa, a nie różnica w szczegółach.
 *
 * PIERWSZY GATUNEK DOŁĄCZA DO ROZMOWY. Wchodzi do pokoju jako uczestnik,
 * pojawia się na liście obecnych, dostaje własną kratkę na siatce i bywa
 * zapowiadany przez samą platformę („do spotkania dołączył asystent AI").
 * Rozpoznaje się go, bo JEST w rozmowie: ma nazwę, ma awatar, czasem coś
 * powie na czacie. Google Meet, Zoom i Teams pokazują go wprost.
 *
 * DRUGI GATUNEK SŁUCHA GŁOŚNIKA. Stoi po stronie jednego człowieka, tak
 * samo jak dyktafon położony obok laptopa: bierze dźwięk, który i tak
 * wychodzi z tego komputera, i mikrofon, który i tak jest włączony. Dla
 * rozmowy nie istnieje, bo nie ma go w rozmowie.
 *
 * Cribro jest drugim gatunkiem i ten test pilnuje, żeby nim został. Nie
 * jest to sztuczka: to jest kształt tej aplikacji od pierwszego dnia
 * (patrz nagłówek native/tap/main.swift). Test jest tu po to, żeby
 * przypadkowa zmiana nie przesunęła go po cichu do pierwszego gatunku —
 * bo przesunięcie byłoby jednym `import`em, a widać je dopiero u kogoś
 * innego na ekranie.
 *
 * ══ CZEGO TEN TEST NIE OBIECUJE ══
 *
 * Nie obiecuje, że nagrywania nie da się zauważyć na tym komputerze.
 * macOS pokazuje własny wskaźnik przy każdym dostępie do mikrofonu
 * i ekranu i to jest dobrze: człowiek przy klawiaturze MA wiedzieć, że
 * nagrywa. Sama aplikacja mówi to samo — znaczek świeci na czerwono przez
 * cały czas nagrania.
 *
 * Nie obiecuje też, że rozmówcy nie trzeba uprzedzić. Trzeba, i w wielu
 * miejscach wymaga tego prawo; zakładka Spotkania ma nawet gotowe zdanie
 * do wklejenia na czat. Ten test mówi wyłącznie o tym, czego CRIBRO nie
 * robi: nie wchodzi do cudzej rozmowy i nic do niej nie wpuszcza.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...bits) => fs.readFileSync(path.join(root, ...bits), "utf8");

let checks = 0;
const ok = (label) => {
  checks += 1;
  console.log(`✓ ${label}`);
};

/* ── 1. Nikt nigdzie nie dołącza ──────────────────────────────────
   Dołączenie do rozmowy wymagałoby albo otwarcia pokoju u siebie
   (WebRTC), albo cudzego API do spotkań. Ani jedno, ani drugie nie ma
   w tym drzewie prawa się pojawić. */

const SOURCES = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|swift|html)$/.test(entry.name)) SOURCES.push(full);
  }
})(path.join(root, "src"));
SOURCES.push(path.join(root, "native", "tap", "main.swift"));

/** Kod bez komentarzy — o tym, co aplikacja ROBI, nie o tym, co o sobie pisze. */
function code(file) {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*(?:\/\/|\*|<!--).*$/gm, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

const JOINING = [
  [/\bRTCPeerConnection\b/, "WebRTC — to jest wchodzenie do pokoju"],
  [/\bgetDisplayMedia\b/, "udostępnianie ekranu do cudzej rozmowy"],
  [/meet\.googleapis\.com/, "API spotkań Google"],
  [/api\.zoom\.us/, "API Zooma"],
  [/graph\.microsoft\.com\/.*onlineMeetings/, "API spotkań Teams"],
  [/\bbot(?:Name|Join|Participant)\b/i, "uczestnik-bot"],
];

for (const file of SOURCES) {
  const body = code(file);
  for (const [pattern, why] of JOINING) {
    assert.ok(
      !pattern.test(body),
      `${path.relative(root, file)} sięga po ${why} — Cribro nie dołącza do rozmów.`,
    );
  }
}
ok("Nigdzie w kodzie nie ma dołączania do cudzej rozmowy");

/* ── 2. Nic nie wchodzi do rozmowy ────────────────────────────────
   Wirtualny mikrofon albo wirtualna kamera to sterownik instalowany
   w systemie — i jedyna droga, którą aplikacja mogłaby coś do rozmowy
   WPUŚCIĆ. W paczce nie ma czego takiego instalować. */

const pkg = JSON.parse(read("package.json"));
const extras = JSON.stringify(pkg.build?.extraResources ?? []) + JSON.stringify(pkg.build?.extraFiles ?? []);
assert.ok(
  !/\.(driver|plugin|kext|dext|bundle)\b/i.test(extras),
  "paczka niesie sterownik albo wtyczkę systemową — wirtualne urządzenie wpuszcza dźwięk do cudzej rozmowy",
);
assert.ok(
  !/audio-output|virtual|loopback/i.test(read("build", "entitlements.mac.plist")),
  "uprawnienia aplikacji mówią o wyjściu audio albo o urządzeniu wirtualnym",
);
ok("Paczka nie instaluje wirtualnego mikrofonu ani kamery");

/* ── 3. Program pomocniczy bierze DŹWIĘK, nie obraz ───────────────
   Strumień ScreenCaptureKit jest strumieniem ekranu i klatki w nim
   powstają — ale nikt ich nie zamawia i nikt ich nie czyta. Gdyby
   ktoś kiedyś dopisał wyjście `.screen`, ta aplikacja z dyktafonu
   zrobiłaby się nagrywarką ekranu i nikt by tego nie zauważył. */

const tap = read("native", "tap", "main.swift");
assert.ok(
  !/addStreamOutput\([^)]*type:\s*\.screen/.test(tap),
  "cribro-tap zamawia obraz z ekranu — ma brać wyłącznie dźwięk",
);
assert.ok(/config\.capturesAudio = true/.test(tap), "cribro-tap nie zamawia dźwięku");
assert.ok(
  /config\.width = \d\b/.test(tap) && /config\.height = \d\b/.test(tap),
  "klatka obrazu przestała być dwoma pikselami — to już nie jest „nie interesuje mnie obraz”",
);
ok("cribro-tap bierze dźwięk, a obrazu nie zamawia");

/* ── 4. Cribro wyklucza samo siebie ───────────────────────────────
   Dźwięk potwierdzenia po dyktowaniu i odsłuch fragmentu zapisu wychodzą
   z procesów Electrona, nie z cribro-tap — więc `excludesCurrentProcessAudio`
   ich nie łapie. Bez jawnego wykluczenia własny sygnał aplikacji wchodziłby
   do nagrania cudzej rozmowy i wracał w transkrypcji jako czyjaś wypowiedź. */

assert.ok(
  /config\.excludesCurrentProcessAudio = true/.test(tap),
  "cribro-tap nagrywa własny proces",
);
assert.ok(
  /let mine = \[[^\]]*com\.cribro\.sift/.test(tap),
  "cribro-tap nie wyklucza aplikacji Cribro — jej własny dźwięk wchodzi do nagrania rozmowy",
);
ok("Własny dźwięk Cribro nie wchodzi do nagrania");

/* ── 5. Żadne nasze okno nie udaje okna rozmowy ───────────────────
   Tytuły okien widzi każda aplikacja na tym komputerze — i to z nich
   czyta nasze własne wykrywanie rozmów (src/main/detect.js). Jest to
   najlepszy dostępny model tego, po czym cudzy wykrywacz „asystentów AI"
   poznawałby aplikację do notatek: po napisie na belce.

   Nasze okna mają więc nie trafiać we WŁASNE wzorce. Gdyby trafiały,
   Cribro wykrywałoby samo siebie jako spotkanie — a przy ustawieniu „sam
   z siebie" nagrywałoby ekran, na którym stoi jego własne okno. */

const { spot } = require("../src/main/detect");

const titles = fs
  .readdirSync(path.join(root, "src", "renderer"))
  .filter((name) => name.endsWith(".html"))
  .map((name) => {
    const hit = /<title>([^<]*)<\/title>/.exec(read("src", "renderer", name));
    return { name, title: (hit?.[1] ?? "").trim() };
  });

assert.ok(titles.length >= 8, "nie znaleziono tytułów okien — test patrzy w złe miejsce");
for (const { name, title } of titles) {
  assert.equal(
    spot([title]),
    null,
    `okno ${name} nazywa się „${title}" i wygląda z zewnątrz jak okno rozmowy`,
  );
}
ok(`Żaden z ${titles.length} tytułów okien nie wygląda jak okno rozmowy`);

/* Tytuł okna jednego spotkania nie niesie też nazwy tej rozmowy: nazwa
   spotkania na belce byłaby cudzą informacją wystawioną na widok każdej
   aplikacji na tym komputerze. */
const solo = titles.find((item) => item.name === "meeting.html");
assert.ok(solo, "nie ma okna pojedynczego spotkania");
assert.ok(
  !/spotkanie|meeting|rozmowa/i.test(solo.title),
  `okno pojedynczego spotkania nazywa się „${solo.title}" — nazwa ma być bezbarwna`,
);
ok("Okno pojedynczego spotkania nie ogłasza, że jest spotkaniem");

/* ── 6. Nagranie jedzie w jedno miejsce ───────────────────────────
   Dźwięk rozmowy opuszcza ten komputer wyłącznie jako materiał do
   przepisania i wyłącznie do dostawcy transkrypcji. Żadnej telemetrii,
   żadnego „udostępnij zespołowi", żadnego drugiego adresu. */

const stt = code(path.join(root, "src", "main", "stt.js"));
const hosts = [...stt.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((hit) => hit[1]);
const allowed = new Set(["generativelanguage.googleapis.com", "api.openai.com"]);
for (const host of hosts) {
  assert.ok(allowed.has(host), `transkrypcja wysyła nagranie do ${host} — to nie jest dostawca modelu`);
}
ok(`Nagranie jedzie wyłącznie do dostawcy transkrypcji (${[...new Set(hosts)].join(", ")})`);

console.log(`\nCiche nagrywanie: ${checks} sprawdzeń przeszło. Cribro słucha głośnika, a nie siedzi w rozmowie.`);
