"use strict";

const { keyFor } = require("./providers");
const { describeError } = require("./stt");

/**
 * Krok 3 spotkania — wniosek z rozmowy.
 *
 * Transkrypcja odpowiada na pytanie „co padło". Podsumowanie odpowiada na
 * pytanie, dla którego w ogóle się nagrywa: „co z tego wynika". To są dwie
 * różne rzeczy i dlatego stoją w dwóch zakładkach, a nie jedna pod drugą.
 *
 * TRZY RZECZY, KTÓRE TU DECYDUJĄ:
 *
 *   1. NOTATKI WAŻĄ WIĘCEJ NIŻ ZAPIS. Zapis powstaje sam z każdego dźwięku,
 *      jaki padł; notatkę ktoś napisał ręką w trakcie rozmowy, bo uznał to
 *      za warte zapisania. Model dostaje jedno i drugie, ale wie, co jest
 *      czym.
 *
 *   2. TYTUŁ POWSTAJE PRZY OKAZJI, w tym samym wywołaniu. Nazwa wzięta
 *      z okna przeglądarki to zwykle kod pokoju („jxg-hfsa-qvb") — czyli
 *      nazwa, po której za tydzień nikt niczego nie znajdzie. Osobne
 *      wywołanie po sam tytuł kosztowałoby drugie tyle i mogłoby powiedzieć
 *      coś innego niż podsumowanie.
 *
 *   3. ZMYŚLONE USTALENIE JEST GORSZE NIŻ BRAK PODSUMOWANIA. Zapis rozmowy
 *      bywa dziurawy: przesłuch, cisza, urwany odcinek. Model ma o tym
 *      wiedzieć i pisać tylko to, co naprawdę padło — „nie wiem" jest
 *      poprawną odpowiedzią, wymyślony termin nie jest.
 *
 * Budowanie promptu i czytanie odpowiedzi są czyste — wchodzi zapis,
 * wychodzi tekst. Sprawdza je zwykły Node (scripts/digest-test.js).
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** Ile znaków zapisu wpuszczamy do jednego wywołania. Godzina rozmowy to
    około 45 tysięcy znaków — mieści się z zapasem u każdego dostawcy. */
const MAX_CHARS = 120_000;

/**
 * Umowa, której nie zmienia żaden szablon.
 *
 * Szablon mówi, JAK ma wyglądać wynik. To niżej mówi, czego nie wolno
 * zrobić niezależnie od szablonu — i dlatego stoi osobno, poza zasięgiem
 * własnych instrukcji użytkownika.
 */
const CONTRACT = `Jesteś protokolantem. Dostajesz zapis rozmowy z podziałem na mówiących, a czasem także notatki, które ktoś pisał ręką w jej trakcie.

CO MASZ WIEDZIEĆ O MATERIALE:
- Zapis powstał automatycznie i bywa dziurawy: przekręcone nazwiska, urwane zdania, fragmenty przypisane nie tej osobie.
- „Ty" to człowiek, który nagrywał. „Rozmówcy" to wszyscy pozostali — zapis nie odróżnia ich od siebie i ty też nie próbuj.
- NOTATKI WAŻĄ WIĘCEJ NIŻ ZAPIS. Ktoś napisał je ręką w trakcie rozmowy, bo uznał je za warte zapisania. Jeśli notatka mówi co innego niż zapis, wygrywa notatka.

ZAKAZY BEZWZGLĘDNE:
1. Nie dopisujesz ustaleń, terminów, liczb ani nazwisk, których nie było. Zmyślone ustalenie jest gorsze niż brak podsumowania.
2. Nie zgadujesz, kto jest kim. Jeśli imię nie padło, piszesz o rolach („rozmówca") albo bezosobowo.
3. Nie oceniasz i nie doradzasz. Zapisujesz, co się wydarzyło.
4. Piszesz w języku, w którym mówiono.
5. Gdy zapis jest za krótki albo nie ma w nim treści — mówisz to wprost jednym zdaniem, zamiast rozciągać nic na trzy akapity.

FORMAT ODPOWIEDZI — dokładnie taki:
TYTUŁ: <nazwa spotkania, najwyżej sześć słów, o czym była rozmowa; bez daty i bez godziny>
<pusta linia>
<podsumowanie>`;

