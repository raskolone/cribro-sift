"use strict";
/**
 * Notatka ze spotkania na PRAWDZIWYM składzie danych.
 *   node scripts/meetnote-live-test.js
 *
 * scripts/meetnote-test.js sprawdza, jak notatka się NAZYWA — czysta
 * funkcja, czysty wynik. Tutaj chodzi o rzecz, której na czystej funkcji
 * sprawdzić się nie da: co się dzieje z kartką, która JUŻ LEŻY w Notatniku,
 * gdy rozmowa dostaje podsumowanie po transkrypcji, gdy ktoś dopisał do niej
 * dwa zdania albo gdy ją skasował.
 *
 * Trzy granice, których automatyka nie przekracza (patrz main/meetnote.js):
 *   1. skasowana ręką nie wraca,
 *   2. zmieniona ręką nie jest nadpisywana,
 *   3. nie powstaje z niczego.
 *
 * Sklep zapisuje na dysk i czyta z dysku, więc test biegnie w Electronie
 * (Store woła app.getPath) i w katalogu tymczasowym — nie tyka ustawień
 * ani notatek na tym komputerze. Podstawianie atrapy sklepu sprawdzałoby
 * atrapę, a cała rzecz dzieje się właśnie na styku ze sklepem.
 */
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-meetnote-"));

const MAIN = `
const { app } = require("electron");

app.disableHardwareAcceleration();
app.setPath("userData", ${JSON.stringify(path.join(work, "dane"))});

const out = { steps: [] };
const finish = (why) => {
  if (why) out.skip = why;
  process.stdout.write("\\n@@WYNIK@@" + JSON.stringify(out) + "@@KONIEC@@\\n");
  app.exit(0);
};
setTimeout(() => finish("sklep nie odpowiedział w 30 s"), 30000);

app.whenReady().then(async () => {
  const { Store } = require(${JSON.stringify(path.join(root, "src/main/store.js"))});
  const { keepNote } = require(${JSON.stringify(path.join(root, "src/main/meetnote.js"))});

  const say = (name, value) => out.steps.push({ name, value });
  const JA = "Maciej Wyrozumski";
  const store = new Store();

  /* ── Rozmowa, po której nie ma czego zapisać ── */
  const pusta = store.createMeeting({ title: "Cisza", state: "done" });
  const nic = keepNote(store, pusta.id, { me: JA });
  say("rozmowa bez zapisu i bez wniosku nie zakłada kartki", nic.action);
  say("i nie zostawia notatki", store.getNotes().length);

  /* ── Zwykły przebieg: najpierw zapis, potem podsumowanie ── */
  const id = store.createMeeting({
    title: "Przegląd tygodnia",
    titleFrom: "room",
    where: "Google Meet",
    people: [JA, "Ania Kowalska"],
    state: "done",
  }).id;
  store.updateMeeting(id, {
    transcript: [
      { speaker: "Ty", lane: "mic", at: 0, text: "Zdążymy z raportem?" },
      { speaker: "Ania Kowalska", lane: "system", at: 12, text: "Dane wyślę we wtorek." },
    ],
  });

  const pierwsza = keepNote(store, id, { me: JA });
  say("po zakończeniu nagrania kartka powstaje", pierwsza.action);
  say("…z rodzajem, po którym pozna ją przegródka", pierwsza.note.kind);
  say("…bez szuflady — tylko zwijana przegródka, jak przy szybkich notatkach", pierwsza.note.folder ?? null);
  say("…z zapisem rozmowy w środku", pierwsza.note.text.includes("Dane wyślę we wtorek."));
  say("…i pod nazwą złożoną z treści i rozmówcy", pierwsza.note.text.split("\\n")[0]);
  say("spotkanie pamięta swoją kartkę", store.getMeetings().find((m) => m.id === id).noteId === pierwsza.note.id);

  /* Drugie wywołanie bez zmian niczego nie rusza — meldunek „zmieniono"
     wysłany bez zmiany przerysowałby otwartą notatkę pod palcami. */
  say("powtórzone wywołanie bez zmian nic nie robi", keepNote(store, id, { me: JA }).action);
  say("i nie zakłada drugiej kopii", store.getNotes().length);

  /* ── Podsumowanie dochodzi później i wchodzi do TEJ SAMEJ kartki ── */
  store.updateMeeting(id, {
    summary: "**Ustalenia**\\n- Raport idzie w czwartek.\\n\\n**Zadania**\\n- Ania: przysłać dane, wtorek",
  });
  const druga = keepNote(store, id, { me: JA });
  say("podsumowanie wchodzi do tej samej kartki", druga.action);
  say("wciąż jedna notatka", store.getNotes().length);
  say("…i ma w sobie wniosek", druga.note.text.includes("Raport idzie w czwartek."));
  say("…zadania jako listę do odhaczenia", druga.note.text.includes("- [ ] Ania: przysłać dane, wtorek"));
  say("…i nadal cały zapis rozmowy", druga.note.text.includes("## Zapis rozmowy"));

  /* ── Ktoś dopisał do notatki dwa zdania ── */
  store.updateNote(druga.note.id, { text: druga.note.text + "\\n\\nSpytać Anię o budżet." });
  store.updateMeeting(id, { summary: "Zupełnie inne podsumowanie." });
  const ręczna = keepNote(store, id, { me: JA });
  say("notatka zmieniona ręką nie jest nadpisywana", ręczna.action);
  say("i dopisek w niej zostaje", ręczna.note.text.includes("Spytać Anię o budżet."));
  say("…a nowe podsumowanie do niej nie weszło", !ręczna.note.text.includes("Zupełnie inne podsumowanie."));

  /* ── Ktoś skasował notatkę ── */
  store.deleteNote(druga.note.id);
  const poKasowaniu = keepNote(store, id, { me: JA });
  say("skasowana ręką nie wraca", poKasowaniu.action);
  say("i nie zostawia po sobie nowej", store.getNotes().length);

  /* Ale prośba wprost („Pokaż notatkę") zakłada ją od nowa — tak, jak
     robi to meetings:toNote w main/main.js: zdejmuje wskazanie na nagrobek
     i pyta jeszcze raz. */
  store.updateMeeting(id, { noteId: null });
  const naŻyczenie = keepNote(store, id, { me: JA });
  say("prośba wprost zakłada kartkę od nowa", naŻyczenie.action);

  /* ── Notatka przyniesiona z innego komputera ──
     Synchronizacja nie wozi pola autoText (patrz kolumny w main/sync.js),
     więc kartka z drugiej maszyny wygląda jak zmieniona ręką — i tak ma być. */
  const zChmury = store.createNote({ text: "Coś z innego komputera", kind: "meeting" });
  store.updateMeeting(id, { noteId: zChmury.id });
  say("kartka bez autoText jest traktowana jak zmieniona ręką",
    keepNote(store, id, { me: JA }).action);
  say("i jej treść zostaje", store.getNotes().find((n) => n.id === zChmury.id).text);

  finish();
});
`;

