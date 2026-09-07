"use strict";
/**
 * Test na sucho: podstawia fetch i sprawdza, czy żądania do dostawców
 * budują się poprawnie. Nie potrzebuje kluczy ani sieci.
 *   node scripts/smoke.js
 */
const assert = require("assert");

// stt.js i sieve.js nie dotykają Electrona, więc dają się załadować wprost.
const { transcribe } = require("../src/main/stt");
const { sift, buildSystemPrompt } = require("../src/main/sieve");

const calls = [];
global.fetch = async (url, init) => {
  calls.push({ url, init, body: init.body ? JSON.parse(tryJson(init.body)) : null });
  return {
    ok: true,
    status: 200,
    json: async () =>
      url.includes("googleapis")
        ? { candidates: [{ content: { parts: [{ text: "odpowiedź gemini" }] } }] }
        : { choices: [{ message: { content: "odpowiedź openai" }, finish_reason: "stop" }], text: "odpowiedź openai" },
  };
};
function tryJson(body) {
  return typeof body === "string" ? body : "null";
}

const base = {
  mesh: "srednie",
  language: "auto",
  grains: ["Cribro", "Hostinger"],
  stt: { provider: "gemini", model: "gemini-3.7-flash", apiKey: "AIza-test" },
  sieve: { provider: "gemini", model: "gemini-3.1-pro", apiKey: "", customInstruction: "" },
};
const audio = Buffer.from("RIFFfake");

