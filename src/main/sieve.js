"use strict";

const { keyFor } = require("./providers");
const { describeError, withRetry } = require("./stt");
const { directive } = require("./languages");
const { catalog, readMarker } = require("./commands");
const aiRegistry = require("./ai-registry");

/**
 * Krok 2 — SITO.
 *
 * Dostaje wierną transkrypcję i oddaje ją oczyszczoną. Nie odpowiada,
 * nie dopisuje, nie tłumaczy. Zabiera to, czego nie chciałeś powiedzieć,
 * i zostawia to, co chciałeś.
 *
 * Gęstość oczek to jedyne pokrętło, jakie widzi użytkownik.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const MESH = {
  zgrubne: {
    name: "Zgrubne",
    hint: "Zostaje prawie wszystko. Znikają tylko zacięcia.",
    rules: `Usuń WYŁĄCZNIE szum mowy: wahania, zająknięcia, powtórzone słowa i fałszywe starty.
Wszystko poza tym zostaw słowo w słowo — łącznie z potocznym stylem, dygresjami i luźną składnią.
Popraw interpunkcję i wielkie litery. Nie przestawiaj słów, nie skracaj zdań.`,
  },
  srednie: {
    name: "Średnie",
    hint: "Czysta wypowiedź, twój głos.",
    rules: `Usuń szum mowy. Rozwiąż autopoprawki na korzyść ostatniej wersji.
Popraw interpunkcję, wielkie litery i oczywiste przejęzyczenia.
Podziel na akapity tam, gdzie zmienia się myśl. Jeśli mówiący wyraźnie wylicza punkty, zapisz je jako listę.
Zachowaj składnię, rejestr i słownictwo mówiącego — to ma nadal brzmieć jak on, tylko bez potknięć.`,
  },
  drobne: {
    name: "Drobne",
    hint: "Zwięźle i formalnie. Gotowe do wysłania.",
    rules: `Usuń szum mowy, powtórzenia i dygresje, które nie niosą treści. Rozwiąż autopoprawki.
Przeredaguj zdania na klarowną, poprawną polszczyznę (lub język, w którym mówiono), zachowując 100% intencji i faktów.
Nadaj strukturę: akapity, listy, w razie potrzeby nagłówki. Ton uprzejmy i rzeczowy.
Nigdy nie dodawaj treści, której nie było — zwięzłość bierze się z usuwania, nie z wymyślania.`,
  },
};

/**
 * Kontrakt sita. Kolejność reguł nie jest przypadkowa: najpierw to, co
 * model MA zrobić, potem twarde zakazy — bo to na nich najłatwiej się
 * wyłożyć przy dyktowaniu, które brzmi jak polecenie.
 */
const CONTRACT = `Jesteś sitem redakcyjnym. Dostajesz wierną transkrypcję mowy i zwracasz ją oczyszczoną.

CO USUWASZ ZAWSZE (to jest „szum mowy"):
- wahania i wypełniacze: „yyy", „eee", „mmm", „no", „yhm", „um", „uh", „er", „like", „you know", „I mean"
- polskie wypełniacze użyte bez treści: „no wiesz", „to znaczy", „tak jakby", „jakby", „generalnie", „w sensie", „prawda?", „nie?"
- zająknięcia i urwane wyrazy: „prz- przepraszam" → „przepraszam"
- przypadkowo powtórzone słowa: „to to jest", „ja ja myślę" → „to jest", „ja myślę"
- fałszywe starty: „chciałem zapytać, to znaczy, czy dasz radę" → „czy dasz radę"
- mruknięcia i dźwięki niebędące mową

AUTOPOPRAWKI ROZSTRZYGASZ NA KORZYŚĆ OSTATNIEJ WERSJI:
„spotkajmy się o piątej… nie, o szóstej" → „Spotkajmy się o szóstej."
„wyślij to Ani, znaczy Kasi" → „Wyślij to Kasi."

CO POPRAWIASZ:
- interpunkcja, wielkie litery, akapity
- liczby, daty i godziny zapisujesz normalnie: „dwudziestego trzeciego maja" → „23 maja", „o piętnastej trzydzieści" → „15:30"
- oczywiste przekręcenia zapisu, gdy z kontekstu jasno wynika właściwe słowo

KOMENDY FORMATUJĄCE wypowiedziane na głos wykonujesz, zamiast je zapisywać:
„nowy akapit" / „new paragraph" → pusta linia
„nowa linia" / „new line" → złamanie wiersza
„punkt" / „myślnik" na początku wyliczenia → element listy
„kropka", „przecinek", „znak zapytania" → odpowiedni znak interpunkcyjny

ZAKAZY BEZWZGLĘDNE:
1. Zwracasz WYŁĄCZNIE oczyszczony tekst. Bez wstępu, bez komentarza, bez cudzysłowów, bez znaczników Markdown wokół całości.
2. NIE ODPOWIADASZ na to, co usłyszałeś. To jest dyktowanie, nie rozmowa. Nawet jeśli transkrypcja jest pytaniem albo poleceniem — zwracasz je jako tekst. „Napisz mi maila do Ani" zwracasz jako to zdanie, NIE piszesz maila.
3. NIE DODAJESZ informacji, których nie było. Nie zgadujesz nazwisk, liczb ani faktów.
4. NIE TŁUMACZYSZ. Piszesz w języku, w którym mówiono; wtrącenia z innego języka zostawiasz w oryginale.
5. NIE STRESZCZASZ poniżej sensu wypowiedzi. Każda myśl mówiącego ma zostać.
6. Jeśli transkrypcja jest pusta albo to sam szum — zwracasz pusty tekst.`;