/**
 * Szablony podsumowania — czyli to, co użytkownik naprawdę wybiera.
 *
 * Jeden gotowy i jeden własny. Trzeci, „zrób mi ładnie", nie istnieje:
 * każdy szablon musi umieć powiedzieć, czego w wyniku NIE MA, bo pusty
 * nagłówek „Zadania" pod rozmową bez zadań to obietnica bez pokrycia.
 */
const TEMPLATES = {
  generic: {
    name: "Zwykłe podsumowanie",
    hint: "O czym było, co ustalono, co komu zostało.",
    rules: `Ułóż podsumowanie z sekcji, każda z nagłówkiem **pogrubionym**:

**O czym było** — dwa, trzy zdania. Sam temat i powód rozmowy.
**Ustalenia** — lista tego, co postanowiono. Każdy punkt jednym zdaniem.
**Zadania** — lista w formie „kto: co, termin". Termin tylko wtedy, gdy padł.
**Otwarte** — lista spraw, których nie rozstrzygnięto, i pytań bez odpowiedzi.

SEKCJĘ, DLA KTÓREJ NIE MA TREŚCI, POMIJASZ W CAŁOŚCI. Nagłówek bez punktów obiecuje coś, czego nie ma.`,
  },
  custom: {
    name: "Własne wytyczne",
    hint: "Piszesz sam, czego oczekujesz od podsumowania.",
    rules: null, // bierze się z ustawień — patrz buildPrompt
  },
};

const pad = (value) => String(value).padStart(2, "0");

/** Znacznik czasu w postaci, którą czyta się bez liczenia. */
function stamp(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${pad(total % 60)}`;
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(total % 60)}`;
}

/**
 * Zapis rozmowy jako tekst do wysłania.
 *
 * Znacznik czasu przy każdej wypowiedzi nie jest ozdobą: bez niego model
 * nie ma jak napisać „pod koniec rozmowy wrócili do budżetu", a to jest
 * dokładnie ten rodzaj zdania, po który się sięga do podsumowania.
 */
function transcriptText(lines, { cap = MAX_CHARS } = {}) {
  const out = [];
  let size = 0;
  for (const line of lines ?? []) {
    const said = String(line?.text ?? "").trim();
    if (!said) continue;
    const row = `[${stamp(line.at)}] ${line.speaker ?? "?"}: ${said}`;
    size += row.length + 1;
    /* Przy zapisie dłuższym niż limit ucinamy POCZĄTEK, nie koniec.
       Ustalenia zapadają na końcu rozmowy — to je trzeba mieć na pewno. */
    out.push(row);
    while (size > cap && out.length > 1) size -= out.shift().length + 1;
  }
  return out.join("\n");
}

/**
 * Materiał dla modelu: zapis, notatki i to, czego o nich wiadomo.
 *
 * @param {object} meeting  wpis spotkania ze sklepu
 * @returns {string}
 */
function material(meeting) {
  const parts = [];
  /* Kto był w pokoju — z kalendarza. Bez tej listy model nie ma jak
     przypisać ustalenia do osoby i pisze bezosobowo („ustalono, że…"),
     a to jest dokładnie ta informacja, po którą sięga się do notatek. */
  const people = (meeting?.people ?? []).filter(Boolean);
  if (people.length) {
    parts.push(
      `ZAPROSZENI (z kalendarza, kolejność bez znaczenia): ${people.join(", ")}.\nZapis nie mówi, które słowa należą do kogo z nich — nie zgaduj tego. Imion używaj tylko wtedy, gdy padły w rozmowie.`,
    );
  }
  const notes = String(meeting?.notes ?? "").trim();
  if (notes) parts.push(`NOTATKI PISANE RĘKĄ W TRAKCIE ROZMOWY:\n${notes}`);
  const talk = transcriptText(meeting?.transcript);
  parts.push(talk ? `ZAPIS ROZMOWY:\n${talk}` : "ZAPIS ROZMOWY: (pusty)");
  return parts.join("\n\n");
}

/**
 * Pełne polecenie dla modelu.
 *
 * @param {object} meeting
 * @param {object} [options]
 * @param {string} [options.template]      "generic" albo "custom"
 * @param {string} [options.instructions]  własne wytyczne
 * @returns {{system: string, user: string}}
 */
