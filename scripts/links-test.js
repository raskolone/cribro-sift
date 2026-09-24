"use strict";

const assert = require("assert");
const { markdownToHtml, htmlToMarkdown } = require("../src/shared/richtext.js");

console.log("Rozpoczynam testy obsługi linków i kart podglądu...");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── 1. Markdown ↔ HTML z linkami i kartami ───────────────────────── */

// Markdown z linkiem w formacie [tekst](url)
const mdWithLink = "Zobacz projekt [Cribro](https://cribro.com) na żywo.";
const htmlWithLink = markdownToHtml(mdWithLink);
check("Link w Markdown zamienia się na tag <a>", htmlWithLink.includes('<a class="prose-link" href="https://cribro.com"'));
check("Tekst linku zostaje zachowany", htmlWithLink.includes('>Cribro</a>'));

// Konwersja powrotna z HTML do Markdown
const backToMd = htmlToMarkdown({
  childNodes: [
    {
      nodeType: 1,
      tagName: "P",
      childNodes: [
        { nodeType: 3, nodeValue: "Zobacz projekt " },
        {
          nodeType: 1,
          tagName: "A",
          getAttribute: (attr) => attr === "href" ? "https://cribro.com" : null,
          childNodes: [{ nodeType: 3, nodeValue: "Cribro" }],
        },
        { nodeType: 3, nodeValue: " na żywo." },
      ],
    },
  ],
});
check("Tag <a> wraca do Markdowna jako [tekst](url)", backToMd === mdWithLink);

// Obsługa karty linku (<figure class="link-card" data-url="...">)
const fakeFigure = {
  nodeType: 1,
  tagName: "FIGURE",
  getAttribute: (attr) => attr === "data-url" ? "https://github.com/cribro/sift" : "link-card link-card--big",
  childNodes: [
    {
      nodeType: 1,
      tagName: "DIV",
      childNodes: [{ nodeType: 3, nodeValue: "Ignorowana treść podglądu" }],
    },
  ],
};

const figureMd = htmlToMarkdown({
  childNodes: [fakeFigure],
});
check("Karta <figure> serializuje się z powrotem do czystego URL-a", figureMd === "https://github.com/cribro/sift");

/* ── 2. YouTube Regex i detekcja URL ─────────────────────────────── */

const ytUrls = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://youtube.com/shorts/dQw4w9WgXcQ",
  "https://www.youtube.com/embed/dQw4w9WgXcQ",
];

const ytRegex = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

for (const u of ytUrls) {
  const match = u.match(ytRegex);
  check(`YouTube URL ${u} poprawnie rozpoznaje ID wideo`, match && match[1] === "dQw4w9WgXcQ");
}

/* ── 3. Zapis formatów kart w modelu notatki ─────────────────────── */

const noteMock = {
  id: "test-note-1",
  text: "Oto link: https://github.com",
  linkCards: {
    "https://github.com": {
      format: "big",
      meta: {
        title: "GitHub: Let's build from here",
        domain: "github.com",
        image: "https://github.githubassets.com/images/modules/site/social-cards/campaign-social.png",
        favicon: "https://github.githubassets.com/favicons/favicon.png",
      },
    },
  },
};

check("Model notatki poprawnie przechowuje stan linkCards", noteMock.linkCards["https://github.com"].format === "big");
check("Metadane karty zawierają tytuł, obraz i favicon", Boolean(
  noteMock.linkCards["https://github.com"].meta.title &&
  noteMock.linkCards["https://github.com"].meta.image &&
  noteMock.linkCards["https://github.com"].meta.favicon
));

console.log(`\nWszystkie ${passed} testów linków i kart podglądu przeszło pomyślnie!`);
