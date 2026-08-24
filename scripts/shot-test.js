"use strict";
/**
 * Tekst z ekranu: co ląduje w notatce, co jedzie do modelu i co wraca.
 *   node scripts/shot-test.js
 *
 * Trzy rzeczy trzeba tu pilnować, bo każda psuje się cicho:
 *
 *   1. ADRES OBRAZKA. Notatka trzyma zrzut jako link Markdowna, a katalog
 *      „Application Support\" ma spację w nazwie. Nawiasy Markdowna kończy
 *      pierwsza spacja — bez zakodowania obrazek urywa się w połowie
 *      ścieżki i notatka pokazuje pustą ramkę zamiast zrzutu.
 *
 *   2. KONTRAKT ODCZYTU. Na zrzucie prawie zawsze widać czyjeś pytanie
 *      albo formularz, więc model ma ciągłą pokusę, żeby odpowiedzieć
 *      zamiast przepisać. Zakaz musi być w prompcie i musi tam zostać.
 *
 *   3. BRAK KLUCZA. To nie jest awaria: zrzut nadal da się wstawić jako
 *      obrazek. Wyjątek w tym miejscu zabierałby połowę funkcji.
 *
 * Nic tu nie dotyka sieci, Electrona ani ekranu — zaznaczanie dostaje
 * podstawione narzędzie, a model podstawiony `fetch`.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const {
  compose,
  imageLink,
  fileUrl,
  clean,
  stampName,
  buildRequest,
  readText,
  grabRegion,
  READ_PROMPT,
  MOCK_TEXT,
} = require("../src/main/shot");
const { keyFor } = require("../src/main/providers");
const { markdownToHtml, htmlToMarkdown } = require("../src/shared/richtext");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

const SHOT = "/Users/ktoś/Library/Application Support/Cribro Sift/zrzuty/zrzut-2026-08-24-161500-ab12.png";

/* ── Co ląduje w notatce ────────────────────────────────────── */

check(
  "Forma „tekst\" wstawia sam odczyt, bez śladu po obrazku",
  compose({ form: "text", text: "Plan na jutro", image: SHOT }) === "Plan na jutro",
);

check(
  "Forma „obrazek\" wstawia sam link do pliku",
  compose({ form: "image", text: "Plan na jutro", image: SHOT }) === imageLink(SHOT),
);

check(
  "Forma „oba\" stawia obrazek nad tekstem, oddzielony pustą linią",
  compose({ form: "both", text: "Plan na jutro", image: SHOT }) ===
    `${imageLink(SHOT)}\n\nPlan na jutro`,
);

check(
  "„Oba\" bez odczytu nie zostawia pustej linii na końcu",
  compose({ form: "both", text: "   ", image: SHOT }) === imageLink(SHOT),
);

check(
  "Bez obrazka i bez tekstu nie ma czego zapisać",
  compose({ form: "both", text: "", image: null }) === "",
);

/* Spacja w nazwie katalogu to nie jest przypadek brzegowy — tak nazywa
   się katalog, w którym leżą wszystkie dane aplikacji na macOS. */
check(
  "Spacja w ścieżce jest zakodowana, więc link się nie urywa",
  fileUrl(SHOT).includes("Application%20Support") && !fileUrl(SHOT).includes(" "),
);

check(
  "Link zaczyna się od file:// i kończy nazwą pliku",
  imageLink(SHOT).startsWith("![zrzut ekranu](file:///Users/") && imageLink(SHOT).endsWith(".png)"),
);

check(
  "Nazwa pliku niesie datę i nie powtarza się przy dwóch zrzutach z tej samej sekundy",
  /^zrzut-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{4}\.png$/.test(stampName(new Date("2026-08-24T16:15:00"))) &&
    stampName() !== stampName(),
);

/* ── Uprzejmość modelu, o którą nikt nie prosił ─────────────── */

check(
  "Blok kodu wokół odczytu jest zdejmowany",
  clean("```\nPlan na jutro\n```") === "Plan na jutro",
);

check(
  "Wstęp „Oto tekst z obrazka:\" znika razem z linią",
  clean("Oto tekst z obrazka:\nPlan na jutro") === "Plan na jutro",
);

check(
  "Zdanie, które tylko zaczyna się podobnie, zostaje nietknięte",
  clean("To jest ważne: nie zapomnij o raporcie") === "To jest ważne: nie zapomnij o raporcie",
);

check("Pusty odczyt zostaje pusty", clean("   \n  ") === "");

/* ── Co jedzie do modelu ────────────────────────────────────── */

const request = buildRequest(Buffer.from("PNG-udawany"), "gpt-5.6-luna");

check("Model idzie z ustawień, a nie z kodu wywołania", request.model === "gpt-5.6-luna");

check(
  "Obrazek jedzie jako data: z typem PNG",
  request.messages[1].content[0].image_url.url.startsWith("data:image/png;base64,"),
);

check(
  "Odczyt idzie w rozdzielczości „high\" — drobny druk inaczej wychodzi zgadywanką",
  request.messages[1].content[0].image_url.detail === "high",
);

check(
  "Kontrakt zakazuje odpowiadania na to, co widać na obrazku",
  /NIE ODPOWIADASZ/.test(READ_PROMPT) && READ_PROMPT === request.messages[0].content,
);

check(
  "Kontrakt zakazuje poprawiania cudzych literówek i tłumaczenia",
  /NIE POPRAWIASZ/.test(READ_PROMPT) && /NIE TŁUMACZYSZ/.test(READ_PROMPT),
);

/* ── Odczyt: atrapa, brak klucza, odpowiedź i błąd ──────────── */

const settings = (patch = {}) => ({
  stt: { provider: "gemini", apiKey: "" },
  sieve: { provider: "gemini", apiKey: "" },
  shot: { provider: "openai", model: "gpt-5.6-luna", apiKey: "", ...patch },
});

