"use strict";
/**
 * Synchronizacja notatek z Supabase — bez sieci i bez konta.
 *   node scripts/sync-test.js
 *
 * To jedyne miejsce w aplikacji, w którym da się stracić czyjąś pracę:
 * dwa komputery piszą w tę samą notatkę i ktoś musi przegrać. Test pilnuje,
 * żeby przegrywał zawsze ten sam — starszy — i żeby skasowana notatka nie
 * wracała z drugiego urządzenia.
 *
 * Serwer jest atrapą, ale zachowuje się jak prawdziwy w tym jednym, co ma
 * znaczenie: `synced_at` nadaje sam i zawsze rosnąco.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-sync-"));
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      app: { getPath: () => home },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return load.call(this, request, ...rest);
};

const { Store } = require("../src/main/store");
const { syncNotes, decide, toRow, toNote, isDirty } = require("../src/main/sync");

/* ── Atrapa serwera ─────────────────────────────────────────────── */

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString();

function server(rows = [], userId = "u1") {
  return {
    rows,
    snapshot: () => ({ signedIn: true, userId }),
    async rest(pathname, options = {}) {
      const [, query = ""] = pathname.split("?");
      const params = new URLSearchParams(query);

      if (!options.method || options.method === "GET") {
        const gt = params.get("synced_at")?.replace(/^gt\./, "");
        const limit = Number(params.get("limit") ?? 500);
        const offset = Number(params.get("offset") ?? 0);
        const data = rows
          // Tak samo jak RLS w bazie: widać wyłącznie własne wiersze.
          .filter((row) => row.user_id === userId)
          .filter((row) => (gt ? row.synced_at > gt : true))
          .sort((a, b) => (a.synced_at < b.synced_at ? -1 : 1))
          .slice(offset, offset + limit);
        return { data };
      }

      for (const incoming of options.body) {
        const stamp = tick();
        const index = rows.findIndex(
          (row) => row.user_id === incoming.user_id && row.local_id === incoming.local_id,
        );
        const row = { ...incoming, synced_at: stamp };
        if (index === -1) rows.push(row);
        else rows[index] = row;
      }
      return { data: null };
    },
  };
}

function freshStore(name) {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store();
  // Store bierze katalog przy tworzeniu; przestawiamy ścieżki, żeby dwa
  // „komputery" w jednym teście nie pisały do tego samego pliku.
  store.settingsPath = path.join(dir, "settings.json");
  store.historyPath = path.join(dir, "history.json");
  store.notesPath = path.join(dir, "notes.json");
  store.cloudPath = path.join(dir, "cloud.json");
  store.notes = [];
  store.cloud = { userId: null, cursor: null, lastSyncAt: null };
  return store;
}

const ok = (label) => console.log(`✓ ${label}`);

