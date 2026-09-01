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
 * Znaczniki, którymi wolno pisać — czyli DOKŁADNIE te, które umie notatka.
 *
 * To nie jest kosmetyka i nie jest to lista życzeń. Podsumowanie kończy
 * jako notatka w Notatniku (patrz keepMeetingNote w main/main.js), a notatka
 * jest Markdownem tłumaczonym na sformatowany tekst przez shared/richtext.js.
 * Co model napisze POZA tym zestawem, zostanie w notatce zwykłym tekstem
 * z gwiazdkami w środku — czyli będzie wyglądać na usterkę.
 *
 * Zakres jest wąski celowo: dokładnie to, co potrafi pasek narzędzi notatki.
 * Wszystkiego innego nie ma, więc nie ma też czego stracić po drodze.
 *
 * NAJWAŻNIEJSZE JEST TU POLE DO ODHACZENIA. Zadanie zapisane jako „- [ ]"
 * staje się w notatce prawdziwą listą do odhaczenia, którą się klika —
 * a nie akapitem o zadaniach. To jest cała różnica między notatką, którą
 * się czyta, a notatką, z której się pracuje.
 */
const MARKUP = `ZNACZNIKI. Podsumowanie pisz znacznikami, które ta aplikacja rozumie i pokazuje jako sformatowany tekst. Wolno używać WYŁĄCZNIE tych:

  ## Nagłówek           nagłówek sekcji (## albo ### — nie używaj #)
  ## ▾ Nagłówek         nagłówek składany, ROZWINIĘTY: wszystko pod nim da się schować jednym kliknięciem
  ## ▸ Nagłówek         nagłówek składany, ZWINIĘTY — dla części, które zwykle się pomija
  **pogrubienie**       _kursywa_       \`kod\`
  - punkt               lista
  1. punkt              lista numerowana
  - [ ] zadanie         POLE DO ODHACZENIA — używaj go dla wszystkiego, co ktoś ma zrobić
  > cytat               dosłowne zdanie, które padło
  ---                   linia rozdzielająca

Czego NIE używasz: tabel, HTML-a, bloków kodu z potrójnym grawisem, nagłówka pierwszego stopnia (#) ani żadnych innych znaczników. Nie owijasz całej odpowiedzi w blok kodu.

Znacznika używaj wtedy, gdy niesie znaczenie: „- [ ]" dla rzeczy do zrobienia, „>" dla zdania, które naprawdę padło. Pogrubienie w co drugim zdaniu nie podkreśla niczego.`;

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
<podsumowanie>

${MARKUP}`;



/**
 * Szablony podsumowania — czyli to, co użytkownik naprawdę wybiera.
 *
 * Jeden gotowy i jeden własny. Trzeci, „zrób mi ładnie", nie istnieje:
 * każdy szablon musi umieć powiedzieć, czego w wyniku NIE MA, bo pusty
 * nagłówek „Zadania" pod rozmową bez zadań to obietnica bez pokrycia.
 */
const TEMPLATES = {
  generic: {
    name: "W punktach",
    hint: "Najważniejsze na górze, reszta punktami. Zadania jako lista do odhaczenia.",
    rules: `Ułóż podsumowanie W PUNKTACH i zacznij od tego, co najważniejsze.

## Najważniejsze
Od jednego do trzech punktów, każdy jednym zdaniem. To jest odpowiedź na pytanie „co z tej rozmowy wynika" — dla kogoś, kto przeczyta TYLKO tę sekcję i nic więcej. Nie streszczasz tu przebiegu; wybierasz to, co naprawdę waży. Jeżeli rozmowa nie przyniosła nic ważnego, piszesz to jednym zdaniem, zamiast szukać na siłę.

## O czym było
Punkty. Każdy jednym zdaniem: temat po temacie, w kolejności, w której padły.

## Ustalenia
Punkty. Co postanowiono — i tylko to, co naprawdę postanowiono. Rozmowa bez rozstrzygnięć nie ma tej sekcji.

