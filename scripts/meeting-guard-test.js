"use strict";
/**
 * Zapis spotkania: zatrucie promptem, mówcy i walidacja nagraniem.
 *   node scripts/meeting-guard-test.js
 *
 * Trzy usterki, z których każda psuje zapis po cichu — i każda naprawdę
 * się zdarzyła albo wynikała wprost z kodu:
 *
 *   1. MODEL PRZEPISUJE INSTRUKCJĘ. W zapisie zajęć stało zdanie „To jest
 *      KONTEKST, nie przepisuj go ponownie" podpisane rozmówcą, a obok
 *      dziewięć razy samo słowo „KONTEKST" podpisane właścicielem konta.
 *      Zdanie, którego nikt nie powiedział, przypisane człowiekowi
 *      z imienia, jest gorsze niż dziura w zapisie: dziurę widać.
 *
 *   2. TRZY OSOBY ZAPISUJĄ SIĘ JAKO JEDNA. Tor systemu miesza wszystkich
 *      zdalnych rozmówców w jedno wejście. Bez rozbicia zajęcia w cztery
 *      osoby mają w zapisie dwie etykiety.
 *
 *   3. SZKIC UDAJE ZAPIS. Przepisywanie w biegu leci pod presją czasu
 *      i wolno mu się mylić — ale tylko wtedy, gdy widać, GDZIE.
 *
 * Wszystko trzy da się sprawdzić bez sieci i bez Electrona: wchodzą dane,
 * wychodzą rozstrzygnięcia.
 */
const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const stt = require(path.join(root, "src/main/stt.js"));
const { splice, expandTurns } = require(path.join(root, "src/main/merge.js"));
const { compare } = require(path.join(root, "src/main/verify.js"));

let passed = 0;
const ok = (label) => (console.log(`✓ ${label}`), (passed += 1));

/* ── 1. Instrukcja nie ma prawa wejść do zapisu ──────────────────── */

// Dokładnie to, co stało w zapisie zajęć.
assert.ok(
  stt.echoedPrompt("To jest KONTEKST, nie przepisuj go ponownie."),
  "zdanie z promptu przeszło jako wypowiedź",
);
assert.ok(
  stt.echoedPrompt("Zapisz dokładnie to, co słychać w nagraniu."),
  "polecenie transkrypcji przeszło jako wypowiedź",
);
assert.ok(
  stt.echoedPrompt("Nazwy własne, które mogą paść: Anna, Robert."),
  "podpowiedź o nazwach własnych przeszła jako wypowiedź",
);
ok("Przepisana instrukcja jest rozpoznawana");

/* Prawdziwa mowa o kontekście NIE MOŻE wpaść w to sito. Na zajęciach
   o modelach językowych słowo „kontekst" pada co drugie zdanie — sito,
   które by je wycinało, byłoby gorsze od usterki, którą naprawia. */
for (const said of [
  "Wróćmy do limitów kontekstu w modelach językowych.",
  "Kontekst ma tu znaczenie kluczowe, zapiszcie to.",
  "Okno kontekstowe Gemini urosło do miliona tokenów.",
  "Nie przepisujcie tego do zeszytu, to będzie na slajdach.",
]) {
  assert.ok(!stt.echoedPrompt(said), `prawdziwa wypowiedź uznana za instrukcję: „${said}"`);
}
ok("Prawdziwa mowa o kontekście przechodzi nietknięta");

/* ── 2. Krótkie zapętlenie ───────────────────────────────────────── */

// Dziewięć „KONTEKST" pod rząd — tyle, ile było w zapisie zajęć.
assert.ok(
  stt.loopedTranscript("KONTEKST ".repeat(9)),
  "dziewięciokrotne powtórzenie przeszło przez sito zapętleń",
);
// A zwykłe zniecierpliwienie nie jest zapętleniem.
assert.ok(!stt.loopedTranscript("tak, tak, tak"), "„tak, tak, tak” uznane za zapętlenie");
assert.ok(
  !stt.loopedTranscript("Dobrze, dobrze, rozumiem, zapiszmy to i idźmy dalej."),
  "zwykłe powtórzenie uznane za zapętlenie",
);
ok("Krótkie zapętlenie jest łapane, a zniecierpliwienie nie");

/* ── 3. Ogon nie wraca do modelu ─────────────────────────────────── */

