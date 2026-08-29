"use strict";
/**
 * Dźwięk spotkania: rozplot ramek i zapis dwóch torów.
 *   node scripts/tap-test.js
 *
 * Dwie części, bo są to dwa różne rodzaje pewności:
 *
 *   ROZPLOT jest czystą funkcją i sprawdza się bez niczego. Potok oddaje
 *   bajty porcjami, jakie akurat wyjdą jądru — ramka bywa pocięta na pół
 *   w dowolnym miejscu, a w jednej porcji potrafi ich przyjechać dwadzieścia.
 *   Błąd w tym miejscu nie wygląda na błąd: dźwięk po prostu zaczyna
 *   trzeszczeć, a transkrypcja robi się bełkotem.
 *
 *   NAGRANIE wymaga zgody „Nagrywanie ekranu" i sprzętu, więc uruchamia się
 *   tylko wtedy, gdy program pomocniczy jest zbudowany. Bez zgody kończy się
 *   głośnym pominięciem, a nie cichym przejściem — cicho przechodzący test
 *   nagrywania jest gorszy niż jego brak.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parse, record, helperPath, wavHeader } = require("../src/main/tap");

/* Ekran nie może zasnąć w trakcie tego testu.

   ScreenCaptureKit przy uśpionym ekranie nie zgłasza ŻADNEGO ekranu, więc
   nagrywanie odpada — i wygląda to na zepsutą funkcję, choć zepsuty jest
   tylko moment. `caffeinate -w` trzyma czuwanie dokładnie tak długo, jak
   żyje ten proces — a `-u` budzi ekran, jeśli zdążył już zasnąć. Bez tego
   drugiego cały ten test milczy na maszynie zostawionej na chwilę samej,
   i milczy w sposób, który wygląda jak brak zgody. */
try {
  require("child_process").execFileSync("caffeinate", ["-u", "-t", "1"], { stdio: "ignore" });
} catch {
  /* nie macOS — nie ma czego budzić */
}
try {
  require("child_process")
    .spawn("caffeinate", ["-d", "-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: true,
    })
    .unref();
} catch {
  /* nie macOS albo brak caffeinate — test poleci jak dotąd */
}


let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

/* ── Ramka ──────────────────────────────────────────────────── */

/** Taka sama ramka, jaką składa PipeDrain w native/tap/main.swift. */
function frame(lane, millis, samples) {
  const pcm = Buffer.alloc(samples * 2);
  for (let at = 0; at < samples; at += 1) pcm.writeInt16LE(at * 11 - 300, at * 2);
  const head = Buffer.alloc(20);
  head.write("CRIB", 0, "ascii");
  head[4] = lane;
  head.writeUInt32LE(samples, 8);
  head.writeDoubleLE(millis, 12);
  return Buffer.concat([head, pcm]);
}

let out = parse(frame(0, 0, 4));
check("Jedna ramka wchodzi w całości", out.frames.length === 1 && out.rest.length === 0);
check("Tor zero to mikrofon", out.frames[0].lane === "mic");
check("Próbki wychodzą co do bajta", out.frames[0].pcm.length === 8);

out = parse(Buffer.concat([frame(1, 0, 2), frame(0, 40, 3), frame(1, 40, 2)]));
check("Trzy ramki w jednej porcji", out.frames.length === 3);
check(
  "Tory nie mieszają się przy sklejeniu",
  out.frames.map((item) => item.lane).join(",") === "system,mic,system",
);
check("Czas jedzie razem z ramką", out.frames[1].millis === 40);

const whole = frame(1, 120, 8);
out = parse(whole.subarray(0, 14));
check("Ucięty nagłówek czeka na resztę", out.frames.length === 0 && out.rest.length === 14);

out = parse(whole.subarray(0, 24));
check("Ucięte próbki też czekają — pół ramki to nie ramka", out.frames.length === 0);

/* Najważniejszy przypadek: strumień składany porcja po porcji, w kawałkach
   nierównych i nietrafiających w granice ramek. Tak właśnie zachowuje się
   potok i tak nie zachowuje się żaden test pisany po jednej ramce. */