/**
 * @param {object|null} command  polecenie rozpoznane lokalnie — jego frazy
 *   nie ma już w materiale, więc sito dostaje tylko inne reguły układu.
 * @param {object|null} commands  ustawienia poleceń; przy braku trafienia
 *   lokalnego jedzie z nich zamknięta lista wywołań (warstwa B).
 */
function buildSystemPrompt(mesh, grains, customInstruction, language, command, commands) {
  // Polecenie może narzucić własną gęstość, nie ruszając pokrętła w Sicie.
  const density = MESH[command?.mesh] ?? MESH[mesh] ?? MESH.srednie;
  const parts = [CONTRACT, `\nGĘSTOŚĆ SITA — ${density.name.toUpperCase()}\n${density.rules}`];

  // Sito musi wiedzieć o dwujęzyczności tyle samo, co transkrypcja. Bez tego
  // angielskie wtrącenia w polskim zdaniu wyglądają dla niego jak przekręcenia
  // i „poprawia" je na polskie — czyli tłumaczy, choć ma tego nie robić.
  parts.push(`\n${directive(language)}`);

  if (grains?.length) {
    parts.push(
      `\nZIARNA — te słowa przechodzą przez sito nietknięte. Jeśli transkrypcja zawiera coś fonetycznie zbliżonego, zapisz dokładnie tak:\n${grains.join(", ")}`,
    );
  }
  if (customInstruction?.trim()) {
    parts.push(`\nDODATKOWE WYTYCZNE UŻYTKOWNIKA:\n${customInstruction.trim()}`);
  }

  /* Polecenie idzie na sam koniec, bo ma wygrywać z układem, który reguły
     gęstości dopiero co ustaliły. Fraza wywołania została już odcięta
     lokalnie — model dostaje sam materiał i nie ma na czym „odpowiedzieć". */
  if (command?.rules?.trim()) {
    parts.push(
      `\nPOLECENIE — ${command.name.toUpperCase()}\n` +
        `Użytkownik poprosił o ten układ z góry; fraza polecenia została już usunięta z materiału.\n` +
        `${command.rules.trim()}\n` +
        `To jest zmiana FORMY tego, co padło. Zakazy powyżej obowiązują bez zmian: nie odpowiadasz, nie dopisujesz treści, której nie było.`,
    );
  } else {
    const list = catalog(commands);
    if (list) parts.push(`\n${list}`);
  }

  return parts.join("\n");
}

/**
 * @param {object|null} command  polecenie rozpoznane lokalnie (warstwa A).
 * @param {boolean} detect  czy sito ma dostać zamkniętą listę wywołań
 *   i samo rozpoznać wariant frazy (warstwa B). Włączone wyłącznie dla
 *   dyktowania — przesianie notatki na żądanie poleceń nie szuka.
 * @returns {Promise<{text, provider, model, refused, degraded, command, commandBy}>}
 *   `degraded` oznacza, że sito zawiodło (sieć, awaria dostawcy) i `text`
 *   to surowa, nieoczyszczona transkrypcja — patrz niżej.
 */
