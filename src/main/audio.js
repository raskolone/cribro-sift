"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Dźwięk na dysku — mniejszy, niż wyszedł z nagrywania.
 *
 * Godzina rozmowy to sto piętnaście megabajtów NA TOR w surowym WAV-ie.
 * Przy dwóch torach i dwóch spotkaniach dziennie robi się z tego pół
 * gigabajta tygodniowo — i to jest jedyny powód, dla którego nagranie
 * domyślnie ginie po transkrypcji. A ginie szkoda: z pliku da się
 * przepisać jeszcze raz lepszym modelem i da się odsłuchać zdanie,
 * którego zapis nie zrozumiał.
 *
 * AAC 32 kb/s robi z tych stu piętnastu megabajtów czternaście, a mowa
 * przy szesnastu kilohercach nie ma czego na tym stracić — to i tak jest
 * pasmo telefoniczne. Konwertuje `afconvert`, który stoi w każdym macOS:
 * bez bibliotek, bez pobierania, bez licencji.
 *
 * W DRUGĄ STRONĘ TEŻ, bo przepisywanie tnie surowe próbki (main/segments.js)
 * i nie umie czytać skompresowanego strumienia. Rozpakowujemy więc do
 * pliku tymczasowego na czas przepisywania i kasujemy zaraz po nim.
 */

const RATE = 16000;
/** Ile bitów na sekundę. Mowa mono przy 16 kHz — trzydzieści dwa kilobity
    to i tak więcej, niż niesie sam sygnał. */
const BITRATE = 32000;

const run = (args) =>
  new Promise((resolve, reject) => {
    execFile("afconvert", args, { timeout: 10 * 60_000 }, (problem, _out, err) => {
      if (problem) reject(new Error(`afconvert: ${String(err || problem.message).trim()}`));
      else resolve(true);
    });
  });

/**
 * WAV → AAC. Oddaje ścieżkę pliku wynikowego; źródło kasuje.
 *
 * Przy niepowodzeniu ODDAJE ŚCIEŻKĘ ŹRÓDŁA i nie kasuje niczego —
 * nieskompresowane nagranie jest gorsze od skompresowanego, ale nagranie
 * skasowane bez zamiennika jest gorsze od obu.
 */
async function shrink(file) {
  if (!file || !fs.existsSync(file)) return file;
  const out = file.replace(/\.wav$/i, "") + ".m4a";
  try {
    await run(["-f", "m4af", "-d", "aac", "-b", String(BITRATE), file, out]);
    if (!fs.existsSync(out) || fs.statSync(out).size < 512) throw new Error("pusty wynik");
    fs.rmSync(file, { force: true });
    return out;
  } catch {
    fs.rmSync(out, { force: true });
    return file;
  }
}

/**
 * AAC → WAV do pliku tymczasowego. Oddaje ścieżkę; sprząta wywołujący.
 *
 * Plik, który już jest WAV-em, wraca bez zmian i bez kopiowania — po to,
 * żeby wywołujący nie musiał wiedzieć, w czym trzyma nagranie.
 */
async function expand(file) {
  if (!file || !fs.existsSync(file)) return { file, temporary: false };
  if (/\.wav$/i.test(file)) return { file, temporary: false };
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "cribro-audio-")),
    path.basename(file).replace(/\.[^.]+$/, "") + ".wav",
  );
  await run(["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", file, out]);
  return { file: out, temporary: true };
}

/** Ile miejsca zajmuje nagranie spotkania — do pokazania człowiekowi. */
function weigh(tracks) {
  let bytes = 0;
  for (const file of Object.values(tracks ?? {})) {
    if (file && fs.existsSync(file)) bytes += fs.statSync(file).size;
  }
  return bytes;
}

module.exports = { shrink, expand, weigh, BITRATE, RATE };
