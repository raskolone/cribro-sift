/* HUD — nagrywanie i jedyna animacja, jaką widać podczas mówienia.
   Pierścień to sito: przy nasłuchu oddycha z głosem, przy przesiewaniu
   przepuszcza przez siebie ziarna i gubi plewy. */

const shell = document.getElementById("shell");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const timerEl = document.getElementById("timer");
const waveEl = document.getElementById("wave");
const canvas = document.getElementById("ring");
const ctx = canvas.getContext("2d");

/* Pierścień jest rysowany, nie stylowany — kolory bierze z tokenów motywu,
   żeby akcent nie istniał drugi raz, wpisany na sztywno w JS. */
const ACCENT = themeRgb("--accent");
const WARN = themeRgb("--warn");
/* Nagrywanie ma własny kolor — fiolet. Zieleń zostaje temu, co gotowe,
   i pierścień musi mówić to samo co obwódka pigułki, znaczek widgetu
   i ikona w pasku menu. Patrz #shell[data-state="listening"] w hud.html. */
const REC = themeRgb("--rec");

const BARS = 28;
const bars = Array.from({ length: BARS }, () => {
  const bar = document.createElement("i");
  waveEl.appendChild(bar);
  return bar;
});

const DPR = window.devicePixelRatio || 2;
canvas.width = 44 * DPR;
canvas.height = 44 * DPR;
ctx.scale(DPR, DPR);

let state = "idle";
let level = 0; // wygładzona głośność 0..1
let startedAt = 0;
let raf = null;

/* Nasłuch zaczyna się od pełnej pigułki: fala, napis „Słucham" i zegar.
   Po tym czasie pigułka schodzi z ekranu, a nagrywanie widać dalej —
   na znaczku widgetu. Patrz komentarz w hud.html. */
const MINI_AFTER = 3000;
let miniTimer = null;
/* Czy jest komu przekazać pałeczkę. Ustawia proces główny przy starcie:
   widget może być wyłączony i wtedy pigułka musi zostać. */
let handoff = false;

/* ── Sygnał dźwiękowy ────────────────────────────────────────── */

/* Dwa krótkie tony zamiast komunikatu. Podczas dyktowania patrzysz
   w inną aplikację, więc potwierdzenie musi wejść uchem, nie okiem. */
let soundOn = true;
const applySettings = (settings) => {
  soundOn = settings.playSound !== false;
  setLanguage(settings.uiLanguage ?? "pl");
};
window.cribro.settings.get().then(applySettings).catch(() => {});
window.cribro.settings.onChange(applySettings);

function chime(notes) {
  if (!soundOn) return;
  const audio = new AudioContext();
  notes.forEach(([freq, at, len], index) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, audio.currentTime + at);
    gain.gain.linearRampToValueAtTime(0.05, audio.currentTime + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + len);
    osc.connect(gain).connect(audio.destination);
    osc.start(audio.currentTime + at);
    osc.stop(audio.currentTime + at + len);
    if (index === notes.length - 1) {
      setTimeout(() => audio.close().catch(() => {}), (at + len) * 1000 + 120);
    }
  });
}

const SOUND = {
  start: [[523.25, 0, 0.1]], // C5 — otwarcie
  done: [
    [659.25, 0, 0.09], // E5
    [880.0, 0.085, 0.16], // A5 — domknięcie
  ],
  cancel: [[330, 0, 0.13]],
};

/* ── Nagrywanie ──────────────────────────────────────────────── */

/* Nagrywamy surowy PCM i sami składamy WAV, zamiast brać gotowy WebM
   z MediaRecordera. Powód jest prosty: Gemini przyjmuje WAV, MP3, OGG
   i FLAC — ale nie WebM. WAV 16 kHz mono to jedyny format, który
   przechodzi u wszystkich dostawców bez konwersji, a przy dyktowaniu
   trwającym kilkanaście sekund waży tyle co nic. */

const SAMPLE_RATE = 16000;

/* Worklet biegnie na wątku audio i podaje kolejne ramki do okna.
   Ładujemy go z blob-a, żeby nie trzymać osobnego pliku. */
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0][0];
    if (channel) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor("capture", Capture);
