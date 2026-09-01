"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Dźwięk spotkania — strona Node'a.
 *
 * Cała robota natywna siedzi w `native/tap/main.swift`; tutaj jest to, co
 * musi wiedzieć aplikacja: gdzie leży ten program, jak go zatrzymać po
 * ludzku i jak rozpleść to, co z niego wychodzi, na dwa tory.
 *
 * Dlaczego w ogóle jest program natywny — patrz nagłówek main.swift.
 * W skrócie: Electron na macOS nie umie wziąć dźwięku systemu i mówi to
 * wprost we własnych typach.
 *
 * ── RAMKA ──
 *
 *     magia   4B  "CRIB"
 *     tor     1B  0 = mikrofon, 1 = system
 *     zapas   3B
 *     próbek  4B  uint32 little-endian
 *     czas    8B  double little-endian, milisekundy od startu strumienia
 *     próbki      16 bitów, mono, 16 kHz
 *
 * Magia nie jest ozdobą. Standardowe wyjście to wspólny kanał i wystarczy,
 * żeby jedna biblioteka uznała, że ma coś do powiedzenia, a odbiorca
 * przyjąłby jej zdanie za dźwięk. Po magii da się odnaleźć początek
 * następnej ramki i wrócić na tory.
 */

const MAGIC = Buffer.from("CRIB", "ascii");
const HEAD = 20;
const SAMPLE_RATE = 16000;

const LANE = { 0: "mic", 1: "system" };

/**
 * Ramki kompletne i reszta, która jeszcze się nie zebrała.
 *
 * Czysta funkcja — wchodzi bufor, wychodzi decyzja. Potok oddaje bajty
 * porcjami, jakie akurat wyjdą jądru, więc ramka bywa pocięta na pół
 * w dowolnym miejscu, a w jednej porcji potrafi przyjechać ich dwadzieścia.
 *
 * @param {Buffer} buffer
 * @returns {{frames: Array<{lane: string, millis: number, pcm: Buffer}>, rest: Buffer}}
 */
function parse(buffer) {
  const frames = [];
  let at = 0;

  while (at + HEAD <= buffer.length) {
    if (buffer.compare(MAGIC, 0, 4, at, at + 4) !== 0) {
      // Zgubiony rytm: szukamy następnej magii zamiast przyjmować śmieci
      // za próbki. Bez tego jeden obcy bajt psułby dźwięk już do końca.
      const next = buffer.indexOf(MAGIC, at + 1);
      if (next === -1) return { frames, rest: buffer.subarray(buffer.length) };
      at = next;
      continue;
    }

    const samples = buffer.readUInt32LE(at + 8);
    const bytes = samples * 2;
    if (at + HEAD + bytes > buffer.length) break; // reszta ramki jeszcze w drodze

    frames.push({
      lane: LANE[buffer[at + 4]] ?? "system",
      millis: buffer.readDoubleLE(at + 12),
      pcm: buffer.subarray(at + HEAD, at + HEAD + bytes),
    });
    at += HEAD + bytes;
  }

  return { frames, rest: buffer.subarray(at) };
}

/** Nagłówek WAV. Powstaje na końcu, bo dopiero wtedy znana jest długość. */
function wavHeader(payload) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + payload, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); // długość bloku fmt
  header.writeUInt16LE(1, 20); // PCM bez kompresji
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // bajtów na sekundę
  header.writeUInt16LE(2, 32); // bajtów na ramkę
  header.writeUInt16LE(16, 34); // bitów na próbkę
  header.write("data", 36, "ascii");
  header.writeUInt32LE(payload, 40);
  return header;
}

/**
 * Plik toru. Otwarty od razu, domykany nagłówkiem przy zamknięciu.
 *
 * ══ DLACZEGO PISZEMY PORCJAMI, A NIE RAMKAMI ══
 *
 * ScreenCaptureKit sypie ramkami kilkadziesiąt razy na sekundę, na każdy
 * tor osobno. Zapis ramka po ramce to ponad sto zapisów SYNCHRONICZNYCH
 * na sekundę — a synchronicznych znaczy: proces główny stoi i czeka na
 * dysk, sto razy na sekundę, przez całą godzinę rozmowy. Stoi wtedy razem
 * z nim wszystko, co proces główny robi poza tym: skróty klawiszowe,
 * meldunki do okien, obsługa menu.
 *
 * Sekunda dźwięku to 32 kB i jeden zapis. Cena jest widoczna i policzona:
 * po twardym ubiciu aplikacji ginie do sekundy nagrania zamiast do jednej
 * ramki. Za tę sekundę kupujemy stukrotnie mniej wejść do jądra — i tę
 * samą sekundę ratunek po awarii (patrz recover w main/meeting.js) i tak
 * odtwarza z rozmiaru pliku.
 */
const FLUSH_BYTES = 32 * 1024; // sekunda dźwięku przy 16 kHz mono

class Lane {
  constructor(file) {
    this.file = file;
    this.handle = fs.openSync(file, "w");
    this.payload = 0;
    this.held = [];
    this.holding = 0;
    fs.writeSync(this.handle, Buffer.alloc(44));
  }