function buildPrompt(meeting, { template = "generic", instructions = "" } = {}) {
  const own = String(instructions ?? "").trim();
  /* Własne wytyczne bez treści nie mogą znaczyć „bez wytycznych": wynikiem
     byłby wtedy zlepek zdań bez żadnego układu. Wracamy do gotowego. */
  const chosen = template === "custom" && own ? "custom" : "generic";
  const rules =
    chosen === "custom"
      ? `Podsumowanie ma spełnić TE wytyczne, podane przez człowieka, dla którego je piszesz:\n\n${own}`
      : TEMPLATES.generic.rules;

  return {
    system: `${CONTRACT}\n\n${rules}`,
    user: material(meeting),
    template: chosen,
  };
}

/**
 * Odpowiedź modelu na tytuł i treść.
 *
 * Tytułu NIE WYMUSZAMY: model, który go nie dał, oddał samo podsumowanie
 * i to jest lepsze niż pierwsza linia treści awansowana na nazwę.
 *
 * @param {string} raw
 * @returns {{title: string|null, summary: string}}
 */
function readAnswer(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { title: null, summary: "" };

  const [first, ...rest] = text.split("\n");
  const hit = /^\s*(?:TYTU[ŁL]|TITLE)\s*:\s*(.+?)\s*$/i.exec(first);
  if (!hit) return { title: null, summary: text };

  const title = hit[1]
    // Model lubi opakować tytuł w cudzysłów albo w gwiazdki Markdowna.
    .replace(/^[*_"„”'`]+|[*_"„”'`.]+$/g, "")
    .trim();
  return { title: title || null, summary: rest.join("\n").trim() };
}

/**
 * Podsumowanie spotkania.
 *
 * @param {object} meeting   wpis ze sklepu (transcript + notes)
 * @param {object} settings  całe ustawienia
 * @param {object} [hooks]
 * @param {Function} [hooks.ask]  wywołanie modelu; wstrzykiwane w teście
 * @returns {Promise<{title: string|null, summary: string, provider: string, model: string}>}
 */
async function digest(meeting, settings, { ask } = {}) {
  const lines = meeting?.transcript?.length ?? 0;
  const notes = String(meeting?.notes ?? "").trim();
  if (!lines && !notes) {
    throw new Error("Nie ma z czego zrobić podsumowania — zapis rozmowy jest pusty.");
  }

  const meet = settings?.meetings ?? {};
  const { system, user, template } = buildPrompt(meeting, {
    template: meet.template,
    instructions: meet.instructions,
  });

  /* Podsumowanie robi ten sam dostawca, co sito — bo to to samo zadanie:
     tekst wchodzi, tekst wychodzi. Osobne ustawienie byłoby trzecim
     kluczem API do wpisania i pierwszym, o którym nikt by nie pamiętał. */
  const provider = settings?.sieve?.provider ?? "gemini";
  const model = settings?.sieve?.model;
  const call = ask ?? send;
  const apiKey = keyFor(provider, settings);
  if (!apiKey && provider !== "mock") {
    throw new Error(`Brak klucza API dla dostawcy „${provider}" — podsumowanie potrzebuje modelu.`);
  }

  const raw = await call({ provider, model, apiKey, system, user });
  const { title, summary } = readAnswer(raw);
  return { title, summary, provider, model, template };
}

/** Wywołanie modelu. Trzej dostawcy, jedno pytanie. */
async function send({ provider, model, apiKey, system, user }) {
  if (provider === "gemini") {
    const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    if (!response.ok) throw new Error(await describeError(response, "Gemini"));
    const data = await response.json();
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini odmówił podsumowania (${data.promptFeedback.blockReason}).`);
    }
    return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
  }

  if (provider === "openai") {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_completion_tokens: 4000,
      }),
    });
    if (!response.ok) throw new Error(await describeError(response, "OpenAI"));
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "anthropic") {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }],
    });
    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  throw new Error(`Nieznany dostawca podsumowań: ${provider}`);
}

/* ── Rozmowa przesiana ──────────────────────────────────────────

   Trzecia postać tej samej rozmowy — i ta, której nie ma nigdzie indziej.

   Zapis odpowiada na pytanie „co dokładnie padło" i jest nie do czytania:
   godzina mowy to czterdzieści tysięcy znaków razem z „halo, słychać
   mnie?", trzema minutami o pogodzie i każdym „yyy". Podsumowanie
   odpowiada na „co z tego wynika" i gubi wszystko poza wnioskiem — a bywa,
   że liczy się, KTO ustąpił i dlaczego.

   Między nimi jest miejsce, którego nikt nie zajmuje: rozmowa, z której
   zdjęto szum, a która wciąż jest rozmową. Cribro robi dokładnie to jedno
   przy dyktowaniu (patrz main/sieve.js) i tu robi to samo — bo to jest ta
   sama czynność, tylko materiał ma dwie strony zamiast jednej. */

const TALK_CONTRACT = `Jesteś sitem redakcyjnym. Dostajesz automatyczny zapis rozmowy dwóch stron i zwracasz go OCZYSZCZONY — nadal jako rozmowę, nie jako streszczenie.

CO USUWASZ:
- szum mowy: „yyy", „eee", „no", „wiesz", „tak jakby", zająknięcia, powtórzone słowa, fałszywe starty
- techniczne początki i końce: „halo", „słychać mnie?", „chyba się zawiesiłeś", „muszę lecieć na następne"
- wymianę zdań, która nie niesie treści: powitania, pogodę, small talk
- powtórzenia tej samej myśli tą samą osobą

CO ZOSTAWIASZ:
- każdą myśl, która padła, razem z tym, kto ją powiedział
- kolejność wypowiedzi i ich naprzemienność — to ma się dalej czytać jak rozmowa
- zdania, w których ktoś zmienia zdanie, ustępuje albo się nie zgadza: to jest treść, a nie szum
- liczby, terminy, nazwy i imiona dokładnie tak, jak padły

CZEGO NIE ROBISZ:
1. Nie streszczasz. Wypowiedź zostaje wypowiedzią, tylko bez potknięć.
2. Nie dopisujesz niczego, czego nie było — ani ustaleń, ani zdań łączących.
3. Nie zmieniasz przypisania do mówiących. Zapis bywa w tym niedokładny, ale zgadywanie pogorszy sprawę.
4. Nie tłumaczysz. Piszesz w języku, w którym mówiono.

FORMAT — dokładnie taki, wiersz po wierszu, bez niczego poza nim:
[mm:ss] Mówiący: oczyszczona wypowiedź`;

/** Wiersz rozmowy: „[12:34] Ania: treść". */
const DIALOGUE = /^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([^:]{1,40}?)\s*:\s*(.+?)\s*$/;

/**
 * Odpowiedź modelu z powrotem na wiersze rozmowy.
 *
 * Wiersze, które nie trzymają formatu, POMIJAMY zamiast ratować. Model,
 * który zaczął pisać prozą, nie oddał rozmowy — a doklejenie jego prozy
 * do zapisu jako czyjejś wypowiedzi byłoby włożeniem komuś w usta słów,
 * których nie powiedział.
 */
function readDialogue(raw) {
  const out = [];
  for (const line of String(raw ?? "").split("\n")) {
    const hit = DIALOGUE.exec(line);
    if (!hit) continue;
    const [, a, b, c, who, said] = hit;
    const at = c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
    out.push({ speaker: who.replace(/\*\*/g, "").trim(), at, text: said.trim() });
  }
  return out;
}

/**
 * Rozmowa bez szumu.
 *
 * @returns {Promise<Array<{speaker, at, text}>>}
 */
async function polish(meeting, settings, { ask } = {}) {
  const lines = meeting?.transcript ?? [];
  if (!lines.length) throw new Error("Nie ma czego przesiewać — zapis rozmowy jest pusty.");

  const provider = settings?.sieve?.provider ?? "gemini";
  const model = settings?.sieve?.model;
  const apiKey = keyFor(provider, settings);
  if (!apiKey && provider !== "mock") {
    throw new Error(`Brak klucza API dla dostawcy „${provider}" — sito potrzebuje modelu.`);
  }

  const people = (meeting?.people ?? []).filter(Boolean);
  const system = people.length
    ? `${TALK_CONTRACT}\n\nW rozmowie brali udział: ${people.join(", ")}. Imiona zapisuj dokładnie tak.`
    : TALK_CONTRACT;

  const raw = await (ask ?? send)({
    provider,
    model,
    apiKey,
    system,
    user: transcriptText(lines),
  });
  const talk = readDialogue(raw);
  if (!talk.length) throw new Error("Sito nie oddało rozmowy w oczekiwanej postaci.");
  return talk;
}

/**
 * Zadania wyłuskane z podsumowania.
 *
 * Model pisze je listą pod nagłówkiem — i jako lista są do przeczytania,
 * ale nie do odhaczenia. Notatka umie jedno i drugie, więc przy przenoszeniu
 * spotkania do Notatnika punkty z tej jednej sekcji stają się zadaniami.
 *
 * Szukamy po nagłówku, nie po treści: „kto: co, termin" w środku akapitu
 * o czym innym nie jest zadaniem, choćby wyglądało.
 */
function tasksFrom(summary) {
  const lines = String(summary ?? "").split("\n");
  const head = /^\s*(?:\*\*|##+\s*)?(zadania|do zrobienia|tasks|action items)\b/i;
  const other = /^\s*(?:\*\*|##+\s*)\S/;
  const bullet = /^\s*[-*•]\s+(.+?)\s*$/;

  const out = [];
  let inside = false;
  for (const line of lines) {
    if (head.test(line)) {
      inside = true;
      continue;
    }
    if (inside && other.test(line) && !bullet.test(line)) break;
    if (!inside) continue;
    const hit = bullet.exec(line);
    if (hit) out.push(hit[1].replace(/\*\*/g, "").trim());
  }
  return out.filter(Boolean);
}

const stampDate = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString("pl-PL", { dateStyle: "long", timeStyle: "short" });
};

/**
 * Spotkanie jako notatka — czyli jako coś, co da się WYSŁAĆ.
 *
 * To jest cała droga wyjścia z tego modułu i dlatego prowadzi przez
 * Notatnik, a nie przez własny eksport: notatka umie już PDF, Notion,
 * Apple Notes, chmurę i schowek. Drugi zestaw tych samych przycisków przy
 * spotkaniu byłby drugim miejscem do poprawiania przy każdej zmianie.
 *
 * Zadania idą jako lista do odhaczenia, bo taka jest ich natura. Zapis
 * rozmowy — na końcu i pod nagłówkiem, bo czyta się go rzadko i wtedy,
 * gdy podsumowanie czegoś nie mówi.
 */
function asNote(meeting, { transcript = true } = {}) {
  const out = [];
  const title = meeting?.title || "Spotkanie";
  out.push(`# ${title}`, "");

  const meta = [stampDate(meeting?.at), meeting?.where].filter(Boolean);
  if (meta.length) out.push(meta.join(" · "), "");
  const people = (meeting?.people ?? []).filter(Boolean);
  if (people.length) out.push(`**Kto był:** ${people.join(", ")}`, "");

  const tasks = tasksFrom(meeting?.summary);
  if (meeting?.summary) {
    /* Sekcję zadań wycinamy z podsumowania i wstawiamy niżej jako listę
       do odhaczenia — inaczej te same punkty stałyby w notatce dwa razy. */
    const body = tasks.length ? stripTasks(meeting.summary) : meeting.summary;
    out.push(body.trim(), "");
  }
  if (tasks.length) {
    out.push("## Zadania", "");
    for (const task of tasks) out.push(`- [ ] ${task}`);
    out.push("");
  }

  const notes = String(meeting?.notes ?? "").trim();
  if (notes) out.push("## Notatki z rozmowy", "", notes, "");

  if (transcript && meeting?.transcript?.length) {
    out.push("## Zapis rozmowy", "");
    for (const line of meeting.transcript) {
      out.push(`**${line.speaker ?? "?"}** · ${stamp(line.at)}`, "", String(line.text ?? "").trim(), "");
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Podsumowanie bez sekcji zadań — te idą osobno, jako lista do odhaczenia. */
function stripTasks(summary) {
  const lines = String(summary ?? "").split("\n");
  const head = /^\s*(?:\*\*|##+\s*)?(zadania|do zrobienia|tasks|action items)\b/i;
  const other = /^\s*(?:\*\*|##+\s*)\S/;
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (head.test(line)) {
      skipping = true;
      continue;
    }
    /* Punkt listy poznaje się po ODSTĘPIE za znakiem. Bez tego warunku
       „**Otwarte**" liczyłoby się jako punkt (zaczyna się gwiazdką)
       i cała sekcja po zadaniach znikałaby z podsumowania. */
    if (skipping && other.test(line) && !/^\s*(?:[-•]|\*)\s/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

module.exports = {
  digest,
  polish,
  readDialogue,
  buildPrompt,
  readAnswer,
  transcriptText,
  material,
  tasksFrom,
  asNote,
  TEMPLATES,
  MAX_CHARS,
};
