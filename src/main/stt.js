"use strict";

const { keyFor } = require("./providers");
const { directive, fixedCode, whisperHint } = require("./languages");

/**
 * Krok 1 — głos na tekst.
 *
 * Transkrypcja ma być WIERNA: zacięcia, powtórzenia i „yyy" mają zostać.
 * Czyszczeniem zajmuje się dopiero sito, w osobnym wywołaniu. Dzięki temu
 * widać potem w historii, co dokładnie odpadło.
 *
 * Nagranie przychodzi jako WAV 16 kHz mono — format, który przyjmują
 * wszyscy dostawcy bez konwersji.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_INLINE_BYTES = 18 * 1024 * 1024; // Gemini przyjmuje 20 MB na całe żądanie

const VERBATIM_PROMPT = `Zapisz dokładnie to, co słychać w nagraniu.

Zasady:
- Przepisz mowę wiernie, słowo w słowo, razem z wahaniami („yyy", „eee", „no"), powtórzeniami i urwanymi zdaniami.
- Nie poprawiaj, nie skracaj, nie porządkuj. Od tego jest następny krok.
- Nie dodawaj nic od siebie: żadnych nagłówków, komentarzy, cudzysłowów ani znaczników czasu.
- Zachowaj język, w którym mówiono. Wtrącenia z innego języka zostaw w oryginale.
- Jeśli w nagraniu nie ma mowy, zwróć pusty tekst.

Zwróć wyłącznie treść wypowiedzi.`;

const MOCK_TRANSCRIPTS = [
  "yyy dobra to znaczy chciałem powiedzieć że eee ta funkcja z sitem no wiesz ona powinna działać tak że użytkownik trzyma dwa klawisze i mówi i potem yyy to znaczy jak puści to się kończy nagranie i tekst leci do schowka automatycznie",
  "hej Aniu eee chciałem zapytać czy dasz radę przesłać mi ten raport do piątku no to znaczy do czwartku bo w piątek mam już spotkanie z klientem i yyy potrzebuję to wcześniej przejrzeć dzięki wielkie",
  "no dobra więc plan na jutro jest taki że yyy po pierwsze robimy przegląd zgłoszeń potem eee to znaczy najpierw kawa a potem przegląd zgłoszeń no i po drugie musimy się zdecydować co robimy z tym starym API bo ono nam yyy leży i kwiczy",
];

/**
 * @param {Buffer} audio  bajty pliku WAV
 * @param {object} settings  całe ustawienia (potrzebne do współdzielenia klucza)
 * @returns {Promise<{text: string, provider: string, model: string}>}
 */
async function transcribe(audio, settings) {
  const { provider, model } = settings.stt;
  const language = settings.language;

  if (provider === "mock") {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const pick = MOCK_TRANSCRIPTS[Math.floor(Math.random() * MOCK_TRANSCRIPTS.length)];
    return { text: pick, provider, model: "mock" };
  }

  if (audio.length > MAX_INLINE_BYTES) {
    throw new Error(
      `Nagranie jest za długie (${Math.round(audio.length / 1024 / 1024)} MB). Podziel je na krótsze fragmenty.`,
    );
  }

  const apiKey = keyFor(provider, settings);
  if (!apiKey) throw new Error(`Brak klucza API dla dostawcy „${provider}".`);

  if (provider === "gemini") return geminiTranscribe(audio, model, apiKey, language);
  if (provider === "openai") return openaiTranscribe(audio, model, apiKey, language);
  throw new Error(`Nieznany dostawca transkrypcji: ${provider}`);
}

async function geminiTranscribe(audio, model, apiKey, language) {
  const hint = `\n\n${directive(language)}`;

  const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: VERBATIM_PROMPT + hint },
            { inlineData: { mimeType: "audio/wav", data: audio.toString("base64") } },
          ],
        },
      ],
      // Zero temperatury: transkrypcja to odczyt, nie twórczość.
      generationConfig: { temperature: 0 },
    }),
  });

  if (!response.ok) throw new Error(await describeError(response, "Gemini"));

  const data = await response.json();
  const blocked = data.promptFeedback?.blockReason;
  if (blocked) throw new Error(`Gemini odrzucił nagranie (${blocked}).`);

  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  return { text, provider: "gemini", model };
}

async function openaiTranscribe(audio, model, apiKey, language) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "dictation.wav");
  form.append("model", model);
  form.append("response_format", "json");

  // Kod języka tylko wtedy, gdy język jest jeden. Narzucony przy dwóch
  // językach kazałby Whisperowi zmielić drugi na pierwszy — czyli dokładnie
  // to, czego dwujęzyczne dyktowanie ma unikać.
  const code = fixedCode(language);
  if (code) form.append("language", code);
  const hint = whisperHint(language);
  if (hint) form.append("prompt", hint);

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) throw new Error(await describeError(response, "OpenAI"));

  const data = await response.json();
  return { text: (data.text ?? "").trim(), provider: "openai", model };
}

/** Komunikat, z którym da się cokolwiek zrobić, zamiast samego kodu HTTP. */
async function describeError(response, who) {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 240);
  try {
    detail = JSON.parse(body).error?.message ?? detail;
  } catch {
    /* nie każdy błąd jest JSON-em */
  }

  if (response.status === 401 || response.status === 403) {
    return `${who}: klucz API odrzucony (${response.status}). Sprawdź, czy wkleiłeś go w całości.`;
  }
  if (response.status === 404) {
    return `${who}: nie ma takiego modelu (404). Wybierz inny z listy w Ustawieniach.`;
  }
  if (response.status === 429) {
    return `${who}: przekroczony limit zapytań (429). Poczekaj chwilę i spróbuj ponownie.`;
  }
  return `${who} zwrócił błąd ${response.status}: ${detail}`;
}

module.exports = { transcribe, describeError };