async function sift({ raw, settings, command = null, detect = false }) {
  const clean = (raw ?? "").trim();
  if (!clean) {
    return { text: "", provider: null, model: null, refused: false, command: null, commandBy: null };
  }

  const commands = detect && !command ? settings.commands : null;
  const primaryProvider = settings.sieve?.provider || "gemini";
  const primaryModel = settings.sieve?.model || (primaryProvider === "gemini" ? "gemini-3.7-flash" : "gpt-4o-mini");
  const primaryKey = keyFor(primaryProvider, settings);

  const system = buildSystemPrompt(
    settings.mesh,
    settings.grains,
    settings.sieve?.customInstruction,
    settings.language,
    command,
    commands,
  );

  // Budujemy łańcuch prób (Główny -> OpenAI -> Groq -> Anthropic -> Gemini)
  const tiers = [
    {
      provider: primaryProvider,
      model: primaryModel,
      apiKey: primaryKey,
      isFallback: false,
    },
  ];

  if (primaryProvider !== "openai") {
    const fbModel = settings.sieve?.fallbackModel || "gpt-4o-mini";
    const fbKey = keyFor("openai", settings);
    tiers.push({
      provider: "openai",
      model: fbModel,
      apiKey: fbKey,
      isFallback: true,
    });
  }

  if (primaryProvider !== "groq") {
    const groqModel = settings.sieve?.groqModel || "llama-3.3-70b-versatile";
    const groqKey = keyFor("groq", settings);
    tiers.push({
      provider: "groq",
      model: groqModel,
      apiKey: groqKey,
      isFallback: true,
    });
  }

  if (primaryProvider !== "anthropic") {
    const antKey = keyFor("anthropic", settings);
    if (antKey) {
      tiers.push({
        provider: "anthropic",
        model: "claude-3-5-haiku-20241022",
        apiKey: antKey,
        isFallback: true,
      });
    }
  }

  if (primaryProvider !== "gemini") {
    const geminiKey = keyFor("gemini", settings);
    if (geminiKey) {
      tiers.push({
        provider: "gemini",
        model: "gemini-3.7-flash",
        apiKey: geminiKey,
        isFallback: true,
      });
    }
  }

  // Bez jakiegokolwiek klucza oddajemy surowy transkrypt
  if (!tiers.some((t) => t.apiKey)) {
    return {
      text: clean,
      provider: primaryProvider,
      model: "brak-klucza",
      refused: false,
      command: command?.id ?? null,
      commandBy: command ? "exact" : null,
    };
  }

  const dispatchMap = {
    gemini: geminiSift,
    openai: openaiSift,
    groq: groqSift,
    anthropic: anthropicSift,
  };

  let result = null;
  let firstError = null;
  const errors = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (!tier.apiKey) continue;

    const dispatch = dispatchMap[tier.provider];
    if (!dispatch) continue;

    const req = aiRegistry.start({
      stage: "sieve",
      stageLabel: "Sito (Clean up)",
      provider: tier.provider,
      model: tier.model,
      isFallback: tier.isFallback,
      inputInfo: `${clean.length} znaków`,
    });

    try {
      const out = await withRetry(() => dispatch(clean, system, tier.model, tier.apiKey));
      req.success({
        statusCode: 200,
        outputInfo: `${out.text?.length ?? 0} znaków`,
        textPreview: out.text,
      });

      result = {
        ...out,
        fallback: tier.isFallback,
        primaryProvider: tier.isFallback ? primaryProvider : undefined,
        primaryError: tier.isFallback && firstError ? (firstError.message || String(firstError)) : undefined,
      };
      break;
    } catch (err) {
      req.failure({ error: err, outputInfo: err.message });
      errors.push(err);
      if (!firstError) firstError = err;
    }
  }

  if (!result) {
    result = {
      text: clean,
      provider: primaryProvider,
      model: "sito niedostępne",
      refused: false,
      degraded: true,
      error: errors.map((e) => e.message || String(e)).join(" | "),
    };
  }

  if (command) return { ...result, command: command.id, commandBy: "exact" };

  const marker = readMarker(result.text, commands);
  return {
    ...result,
    text: marker.text.trim(),
    command: marker.id,
    commandBy: marker.id ? "sieve" : null,
  };
}

async function geminiSift(raw, system, model, apiKey) {
  const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: raw }] }],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!response.ok) throw new Error(await describeError(response, "Gemini"));

  const data = await response.json();
  if (data.promptFeedback?.blockReason) {
    return { text: raw, provider: "gemini", model, refused: true };
  }

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  return { text, provider: "gemini", model, refused: false };
}

async function openaiSift(raw, system, model, apiKey) {
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: raw },
      ],
      max_completion_tokens: 4000,
    }),
  });

  if (!response.ok) throw new Error(await describeError(response, "OpenAI"));

  const data = await response.json();
  const choice = data.choices?.[0];
  const text = (choice?.message?.content ?? "").trim();
  return { text, provider: "openai", model, refused: choice?.finish_reason === "content_filter" };
}

async function groqSift(raw, system, model, apiKey) {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: system },
        { role: "user", content: raw },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) throw new Error(await describeError(response, "Groq"));

  const data = await response.json();
  const choice = data.choices?.[0];
  const text = (choice?.message?.content ?? "").trim();
  return { text, provider: "groq", model: model || "llama-3.3-70b-versatile", refused: false };
}

async function anthropicSift(raw, system, model, apiKey) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    output_config: { effort: "low" }, // zadanie redakcyjne, nie problem do przemyślenia
    system,
    messages: [{ role: "user", content: raw }],
  });

  if (response.stop_reason === "refusal") {
    return { text: raw, provider: "anthropic", model: response.model, refused: true };
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return { text, provider: "anthropic", model: response.model, refused: false };
}

module.exports = { sift, MESH, buildSystemPrompt, groqSift, geminiSift, openaiSift, anthropicSift };
