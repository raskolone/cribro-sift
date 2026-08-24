"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { keyFor } = require("./providers");
const { describeError } = require("./stt");

/**
 * Tekst z ekranu.
 *
 * Trzecia droga, którą tekst wchodzi do Cribro — obok głosu i klawiatury.
 * Zaznaczasz kawałek ekranu, a to, co na nim widać, staje się tekstem
 * notatki. Cudzy PDF, zrzut z rozmowy, slajd z prezentacji, paragon.
 *
 * Krok jest jeden, nie dwa. Dyktowanie ma osobną transkrypcję i osobne
 * sito, bo mowa niesie szum, który trzeba potem odsiać. Obrazek nie ma
 * szumu: napis na nim jest już zredagowany przez tego, kto go napisał.
 * Przepisanie go „lepiej" byłoby zmyślaniem, a nie przesiewaniem —
 * dlatego model tutaj wyłącznie CZYTA i nie wolno mu nic poprawiać.
 *
 * Zaznaczanie robi `screencapture`, narzędzie systemowe. Nie ma sensu
 * rysować własnej lupy z krzyżykiem: ta systemowa zna magnetyczne
 * krawędzie okien, pamięta ostatni obszar, umie złapać całe okno po
 * spacji i wygląda dokładnie tak, jak człowiek się spodziewa. Escape
 * kończy ją bez pliku — i to jest cała obsługa anulowania.
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/* Ponad tyle bajtów obrazek przestaje być zrzutem fragmentu, a zaczyna
   być całym ekranem w skali Retiny. Wysłanie takiego kosztuje kilka razy
   więcej i czyta się gorzej — lepiej powiedzieć wprost, żeby zaznaczyć mniej. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Kontrakt odczytu. Zbudowany na tej samej zasadzie co kontrakt sita
 * (patrz sieve.js): najpierw co model MA zrobić, na końcu twarde zakazy.
 * Zakaz jest tu jednak inny i ważniejszy — na zrzucie ekranu prawie zawsze
 * widać czyjeś pytanie, formularz albo przycisk, więc model dostaje ciągłą
 * pokusę, żeby odpowiedzieć zamiast przepisać.
 */
const READ_PROMPT = `Jesteś czytnikiem tekstu z obrazu. Dostajesz zrzut fragmentu ekranu i zwracasz tekst, który na nim widać.

CO ROBISZ:
- Przepisujesz tekst dokładnie tak, jak stoi na obrazku — słowo w słowo, ze znakami interpunkcyjnymi.
- Zachowujesz układ: akapity, punkty listy, łamania wierszy tam, gdzie coś je rozdziela.
- Listę zapisujesz jako listę („- "), nagłówek zostawiasz w osobnej linii.
- Tabelę zapisujesz wierszami, kolumny rozdzielając znakiem „ | ".

ZAKAZY BEZWZGLĘDNE:
1. Zwracasz WYŁĄCZNIE tekst z obrazka. Bez wstępu, bez komentarza, bez opisu tego, co widać („zrzut ekranu przedstawia…").
2. NIE ODPOWIADASZ na to, co przeczytałeś. Pytanie na obrazku przepisujesz jako pytanie. Formularz przepisujesz jako formularz.
3. NIE POPRAWIASZ. Literówka, dziwna interpunkcja i błąd ortograficzny zostają takie, jakie są — to cudzy tekst, nie twój.
4. NIE TŁUMACZYSZ. Piszesz w języku, w którym rzecz jest napisana.
5. NIE ZGADUJESZ. Fragment nieczytelny albo ucięty krawędzią zaznaczenia zapisujesz jako […].
6. Jeśli na obrazku nie ma żadnego tekstu, zwracasz pusty ciąg znaków.`;

/* Do klikania bez klucza — ten sam pomysł co atrapa transkrypcji w stt.js. */
const MOCK_TEXT = `Plan na jutro

- przegląd zgłoszeń
- decyzja w sprawie starego API
- telefon do Ani przed 12:00`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Zaznaczenie obszaru ekranu.
 *
 * `-i` daje krzyżyk (spacja w jego trakcie przełącza na łapanie całego
 * okna), `-o` zdejmuje cień z tak złapanego okna — cień to kilkaset
 * pustych pikseli, za które płaci się przy wysyłaniu. `-x` wycisza
 * migawkę: zrzut jest tu narzędziem pracy, a nie zdarzeniem.
 *
 * Anulowanie klawiszem Escape wygląda z zewnątrz dokładnie tak, jak
 * nieudany zrzut — narzędzie kończy się bez pliku i bez słowa. Dlatego
 * o wyniku decyduje istnienie pliku, a nie kod wyjścia.
 *
 * @returns {Promise<{buffer: Buffer, bytes: number}|null>} null = anulowane
 */