(async () => {
  /* 1. Gemini: transkrypcja */
  calls.length = 0;
  let out = await transcribe(audio, base);
  let call = calls[0];
  assert.ok(call.url.includes("/models/gemini-3.7-flash:generateContent"), "zły URL modelu");
  assert.equal(call.init.headers["x-goog-api-key"], "AIza-test", "brak nagłówka z kluczem");
  assert.ok(call.body.contents[0].parts[1].inlineData.mimeType === "audio/wav", "zły mime audio");
  assert.equal(out.text, "odpowiedź gemini");
  console.log("✓ Gemini transkrypcja: URL, nagłówek i audio/wav");

  /* 2. Wspólny klucz: sito nie ma własnego, ale ten sam dostawca co krok 1 */
  calls.length = 0;
  out = await sift({ raw: "yyy to to znaczy działa", settings: base });
  call = calls[0];
  assert.equal(call.init.headers["x-goog-api-key"], "AIza-test", "klucz nie został współdzielony");
  assert.ok(call.url.includes("gemini-3.1-pro"), "sito użyło modelu transkrypcji");
  assert.ok(call.body.systemInstruction.parts[0].text.includes("NIE ODPOWIADASZ"), "brak kontraktu w systemInstruction");
  assert.equal(out.text, "odpowiedź gemini");
  console.log("✓ Sito Gemini: wspólny klucz, własny model, prompt systemowy");

  /* 3. OpenAI po obu stronach */
  calls.length = 0;
  const openai = {
    ...base,
    stt: { provider: "openai", model: "gpt-transcribe", apiKey: "sk-test" },
    sieve: { provider: "openai", model: "gpt-5.6-terra", apiKey: "", customInstruction: "" },
  };
  await transcribe(audio, openai);
  assert.ok(calls[0].url.includes("/v1/audio/transcriptions"), "zły endpoint STT OpenAI");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");

  calls.length = 0;
  await sift({ raw: "test", settings: openai });
  assert.ok(calls[0].url.includes("/v1/chat/completions"), "zły endpoint sita OpenAI");
  assert.equal(calls[0].body.model, "gpt-5.6-terra");
  assert.equal(calls[0].body.messages[0].role, "system");
  console.log("✓ OpenAI: transkrypcja i sito na właściwych endpointach");

  /* 4. Brak klucza → surowy tekst, bez wyjątku */
  const noKey = {
    ...base,
    stt: { provider: "mock", model: "mock", apiKey: "" },
    sieve: { provider: "gemini", model: "gemini-3.7-flash", apiKey: "", customInstruction: "" },
  };
  const raw = "yyy no wiesz to działa";
  out = await sift({ raw, settings: noKey });
  assert.equal(out.text, raw, "bez klucza sito powinno oddać surowy tekst");
  assert.equal(out.model, "brak-klucza");
  console.log("✓ Bez klucza: sito oddaje surowy transkrypt zamiast rzucać błędem");

  /* 5. Ziarna i gęstość trafiają do promptu */
  const prompt = buildSystemPrompt("drobne", ["Cribro", "Hostinger"], "Nie używaj wykrzykników.");
  assert.ok(prompt.includes("DROBNE"), "brak gęstości sita");
  assert.ok(prompt.includes("Cribro, Hostinger"), "brak ziaren");
  assert.ok(prompt.includes("Nie używaj wykrzykników."), "brak własnej wytycznej");
  assert.ok(prompt.includes("NIE ODPOWIADASZ"), "brak zakazu odpowiadania");
  console.log("✓ Prompt: gęstość, ziarna, własna wytyczna i zakazy");

  /* 6. Dwujęzyczność — to, po co w ogóle jest ten tryb */
  const bilingual = {
    ...base,
    language: { mode: "bilingual", primary: "pl", secondary: "en" },
    stt: { provider: "openai", model: "whisper-1", apiKey: "sk-test" },
  };

  calls.length = 0;
  await transcribe(audio, bilingual);
  const form = calls[0].init.body;
  assert.ok(!form.has("language"), "przy dwóch językach kod języka nie może iść do Whispera");
  assert.ok(String(form.get("prompt")).includes("angielski"), "brak podpowiedzi o drugim języku");
  console.log("✓ Dwujęzycznie: Whisper bez narzuconego kodu, z podpowiedzią o parze");

  calls.length = 0;
  await transcribe(audio, { ...bilingual, language: { mode: "single", primary: "pl" } });
  assert.equal(calls[0].init.body.get("language"), "pl", "przy jednym języku kod ma iść wprost");
  console.log("✓ Jeden język: kod idzie do Whispera wprost");

  // Sito musi wiedzieć o dwujęzyczności tyle samo, co transkrypcja — inaczej
  // „poprawi" angielskie wtrącenia na polskie, czyli je przetłumaczy.
  const bilingualPrompt = buildSystemPrompt("srednie", [], "", bilingual.language);
  assert.ok(bilingualPrompt.includes("DWUJĘZYCZNIE"), "sito nie wie o dwóch językach");
  assert.ok(bilingualPrompt.includes("NIE TŁUMACZ"), "brak zakazu tłumaczenia");
  console.log("✓ Sito wie o parze języków i ma zakaz tłumaczenia");

  /* 7. Sieć potyka się raz i wraca za drugim razem — bez powtórki ginęłoby całe nagranie */
  {
    const originalFetch = global.fetch;
    let attempt = 0;
    global.fetch = async (url, init) => {
      attempt += 1;
      if (attempt === 1) throw new Error("fetch failed");
      return originalFetch(url, init);
    };
    out = await transcribe(audio, base);
    assert.equal(attempt, 2, "powinna paść dokładnie jedna powtórka");
    assert.equal(out.text, "odpowiedź gemini");
    global.fetch = originalFetch;
    console.log("✓ Transkrypcja: jedna potknięta sieć nie kosztuje nagrania");
  }

  /* 8. Sito padło mimo powtórki → surowy transkrypt zamiast utraty całości */
  {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, text: async () => "" });
    const rawText = "yyy no wiesz to działa";
    out = await sift({ raw: rawText, settings: base });
    assert.equal(out.text, rawText, "sito padłe powinno oddać surowy transkrypt");
    assert.equal(out.degraded, true, "brak flagi degraded przy awarii sita");
    global.fetch = originalFetch;
    console.log("✓ Sito: awaria dostawcy po powtórce oddaje surowy tekst, nie wyjątek");
  }

  /* 9. Zapętlona odpowiedź dostawcy — nie wolno jej wpuścić do historii.

     Prawdziwy przypadek z 7 września 2026: dwadzieścia trzy sekundy wahania
     wróciły jako 32 765 słów, z czego 32 760 razy „no,". Taki wpis potem
     zamrażał okno przy każdym rysowaniu listy. */
  {
    const { loopedTranscript } = require("../src/main/stt");

    const zapetlone = ("No, yyy, wiesz, " + "no, ".repeat(32760)).trim();
    assert.ok(loopedTranscript(zapetlone), "powtórzone no ma zostać wyłapane");
    assert.match(loopedTranscript(zapetlone), /zaciął się na słowie/);

    assert.ok(loopedTranscript("no, yyy, ".repeat(200)), "krążenie po dwóch słowach to też zapętlenie");

    /* Zwykłe długie dyktowanie ma przejść — próg bez tego byłby cenzurą
       na wypowiedzi, a nie sitem na usterki. */
    const zwykle = Array.from({ length: 400 }, (_, i) => `słowo${i % 180}`).join(" ");
    assert.equal(loopedTranscript(zwykle), null, "prawdziwe dyktowanie nie jest zapętleniem");

    /* Krótkie powtórzenie to zniecierpliwienie, nie awaria. */
    assert.equal(loopedTranscript("tak, tak, tak"), null, "krótkie powtórzenie ma przejść");
    assert.equal(loopedTranscript(""), null, "pusty tekst nie jest zapętleniem");

    console.log("✓ Zapętlona transkrypcja jest wyłapywana, a zwykłe dyktowanie przechodzi");
  }

  /* 10. Zapętlenie dostaje JEDNĄ powtórkę — jest losowe, więc drugi strzał
        zwykle wraca normalnym tekstem. */
  {
    const { isTransient } = require("../src/main/stt");
    const error = new Error("Transkrypcja się zapętliła — …");
    error.kind = "zapętlenie";
    assert.equal(isTransient(error), true, "zapętlenie ma prawo do powtórki");
    assert.equal(isTransient(new Error("Brak klucza API")), false, "zły klucz powtórki nie dostaje");
    console.log("✓ Zapętlenie jest ponawiane raz, a błąd klucza nie");
  }

  console.log("\nWszystkie sprawdzenia przeszły.");
})().catch((error) => {
  console.error("✗", error.message);
  process.exit(1);
});