## Zadania
POLA DO ODHACZENIA, po jednym na zadanie, w formie:
- [ ] Kto: co, termin
Imię tylko wtedy, gdy padło; termin tylko wtedy, gdy padł. Bez zadań nie ma tej sekcji.

## ▸ Otwarte
Punkty: sprawy nierozstrzygnięte i pytania bez odpowiedzi. Ta jedna sekcja jest ZWINIĘTA (strzałka ▸), bo zagląda się do niej rzadziej niż do reszty — ale ma być, gdy jest w niej coś.

SEKCJĘ, DLA KTÓREJ NIE MA TREŚCI, POMIJASZ W CAŁOŚCI — razem z nagłówkiem. Nagłówek bez punktów obiecuje coś, czego nie ma.`,
  },
  custom: {
    name: "Własne wytyczne",
    hint: "Piszesz sam, czego oczekujesz — razem z tym, jak wynik ma wyglądać.",
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
function material(meeting, { previous } = {}) {
  const parts = [];
  /* CO BYŁO POPRZEDNIM RAZEM. Spotkanie cotygodniowe jest ciągiem dalszym,
     a nie osobną rozmową: „wracamy do budżetu" znaczy coś tylko wtedy, gdy
     wiadomo, na czym stanęło. Podajemy sam wniosek z poprzedniego, nigdy
     jego zapis — i wyraźnie oddzielony, żeby nie wsiąkł w to podsumowanie
     jako ustalenie z dzisiaj. */
  const before = String(previous ?? "").trim();
  if (before) {
    parts.push(
      `POPRZEDNIE SPOTKANIE Z TEJ SERII — jego podsumowanie. To jest TŁO, nie treść dzisiejszej rozmowy. Nie przepisuj go i nie wciągaj do ustaleń; użyj tylko po to, żeby zrozumieć skróty i nawiązania.\n${before}`,
    );
  }
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
function buildPrompt(meeting, { template = "generic", instructions = "", previous = "" } = {}) {
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
    user: material(meeting, { previous }),
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
    previous: meeting?.previousSummary,
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
    if (!hit) continue;
    /* Model umie już pisać polami do odhaczenia (patrz MARKUP wyżej), więc
       punkt bywa gotowym „- [ ] zrobić X". Sam nawias trzeba wtedy zdjąć —
       inaczej zadanie wróciłoby niżej jako „- [ ] [ ] zrobić X". */
    out.push(hit[1].replace(/^\[[ xX]\]\s*/, "").replace(/\*\*/g, "").trim());
  }
  return out.filter(Boolean);
}

/** Czy podsumowanie ma już pola do odhaczenia — czyli czy zrobiło to za nas. */
const hasCheckboxes = (summary) => /^\s*[-*]\s+\[[ xX]\]\s+\S/m.test(String(summary ?? ""));

const stampDate = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString("pl-PL", { dateStyle: "long", timeStyle: "short" });
};

/* ── Nazwa notatki ze spotkania ─────────────────────────────────

   Notatka ze spotkania powstaje SAMA i sama musi się nazwać — nikt nie
   siada po rozmowie do wymyślania nagłówka. A nazwa jest tu jedyną rzeczą,
   po której się ją potem znajdzie: w Notatniku leży obok trzydziestu
   innych i widać z niej dokładnie jedną linijkę.

   Nazwa składa się z DWÓCH rzeczy, bo tak brzmi pytanie, które się sobie
   zadaje tydzień później: „o czym to było" ORAZ „z kim". Ani samo
   „Budżet na trzeci kwartał", ani samo „Ania Kowalska" nie odpowiada na
   nie w całości — a cotygodniowy przegląd nazwany co tydzień tak samo
   nie odróżnia się od poprzedniego niczym poza datą.

   O CZYM bierzemy z tego, co o rozmowie już wiadomo: z nazwy spotkania
   (napisanej przez model z treści, przepisanej z okna rozmowy albo wziętej
   z kalendarza), a gdy jej nie ma — z pierwszego zdania podsumowania.
   Z KIM liczymy tutaj, lokalnie, z listy zaproszonych i z mówiących
   w zapisie. To jest wiedza, którą aplikacja ma; pytanie o nią modelu
   byłoby drugim wywołaniem po rzecz, która leży w pliku obok. */

/** Podpisy, które nie są niczyim imieniem — nie ma po co ich wymieniać. */
const NOT_A_NAME = /^(?:ty|ja|rozm[óo]wcy?|nieznany|uczestnicy?|speaker|unknown|\?)$/i;

/** Imię z adresu albo z podpisu: „Ania Kowalska <a@x.pl>" → „Ania Kowalska". */
function humanName(entry) {
  const raw = String(entry ?? "").trim();
  if (!raw) return "";
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(raw);
  if (named) return named[1].trim();
  // Sam adres: „ania.kowalska@firma.pl" → „ania.kowalska". Lepsze to niż
  // domena cudzej firmy w nagłówku notatki.
  if (raw.includes("@")) return raw.split("@")[0].replace(/[._-]+/g, " ").trim();
  return raw;
}

/** Czy te dwa podpisy to ta sama osoba. Porównanie na tyle luźne, żeby
    „Maciej Wyrozumski" z kalendarza zgadzał się z „maciej wyrozumski"
    z konta systemowego, i na tyle ciasne, żeby nie zlepiać dwóch Ań. */
const samePerson = (a, b) =>
  !!a && !!b && humanName(a).toLowerCase().trim() === humanName(b).toLowerCase().trim();

/**
 * Z KIM była ta rozmowa — jednym napisem.
 *
 * Kolejność źródeł jest kolejnością pewności: lista zaproszonych
 * z kalendarza wie, kto miał być, zapis rozmowy wie, kto mówił. Siebie
 * z obu odejmujemy: „spotkanie z sobą" nie jest informacją.
 *
 * @param {object} meeting
 * @param {object} [options]
 * @param {string} [options.me]  imię i nazwisko właściciela konta
 * @returns {string}  nazwa osoby, wyliczenie dwóch albo „zespół (N osób)"
 */
function withWhom(meeting, { me = "" } = {}) {
  const invited = (meeting?.people ?? [])
    .map(humanName)
    .filter((name) => name && !samePerson(name, me) && !NOT_A_NAME.test(name));

  const said = [
    ...new Set(
      (meeting?.transcript ?? [])
        .map((line) => humanName(line?.speaker))
        .filter((name) => name && !samePerson(name, me) && !NOT_A_NAME.test(name)),
    ),
  ];

  /* Zaproszeni są pewniejsi od mówiących: zapis bywa podpisany „Rozmówcy",
     a kalendarz zna imię i nazwisko. Gdy zaproszonych nie ma — bo nagranie
     ruszyło z menu, bez kalendarza — zostają ci, którzy się odezwali. */
  const people = [...new Set(invited.length ? invited : said)];
  if (!people.length) return "";
  if (people.length === 1) return people[0];
  if (people.length === 2) return `${people[0]} i ${people[1]}`;
  /* Powyżej dwóch nazwisk wyliczanka przestaje być nazwą i staje się listą
     — a nagłówek notatki ma się mieścić w jednej linijce. */
  return `zespół (${people.length} ${osoby(people.length)})`;
}

/** „2 osoby", „5 osób" — polska liczba mnoga, bo napis idzie do nagłówka. */
function osoby(count) {
  const last = count % 10;
  const teen = count % 100 >= 12 && count % 100 <= 14;
  return !teen && last >= 2 && last <= 4 ? "osoby" : "osób";
}

/** Pierwsze zdanie podsumowania — nazwa awaryjna, gdy rozmowa nie ma żadnej. */
function firstSentence(summary, limit = 48) {
  const line = String(summary ?? "")
    .split("\n")
    .map((row) => row.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|>\s?)/, "").replace(/\*\*/g, "").trim())
    .find(Boolean);
  if (!line) return "";
  const sentence = /^(.{10,}?[.!?])(?:\s|$)/.exec(line);
  const out = (sentence ? sentence[1] : line).replace(/[.\s]+$/, "");
  return out.length > limit ? `${out.slice(0, limit - 1).trimEnd()}…` : out;
}

/**
 * Nazwa notatki ze spotkania: o czym i z kim.
 *
 * @param {object} meeting
 * @param {object} [options]
 * @param {string} [options.me]
 * @returns {string}
 */
function noteTitle(meeting, { me = "", limit = 72 } = {}) {
  const about = String(meeting?.title ?? "").trim() || firstSentence(meeting?.summary) || "Spotkanie";
  const whom = withWhom(meeting, { me });
  // Nazwa, w której to imię już stoi („Rozmowa z Anią Kowalską"), nie
  // potrzebuje go po kropce drugi raz.
  if (!whom || mentions(about, whom)) return trimTitle(about, limit);
  return trimTitle(`${about} · ${whom}`, limit);
}

/**
 * Czy w tej nazwie już o tej osobie mowa.
 *
 * Po rdzeniach, nie po całych słowach, bo polszczyzna odmienia: „Ania
 * Kowalska" stoi w nazwie spotkania jako „z Anią Kowalską" i porównanie
 * dosłowne nie znalazłoby tam nikogo. Ucinamy więc końcówkę i pytamy
 * o początek słowa — dopasowanie w środku wyrazu („mania" dla „Ani")
 * byłoby przypadkiem, a nie wzmianką.
 *
 * Pomyłka kosztuje tu jedno: imię nie dopisze się po kropce, choć mogło.
 * Pomyłka w drugą stronę kosztowałaby „Rozmowa z Anią · Ania".
 */
function mentions(about, whom) {
  const hay = String(about ?? "").toLowerCase();
  const words = String(whom ?? "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length >= 3);
  if (!words.length) return false;
  return words.every((word) => {
    const stem = word.slice(0, Math.max(3, word.length - 2));
    return new RegExp(`(?:^|[^\\p{L}])${stem}`, "u").test(hay);
  });
}

/** Nazwa przycięta tak, żeby nie urwała się w połowie słowa. */
function trimTitle(text, limit) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

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
function asNote(meeting, { transcript = true, me = "" } = {}) {
  const out = [];
  /* Nagłówek notatki NIE JEST nazwą spotkania: mówi też, z kim ta rozmowa
     była (patrz noteTitle wyżej). Nazwa spotkania zostaje nazwą spotkania
     i widać ją w zakładce Spotkania; notatka leży obok trzydziestu innych
     i musi bronić się jedną linijką. */
  const title = noteTitle(meeting, { me });
  out.push(`# ${title}`, "");

  const meta = [stampDate(meeting?.at), meeting?.where].filter(Boolean);
  if (meta.length) out.push(meta.join(" · "), "");
  const people = (meeting?.people ?? []).filter(Boolean);
  if (people.length) out.push(`**Kto był:** ${people.join(", ")}`, "");

  /* ══ ZADANIA: PRZENOSIMY JE TYLKO WTEDY, GDY TRZEBA ══

     Ten krok powstał, gdy model pisał zadania akapitem — lista „kto: co,
     termin" czyta się dobrze, ale nie da się jej odhaczyć. Wycinaliśmy ją
     więc z podsumowania i wstawialiśmy niżej jako pola do odhaczenia.

     Dziś model pisze pola sam (patrz MARKUP wyżej), a wtedy ten krok nie ma
     już co poprawiać — i nie wolno mu niczego ruszać. Przepisanie gotowej
     listy od nowa gubiłoby to, co ktoś zdążył odhaczyć, i przestawiałoby
     sekcję na koniec notatki wbrew układowi, o który poproszono we własnych
     wytycznych. Podsumowanie z polami zostaje więc DOKŁADNIE takie, jakie
     przyszło. */
  const ready = hasCheckboxes(meeting?.summary);
  const tasks = ready ? [] : tasksFrom(meeting?.summary);
  if (meeting?.summary) {
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
    /* ══ NIEPEŁNY ZAPIS MÓWI O TYM SAM ══

       Zapis rozmowy jest w notatce po to, żeby zastąpić skasowane nagranie
       — więc pytanie „czy to jest całość" trzeba na niego nanieść, a nie
       zostawić do wywnioskowania. Zapis, w którym brakuje pół godziny,
       wygląda dokładnie tak samo jak kompletny: kilka wypowiedzi ze
       znacznikami czasu. Jedno zdanie tutaj kosztuje linijkę i jest jedyną
       rzeczą, która odróżnia jedno od drugiego. */
    const cover = meeting.coverage;
    if (cover && cover.complete === false && cover.spokenSeconds) {
      out.push(
        `> Ten zapis jest niepełny: obejmuje ${Math.round(cover.writtenSeconds / 60)} ` +
          `z ${Math.round(cover.spokenSeconds / 60)} minut rozmowy.`,
        "",
      );
    }
    for (const line of meeting.transcript) {
      out.push(`**${line.speaker ?? "?"}** · ${stamp(line.at)}`, "", String(line.text ?? "").trim(), "");
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ── Zwijanie w podsumowaniu ───────────────────────────────────

   Strzałka przy nagłówku stoi W TREŚCI, a nie obok niej — dokładnie tak,
   jak w notatce (patrz TOGGLE_MARK w shared/richtext.js). To nie jest
   szczegół zapisu, tylko rozstrzygnięcie: „ta część jest schowana" to coś,
   co ktoś postanowił, a nie stan okna.

   Podglądowi podsumowania jest to potrzebne bardziej niż notatce. Zakładka
   Spotkania przerysowuje się przy każdym meldunku z procesu głównego —
   a w trakcie rozmowy przychodzi on co odcinek zapisu, czyli co dwie minuty.
   Zwinięcie trzymane tylko w oknie zamykałoby się wtedy samo, w środku
   czytania, bez żadnego powodu widocznego dla człowieka. */

/** Nagłówki składane w podsumowaniu — w kolejności, w której stoją. */
const TOGGLE_LINE = /^(\s{0,3}#{1,6}[ \t]+)([\u25B8\u25BE])([ \t]*)/;

/**
 * Przestawienie n-tego nagłówka składanego.
 *
 * @param {string} summary
 * @param {number} index  który z kolei nagłówek składany, licząc od zera
 * @param {boolean} open  ma być rozwinięty
 * @returns {string} podsumowanie z przestawioną strzałką
 */
function flipToggle(summary, index, open) {
  const lines = String(summary ?? "").split("\n");
  let seen = -1;
  for (let at = 0; at < lines.length; at += 1) {
    const hit = TOGGLE_LINE.exec(lines[at]);
    if (!hit) continue;
    seen += 1;
    if (seen !== index) continue;
    lines[at] = lines[at].replace(TOGGLE_LINE, `$1${open ? "\u25BE" : "\u25B8"}$3`);
    return lines.join("\n");
  }
  // Nagłówka o tym numerze nie ma — podsumowanie zmieniło się pod ręką.
  // Zwracamy je nietknięte, zamiast przestawiać cudzy nagłówek.
  return String(summary ?? "");
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
  /* Samo wywołanie modelu, bez niczego dookoła. Wychodzi stąd, bo poranne
     podsumowanie (main/briefing.js) zadaje modelowi zupełnie inne pytanie,
     ale zadaje je tym samym trzem dostawcom i tym samym kluczem. Druga
     kopia tej funkcji rozjechałaby się przy pierwszej zmianie u dostawcy. */
  send,
  readDialogue,
  buildPrompt,
  readAnswer,
  transcriptText,
  material,
  tasksFrom,
  hasCheckboxes,
  flipToggle,
  asNote,
  noteTitle,
  withWhom,
  mentions,
  humanName,
  firstSentence,
  TEMPLATES,
  MAX_CHARS,
};
