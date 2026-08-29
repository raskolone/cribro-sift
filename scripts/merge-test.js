"use strict";
/**
 * Splot dwóch torów w zapis rozmowy.
 *   node scripts/merge-test.js
 *
 * Najważniejszy jest tu PRZESŁUCH i nie jest to test zapobiegawczy. Sonda
 * E0 zmierzyła, że przy głośnikach cudza mowa wchodzi także torem mikrofonu
 * na −27,6 dBFS — raptem 10 dB poniżej toru systemu. Bez tego kroku każde
 * zdanie drugiej strony pada w zapisie dwa razy: raz jako ich, raz jako
 * twoje. Rozmowa bez słuchawek daje wtedy transkrypcję nie do czytania.
 *
 * Druga połowa przypadków to takie, w których splot ma czegoś NIE zrobić:
 * dwie osoby mówiące o tym samym nie są echem, a odpowiedź „tak" nie jest
 * powtórzeniem cudzego „tak".
 */
const assert = require("assert");
const { splice, trimRepeat, echoRatio, repeatLength, speakerFor } = require("../src/main/merge");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

const piece = (lane, from, to, text) => ({ lane, from, to, text });

/* ── Zakładka ───────────────────────────────────────────────── */

check(
  "Powtórzony ogon jest rozpoznany co do słowa",
  repeatLength("i wtedy zadzwoniła Ania", "zadzwoniła Ania z pytaniem", 10) === 2,
);
check("Brak powtórzenia to zero", repeatLength("zupełnie co innego", "a tu nowy temat", 10) === 0);

check(
  "Powtórzony początek znika z następnego odcinka",
  trimRepeat("i wtedy zadzwoniła Ania", "zadzwoniła Ania z pytaniem o raport") ===
    "z pytaniem o raport",
);
check(
  "Interpunkcja nie przeszkadza w rozpoznaniu, ale zostaje w zapisie",
  trimRepeat("no i co dalej?", "Co dalej — nie wiem.") === "— nie wiem.",
);
check(
  "Bez powtórzenia tekst zostaje nietknięty",
  trimRepeat("pierwsze zdanie", "drugie zdanie") === "drugie zdanie",
);

/* ── Przesłuch ──────────────────────────────────────────────── */

check(
  "To samo zdanie w obu torach to echo",
  echoRatio("czy dasz radę do piątku", "no więc czy dasz radę do piątku bo klient czeka") >= 0.9,
);
check(
  "Rozmowa o tym samym echem nie jest — kolejność słów się nie powtarza",
  echoRatio("piątek mi nie pasuje, wolę wtorek", "czy dasz radę do piątku") < 0.6,
);
check("Pusty tekst nie jest echem niczego", echoRatio("", "cokolwiek") === 0);

let out = splice([
  piece("system", 0, 10, "Czy dasz radę przygotować to do piątku?"),
  // to samo, złapane mikrofonem z głośników — przy rozmowie bez słuchawek
  piece("mic", 0.4, 10.2, "czy dasz radę przygotować to do piątku"),
  piece("mic", 11, 16, "Dam radę, ale potrzebuję danych z wtorku."),
]);
check("Przesłuch wypada z zapisu", out.length === 2);
check("…i wypada z toru MIKROFONU, nie systemu", out[0].lane === "system");
check("Prawdziwa odpowiedź zostaje", out[1].text.startsWith("Dam radę"));

/* Przypadek, dla którego echo liczy się ZDANIAMI, a nie całym odcinkiem.
   Odcinek trwa dwie minuty i mieści w sobie jedno i drugie: twoją
   wypowiedź i przesłuch z głośników. Liczone na całości echo rozcieńcza
   się do zera i nie przekracza żadnego progu — a wtedy cudze zdanie
   zostaje w zapisie jako twoje. */
out = splice([
  piece("system", 0, 120, "Musimy zdążyć z tym raportem przed poniedziałkiem rano."),
  piece(
    "mic",
    0,
    120,
    "Musimy zdążyć z tym raportem przed poniedziałkiem rano. Dobrze, w takim razie wezmę to na siebie i odezwę się w czwartek.",
  ),
]);
check("Z odcinka mieszanego wypada samo echo", out.length === 2);
check(
  "…a twoja wypowiedź z tego samego odcinka zostaje w całości",
  out[1].lane === "mic" && out[1].text.startsWith("Dobrze, w takim razie"),
);
check("…i nie zostaje w niej ani śladu cudzego zdania", !out[1].text.includes("raportem"));