  write(pcm) {
    /* Kopia, bo ramka jest wycinkiem wspólnego bufora, który za chwilę
       przestanie być aktualny — a my odkładamy ją na później. */
    this.held.push(Buffer.from(pcm));
    this.holding += pcm.length;
    this.payload += pcm.length;
    if (this.holding >= FLUSH_BYTES) this.flush();
  }

  /** Wszystko, co czeka, na dysk. Jedno wejście do jądra na porcję. */
  flush() {
    if (!this.holding) return;
    const batch = this.held.length === 1 ? this.held[0] : Buffer.concat(this.held, this.holding);
    this.held = [];
    this.holding = 0;
    fs.writeSync(this.handle, batch);
  }

  get seconds() {
    return this.payload / 2 / SAMPLE_RATE;
  }

  close() {
    // Reszta z bufora MUSI trafić na dysk przed nagłówkiem: nagłówek mówi,
    // ile bajtów jest w pliku, i skłamałby o tę ostatnią porcję.
    this.flush();
    fs.writeSync(this.handle, wavHeader(this.payload), 0, 44, 0);
    fs.closeSync(this.handle);
  }
}

/**
 * Gdzie leży program pomocniczy.
 *
 * W buildzie idzie do `Contents/Resources` (patrz extraResources
 * w package.json), przy pracy z kodem — do `native/build`. Sprawdzamy
 * obie drogi zamiast zgadywać po zmiennej środowiskowej: `npm start`
 * i podpisany bundle mają się zachowywać tak samo.
 */
function helperPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, "cribro-tap"),
    path.join(__dirname, "..", "..", "native", "build", "cribro-tap"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Najgłośniejsza próbka w porcji, 0…1 — do pierścienia HUD-a i znaczka. */
function peak(pcm) {
  let top = 0;
  for (let at = 0; at + 1 < pcm.length; at += 2) {
    const value = Math.abs(pcm.readInt16LE(at));
    if (value > top) top = value;
  }
  return top / 32768;
}

/**
 * Nagrywanie spotkania.
 *
 * @param {object} options
 * @param {string} options.dir       katalog na dwa pliki WAV
 * @param {string[]} [options.exclude]  aplikacje, których dźwięk pomijamy
 * @param {(level: number) => void} [options.onLevel]  głośność, do pokazania
 * @param {(lane: string, pcm: Buffer) => void} [options.onPcm]  próbki w biegu
 * @param {(message: string) => void} [options.onError]
 * @returns {{stop: () => Promise<object>, files: {mic: string, system: string}}}
 */
function record({ dir, exclude = [], onLevel, onPcm, onError } = {}) {
  const helper = helperPath();
  if (!helper) {
    throw new Error(
      "Nie znaleziono programu cribro-tap. Zbuduj go raz: npm run tap",
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  const files = {
    mic: path.join(dir, "tor-a-mikrofon.wav"),
    system: path.join(dir, "tor-b-system.wav"),
  };
  const lanes = { mic: new Lane(files.mic), system: new Lane(files.system) };

  const args = ["--stream"];
  if (exclude.length) args.push("--exclude", exclude.join(","));

  const child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe"] });

  let rest = Buffer.alloc(0);
  let closed = false;
  const startedAt = Date.now();

  child.stdout.on("data", (chunk) => {
    const { frames, rest: left } = parse(Buffer.concat([rest, chunk]));
    rest = left;
    for (const frame of frames) {
      lanes[frame.lane]?.write(frame.pcm);
      /* Te same próbki idą DALEJ, a nie tylko na dysk: z nich powstają
         odcinki do transkrypcji w biegu (main/segments.js). Kopii nie
         robimy — odbiorca dostaje wycinek wspólnego bufora i ma go zużyć
         od razu, tak jak robi to krajalnica. */
      if (onPcm) onPcm(frame.lane, frame.pcm);
      // Pokazujemy głośność MIKROFONU. Tor systemu też ma poziom, ale to
      // nie o nim człowiek chce wiedzieć, patrząc na znaczek: chce wiedzieć,
      // czy słychać JEGO.
      if (frame.lane === "mic" && onLevel) onLevel(peak(frame.pcm));
    }
  });

  // Program pomocniczy mówi na stderr i tylko tam — standardowe wyjście
  // należy do ramek. Awarie idą dalej, reszta jest przebiegiem pracy.
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    if (text.includes("BŁĄD")) onError?.(text.replace(/^BŁĄD:\s*/, ""));
  });

  child.on("error", (problem) => onError?.(problem.message));

  const finish = () => {
    if (closed) return;
    closed = true;
    for (const lane of Object.values(lanes)) lane.close();
  };

  return {
    files,
    get seconds() {
      return (Date.now() - startedAt) / 1000;
    },
    /**
     * Koniec nagrywania.
     *
     * Słowo „stop" na wejściu, nie sygnał: `kill` kończy program w połowie
     * ramki i wtedy ostatnia sekunda dźwięku ginie razem z tym, co w niej
     * padło. Sygnał zostaje na wypadek, gdyby program się zaciął.
     */
    stop: () =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(guard);
          finish();
          resolve({ files, mic: lanes.mic.seconds, system: lanes.system.seconds });
        };
        const guard = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 5000);

        child.once("close", done);
        try {
          child.stdin.write("stop\n");
          child.stdin.end();
        } catch {
          child.kill("SIGTERM");
        }
      }),
  };
}

module.exports = { record, parse, wavHeader, helperPath, SAMPLE_RATE };
