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

const MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 godzin — po tym czasie plik tymczasowy jest automatycznie kasowany

function dir() {
  const d = path.join(app.getPath("userData"), "ratunek");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Zapisuje nagranie razem z tym, co się stało — do pokazania i do ponowienia. */
function stash(audio, info = {}) {
  purgeExpired();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const meta = { id, savedAt: new Date().toISOString(), ...info };
  fs.writeFileSync(path.join(dir(), `${id}.wav`), audio);
  fs.writeFileSync(path.join(dir(), `${id}.json`), JSON.stringify(meta, null, 2));
  // Kopia wskaźnika na ostatnie nagranie
  fs.writeFileSync(path.join(dir(), "latest.json"), JSON.stringify({ id, savedAt: meta.savedAt }));
  return id;
}

/** Co czeka na powrót sieci — najnowsze pierwsze. */
function list() {
  purgeExpired();
  return fs
    .readdirSync(dir())
    .filter((name) => name.endsWith(".json") && name !== "latest.json")
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
  const latestFile = path.join(dir(), "latest.json");
  try {
    if (fs.existsSync(latestFile)) {
      const latest = JSON.parse(fs.readFileSync(latestFile, "utf8"));
      if (latest.id === id) fs.rmSync(latestFile, { force: true });
    }
  } catch {}
}

/**
 * Nagrania starsze niż 8 godzin.
 * Plik tymczasowy ma być przechowywany przez 8h, a potem automatycznie kasowany.
 */
function purgeExpired() {
  const cutoff = Date.now() - MAX_AGE_MS;
  try {
    const files = fs.readdirSync(dir()).filter((name) => name.endsWith(".json") && name !== "latest.json");
    for (const name of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir(), name), "utf8"));
        if (new Date(meta.savedAt).getTime() < cutoff) {
          remove(meta.id);
        }
      } catch {
        // Uszkodzony plik metadanych — usuwamy
        const baseId = name.replace(/\.json$/, "");
        remove(baseId);
      }
    }
  } catch {}
}

function audioFor(id) {
  const file = path.join(dir(), `${id}.wav`);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

/**
 * Zwraca metadane i bufor audio ostatniego zapisanego nagrania, jeśli istnieje.
 */
function last() {
  const pending = list();
  if (!pending.length) return null;
  const meta = pending[0];
  const audio = audioFor(meta.id);
  return { ...meta, audio };
}

/**
 * Próba odzyskania konkretnie ostatniego nagrania.
 */
async function retryLast(settings, onRescued) {
  const item = last();
  if (!item || !item.audio) {
    throw new Error("Brak zapisanego nagrania do odzyskania.");
  }
  let raw = item.raw;
  let provider = item.provider ?? settings.stt.provider;
  let sttModel = item.sttModel ?? settings.stt.model;
  if (!raw) {
    const tr = await transcribe(item.audio, settings);
    raw = tr.text;
    provider = tr.provider;
    sttModel = tr.model;
  }
  if (!raw.trim()) {
    remove(item.id);
    throw new Error("Nagranie okazało się puste po transkrypcji.");
  }
  const result = await sift({ raw, settings });
  const rescuedEntry = {
    ...item,
    raw,
    text: result.text || raw,
    provider,
    sttModel,
    model: result.model,
  };
  if (onRescued) await onRescued(rescuedEntry);
  remove(item.id);
  return rescuedEntry;
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
      let raw = meta.raw;
      let provider = meta.provider ?? settings.stt.provider;
      let sttModel = meta.sttModel ?? settings.stt.model;
      if (!raw) {
        const tr = await transcribe(audio, settings);
        raw = tr.text;
        provider = tr.provider;
        sttModel = tr.model;
      }
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

module.exports = { stash, list, remove, purgeExpired, flush, last, retryLast, MAX_AGE_MS };
