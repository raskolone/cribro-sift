"use strict";
/**
 * Notatka → bloki Notion. Bez sieci i bez tokenu.
 *   node scripts/notion-test.js
 *
 * ══ O CO TU CHODZI ══
 *
 * Notion jest CUDZYM formatem i to jest cała trudność. Markdown, w którym
 * Cribro trzyma notatki, ma rzeczy, których Notion nie zna, i odwrotnie —
 * a wszystko, czego składanie bloków nie rozpozna, nie znika po cichu:
 * ląduje w cudzej stronie jako surowy zapis. Tekst, którego nikt nie umiał
 * przetłumaczyć, wygląda tam dokładnie jak błąd, i słusznie.
 *
 * Najdroższą lekcją był zrzut ekranu. Linia `![zrzut](file:///…)` nie
 * pasowała do żadnej reguły, więc wpadała do worka „akapit" i szła
 * do Notion w całości, razem z zakodowanymi spacjami w ścieżce. Notatka
 * z jednym zrzutem miała w środku sto znaków ścieżki z czyjegoś dysku.
 *
 * Ten test pilnuje trzech rzeczy naraz:
 *   1. że kształty, które Notion zna, dojeżdżają jako te kształty,
 *   2. że obrazek nie zostawia po sobie ścieżki do czytania,
 *   3. że limity Notion (2000 znaków na kawałek) są przestrzegane —
 *      przekroczony odbija CAŁE żądanie, więc razem z nim przepada
 *      też reszta notatki, która była w porządku.
 */
const assert = require("assert");
const { toBlocks, richText, pageId } = require("../src/main/notion");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/** Cały tekst bloku, sklejony — bez wchodzenia w kształt `rich_text`. */
const textOf = (block) =>
  (block[block.type]?.rich_text ?? []).map((part) => part.text.content).join("");

/* ── Kształty, które Notion zna ────────────────────────────────── */

const blocks = toBlocks(
  [
    "# Tytuł",
    "",
    "Zwykły akapit.",
    "",
    "- punkt pierwszy",
    "- punkt drugi",
    "",
    "- [x] zrobione",
    "- [ ] jeszcze nie",
    "",
    "1. raz",
    "2. dwa",
    "",
    "> cytat",
    "",
    "---",
    "",
    "## ▸ Składany nagłówek",
  ].join("\n"),
);

const kinds = blocks.map((block) => block.type);

check("Nagłówek zostaje nagłówkiem", kinds[0] === "heading_1");
check("Akapit zostaje akapitem", kinds[1] === "paragraph");
check("Punkty listy zostają punktami", kinds[2] === "bulleted_list_item");
check(
  "Zadanie z polem do odhaczenia zostaje zadaniem, ze swoim stanem",
  blocks.find((b) => b.type === "to_do")?.to_do.checked === true,
);
check(
  "…a nieodhaczone zostaje nieodhaczone",
  blocks.filter((b) => b.type === "to_do")[1]?.to_do.checked === false,
);
check("Lista numerowana nie robi się listą punktowaną", kinds.includes("numbered_list_item"));
check("Cytat zostaje cytatem", kinds.includes("quote"));
check("Kreska rozdzielająca zostaje kreską", kinds.includes("divider"));

/* Nagłówek składany to jedno z niewielu miejsc, gdzie oba programy mają
   dokładnie to samo pojęcie — i szkoda byłoby je zgubić po drodze. */
const toggle = blocks.find((b) => b.type?.startsWith("heading") && b[b.type].is_toggleable);
check("Nagłówek składany jedzie jako składany, a nie jako zwykły", !!toggle);
check("…i bez znaczka ▸ w treści, bo Notion rysuje własny", textOf(toggle) === "Składany nagłówek");

/* ── Zrzut ekranu ──────────────────────────────────────────────── */

const zDysku = toBlocks("![zrzut ekranu](file:///Users/kto%C5%9B/Cribro%20Sift/zrzut.png)");
check("Obrazek z dysku nie zostawia ścieżki do czytania", !/file:\/\//.test(textOf(zDysku[0])));
check("…ani surowego Markdownu", !/!\[/.test(textOf(zDysku[0])));
check(
  "…tylko jedno zdanie o tym, że był i gdzie został",
  /został na komputerze/.test(textOf(zDysku[0])),
);
check("…napisane kursywą, bo to nie jest zdanie autora", zDysku[0].paragraph.rich_text[0].annotations?.italic === true);

const zSieci = toBlocks("![wykres](https://example.com/wykres.png)");
check("Obrazek spod adresu jedzie jako prawdziwy obrazek", zSieci[0].type === "image");
check(
  "…z tym samym adresem, pod którym leży",
  zSieci[0].image.external.url === "https://example.com/wykres.png",
);

/* Obrazek w ŚRODKU zdania zostaje tekstem i to jest wybór, nie przeoczenie:
   Cribro wstawia zrzuty zawsze w osobnej linii (patrz compose w main/shot.js),
   a wyjmowanie obrazka ze środka akapitu rozbijałoby zdanie na trzy bloki. */
const wSrodku = toBlocks("Tekst z ![obrazkiem](file:///x.png) w środku.");
check("Obrazek w środku zdania nie rozbija akapitu na trzy", wSrodku.length === 1);

/* ── Znaczniki wewnątrz linii ──────────────────────────────────── */

const bold = richText("zwykły **gruby** dalej");
check("Pogrubienie jedzie jako cecha kawałka, nie jako gwiazdki", bold[1].annotations?.bold === true);
check("…a gwiazdki znikają z treści", bold.map((p) => p.text.content).join("") === "zwykły gruby dalej");

const code = richText("polecenie `npm test` w zdaniu");
check("Kod jedzie jako kod", code[1].annotations?.code === true);

/* ── Limit Notion ──────────────────────────────────────────────── */

const dlugi = richText("x".repeat(4500));
check("Kawałek dłuższy niż 2000 znaków dzieli się, zamiast odbić żądanie", dlugi.length === 3);
check("…i nic po drodze nie ginie", dlugi.map((p) => p.text.content).join("").length === 4500);
check("…a żaden kawałek nie przekracza limitu", dlugi.every((p) => p.text.content.length <= 2000));

check("Pusta linia nie robi pustego bloku", toBlocks("\n\n\n").length === 0);
check(
  "Pusty tekst daje kawałek, a nie pustą listę — Notion nie przyjmuje pustych",
  richText("").length === 1,
);

/* ── Adres strony ──────────────────────────────────────────────── */

check(
  "Identyfikator wyjmuje się z wklejonego adresu",
  pageId("https://notion.so/Plan-2f1a3b4c5d6e7f8091a2b3c4d5e6f708") ===
    "2f1a3b4c-5d6e-7f80-91a2-b3c4d5e6f708",
);
check(
  "Sam identyfikator też przechodzi",
  pageId("2f1a3b4c5d6e7f8091a2b3c4d5e6f708") === "2f1a3b4c-5d6e-7f80-91a2-b3c4d5e6f708",
);

console.log(`\nNotion: ${passed} sprawdzeń przeszło. Cudzy format dostaje swoje kształty.`);