const meeting = require("fs").readFileSync(path.join(root, "src/main/meeting.js"), "utf8");
assert.ok(
  !/session\.tails/.test(meeting),
  "ogon poprzedniego odcinka wrócił do main/meeting.js — to on zapętlał zatrucie",
);
const sttSource = require("fs").readFileSync(path.join(root, "src/main/stt.js"), "utf8");
assert.ok(
  !/To jest KONTEKST/.test(sttSource.replace(/\/\*[\s\S]*?\*\//g, "")),
  "instrukcja o kontekście wróciła do promptu (poza komentarzem)",
);
ok("Kontekst tekstowy nie jedzie już do modelu");

/* ── 4. Trzy osoby to trzy osoby ─────────────────────────────────── */

const pieces = [
  {
    lane: "system",
    from: 0,
    to: 25,
    text: "Dzień dobry. Cześć, tu Robert. A ja jestem Anna.",
    turns: [
      { speaker: 0, from: 0, to: 4, text: "Dzień dobry." },
      { speaker: 1, from: 5, to: 9, text: "Cześć, tu Robert." },
      { speaker: 2, from: 10, to: 14, text: "A ja jestem Anna." },
    ],
  },
  { lane: "mic", from: 15, to: 40, text: "Zaczynamy zajęcia od limitów kontekstu." },
];

const lines = splice(pieces);
const speakers = new Set(lines.map((line) => line.speaker));
assert.ok(speakers.has("Rozmówca 1") && speakers.has("Rozmówca 2") && speakers.has("Rozmówca 3"),
  `trzech rozmówców nie zostało rozdzielonych: ${[...speakers].join(", ")}`);
assert.ok(speakers.has("Ty"), "tor mikrofonu przestał być „Ty”");
ok("Trzy osoby w torze systemu dostają trzy etykiety");

/* TOR MIKROFONU NIE JEST DZIELONY — to jest najważniejsze zdanie w tym
   teście. „Kto jest mną" wynika z osobnego wejścia dźwięku i nie wolno
   zamieniać tej pewności na zgadywanie modelu. */
const micSplit = expandTurns([
  {
    lane: "mic",
    from: 0,
    to: 20,
    text: "Mówię ja i tylko ja.",
    turns: [
      { speaker: 0, from: 0, to: 5, text: "Mówię ja" },
      { speaker: 1, from: 6, to: 10, text: "i tylko ja." },
    ],
  },
]);
assert.equal(micSplit.length, 1, "tor mikrofonu został rozbity na mówców — a tam mówi jedna osoba");
assert.equal(micSplit[0].who, undefined, "tor mikrofonu dostał numer mówiącego");
ok("Tor mikrofonu zostaje jedną osobą — pewność z kabla, nie z modelu");

/* Numer mówiącego jest LOKALNY dla odcinka. Ta sama osoba bywa „2"
   w jednym i „1" w następnym — zszywa je zakładka dźwiękowa. */
const stitched = splice([
  pieces[0],
  {
    lane: "system",
    from: 22,
    to: 47,
    text: "A ja jestem Anna. Mam pytanie o te limity.",
    turns: [
      { speaker: 1, from: 0, to: 3, text: "A ja jestem Anna." },
      { speaker: 1, from: 4, to: 9, text: "Mam pytanie o te limity." },
    ],
  },
]);
const late = stitched.find((line) => line.text.includes("Mam pytanie"));
assert.ok(late, "wypowiedź z drugiego odcinka zniknęła");
assert.equal(
  late.speaker,
  "Rozmówca 3",
  `numer mówiącego nie został zszyty między odcinkami — wyszło „${late.speaker}"`,
);
ok("Numery mówców są zszywane między odcinkami po zakładce");

/* ── 5. Echo jest znaczone, a nie kasowane ───────────────────────── */

const withEcho = [
  { lane: "system", from: 0, to: 25, text: "Proszę otworzyć podręcznik na stronie czterdziestej." },
  { lane: "mic", from: 1, to: 26, text: "Proszę otworzyć podręcznik na stronie czterdziestej." },
];
const hidden = splice(withEcho);
assert.ok(
  !hidden.some((line) => line.lane === "mic"),
  "przesłuch z głośników wszedł do zapisu jako twoja wypowiedź",
);
const shown = splice(withEcho, { keepEcho: true });
const bounced = shown.find((line) => line.echo);
assert.ok(bounced, "przesłuch został skasowany, zamiast zostać oznaczony");
assert.equal(bounced.lane, "mic", "oznaczono nie ten tor");
ok("Przesłuch jest oznaczany, a nie kasowany — da się go odsłonić");

/* ── 6. Walidacja mówi, czego w szkicu nie było ──────────────────── */

const draft = [{ at: 0, speaker: "Ty", text: "Zaczynamy zajęcia od limitów kontekstu" }];
const verified = [
  { at: 0, speaker: "Ty", text: "Zaczynamy zajęcia od limitów kontekstu." },
  { at: 30, speaker: "Rozmówca 1", text: "A czy to dotyczy również modeli otwartych?" },
];
const report = compare(draft, verified);
assert.ok(report.agreement > 0 && report.agreement < 1, "zgodność wyszła skrajna");
assert.equal(report.drift.length, 1, "nie wskazano wypowiedzi, której w szkicu nie było");
assert.ok(report.drift[0].text.includes("modeli otwartych"), "wskazano nie tę wypowiedź");
ok("Walidacja pokazuje, co przepisywanie w biegu przegapiło");

// Zapis identyczny to zgodność pełna — inaczej liczba nic nie znaczy.
const same = compare(verified, verified);
assert.equal(same.agreement, 1, `identyczne zapisy dały zgodność ${same.agreement}`);
assert.equal(same.drift.length, 0, "identyczne zapisy dały rozjazd");
ok("Zapis zgodny ze szkicem daje zgodność pełną");

// Brak szkicu to nie jest rozjazd, tylko brak szkicu.
assert.strictEqual(compare([], verified).agreement, null, "pusty szkic policzony jako niezgodność");
ok("Brak szkicu jest odróżniony od niezgodności");

console.log(`\nZapis spotkania: ${passed} sprawdzeń przeszło.`);