out = splice([
  piece("system", 0, 5, "Tak."),
  piece("mic", 6, 10, "Tak."),
]);
check(
  "Krótka odpowiedź po czasie nie jest echem — zgodziły się dwie osoby",
  out.length === 2,
);

/* ── Sklejanie w wypowiedzi ─────────────────────────────────── */

out = splice([
  piece("mic", 0, 120, "Zacznę od tego, że plan na kwartał"),
  piece("mic", 118, 240, "wygląda dobrze, ale brakuje w nim budżetu."),
]);
check("Ten sam tor bez przerwy to jedna wypowiedź", out.length === 1);
check(
  "…sklejona w kolejności i bez zlepienia słów",
  out[0].text === "Zacznę od tego, że plan na kwartał wygląda dobrze, ale brakuje w nim budżetu.",
);
check("Wypowiedź zaczyna się tam, gdzie zaczął mówić", out[0].at === 0);

out = splice([
  piece("mic", 0, 10, "Pierwsza myśl."),
  piece("mic", 60, 70, "Druga myśl, po długiej ciszy."),
]);
check("Długa przerwa zaczyna nową wypowiedź", out.length === 2);

out = splice([
  piece("mic", 0, 10, "Ja mówię."),
  piece("system", 10, 20, "Oni mówią."),
  piece("mic", 20, 30, "Znowu ja."),
]);
check("Zmiana toru zawsze zaczyna nową wypowiedź", out.length === 3);
check(
  "Kolejność jest chronologiczna",
  out.map((line) => line.at).join(",") === "0,10,20",
);
check("Mikrofon podpisany jest jako ty", out[0].speaker === "Ty");
check("Tor systemu jako rozmówcy", out[1].speaker === "Rozmówcy");

/* ── Odporność ──────────────────────────────────────────────── */

check("Brak odcinków to pusty zapis", splice([]).length === 0);
check("Puste teksty nie tworzą pustych wypowiedzi", splice([piece("mic", 0, 5, "   ")]).length === 0);
check(
  "Odcinki przychodzące nie po kolei są układane",
  splice([piece("mic", 30, 40, "trzecie"), piece("system", 0, 10, "pierwsze")])[0].text ===
    "pierwsze",
);

/* ── Kto jest po drugiej stronie ─────────────────────────────
   Kalendarz zna nazwiska, ale zapis rozmowy nie wie, które słowa należą
   do kogo. Podpisać drugi tor da się więc tylko wtedy, gdy jest tam
   dokładnie jedna osoba — inaczej byłoby to przypisanie cudzych słów
   konkretnemu człowiekowi, czyli gorsze niż „Rozmówcy", bo wygląda
   na wiedzę. */

check(
  "W rozmowie we dwoje druga strona dostaje imię",
  speakerFor(["Maciej Wyrozumski", "Ania Kowalska"], "Maciej Wyrozumski") === "Ania Kowalska",
);
check(
  "Skrócone imię w kalendarzu też się rozpoznaje",
  speakerFor(["Maciej", "Ania Kowalska"], "Maciej Wyrozumski") === "Ania Kowalska",
);
check(
  "Ogonki nie przeszkadzają",
  speakerFor(["Łukasz Żak", "Ania"], "Lukasz Zak") === "Ania",
);
check(
  "Przy trzech osobach zostaje domyślny podpis",
  speakerFor(["Maciej", "Ania", "Bartek"], "Maciej") === "Rozmówcy",
);
check("Bez listy też", speakerFor([], "Maciej") === "Rozmówcy");
check(
  "Gdy nie wiadomo, kim jesteś — również",
  speakerFor(["Ania", "Bartek"], "") === "Rozmówcy",
);

out = splice([piece("system", 0, 5, "Dzień dobry.")], { speakers: { system: "Ania Kowalska" } });
check("Podany podpis trafia do zapisu", out[0].speaker === "Ania Kowalska");
check(
  "…a tor mikrofonu zostaje tobą",
  splice([piece("mic", 0, 5, "Cześć.")], { speakers: { system: "Ania" } })[0].speaker === "Ty",
);

console.log(`\n${passed} sprawdzeń przeszło.`);
