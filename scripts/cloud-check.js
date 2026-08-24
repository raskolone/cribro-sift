"use strict";
/**
 * Sprawdzenie, czy RLS naprawdę pilnuje notatek.
 *   node scripts/cloud-check.js
 *
 * To nie jest test jednostkowy — to rozmowa z twoim prawdziwym projektem
 * Supabase. Skrypt loguje się na podane konta i próbuje zrobić rzeczy,
 * których robić nie wolno: czytać cudze notatki bez logowania, podszyć się
 * pod cudze `user_id`, zmienić notatkę drugiego konta, wywołać funkcję
 * sprzątającą. Każda taka próba MA się nie udać.
 *
 * „Włączyłem RLS" i „RLS działa" to dwa różne zdania. Pierwsze widać
 * w panelu, drugie sprawdza się tylko tak: próbując.
 *
 * Konta podaje się w trakcie (hasła nie widać) albo zmiennymi środowiska:
 *   CRIBRO_A_EMAIL, CRIBRO_A_PASSWORD, CRIBRO_B_EMAIL, CRIBRO_B_PASSWORD
 *
 * Drugie konto jest opcjonalne, ale bez niego nie da się sprawdzić tego,
 * o co w RLS chodzi najbardziej — że jeden człowiek nie widzi drugiego.
 * Skrypt powie wtedy wprost, czego nie sprawdził.
 *
 * Po sobie sprząta: notatka testowa jest kasowana na koniec.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const Module = require("module");

// supabase.js sięga po Electrona już przy wczytaniu — podstawiamy tyle,
// ile trzeba, żeby dał się uruchomić zwykłym Nodem. Sesja i tak leci
// do katalogu tymczasowego, żeby nie ruszać tej z aplikacji.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cribro-rls-"));
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return { app: { getPath: () => scratch }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return load.call(this, request, ...rest);
};

const { Supabase } = require("../src/main/supabase");

/* ── Wejście ────────────────────────────────────────────────────── */

const SETTINGS = path.join(
  os.homedir(),
  "Library/Application Support/Cribro Sift/settings.json",
);

function readConfig() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };

  let url = flag("url");
  let anonKey = flag("key");
  if (!url || !anonKey) {
    try {
      const saved = JSON.parse(fs.readFileSync(SETTINGS, "utf8")).cloud ?? {};
      url ??= saved.url;
      anonKey ??= saved.anonKey;
    } catch {
      /* aplikacja jeszcze nic nie zapisała */
    }
  }
  return { url, anonKey };
}

function ask(query, hidden = false) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.muted = hidden;
    rl._writeToOutput = function (chunk) {
      if (!rl.muted) rl.output.write(chunk);
    };
    rl.question("", (value) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(value.trim());
    });
  });
}

async function account(label, prefix) {
  const email = process.env[`${prefix}_EMAIL`] ?? (await ask(`  ${label} — adres e-mail: `));
  if (!email) return null;
  const password =
    process.env[`${prefix}_PASSWORD`] ?? (await ask(`  ${label} — hasło: `, true));
  return { email, password };
}

/* ── Rachunek ───────────────────────────────────────────────────── */

const results = [];

function summary() {
  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  console.log("");
  if (failed.length) {
    console.log(`✗ Nie zdało: ${failed.length} z ${results.length}.`);
    console.log("  Puść jeszcze raz supabase/schema.sql w SQL Editorze — skrypt");
    console.log("  można wykonać wielokrotnie i nic nie psuje.\n");
    process.exit(1);
  }
  console.log(`✓ Wszystko zdane (${results.length - skipped.length} sprawdzeń).`);
  if (skipped.length) console.log(`  Pominięte: ${skipped.length} — patrz wyżej.`);
  console.log("  Każdy widzi wyłącznie swoje.\n");
}

function record(ok, label, detail = "") {
  results.push({ ok, label, detail });
  const mark = ok === null ? "–" : ok ? "✓" : "✗";
  console.log(`${mark}  ${label}${detail ? `\n     ${detail}` : ""}`);
}

/** Sprawdzenie, które ma się NIE udać. Sukces żądania jest tu porażką. */
async function mustFail(label, run) {
  try {
    await run();
    record(false, label, "żądanie przeszło, a nie miało prawa");
  } catch (error) {
    record(true, label, `odrzucone: ${String(error.message).slice(0, 90)}`);
  }
}

/** Surowe żądanie bez żadnego tokenu — tak wygląda ktoś z ulicy z kluczem anon. */
async function anonymous(url, anonKey, pathname, options = {}) {
  const response = await fetch(`${url}/rest/v1${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 120)}`);
  try {
    return JSON.parse(text || "null");
  } catch {
    return null;
  }
}