/* Znaczniki czasu notatek biorą się z prawdziwego zegara — dwie zmiany
   w tej samej milisekundzie byłyby dla synchronizacji remisem, a test ma
   sprawdzać rozstrzygnięcia, nie remisy. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  /* ── 1. Rozstrzyganie sporu ── */
  assert.equal(decide(null, { updated_at: "2026-01-01T00:00:00Z" }), "take");
  assert.equal(
    decide({ updatedAt: "2026-01-01T00:00:00Z" }, { updated_at: "2026-01-02T00:00:00Z" }),
    "take",
  );
  assert.equal(
    decide({ updatedAt: "2026-01-03T00:00:00Z" }, { updated_at: "2026-01-02T00:00:00Z" }),
    "keep",
  );
  assert.equal(
    decide({ updatedAt: "2026-01-02T00:00:00Z" }, { updated_at: "2026-01-02T00:00:00Z" }),
    "same",
  );
  ok("Wygrywa nowszy updatedAt, remis znaczy zgodę");

  /* ── 2. Nagrobek nie niesie treści ── */
  const buried = toRow(
    { id: "n1", text: "tajne", pinned: true, at: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", deletedAt: "2026-01-02T00:00:00Z" },
    "u1",
  );
  assert.equal(buried.text, "");
  assert.equal(buried.pinned, false);
  assert.equal(buried.deleted_at, "2026-01-02T00:00:00Z");
  assert.equal(toNote({ local_id: "n1", text: "resztka", deleted_at: "x", updated_at: "y", created_at: "z" }).text, "");
  ok("Skasowana notatka nie zostawia tekstu ani na serwerze, ani na dysku");

  /* ── 3. Znacznik wysyłki ── */
  assert.equal(isDirty({ updatedAt: "a", syncedAt: null }), true);
  assert.equal(isDirty({ updatedAt: "a", syncedAt: "a" }), false);
  ok("Do wysyłki idzie tylko to, czego serwer nie widział");

  /* ── 4. Pierwsza synchronizacja: dysk → serwer ── */
  const cloudRows = [];
  const laptop = freshStore("laptop");
  laptop.createNote({ text: "Raport na czwartek." });
  laptop.createNote({ text: "Zadzwonić do Ani." });

  let report = await syncNotes({ client: server(cloudRows), store: laptop });
  assert.equal(report.pushed, 2);
  assert.equal(cloudRows.length, 2);
  ok("Notatki sprzed założenia konta jadą na serwer przy pierwszym przebiegu");

  report = await syncNotes({ client: server(cloudRows), store: laptop });
  assert.equal(report.pushed, 0, "drugi przebieg nie ma czego wysyłać");
  assert.equal(report.taken, 0, "własne wiersze nie są zmianą");
  ok("Drugi przebieg pod rząd nie robi nic");

  /* ── 5. Drugi komputer bierze wszystko ── */
  const desktop = freshStore("desktop");
  await syncNotes({ client: server(cloudRows), store: desktop });
  assert.equal(desktop.getNotes().length, 2);
  assert.equal(
    desktop.getNotes().find((note) => note.text === "Raport na czwartek.").text,
    "Raport na czwartek.",
  );
  ok("Drugi komputer dostaje obie notatki");

  /* ── 6. Zmiana na jednym komputerze dojeżdża na drugi ── */
  const target = desktop.getNotes().find((note) => note.text.startsWith("Raport"));
  await sleep(5);
  desktop.updateNote(target.id, { text: "Raport na czwartek — wysłany." });
  await syncNotes({ client: server(cloudRows), store: desktop });

  report = await syncNotes({ client: server(cloudRows), store: laptop });
  assert.equal(report.taken, 1);
  assert.equal(
    laptop.getNotes().find((note) => note.id === target.id).text,
    "Raport na czwartek — wysłany.",
  );
  ok("Poprawka z drugiego komputera nadpisuje starszą wersję");

  /* ── 7. Starsza wersja nie nadpisuje nowszej ──
     Obie strony piszą w tę samą notatkę, ale na serwer trafia najpierw
     starsza zmiana. Nowsza ma ją zastać i nie ustąpić. */
  await sleep(5);
  desktop.updateNote(target.id, { text: "Wersja z desktopa." });
  await sleep(5);
  laptop.updateNote(target.id, { text: "Wersja z laptopa." });

  await syncNotes({ client: server(cloudRows), store: desktop });
  await syncNotes({ client: server(cloudRows), store: laptop });
  assert.equal(
    laptop.getNotes().find((note) => note.id === target.id).text,
    "Wersja z laptopa.",
    "laptop miał nowszą wersję i nie miał jej oddać",
  );

  await syncNotes({ client: server(cloudRows), store: desktop });
  assert.equal(
    desktop.getNotes().find((note) => note.id === target.id).text,
    "Wersja z laptopa.",
    "starsza wersja miała ustąpić nowszej także u siebie",
  );
  ok("Starsza zmiana nie nadpisuje nowszej, choćby przyszła na serwer pierwsza");

  /* ── 8. Skasowana notatka nie wraca ── */
  await sleep(5);
  laptop.deleteNote(target.id);
  assert.equal(laptop.getNotes().some((note) => note.id === target.id), false);

  await syncNotes({ client: server(cloudRows), store: laptop });
  await syncNotes({ client: server(cloudRows), store: desktop });
  assert.equal(desktop.getNotes().some((note) => note.id === target.id), false);

  // I nie wraca także wtedy, gdy oba komputery odezwą się jeszcze raz.
  await syncNotes({ client: server(cloudRows), store: desktop });
  await syncNotes({ client: server(cloudRows), store: laptop });
  assert.equal(laptop.getNotes().some((note) => note.id === target.id), false);
  assert.equal(desktop.getNotes().some((note) => note.id === target.id), false);
  ok("Skasowana notatka nie wraca z drugiego urządzenia");

  /* ── 9. Nagrobek znika po czasie ── */
  laptop.rawNotes().find((note) => note.id === target.id).deletedAt =
    new Date(Date.now() - 40 * 86_400_000).toISOString();
  assert.equal(laptop.pruneTombstones(30), 1);
  assert.equal(laptop.rawNotes().some((note) => note.id === target.id), false);
  ok("Nagrobek starszy niż trzydzieści dni jest sprzątany");

  /* ── 10. Zalogowanie na inne konto zaczyna od nowa ── */
  report = await syncNotes({ client: server(cloudRows, "u2"), store: laptop });
  assert.equal(laptop.getCloudState().userId, "u2");
  assert.ok(report.pushed > 0, "notatki mają trafić do konta, na które ktoś się właśnie zalogował");
  ok("Zmiana konta przelicza wszystko od zera");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("\nSynchronizacja: wszystko zgodne.");
})().catch((error) => {
  console.error("\n✗", error.message);
  process.exit(1);
});