const entry = path.join(work, "main.js");
fs.writeFileSync(entry, MAIN);
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "meetnote", main: "main.js" }));

const electron = path.join(root, "node_modules", ".bin", "electron");
if (!fs.existsSync(electron)) {
  console.log("· Electron nie jest zainstalowany — pomijam.");
  process.exit(0);
}

let raw;
try {
  raw = execFileSync(electron, [work], {
    encoding: "utf8",
    timeout: 90000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const hit = /@@WYNIK@@([\s\S]*?)@@KONIEC@@/.exec(raw);
if (!hit) {
  console.error(raw);
  throw new Error("sklep nie oddał wyniku");
}
const { steps, skip } = JSON.parse(hit[1]);
if (skip) throw new Error(skip);

const oczekiwane = [
  ["rozmowa bez zapisu i bez wniosku nie zakłada kartki", "none"],
  ["i nie zostawia notatki", 0],
  ["po zakończeniu nagrania kartka powstaje", "created"],
  ["…z rodzajem, po którym pozna ją przegródka", "meeting"],
  ["…bez szuflady — tylko zwijana przegródka, jak przy szybkich notatkach", null],
  ["…z zapisem rozmowy w środku", true],
  ["…i pod nazwą złożoną z treści i rozmówcy", "# Przegląd tygodnia · Ania Kowalska"],
  ["spotkanie pamięta swoją kartkę", true],
  ["powtórzone wywołanie bez zmian nic nie robi", "kept"],
  ["i nie zakłada drugiej kopii", 1],
  ["podsumowanie wchodzi do tej samej kartki", "updated"],
  ["wciąż jedna notatka", 1],
  ["…i ma w sobie wniosek", true],
  ["…zadania jako listę do odhaczenia", true],
  ["…i nadal cały zapis rozmowy", true],
  ["notatka zmieniona ręką nie jest nadpisywana", "kept"],
  ["i dopisek w niej zostaje", true],
  ["…a nowe podsumowanie do niej nie weszło", true],
  ["skasowana ręką nie wraca", "none"],
  ["i nie zostawia po sobie nowej", 0],
  ["prośba wprost zakłada kartkę od nowa", "created"],
  ["kartka bez autoText jest traktowana jak zmieniona ręką", "kept"],
  ["i jej treść zostaje", "Coś z innego komputera"],
];

let passed = 0;
for (const [name, want] of oczekiwane) {
  const step = steps.find((item) => item.name === name);
  assert.ok(step, `krok „${name}" w ogóle się nie wykonał`);
  assert.deepStrictEqual(step.value, want, `„${name}": ${JSON.stringify(step.value)}`);
  console.log("✓", name);
  passed += 1;
}

console.log(
  `\nNotatka ze spotkania (na żywo): ${passed} sprawdzeń przeszło. Sama się zakłada, cudzych dopisków nie tyka.`,
);
