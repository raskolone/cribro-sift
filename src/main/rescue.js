"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { transcribe } = require("./stt");
const { sift } = require("./sieve");

/**
 * Ratunek — lokalna kopia nagrania, gdy transkrypcja nie ma jak dojść do
 * dostawcy: brak internetu, jego chwilowa awaria albo wyczerpane próby
 * z main/stt.js.
 *
 * Bez tego nagranie ginęło bezpowrotnie w tej samej sekundzie, w której
 * zawodziło żądanie — a dyktowanie kosztuje uwagę tylko raz: druga próba,
 * chwilę później, rzadko brzmi tak samo i prawie nigdy nie pada od razu.
 * WAV i to, co się działo, leżą więc obok siebie w katalogu użytkownika
 * i czekają na powrót sieci — sam ratunek nie decyduje, kiedy to sprawdzić,
 * tylko oddaje flush() temu, kto wie, że sieć akurat wróciła (main.js).
 */

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // tydzień — po nim nikt już nie pamięta kontekstu wypowiedzi

function dir() {
  const d = path.join(app.getPath("userData"), "ratunek");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Zapisuje nagranie razem z tym, co się stało — do pokazania i do ponowienia. */
function stash(audio, info = {}) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const meta = { id, savedAt: new Date().toISOString(), ...info };
  fs.writeFileSync(path.join(dir(), `${id}.wav`), audio);
  fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify(meta, null, 2));
  return id;
}

/** Co czeka na powrót sieci — najnowsze pierwsze. */
function list() {
  return fs
    .readdirSync(dir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir(), name), "utf8"));
      } catch {
        return null; // sidecar uszkodzony — traktujemy jak nieobecny, purgeExpired go później sprzątnie
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

function remove(id) {
  fs.rmSync(path.join(dir(), `${id}.wav`), { force: true });
  fs.rmSync(path.join(dir(), `${id}.json`), { force: true });
}

/**
 * Nagrania starsze niż tydzień. Trzymanie ich dłużej nie ratuje niczego —
 * kontekst rozmowy, do której miały trafić, jest już dawno zamknięty.
 */
function purgeExpired() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const meta of list()) {
    if (new Date(meta.savedAt).getTime() < cutoff) remove(meta.id);
  }
}

function audioFor(id) {
  const file = path.join(dir(), `${id}.wav`);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

/**
 * Próba dogonienia zaległości: dla każdego czekającego nagrania powtarza
 * transkrypcję i sito od zera, z bieżącymi ustawieniami (mogły się zmienić,
 * odkąd nagranie utknęło). Ten sam dostawca, który wcześniej zawiódł, mógł
 * już wrócić — a jeśli nie, plik po prostu zostaje na kolejną próbę.
 *
 * @param {object} settings  bieżące ustawienia aplikacji
 * @param {(rescued: object) => Promise<void>|void} onRescued  co zrobić
 *   z odzyskanym tekstem — zwykle dopisanie wpisu do historii
 * @returns {Promise<{done: number, remaining: number}>}
 */
async function flush(settings, onRescued) {
  const pending = list();
  let done = 0;
  for (const meta of pending) {
    const audio = audioFor(meta.id);
    if (!audio) {
      remove(meta.id); // sidecar bez pliku dźwiękowego — nie ma czego ratować
      continue;
    }
    try {
      const { text: raw, provider, model: sttModel } = await transcribe(audio, settings);
      if (!raw.trim()) {
        remove(meta.id);
        continue;
      }
      const result = await sift({ raw, settings });
      await onRescued({
        ...meta,
        raw,
        text: result.text || raw,
        provider,
        sttModel,
        model: result.model,
      });
      remove(meta.id);
      done += 1;
    } catch {
      // sieć dalej nie działa (albo znów nie) — plik zostaje na następną próbę
    }
  }
  return { done, remaining: pending.length - done };
}

module.exports = { stash, list, remove, purgeExpired, flush, MAX_AGE_MS };