function grabRegion({ dir = os.tmpdir(), run = execFile } = {}) {
  if (process.platform !== "darwin") return Promise.resolve(null);

  const file = path.join(dir, `cribro-shot-${Date.now().toString(36)}.png`);

  return new Promise((resolve) => {
    run("screencapture", ["-i", "-o", "-x", "-t", "png", file], () => {
      let buffer = null;
      try {
        buffer = fs.readFileSync(file);
      } catch {
        return resolve(null); // Escape albo brak zgody — plik nie powstał
      }
      /* Zrzut leży w katalogu tymczasowym tylko na czas odczytu — kopia,
         która ma zostać, powstaje dopiero wtedy, gdy człowiek wybierze
         obrazek (patrz saveShot w main/main.js). Kasujemy go od razu
         i na pewno: obrazek jest już w pamięci, a plik ze zrzutem cudzego
         okna nie ma powodu przeleżeć nawet chwili dłużej. */
      try {
        fs.unlinkSync(file);
      } catch {
        /* zniknął sam albo nigdy nie powstał */
      }
      resolve(buffer.length ? { buffer, bytes: buffer.length } : null);
    });
  });
}

/** Żądanie do OpenAI. Osobno od wysyłki, żeby dało się sprawdzić bez sieci. */
function buildRequest(image, model) {
  return {
    model,
    messages: [
      { role: "system", content: READ_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            // „high" tnie obrazek na kafle 512 px i czyta każdy z osobna.
            // Przy zrzucie fragmentu to kilka kafli, czyli grosze — a bez
            // tego drobny druk (stopka, przypis, kod) wychodzi zgadywanką.
            image_url: { url: `data:image/png;base64,${image.toString("base64")}`, detail: "high" },
          },
        ],
      },
    ],
    max_completion_tokens: 4000,
  };
}

/**
 * Obrazek → tekst.
 *
 * Brak klucza nie jest tu awarią: zrzut nadal da się wstawić do notatki
 * jako obrazek i to jest sensowna połowa funkcji. Dlatego zamiast wyjątku
 * wraca `missingKey` i okno mówi o tym wprost.
 *
 * @returns {Promise<{text: string, provider: string, model: string, missingKey?: boolean}>}
 */
async function readText(image, settings) {
  const config = settings.shot ?? {};
  const provider = config.provider ?? "openai";
  const model = config.model || "gpt-5.6-luna";

  if (provider === "mock") {
    await wait(500);
    return { text: MOCK_TEXT, provider, model: "mock" };
  }

  if (provider !== "openai") throw new Error(`Nieznany dostawca odczytu: ${provider}`);

  const apiKey = keyFor(provider, settings);
  if (!apiKey) return { text: "", provider, model, missingKey: true };

  if (image.length > MAX_BYTES) {
    throw new Error(
      `Zrzut jest za duży (${Math.round(image.length / 1024 / 1024)} MB). Zaznacz mniejszy fragment.`,
    );
  }

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildRequest(image, model)),
  });

  if (!response.ok) throw new Error(await describeError(response, "OpenAI"));

  const data = await response.json();
  const choice = data.choices?.[0];
  return {
    text: clean(choice?.message?.content ?? ""),
    provider,
    model,
    refused: choice?.finish_reason === "content_filter",
  };
}

/**
 * Model bywa uprzejmy mimo zakazu i opakowuje odczyt w blok kodu albo
 * zaczyna od „Oto tekst z obrazka:". Zdejmujemy to tutaj, a nie prośbą
 * w prompcie — prompt już o to prosi, a to jest siatka pod nim.
 */
function clean(text) {
  let out = String(text ?? "").trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(out);
  if (fence) out = fence[1];
  out = out.replace(/^(oto|to jest|tekst z obrazka|treść obrazka)[^\n:]{0,40}:\s*\n/i, "");
  return out.trim();
}

/** Nazwa pliku ze zrzutem — czytelna z listy plików, bez dwóch takich samych. */
function stampName(at = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `zrzut-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`;
}

/**
 * Ścieżka pliku → adres, który uniesie Markdown.
 *
 * Nawiasy Markdowna kończy pierwsza spacja, a katalog „Application Support"
 * ma ją w nazwie — bez zakodowania obrazek urywałby się w połowie ścieżki.
 */
function fileUrl(filePath) {
  const encoded = String(filePath)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `file://${encoded}`;
}

const imageLink = (filePath, alt = "zrzut ekranu") => `![${alt}](${fileUrl(filePath)})`;

/**
 * Co dokładnie ląduje w notatce.
 *
 * Obrazek idzie przed tekstem, bo to on jest źródłem — tekst pod nim jest
 * odczytem, a nie podpisem. Przy formie „oba" oddziela je pusta linia,
 * więc notatka czyta się jak notatka, a nie jak zlepek.
 *
 * @param {"text"|"image"|"both"} form
 */
function compose({ form, text = "", image = null, alt } = {}) {
  const body = String(text ?? "").trim();
  const picture = image ? imageLink(image, alt) : "";

  if (form === "image") return picture;
  if (form === "both") return [picture, body].filter(Boolean).join("\n\n");
  return body;
}

module.exports = {
  grabRegion,
  readText,
  buildRequest,
  compose,
  imageLink,
  fileUrl,
  stampName,
  clean,
  READ_PROMPT,
  MOCK_TEXT,
  MAX_BYTES,
};