`;

let stream = null;
let audioCtx = null;
let analyser = null;
let worklet = null;
let pcm = [];
let pcmLength = 0;
let recording = false;
let cancelled = false;

let trigger = "hold";

async function startRecording(meta) {
  trigger = meta?.trigger ?? "hold";
  handoff = !!meta?.handoff;
  cancelled = false;
  pcm = [];
  pcmLength = 0;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (error) {
    window.cribro.hud.sendError(
      `Brak dostępu do mikrofonu: ${error.message}. Sprawdź Ustawienia systemowe → Prywatność → Mikrofon.`,
    );
    return;
  }

  try {
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const source = audioCtx.createMediaStreamSource(stream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);

    worklet = new AudioWorkletNode(audioCtx, "capture");
    worklet.port.onmessage = (event) => {
      if (!recording) return;
      pcm.push(event.data);
      pcmLength += event.data.length;
    };
    source.connect(worklet);

    // Graf audio przetwarza dopiero wtedy, gdy coś ciągnie go do wyjścia.
    // Zerowe wzmocnienie sprawia, że nic nie leci z głośników.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    worklet.connect(mute).connect(audioCtx.destination);
  } catch (error) {
    teardown();
    window.cribro.hud.sendError(`Nie udało się uruchomić nagrywania: ${error.message}`);
    return;
  }

  recording = true;
  startedAt = Date.now();
  chime(SOUND.start);
  setState("listening");
}

function stopRecording() {
  if (!recording) {
    teardown();
    return;
  }
  recording = false;

  const durationMs = Date.now() - startedAt;
  const samples = pcmLength;
  const frames = pcm;
  teardown();

  // Anulowanie ma znaczyć „nie ma nagrania": porzucamy próbki od razu,
  // zamiast czekać, aż nadpisze je następne dyktowanie.
  if (cancelled) {
    pcm = [];
    pcmLength = 0;
    return;
  }

  // Poniżej pół sekundy to prawie na pewno przypadkowe muśnięcie klawiszy.
  // Z punktu widzenia mówiącego to ten sam przypadek co cisza w nagraniu,
  // więc idzie tą samą drogą i kończy się tą samą smutną miną.
  if (samples < SAMPLE_RATE * 0.4) {
    window.cribro.hud.sendEmpty();
    return;
  }

  window.cribro.hud.sendAudio(encodeWav(frames, samples, SAMPLE_RATE), durationMs);
}

function teardown() {
  recording = false;
  stream?.getTracks().forEach((track) => track.stop());
  worklet?.port.close();
  worklet?.disconnect();
  audioCtx?.close().catch(() => {});
  stream = null;
  worklet = null;
  analyser = null;
  audioCtx = null;
}

/** Float32 [-1,1] → plik WAV z 16-bitowym PCM. */
function encodeWav(frames, samples, rate) {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM bez kompresji
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bajty na sekundę
  view.setUint16(32, 2, true); // bajty na próbkę
  view.setUint16(34, 16, true); // bitów na próbkę
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);

  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      const clamped = Math.max(-1, Math.min(1, frame[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return bytes;
}

/* ── Stany ───────────────────────────────────────────────────── */

/* Podpowiedź zależy od tego, jak ruszyło nagranie — przy trzymaniu
   i bez trzymania kończy się je zupełnie inaczej. */
const HINT = {
  hold: "puść klawisze, żeby przesiać",
  "hands-off": "stuknij ⌃⌥, żeby zakończyć · esc anuluje",
  toggle: "naciśnij skrót ponownie, żeby zakończyć",
  button: "naciśnij Zatrzymaj · esc anuluje",
  notatnik: "stuknij ⌃⌥, żeby zakończyć · esc anuluje",
  widget: "stuknij ⌃⌥, żeby zakończyć · esc anuluje",
};

const COPY = {
  idle: { status: "Gotowe", hint: null },
  listening: { status: "Słucham", hint: null },
  sifting: { status: "Przesiewam", hint: null },
  done: { status: "W schowku", hint: null },
  // Puste nagranie. Zdanie zamiast etykiety — patrz nothingHeard w main.js
  // i styl #shell[data-state="empty"] #status w hud.html.
  empty: { status: "Nie mogę pomóc, bo nic nie usłyszałem", hint: null },
};

/* Jak długo widać smutną minę. Tyle samo czeka proces główny, zanim schowa
   okno HUD-a (NOTHING_HEARD_MS w main/main.js) — dwie liczby, jedna chwila. */
const EMPTY_MS = 2800;
let emptyTimer = null;

function setState(next, detail = {}) {
  state = next;
  shell.dataset.state = next;
  shell.classList.toggle("in", next !== "idle");
  if (next !== "empty") clearTimeout(emptyTimer);

  // Każda zmiana stanu rozwija pigułkę z powrotem: „Przesiewam" i „W schowku"
  // to informacje, które trzeba przeczytać, a nie tylko zauważyć kątem oka.
  clearTimeout(miniTimer);
  shell.dataset.size = "full";
  if (next === "listening") {
    miniTimer = setTimeout(() => {
      if (state === "listening") shell.dataset.size = handoff ? "gone" : "mini";
    }, MINI_AFTER);
  }

  const copy = COPY[next] ?? COPY.idle;
  statusEl.textContent = t(copy.status);
  waveEl.hidden = next !== "listening";

  const hint =
    detail.hint ?? (next === "listening" ? (HINT[trigger] ?? HINT.hold) : copy.hint);
  hintEl.hidden = !hint;
  hintEl.textContent = hint ? t(hint) : "";
  timerEl.style.opacity = next === "listening" ? "1" : "0.35";

  // Smutna mina jest rysunkiem, nie animacją — pierścień ma wtedy wolne.
  if (next === "idle" || next === "empty") {
    cancelAnimationFrame(raf);
    raf = null;
    level = 0;
  } else if (!raf) {
    raf = requestAnimationFrame(draw);
  }
}

/* Nic nie usłyszeliśmy. Mina zostaje na chwilę i sama schodzi z ekranu —
   proces główny chowa okno w tym samym momencie. */
function showNothingHeard() {
  chime(SOUND.cancel);
  setState("empty");
  emptyTimer = setTimeout(() => state === "empty" && setState("idle"), EMPTY_MS);
}

/* ── Pierścień ───────────────────────────────────────────────── */

const TICKS = 40;
const grains = Array.from({ length: 18 }, () => ({
  a: Math.random() * Math.PI * 2,
  r: 4 + Math.random() * 10,
  v: 0.16 + Math.random() * 0.3,
  keep: Math.random() > 0.45, // część ziaren przechodzi, część odpada
}));

/* Bufor na próbki. Jeden na całe nagranie, nie jeden na klatkę: przy
   sześćdziesięciu klatkach na sekundę i kilobajcie na klatkę odśmiecacz
   dostawał sześćdziesiąt kilobajtów śmieci na sekundę — a sprząta je
   wtedy, kiedy jemu wygodnie, czyli czasem w środku rysowania. To był
   jeden z tych krótkich przystanków, których nie dało się z niczym
   powiązać. Rozmiar bufora zależy od analizatora, więc bierzemy go
   dopiero wtedy, gdy analizator jest i gdy naprawdę się zmienił. */
let samples = null;

function draw(now) {
  raf = requestAnimationFrame(draw);
  const cx = 22;
  const cy = 22;
  ctx.clearRect(0, 0, 44, 44);

  if (analyser) {
    if (!samples || samples.length !== analyser.frequencyBinCount) {
      samples = new Uint8Array(analyser.frequencyBinCount);
    }
    const data = samples;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += (value - 128) ** 2;
    const rms = Math.sqrt(sum / data.length) / 128;
    level += (Math.min(1, rms * 3.4) - level) * 0.25;
  } else if (state === "sifting") {
    level = 0.35 + Math.sin(now / 320) * 0.12;
  }

  sendLevel(now);

  const t = now / 1000;

  if (state === "listening" || state === "idle") {
    // Sito jako korona kresek — promień oddycha z głosem.
    const hue = state === "listening" ? REC : ACCENT;
    for (let i = 0; i < TICKS; i++) {
      const angle = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
      const wobble = Math.sin(t * 2.2 + i * 0.55) * 0.5 + 0.5;
      const inner = 13;
      const outer = inner + 2 + level * 7 * (0.45 + wobble * 0.55);
      ctx.strokeStyle = `rgba(${hue}, ${0.22 + level * 0.6 * (0.4 + wobble * 0.6)})`;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(${hue}, ${0.5 + level * 0.4})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, 10.5, 0, Math.PI * 2);
    ctx.stroke();
  } else if (state === "sifting") {
    // Ziarna spadają na sito. Przechodzą tylko te, które niosą treść.
    ctx.strokeStyle = `rgba(${WARN}, 0.5)`;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.stroke();

    for (const grain of grains) {
      grain.r += grain.v;
      const passed = grain.r > 12;
      if (grain.r > 20) {
        grain.r = 2;
        grain.a = Math.random() * Math.PI * 2;
        grain.keep = Math.random() > 0.45;
      }
      if (passed && !grain.keep) continue; // plewy nie przechodzą
      const x = cx + Math.cos(grain.a) * grain.r;
      const y = cy + Math.sin(grain.a) * grain.r;
      ctx.fillStyle = passed ? `rgba(${ACCENT}, 0.9)` : `rgba(${WARN}, 0.55)`;
      ctx.beginPath();
      ctx.arc(x, y, passed ? 1.5 : 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (state === "done") {
    ctx.strokeStyle = `rgba(${ACCENT}, 0.95)`;
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx - 1.5, cy + 3.5);
    ctx.lineTo(cx + 5.5, cy - 4);
    ctx.stroke();
  }

  // Fala i zegar
  if (state === "listening") {
    for (let i = 0; i < BARS; i++) {
      const wobble = Math.sin(t * 6 + i * 0.7) * 0.5 + 0.5;
      const scale = 1 + level * 11 * (0.25 + wobble * 0.75);
      bars[i].style.transform = `scaleY(${scale.toFixed(2)})`;
      bars[i].style.opacity = (0.28 + level * 0.72 * (0.3 + wobble * 0.7)).toFixed(2);
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    timerEl.textContent = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
  }
}

/* Poziom głosu dla widgetu. Mikrofon jest tylko tutaj, a po trzech
   sekundach widać już tylko znaczek — bez tej jednej liczby pulsowałby
   w próżni, nie wiedząc, czy ktokolwiek mówi.
   Dwadzieścia razy na sekundę wystarcza oku i nie zatyka mostu. */
const LEVEL_EVERY = 50;
let lastLevelAt = 0;

function sendLevel(now) {
  if (state !== "listening" || now - lastLevelAt < LEVEL_EVERY) return;
  lastLevelAt = now;
  window.cribro.hud.sendLevel?.(Number(level.toFixed(3)));
}

/* ── Most do procesu głównego ────────────────────────────────── */

window.cribro.hud.onStart((meta) => startRecording(meta));
window.cribro.hud.onStop(() => stopRecording());
window.cribro.hud.onCancel(() => {
  cancelled = true;
  chime(SOUND.cancel);
  stopRecording();
  setState("idle");
});

window.cribro.onState(({ state: next, entry, error, empty, command }) => {
  if (next === "listening") return; // ten stan ustawia sam recorder
  if (empty) {
    showNothingHeard();
  } else if (next === "sifting" && command) {
    /* Polecenie trafiło. Nazwa musi być widoczna TERAZ — zanim tekst wpadnie
       pod kursor — bo to jedyny moment, w którym można jeszcze przerwać.
       Napis jest złożony z dwóch części, więc słownik go nie tknie: nazwa
       polecenia to treść użytkownika, a nie napis interfejsu. */
    setState("sifting", { hint: `${t("Polecenie")}: ${command}` });
  } else if (next === "done" && entry) {
    chime(SOUND.done);
    setState("done", {
      hint: `${t("{n} słów", { n: entry.siftedWords })} · ${entry.app ?? t("schowek")}`,
    });
  } else if (error) {
    setState("sifting", { hint: error.slice(0, 60) });
    setTimeout(() => setState("idle"), 2600);
  } else {
    setState(next);
  }
});

setState("idle");
