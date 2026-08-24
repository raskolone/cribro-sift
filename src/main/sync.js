"use strict";

/**
 * Synchronizacja notatek z Supabase.
 *
 * Zasada jest jedna i wszystko z niej wynika: **dysk jest źródłem prawdy,
 * chmura jest kopią**. Cribro ma działać bez sieci i bez konta tak samo
 * dobrze jak z nimi, więc notatka powstaje lokalnie, dostaje lokalne id
 * i dopiero potem — jeśli jest dokąd — jedzie na serwer.
 *
 * Trzy rzeczy, na których zwykle wykłada się taka synchronizacja:
 *
 *   1. KTO WYGRYWA. Wygrywa nowszy `updatedAt`. Zegar urządzenia bywa
 *      przestawiony, ale to jedyny czas, który mówi o TREŚCI — czas
 *      serwera mówi tylko o tym, kiedy przyszło żądanie.
 *
 *   2. CO ZNACZY „NIE MA". Notatki skasowanej nie da się odróżnić od
 *      niewysłanej, jeśli po prostu zniknie. Dlatego kasowanie zostawia
 *      nagrobek (`deletedAt`) — po obu stronach.
 *
 *   3. OD CZEGO ZACZĄĆ NASTĘPNYM RAZEM. Kursor to `synced_at` z serwera,
 *      nie z urządzenia (dlaczego — patrz supabase/schema.sql).
 *
 * Kolejność w jednym przebiegu jest zawsze ta sama: najpierw pobieramy,
 * potem wysyłamy. Odwrotnie własna wysyłka podnosiłaby kursor ponad
 * zmiany, których jeszcze nie widzieliśmy, i te zmiany przepadłyby.
 */

const BASE_COLUMNS = "local_id,text,pinned,color,created_at,updated_at,deleted_at,synced_at";
/* Szuflada i etykiety dojechały po pierwszym wydaniu. Baza, do której nikt
   nie wkleił nowej wersji supabase/schema.sql, tych kolumn nie ma — i wtedy
   PostgREST odbija CAŁE żądanie, więc razem z nimi przepadłaby zwykła
   synchronizacja. Pytamy o nie raz i, gdy ich nie ma, chodzimy bez nich do
   końca uruchomienia (patrz missingColumn niżej). */
const EXTRA_COLUMNS = "folder,tags,align";
const PAGE = 500; // ile wierszy na jedno pobranie
const BATCH = 100; // ile wierszy na jedną wysyłkę
const TOMBSTONE_DAYS = 30;

/** Czy serwer zna szufladę i etykiety. Sprawdzane raz, przy pierwszej próbie. */
let extended = true;

/**
 * Czy to odmowa z powodu kolumny, której w bazie nie ma.
 *
 * PostgREST mówi to na dwa sposoby: przy odczycie zdaniem Postgresa
 * („column notes.folder does not exist"), a przy zapisie własnym
 * („Could not find the 'folder' column … in the schema cache", PGRST204).
 * Każdy inny błąd zostaje błędem — cicho połknięty zabrałby komuś notatki.
 */
const missingColumn = (error) =>
  /column .*does not exist|schema cache|PGRST204|42703/i.test(String(error?.message ?? error));

const time = (value) => (value ? Date.parse(value) || 0 : 0);

/** Notatka z dysku → wiersz w bazie. */
function toRow(note, userId) {
  const row = {
    user_id: userId,
    local_id: note.id,
    // Nagrobek nie niesie treści. Skasowana notatka ma zniknąć także
    // z serwera, a nie zostać tam pod flagą.
    text: note.deletedAt ? "" : String(note.text ?? ""),
    pinned: !note.deletedAt && !!note.pinned,
    color: note.deletedAt ? "default" : (note.color ?? "default"),
    created_at: note.at ?? new Date().toISOString(),
    updated_at: note.updatedAt ?? note.at ?? new Date().toISOString(),
    deleted_at: note.deletedAt ?? null,
  };
  if (extended) {
    row.folder = note.deletedAt ? null : (note.folder ?? null);
    row.tags = note.deletedAt ? [] : (Array.isArray(note.tags) ? note.tags : []);
    row.align = note.deletedAt ? "left" : (note.align ?? "left");
  }
  return row;
}

/** Wiersz z bazy → notatka na dysk. */
function toNote(row) {
  return {
    id: row.local_id,
    at: row.created_at,
    updatedAt: row.updated_at,
    text: row.deleted_at ? "" : (row.text ?? ""),
    pinned: !row.deleted_at && !!row.pinned,
    color: row.color ?? "default",
    folder: row.deleted_at ? null : (row.folder ?? null),
    tags: row.deleted_at ? [] : (Array.isArray(row.tags) ? row.tags : []),
    align: row.deleted_at ? "left" : (row.align ?? "left"),
    deletedAt: row.deleted_at ?? null,
    // Cofnięcie przesiania to bufor tego komputera, nie treść notatki.
    // Wersja z serwera unieważnia go razem z tekstem, do którego wracał.
    previousText: null,
    // Przyjęte z serwera znaczy „zgodne z serwerem" — nie ma czego odsyłać.
    syncedAt: row.updated_at,
  };
}

