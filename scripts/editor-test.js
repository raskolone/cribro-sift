"use strict";
/**
 * Tłumaczenie notatki: Markdown ↔ sformatowany tekst.
 *   node scripts/editor-test.js
 *
 * Edytor pokazuje pogrubienie jako pogrubienie, a na dysku zostawia
 * Markdown. Jeśli te dwie strony się rozjadą, notatka traci formatowanie
 * przy zapisie albo dostaje gwiazdki w treści — dlatego obie drogi mają
 * własny komplet przypadków, a najważniejszy test jest na końcu: powtórne
 * przejście tam i z powrotem nie ma prawa niczego zmienić.
 *
 * htmlToMarkdown dotyka tylko nodeType, tagName, childNodes i getAttribute,
 * więc drzewo da się tutaj zbudować bez przeglądarki.
 */
const assert = require("assert");
const { markdownToHtml, htmlToMarkdown } = require("../src/shared/richtext");

/* ── Atrapa drzewa DOM ────────────────────────────────────────── */

const text = (value) => ({ nodeType: 3, nodeValue: value, childNodes: [] });
const el = (tag, attrs = {}, children = []) => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  childNodes: children,
  getAttribute: (name) => (name in attrs ? attrs[name] : null),
});
const root = (...children) => ({ nodeType: 1, tagName: "DIV", childNodes: children });

/* ── Markdown → HTML ──────────────────────────────────────────── */

const toHtml = [
  ["Akapit", "Zwykłe zdanie.", "<p>Zwykłe zdanie.</p>"],
  ["Nagłówek", "## Spotkanie", "<h2>Spotkanie</h2>"],
  ["Nagłówek pierwszego stopnia", "# Tytuł", "<h1>Tytuł</h1>"],
  ["Głębszy nagłówek zjeżdża do trzeciego stopnia", "##### Drobiazg", "<h3>Drobiazg</h3>"],
  ["Linia rozdzielająca", "---", "<hr />"],
  ["Gwiazdki też są linią", "***", "<hr />"],
  [
    "Nagłówek składany, zwinięty",
    "## \u25B8 Ustalenia",
    '<h2 data-toggle="closed">Ustalenia</h2>',
  ],
  [
    "Nagłówek składany, rozwinięty",
    "## \u25BE Ustalenia",
    '<h2 data-toggle="open">Ustalenia</h2>',
  ],
  [
    "Pogrubienie i kursywa",
    "Tekst z **wagą** i _przechyłem_.",
    "<p>Tekst z <strong>wagą</strong> i <em>przechyłem</em>.</p>",
  ],
  [
    "Gwiazdka w środku słowa nie jest kursywą",
    "30*40 i snake_case_nazwa",
    "<p>30*40 i snake_case_nazwa</p>",
  ],
  ["Znaki HTML w treści są bezpieczne", "a < b & c", "<p>a &lt; b &amp; c</p>"],
  [
    "Zrzut bez rozmiaru zostaje w pełnej szerokości",
    "![zrzut ekranu](file:///a/b.png)",
    '<p><img src="file:///a/b.png" alt="zrzut ekranu" /></p>',
  ],
  [
    "Zrzut zmniejszony niesie swój rozmiar",
    "![zrzut|60%](file:///a/b.png)",
    '<p><img src="file:///a/b.png" alt="zrzut" data-width="60" style="width:60%" /></p>',
  ],
  [
    "Rozmiar mniejszy od najmniejszego podciąga się do niego",
    "![zrzut|2%](f.png)",
    '<p><img src="f.png" alt="zrzut" data-width="10" style="width:10%" /></p>',
  ],
  [
    "Kreska w opisie bez liczby zostaje opisem",
    "![wykres|kwartał](f.png)",
    '<p><img src="f.png" alt="wykres|kwartał" /></p>',
  ],
  [
    "Podkreślenie w nazwie pliku nie robi kursywy",
    "![](file:///a/moj_zrzut_ekranu.png)",
    '<p><img src="file:///a/moj_zrzut_ekranu.png" alt="" /></p>',
  ],
  ["Lista", "- pierwszy\n- drugi", "<ul><li>pierwszy</li><li>drugi</li></ul>"],
  [
    "Lista zadań ze stanem",
    "- [ ] do zrobienia\n- [x] zrobione",
    '<ul class="task"><li data-done="false">do zrobienia</li><li data-done="true">zrobione</li></ul>',
  ],
  [
    "Wcięty punkt wchodzi w poprzedni",
    "- plan\n  - pierwszy krok",
    "<ul><li>plan<ul><li>pierwszy krok</li></ul></li></ul>",
  ],
  ["Cytat sklejony w jeden blok", "> Ania:\n> w czwartek", "<blockquote>Ania:<br />w czwartek</blockquote>"],
  ["Pusta notatka ma gdzie postawić kursor", "", "<p><br /></p>"],
];

for (const [name, markdown, expected] of toHtml) {
  assert.strictEqual(markdownToHtml(markdown), expected, `${name}\n  jest:    ${markdownToHtml(markdown)}\n  powinno: ${expected}`);
  console.log("✓", name);
}

/* ── HTML → Markdown ──────────────────────────────────────────── */