/* ── Przebieg ───────────────────────────────────────────────────── */

(async () => {
  const { url, anonKey } = readConfig();
  if (!url || !anonKey) {
    console.error(
      "\nBrakuje adresu projektu albo klucza anon.\n" +
        "Wpisz je w aplikacji (Ustawienia → Konto i notatki w chmurze)\n" +
        "albo podaj tutaj:  node scripts/cloud-check.js --url https://… --key eyJ…\n",
    );
    process.exit(2);
  }

  console.log(`\nProjekt: ${url}\n`);
  console.log("Konta do sprawdzenia (drugie opcjonalne, ale bez niego");
  console.log("nie da się sprawdzić, czy jedno konto nie widzi drugiego):\n");

  const a = await account("Konto A", "CRIBRO_A");
  if (!a) {
    console.error("\nBez pierwszego konta nie ma czego sprawdzać.\n");
    process.exit(2);
  }
  const b = await account("Konto B", "CRIBRO_B");
  console.log("");

  const clientA = new Supabase({ dir: path.join(scratch, "a") });
  clientA.configure({ url, anonKey });

  /* ── 1. Ktoś z ulicy: ma klucz anon i nic poza tym ── */
  const strangerNotes = await anonymous(url, anonKey, "/notes?select=local_id");
  record(
    Array.isArray(strangerNotes) && strangerNotes.length === 0,
    "Bez logowania notatki są niewidoczne",
    `zwrócono wierszy: ${Array.isArray(strangerNotes) ? strangerNotes.length : "?"}`,
  );

  const strangerProfiles = await anonymous(url, anonKey, "/profiles?select=id");
  record(
    Array.isArray(strangerProfiles) && strangerProfiles.length === 0,
    "Bez logowania profile są niewidoczne",
    `zwrócono wierszy: ${Array.isArray(strangerProfiles) ? strangerProfiles.length : "?"}`,
  );

  await mustFail("Bez logowania nie da się nic dopisać", () =>
    anonymous(url, anonKey, "/notes", {
      method: "POST",
      body: [{ user_id: "00000000-0000-0000-0000-000000000000", local_id: "obcy", text: "x" }],
    }),
  );

  /* ── 2. Konto A ── */
  await clientA.signIn(a.email, a.password);
  const idA = clientA.snapshot().userId;
  record(!!idA, "Konto A zalogowane", `${clientA.snapshot().email} · ${idA}`);

  const profiles = (await clientA.rest("/profiles?select=id,display_name")).data;
  record(
    profiles.length === 1 && profiles[0].id === idA,
    "Konto A widzi dokładnie jeden profil — swój",
    `wierszy: ${profiles.length}`,
  );

  /* ── 2a. Licznik i plan ── */
  const snapshot = (await clientA.rest("/rpc/usage_snapshot", { method: "POST", body: {} })).data;
  record(
    snapshot?.ok === true && typeof snapshot.cap_seconds === "number",
    "Licznik zużycia odpowiada i mówi o własnym koncie",
    `plan: ${snapshot?.plan} · ${snapshot?.used_seconds}/${snapshot?.cap_seconds} s · chmura: ${snapshot?.cloud_notes ? "tak" : "nie"}`,
  );
  const planA = snapshot?.plan ?? "free";
  const cloudA = snapshot?.cloud_notes === true;

  await mustFail("Konto A nie podniesie sobie planu na Pro", async () => {
    const changed = (
      await clientA.rest(`/profiles?id=eq.${idA}`, {
        method: "PATCH",
        body: { plan: "pro" },
        headers: { Prefer: "return=representation" },
      })
    ).data;
    // Brak wyjątku, ale i brak zmiany, też jest poprawną odpowiedzią bazy.
    if (Array.isArray(changed) && changed.length === 0) throw new Error("zero zmienionych wierszy");
    if (Array.isArray(changed) && changed[0]?.plan !== "pro") throw new Error("plan bez zmian");
  });

  await mustFail("Konto A nie wywoła funkcji zajmującej limit", () =>
    clientA.rest("/rpc/claim_audio", { method: "POST", body: { uid: idA, want_seconds: 10 } }),
  );
  await mustFail("Konto A nie wywoła funkcji zwracającej sekundy", () =>
    clientA.rest("/rpc/release_audio", { method: "POST", body: { uid: idA, give_back: 100000 } }),
  );
  await mustFail("Konto A nie zapisze wprost do licznika", () =>
    clientA.rest("/usage", {
      method: "POST",
      body: [{ user_id: idA, period: new Date().toISOString().slice(0, 8) + "01", seconds: -99999 }],
    }),
  );

  /* ── 2b. Notatka kontrolna — wolno ją dopisać tylko na planie z chmurą ── */
  const marker = `rls-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const putNote = () =>
    clientA.rest("/notes?on_conflict=user_id,local_id", {
      method: "POST",
      body: [
        {
          user_id: idA,
          local_id: marker,
          text: "Notatka kontrolna. Zaraz zniknie.",
          created_at: now,
          updated_at: now,
        },
      ],
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });

  if (!cloudA) {
    await mustFail(
      `Konto A jest na planie „${planA}" bez chmury — zapis notatki ma się odbić`,
      putNote,
    );
    record(
      null,
      "Dalsze sprawdzenia notatek — POMINIĘTE",
      "nadaj kontu A plan z chmurą (patrz koniec supabase/schema.sql), żeby sprawdzić resztę",
    );
    return summary();
  }

  await putNote();
  const mine = (await clientA.rest(`/notes?select=local_id&local_id=eq.${marker}`)).data;
  record(mine.length === 1, "Konto A widzi własną notatkę", `local_id: ${marker}`);

  await mustFail("Konto A nie podszyje się pod cudze user_id", () =>
    clientA.rest("/notes", {
      method: "POST",
      body: [
        {
          user_id: "11111111-1111-1111-1111-111111111111",
          local_id: `${marker}-podszywka`,
          text: "nie moje",
          created_at: now,
          updated_at: now,
        },
      ],
    }),
  );

  await mustFail("Funkcja sprzątająca nie jest wystawiona zalogowanym", () =>
    clientA.rest("/rpc/purge_deleted_notes", { method: "POST", body: {} }),
  );

  /* ── 3. Konto B: czy widzi cokolwiek A ── */
  if (b) {
    const clientB = new Supabase({ dir: path.join(scratch, "b") });
    clientB.configure({ url, anonKey });
    await clientB.signIn(b.email, b.password);
    const idB = clientB.snapshot().userId;
    record(!!idB && idB !== idA, "Konto B zalogowane i jest innym kontem", `${clientB.snapshot().email} · ${idB}`);

    const seen = (await clientB.rest(`/notes?select=local_id&local_id=eq.${marker}`)).data;
    record(seen.length === 0, "Konto B NIE widzi notatki konta A", `zwrócono wierszy: ${seen.length}`);

    const all = (await clientB.rest("/notes?select=user_id")).data;
    const foreign = all.filter((row) => row.user_id !== idB);
    record(foreign.length === 0, "Konto B nie widzi ani jednego cudzego wiersza", `cudzych wierszy: ${foreign.length}`);

    const patched = (
      await clientB.rest(`/notes?local_id=eq.${marker}`, {
        method: "PATCH",
        body: { text: "przejęte" },
        headers: { Prefer: "return=representation" },
      })
    ).data;
    record(
      Array.isArray(patched) && patched.length === 0,
      "Konto B nie zmieni notatki konta A",
      `zmienionych wierszy: ${Array.isArray(patched) ? patched.length : "?"}`,
    );

    const removed = (
      await clientB.rest(`/notes?local_id=eq.${marker}`, {
        method: "DELETE",
        headers: { Prefer: "return=representation" },
      })
    ).data;
    record(
      Array.isArray(removed) && removed.length === 0,
      "Konto B nie skasuje notatki konta A",
      `skasowanych wierszy: ${Array.isArray(removed) ? removed.length : "?"}`,
    );

    const profilesB = (await clientB.rest("/profiles?select=id")).data;
    record(
      profilesB.length === 1 && profilesB[0].id === idB,
      "Konto B widzi wyłącznie swój profil",
      `wierszy: ${profilesB.length}`,
    );
  } else {
    record(
      null,
      "Sprawdzenie „jedno konto nie widzi drugiego\" — POMINIĘTE",
      "podaj drugie konto, żeby sprawdzić to, o co w RLS chodzi najbardziej",
    );
  }

  /* ── 4. Sprzątanie ── */
  const still = (await clientA.rest(`/notes?select=text&local_id=eq.${marker}`)).data;
  record(
    still.length === 1 && still[0].text.startsWith("Notatka kontrolna"),
    "Notatka konta A przetrwała próby konta B nietknięta",
    `treść: „${still[0]?.text ?? "—"}"`,
  );
  await clientA.rest(`/notes?local_id=eq.${marker}`, { method: "DELETE" });

  return summary();
})()
  .catch((error) => {
    console.error("\n✗ Przerwane:", error.message, "\n");
    process.exit(1);
  })
  .finally(() => fs.rmSync(scratch, { recursive: true, force: true }));