(async () => {
  const mock = await readText(Buffer.from("x"), settings({ provider: "mock", model: "mock" }));
  check("Atrapa oddaje przykładowy odczyt i nie tyka sieci", mock.text === MOCK_TEXT);

  const noKey = await readText(Buffer.from("x"), settings());
  check(
    "Brak klucza nie jest awarią — wraca `missingKey`, żeby został sam obrazek",
    noKey.missingKey === true && noKey.text === "",
  );

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Plan na jutro" }, finish_reason: "stop" }] }),
    };
  };

  const read = await readText(Buffer.from("x"), settings({ apiKey: "sk-test" }));
  check("Odczyt wraca oczyszczony z odpowiedzi modelu", read.text === "Plan na jutro");
  check("Klucz jedzie nagłówkiem Authorization", calls[0].auth === "Bearer sk-test");
  check("Żądanie idzie do OpenAI", calls[0].url === "https://api.openai.com/v1/chat/completions");

  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: "Incorrect API key" } }),
  });
  const rejected = await readText(Buffer.from("x"), settings({ apiKey: "sk-złe" })).catch(
    (error) => error.message,
  );
  check(
    "Odrzucony klucz mówi, co się stało, zamiast rzucać numerem",
    /klucz API odrzucony \(401\)/.test(rejected),
  );

  /* ── Zaznaczanie ekranu ──────────────────────────────────────
     Narzędzie systemowe podstawiamy: nie ma tu ekranu, a Escape
     w prawdziwym zaznaczaniu wygląda dokładnie tak samo jak brak pliku. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-shot-test-"));

  const cancelled = await grabRegion({ dir, run: (_cmd, _args, done) => done(null) });
  check("Escape w trakcie zaznaczania nie tworzy pliku i daje `null`", cancelled === null);

  const grabbed = await grabRegion({
    dir,
    run: (cmd, args, done) => {
      check("Zaznaczanie woła systemowe `screencapture` w trybie interaktywnym", cmd === "screencapture" && args.includes("-i"));
      check("Migawka jest wyciszona, a cień okna nie wchodzi do zrzutu", args.includes("-x") && args.includes("-o"));
      fs.writeFileSync(args[args.length - 1], Buffer.from("PNG-udawany"));
      done(null);
    },
  });
  check("Zaznaczony obszar wraca jako bufor", grabbed?.buffer?.toString() === "PNG-udawany");
  check(
    "Zrzut nie zostaje w katalogu tymczasowym — na dysk trafia dopiero wybrany obrazek",
    fs.readdirSync(dir).length === 0,
  );
  fs.rmSync(dir, { recursive: true, force: true });

  /* ── Jeden klucz na trzy kroki ───────────────────────────────
     Transkrypcja, sito i odczyt mogą chodzić na tym samym dostawcy —
     wtedy klucz wpisuje się raz, w dowolnym z nich. */
  check(
    "Klucz wpisany przy sicie obsługuje też odczyt z ekranu",
    keyFor("openai", {
      stt: { provider: "gemini", apiKey: "" },
      sieve: { provider: "openai", apiKey: "sk-z-sita" },
      shot: { provider: "openai", apiKey: "" },
    }) === "sk-z-sita",
  );

  /* ── Obrazek w notatce ───────────────────────────────────────
     Notatka na dysku jest Markdownem, na ekranie sformatowanym tekstem.
     Zrzut musi przetrwać obie drogi — inaczej pierwsze otwarcie notatki
     w edytorze kasowałoby obrazek przy zapisie. */
  const note = `${imageLink(SHOT)}\n\nPlan na jutro`;
  const html = markdownToHtml(note);

  check(
    "Obrazek zamienia się w <img> z adresem pliku",
    html.includes(`<img src="${fileUrl(SHOT)}" alt="zrzut ekranu" />`),
  );

  check(
    "Podkreślenia i gwiazdki w adresie nie robią się kursywą",
    markdownToHtml("![x](file:///a/snake_case_nazwa_pliku.png)").includes("snake_case_nazwa_pliku.png"),
  );

  /* Atrapa drzewa DOM — ta sama sztuczka co w scripts/editor-test.js:
     htmlToMarkdown dotyka tylko nodeType, tagName, childNodes i getAttribute. */
  const text = (value) => ({ nodeType: 3, nodeValue: value, childNodes: [] });
  const el = (tag, attrs = {}, children = []) => ({
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  });
  const root = (...children) => ({ nodeType: 1, tagName: "DIV", childNodes: children });

  const back = htmlToMarkdown(
    root(
      el("p", {}, [el("img", { src: fileUrl(SHOT), alt: "zrzut ekranu" })]),
      el("p", {}, [text("Plan na jutro")]),
    ),
  );
  check("Powrót z edytora oddaje ten sam Markdown, co wszedł", back === note);

  /* Notatka z tekstu z ekranu zaczyna się od zrzutu. Gdyby obrazek liczył
     się jako tytuł, na liście notatek stałby adres pliku. */
  const sandbox = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    t: (value) => value,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../src/renderer/js/notes-core.js"), "utf8"),
    sandbox,
  );
  const { titleOf } = sandbox.window.NotesCore;

  check(
    "Tytułem notatki zostaje odczyt, a nie adres obrazka",
    titleOf({ text: note }) === "Plan na jutro",
  );
  check(
    "Notatka z samym obrazkiem nie dostaje tytułu z nazwy pliku",
    titleOf({ text: imageLink(SHOT) }) === "Bez tytułu",
  );

  console.log(`\nTekst z ekranu: ${passed} sprawdzeń przeszło. Odczyt czyta, a nie odpowiada.`);
})();