const toMarkdown = [
  [
    "Pogrubienie i kursywa wracają znacznikami",
    root(el("p", {}, [text("Ala ma "), el("b", {}, [el("i", {}, [text("kota")])])])),
    "Ala ma **_kota_**",
  ],
  [
    "Znacznik obejmuje słowo, nie spację obok niego",
    root(el("p", {}, [text("koniec "), el("strong", {}, [text("zdania ")])])),
    "koniec **zdania**",
  ],
  [
    "Zmieniony rozmiar wraca do pliku",
    root(el("p", {}, [el("img", { src: "f.png", alt: "zrzut", "data-width": "45" })])),
    "![zrzut|45%](f.png)",
  ],
  [
    "Pełna szerokość nie zapisuje się wcale",
    root(el("p", {}, [el("img", { src: "f.png", alt: "zrzut", "data-width": "100" })])),
    "![zrzut](f.png)",
  ],
  [
    "Obrazek bez adresu nie zostawia po sobie nawiasów",
    root(el("p", {}, [el("img", { alt: "nic" })])),
    "",
  ],
  [
    "Opis obrazka wraca taki, jaki wpisano",
    root(el("p", {}, [el("img", { src: "f.png", alt: "tablica po zajęciach", "data-width": "70" })])),
    "![tablica po zajęciach|70%](f.png)",
  ],
  [
    "Puste pogrubienie nie zostawia gwiazdek",
    root(el("p", {}, [el("strong", {}, [text("   ")])])),
    "",
  ],
  [
    "Lista zadań zapisuje stan",
    root(
      el("ul", { class: "task" }, [
        el("li", { "data-done": "true" }, [text("zadzwonić")]),
        el("li", { "data-done": "false" }, [text("wysłać")]),
      ]),
    ),
    "- [x] zadzwonić\n- [ ] wysłać",
  ],
  [
    "Lista zagnieżdżona dostaje wcięcie",
    root(el("ul", {}, [el("li", {}, [text("plan"), el("ul", {}, [el("li", {}, [text("krok")])])])])),
    "- plan\n  - krok",
  ],
  [
    "Linia rozdzielająca wraca kreską",
    root(el("p", {}, [text("przed")]), el("hr"), el("p", {}, [text("po")])),
    "przed\n\n---\n\npo",
  ],
  [
    "Nagłówek składany zapisuje swój stan",
    root(el("h2", { "data-toggle": "closed" }, [text("Ustalenia")])),
    "## \u25B8 Ustalenia",
  ],
  [
    "Pierwszy stopień to jedna krata",
    root(el("h1", {}, [text("Tytuł")])),
    "# Tytuł",
  ],
  [
    "Twarde łamanie w akapicie zostaje łamaniem",
    root(el("p", {}, [text("pierwsza"), el("br"), text("druga")])),
    "pierwsza\ndruga",
  ],
  [
    "Pusty akapit nie mnoży pustych linii",
    root(el("p", {}, [text("raport")]), el("p", {}, [el("br")]), el("p", {}, [text("klient")])),
    "raport\n\nklient",
  ],
];

for (const [name, tree, expected] of toMarkdown) {
  const actual = htmlToMarkdown(tree);
  assert.strictEqual(actual, expected, `${name}\n  jest:      ${JSON.stringify(actual)}\n  powinno:   ${JSON.stringify(expected)}`);
  console.log("✓", name);
}

/* ── Obie drogi naraz ─────────────────────────────────────────── */

/* Notatka wraca do edytora i z powrotem na dysk po każdym naciśnięciu
   klawisza. Gdyby każde przejście coś dokładało, notatka rosłaby sama. */
const parse = (html) => {
  // Prościutki parser wystarczy: HTML pochodzi z markdownToHtml, więc jest
  // zamknięty, bez atrybutów poza class/data-done i bez treści w znacznikach.
  const stack = [{ childNodes: [], nodeType: 1, tagName: "DIV" }];
  const token = /<(\/?)([a-z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*(\/?)>|([^<]+)/gi;

  for (const match of html.matchAll(token)) {
    const [, closing, tag, rawAttrs, selfClosing, plain] = match;
    if (plain !== undefined) {
      stack.at(-1).childNodes.push(text(plain));
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries(
      [...rawAttrs.matchAll(/([a-z-]+)="([^"]*)"/gi)].map(([, name, value]) => [name, value]),
    );
    const node = el(tag, attrs, []);
    stack.at(-1).childNodes.push(node);
    if (!selfClosing && tag !== "br") stack.push(node);
  }
  return stack[0];
};

const NOTE = [
  "# Spotkanie z Anią",
  "",
  "---",
  "",
  "## \u25BE Ustalenia",
  "",
  "### Szczegóły",
  "",
  "Raport ma być gotowy do **czwartku**, nie do _piątku_.",
  "",
  "- [x] zadzwonić do Ani",
  "- [ ] wysłać raport",
  "",
  "- plan",
  "  - pierwszy krok",
  "",
  "> Ania:",
  "> zróbmy to w czwartek",
  "",
  "![tablica po zajęciach|55%](file:///Users/x/Application%20Support/zrzut.png)",
  "",
  "![zrzut bez rozmiaru](file:///Users/x/inny.png)",
].join("\n");

const once = htmlToMarkdown(parse(markdownToHtml(NOTE)));
const twice = htmlToMarkdown(parse(markdownToHtml(once)));

assert.strictEqual(once, NOTE, `pierwsze przejście zmieniło notatkę:\n${once}`);
assert.strictEqual(twice, once, `kolejne przejście zmieniło notatkę:\n${twice}`);
console.log("✓ Notatka przechodzi tam i z powrotem bez zmian");

console.log("\nEdytor notatki tłumaczy formatowanie poprawnie.");
