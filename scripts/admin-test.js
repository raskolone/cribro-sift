"use strict";
/**
 * Panel admina — komu wolno i co z tego wynika.
 *   node scripts/admin-test.js
 *
 * Panel decyduje o dwóch rzeczach, z których obie da się zepsuć po cichu:
 * o tym, KTO widzi cudze konta, i o tym, CZEGO nie widzą subskrybenci.
 * Pierwsza pomyłka pokazuje cudze adresy, druga gasi połowę aplikacji
 * ludziom, którzy nie zrobili nic złego.
 *
 * NAJWAŻNIEJSZE JEST TU MILCZENIE. Gdy nie ma sieci albo baza nie zna
 * jeszcze tych tabel, odpowiedź brzmi „nie wiadomo" — i wtedy widać
 * wszystko, tak jak przed wprowadzeniem przełączników. Aplikacja odcięta
 * od sieci nie ma prawa gasić własnych funkcji.
 *
 * Plik main/admin.js nie zna Electrona: dostaje klienta i oddaje dane.
 * Dlatego wystarczy tu zwykły Node z atrapą klienta.
 */
const assert = require("assert");
const admin = require("../src/main/admin");
const { isOwner, OWNERS } = require("../src/main/owner");

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? `\n  ${detail}` : ""}`);
  console.log("✓", label);
  passed += 1;
};

/** Atrapa klienta Supabase: zapisuje, o co ją poproszono, i oddaje, co każemy. */
function fakeCloud({ signedIn = true, configured = true, answers = {} } = {}) {
  const calls = [];
  return {
    configured,
    signedIn,
    calls,
    rest: async (pathname, options = {}) => {
      calls.push({ pathname, method: options.method ?? "GET", body: options.body });
      const answer = answers[pathname.split("?")[0]];
      if (answer instanceof Error) throw answer;
      return { data: typeof answer === "function" ? answer(options) : (answer ?? null) };
    },
  };
}

/* ── 1. Milczenie znaczy „pokaż wszystko" ── */

check("Bez odpowiedzi z serwera widać każdą funkcję", admin.allowed(null, "meetings") === true);
check("Pusta lista to już odpowiedź — i znaczy „nie”", admin.allowed([], "meetings") === false);
check("Lista z kodem znaczy „tak”", admin.allowed(["meetings"], "meetings") === true);
check("…i nie otwiera niczego poza tym", admin.allowed(["meetings"], "briefing") === false);

(async () => {
  check("Bez konta nie ma kogo pytać", (await admin.mine(fakeCloud({ signedIn: false }))) === null);
  check(
    "Bez skonfigurowanej chmury też nie",
    (await admin.mine(fakeCloud({ configured: false }))) === null,
  );
  check(
    "Awaria zapytania nie gasi aplikacji — wraca „nie wiadomo”",
    (await admin.mine(fakeCloud({ answers: { "/rpc/my_features": new Error("brak sieci") } }))) ===
      null,
  );

  /* ── 2. Odpowiedź serwera, w obu postaciach ── */

  const plain = await admin.mine(fakeCloud({ answers: { "/rpc/my_features": ["meetings", "cloud"] } }));
  check("Lista napisów jest rozumiana", JSON.stringify(plain) === '["meetings","cloud"]');

  const rows = await admin.mine(
    fakeCloud({ answers: { "/rpc/my_features": [{ my_features: "meetings" }] } }),
  );
  check("…i lista wierszy, którą oddaje inna wersja PostgREST-a", JSON.stringify(rows) === '["meetings"]');

  const dirty = await admin.mine(
    fakeCloud({ answers: { "/rpc/my_features": ["meetings", null, 7, { inne: "x" }] } }),
  );
  check("Śmieci z odpowiedzi wypadają, zamiast wywracać okno", JSON.stringify(dirty) === '["meetings"]');

  /* ── 3. Stan przełączników ── */

  const known = await admin.features(
    fakeCloud({ answers: { "/features": [{ code: "meetings", state: "invited" }] } }),
  );
  const meetings = known.find((item) => item.code === "meetings");
  check("Stan z bazy trafia do panelu", meetings.state === "invited");
  check("…razem z opisem, który mieszka w aplikacji", /Nagrywanie rozmowy/.test(meetings.note));
  check(
    "Funkcja, której baza nie zna, pokazuje się jako włączona",
    known.find((item) => item.code === "cloud").state === "on",
  );
  check(
    "…i mówi wprost, że brakuje jej w bazie",
    known.find((item) => item.code === "cloud").known === false,
  );

  const stale = await admin.features(fakeCloud({ answers: { "/features": new Error("brak tabeli") } }));
  check(
    "Stara baza nie wywraca panelu — wszystko widoczne",
    stale.every((item) => item.state === "on" && item.known === false),
  );

  /* ── 4. Zapis ── */

  const cloud = fakeCloud();
  await admin.setState(cloud, "meetings", "off");
  const patch = cloud.calls.at(-1);
  check("Przestawienie idzie PATCH-em na jeden wiersz", patch.method === "PATCH");
  check("…wskazany po kodzie funkcji", patch.pathname.includes("code=eq.meetings"));
  check("…i niesie sam stan", patch.body.state === "off");

  await assert.rejects(
    () => admin.setState(cloud, "czegoś-takiego-nie-ma", "on"),
    /Nie ma takiej funkcji/,
    "nieznana funkcja ma zostać odrzucona po tej stronie",
  );
  check("Nieznanej funkcji nie wysyłamy do bazy", true);

  await assert.rejects(
    () => admin.setState(cloud, "meetings", "może"),
    /Nieznany stan/,
    "stan spoza trójki ma zostać odrzucony",
  );
  check("Stan spoza „on / off / invited” też nie", true);

  /* ── 5. Nadania imienne ── */

  const grants = fakeCloud();
  await admin.grant(grants, "meetings", "u-1", true);
  const added = grants.calls.at(-1);
  check("Nadanie to wstawienie wiersza", added.method === "POST" && added.pathname === "/feature_grants");
  check("…z funkcją i osobą", added.body.feature === "meetings" && added.body.user_id === "u-1");

  await admin.grant(grants, "meetings", "u-1", false);
  const removed = grants.calls.at(-1);
  check("Odebranie to skasowanie tego samego wiersza", removed.method === "DELETE");
  check(
    "…wskazanego i funkcją, i osobą — nie samą funkcją",
    removed.pathname.includes("feature=eq.meetings") && removed.pathname.includes("user_id=eq.u-1"),
  );

  await assert.rejects(() => admin.grant(grants, "meetings", "", true), /Nie wiadomo, komu/);
  check("Nadanie bez osoby nie ma sensu i nie jedzie nigdzie", true);

  /* ── 6. Kto jest właścicielem ── */

  check("Panel należy do jednego adresu", OWNERS.length === 1);
  check("…i to on jest w spisie", isOwner({ email: OWNERS[0], env: {} }) === true);
  check("Cudzy adres panelu nie otwiera", isOwner({ email: "ktos@inny.pl", env: {} }) === false);
  check("Wielkość liter nie ma znaczenia", isOwner({ email: OWNERS[0].toUpperCase(), env: {} }) === true);

  /* ── 7. Spis funkcji zgadza się ze schematem bazy ── */

  const fs = require("fs");
  const path = require("path");
  const schema = fs.readFileSync(path.join(__dirname, "..", "supabase", "schema.sql"), "utf8");
  for (const feature of admin.FEATURES) {
    check(
      `Funkcja „${feature.code}” ma swój wiersz w schemacie bazy`,
      new RegExp(`\\('${feature.code}',`).test(schema),
    );
  }
  check(
    "Schemat zna trzy stany i nie więcej",
    /check \(state in \('on', 'off', 'invited'\)\)/.test(schema),
  );
  check(
    "Spis adminów jest niedostępny dla klienta — nie ma na nim polityki SELECT",
    !/on public\.admins for select/.test(schema),
  );

  console.log(`\nPanel admina: ${passed} sprawdzeń przeszło. Granica jest w bazie, nie w oknie.`);
})().catch((problem) => {
  console.error(`\n✗ ${problem.message}`);
  process.exit(1);
});