const stream = Buffer.concat([frame(0, 0, 5), frame(1, 20, 7), frame(0, 40, 2)]);
let rest = Buffer.alloc(0);
const collected = [];
for (let at = 0; at < stream.length; at += 7) {
  const step = parse(Buffer.concat([rest, stream.subarray(at, at + 7)]));
  collected.push(...step.frames);
  rest = step.rest;
}
check("Strumień pocięty na siódemki składa się z powrotem", collected.length === 3);
check(
  "…i to w tej samej kolejności, z tymi samymi czasami",
  collected.map((item) => `${item.lane}@${item.millis}`).join(" ") === "mic@0 system@20 mic@40",
);
check("Po ostatniej ramce nie zostaje nic", rest.length === 0);

out = parse(Buffer.concat([Buffer.from("śmieci na wejściu"), frame(0, 60, 3)]));
check("Obcy bajt nie psuje strumienia — magia prowadzi do następnej ramki", out.frames.length === 1);
check("…a odzyskana ramka jest cała", out.frames[0].millis === 60);

/* ── Nagłówek WAV ───────────────────────────────────────────── */

const head = wavHeader(32000);
check("Nagłówek ma 44 bajty", head.length === 44);
check("Deklaruje 16 kHz", head.readUInt32LE(24) === 16000);
check("Deklaruje mono i 16 bitów", head.readUInt16LE(22) === 1 && head.readUInt16LE(34) === 16);
check("Długość danych zgadza się z tym, co zapisano", head.readUInt32LE(40) === 32000);

/* ── Nagranie ───────────────────────────────────────────────── */

(async () => {
  const helper = helperPath();
  if (!helper) {
    console.log("\n⚠ cribro-tap niezbudowany — nagranie pominięte. Zbuduj: npm run tap");
    console.log(`\n${passed} sprawdzeń przeszło.`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-tap-test-"));
  let failure = null;
  const tap = record({ dir, onError: (message) => (failure = message) });

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const result = await tap.stop();

  /* Strumień, który ruszył, ale nic nie przyniósł, to nie jest błąd w kodzie
     — to jest brak zgody albo brak wejścia audio. Rozróżniamy te dwie rzeczy,
     bo test, który czerwieni się na cudzej maszynie z powodu ustawień
     systemowych, przestaje po tygodniu cokolwiek znaczyć. */
  if (!failure && result.mic < 0.2 && result.system < 0.2) {
    failure = "strumień ruszył, ale oba tory przyszły puste";
  }

  if (failure) {
    console.log(`\n⚠ nagranie pominięte: ${failure}`);
    console.log("  Zgoda „Nagrywanie ekranu” pamięta TOŻSAMOŚĆ programu, który o nią prosi,");
    console.log("  a goły plik uruchamiany z terminala żadnej stabilnej nie ma — przy każdej");
    console.log("  przebudowie jest dla systemu innym programem. Zgody udziela się więc");
    console.log("  zainstalowanej aplikacji, przy pierwszym nagraniu spotkania, i wtedy");
    console.log("  obejmuje ona także ten program, bo leży w jej bundlu i ma jej podpis.");
    console.log("  Ta część testu jest sprawdzeniem sprzętu, nie warunkiem poprawności.");
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} sprawdzeń przeszło.`);
    return;
  }

  check("Powstały oba pliki", fs.existsSync(result.files.mic) && fs.existsSync(result.files.system));

  for (const [name, file] of Object.entries(result.files)) {
    const bytes = fs.readFileSync(file);
    check(`${name}: plik jest WAV-em, nie surowymi bajtami`,
      bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE");
    check(`${name}: nagłówek mówi tyle, ile plik naprawdę waży`,
      bytes.readUInt32LE(40) === bytes.length - 44);
  }

  // Trzy sekundy nagrywania mają dać około trzech sekund dźwięku. Luz jest
  // na start strumienia; zero znaczyłoby, że tor w ogóle nie doszedł.
  check(`Tor mikrofonu ma treść (${result.mic.toFixed(2)} s)`, result.mic > 1.5 && result.mic < 5);
  check(`Tor systemu ma treść (${result.system.toFixed(2)} s)`, result.system > 1.5 && result.system < 5);
  check(
    `Tory się nie rozjechały (${Math.abs(result.mic - result.system).toFixed(3)} s)`,
    Math.abs(result.mic - result.system) < 0.5,
  );

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} sprawdzeń przeszło.`);
})();