/** Czy notatka ma coś, czego serwer jeszcze nie widział. */
const isDirty = (note) => note.syncedAt !== note.updatedAt;

/**
 * Decyzja dla jednej pary: wiersz z serwera kontra notatka na dysku.
 * Funkcja jest czysta i osobna, bo to jedyne miejsce w całym pliku,
 * gdzie da się stracić czyjąś pracę — i jedyne, które trzeba przetestować
 * bez sieci (patrz scripts/sync-test.js).
 *
 * Zwraca "take" (bierzemy wersję z serwera), "keep" (nasza jest nowsza,
 * pójdzie w wysyłce) albo "same" (zgodne — zostaje tylko odhaczyć).
 */
function decide(local, row) {
  if (!local) return "take";
  const here = time(local.updatedAt);
  const there = time(row.updated_at);
  if (there > here) return "take";
  if (there < here) return "keep";
  return "same";
}

/**
 * Jeden pełny przebieg: pobierz zmiany, nanieś je, odeślij swoje.
 *
 * `store` daje surową listę notatek razem z nagrobkami — widok dla
 * użytkownika ich nie pokazuje, ale synchronizacja bez nich nie działa.
 */
async function syncNotes({ client, store, onProgress }) {
  const snapshot = client.snapshot();
  if (!snapshot.signedIn) throw new Error("Nie jesteś zalogowany.");

  const userId = snapshot.userId;
  const cloud = store.getCloudState();

  // Zalogowanie na inne konto zaczyna wszystko od nowa: kursor poprzedniego
  // konta nie znaczy tu nic, a notatki z tego komputera mają trafić tam,
  // gdzie użytkownik właśnie wszedł.
  const switched = cloud.userId && cloud.userId !== userId;
  let cursor = switched ? null : cloud.cursor;
  if (switched) for (const note of store.rawNotes()) note.syncedAt = null;

  onProgress?.({ phase: "pull" });
  const pulled = await pull({ client, cursor });

  let taken = 0;
  for (const row of pulled.rows) {
    const local = store.rawNotes().find((note) => note.id === row.local_id);
    const verdict = decide(local, row);
    if (verdict === "keep") continue;
    store.putRawNote(toNote(row));
    if (verdict === "take") taken += 1;
  }

  // Kursor podnosimy wyłącznie o to, co przyszło z serwera. Nasza własna
  // wysyłka wróci przy następnym przebiegu i nic nie zmieni — to tańsze
  // niż ryzyko przeskoczenia cudzej zmiany zapisanej w tej samej chwili.
  if (pulled.cursor) cursor = pulled.cursor;

  onProgress?.({ phase: "push" });
  const outgoing = store.rawNotes().filter(isDirty);
  for (let i = 0; i < outgoing.length; i += BATCH) {
    const slice = outgoing.slice(i, i + BATCH);
    const push = () =>
      client.rest("/notes?on_conflict=user_id,local_id", {
        method: "POST",
        body: slice.map((note) => toRow(note, userId)),
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      });
    try {
      await push();
    } catch (error) {
      if (!extended || !missingColumn(error)) throw error;
      extended = false;
      await push(); // toRow czyta `extended` przy każdym wywołaniu
    }
    for (const note of slice) note.syncedAt = note.updatedAt;
  }

  const purged = store.pruneTombstones(TOMBSTONE_DAYS);
  store.persistNotes();
  store.saveCloudState({ userId, cursor, lastSyncAt: new Date().toISOString() });

  return { pulled: pulled.rows.length, taken, pushed: outgoing.length, purged };
}

/**
 * Pobranie zmian od kursora.
 *
 * Stronicujemy przesunięciem, nie kursorem: kilka notatek zapisanych jednym
 * żądaniem dostaje identyczne `synced_at` co do mikrosekundy, a kursor
 * ustawiony na tę wartość albo pominąłby resztę paczki, albo wracałby po nią
 * w kółko. Filtr jest przez cały przebieg ten sam, więc przesunięcie liczy
 * się względem stałego zbioru.
 */
async function pull({ client, cursor }) {
  const rows = [];
  const filter = cursor ? `&synced_at=gt.${encodeURIComponent(cursor)}` : "";

  for (let offset = 0; ; offset += PAGE) {
    const ask = () => {
      const columns = extended ? `${BASE_COLUMNS},${EXTRA_COLUMNS}` : BASE_COLUMNS;
      return client.rest(
        `/notes?select=${columns}${filter}&order=synced_at.asc&limit=${PAGE}&offset=${offset}`,
      );
    };
    let data;
    try {
      ({ data } = await ask());
    } catch (error) {
      if (!extended || !missingColumn(error)) throw error;
      extended = false;
      ({ data } = await ask());
    }
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const newest = rows.reduce((max, row) => (row.synced_at > max ? row.synced_at : max), "");
  return { rows, cursor: newest || null };
}

module.exports = { syncNotes, decide, toRow, toNote, isDirty, TOMBSTONE_DAYS };
