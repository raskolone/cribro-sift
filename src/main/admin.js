"use strict";

/**
 * Panel admina — kto się zarejestrował i co wolno mu zobaczyć.
 *
 * ══ PO CO TO ISTNIEJE ══
 *
 * Na czas wdrażania. Aplikacja idzie do ludzi z funkcjami, które są jeszcze
 * w becie — notatki ze spotkań są pierwszą taką — i musi być sposób, żeby
 * je wyłączyć albo wpuścić na nie pięć osób BEZ WYDAWANIA NOWEJ WERSJI.
 * Wersja idzie przez podpisywanie, notaryzację i pobranie u każdego;
 * przełącznik w bazie działa od następnego uruchomienia okna.
 *
 * ══ CZEGO TU NIE MA ══
 *
 * KLUCZA `service_role`. To jest ten klucz, który omija RLS i widzi
 * wszystko wszystkich — w aplikacji desktopowej nie ma go i nie będzie
 * (patrz nagłówek main/supabase.js). Panel działa na ZWYKŁYM tokenie
 * zalogowanego człowieka; o tym, że wolno mu zobaczyć spis kont, decyduje
 * baza, sprawdzając jego adres w tabeli `admins` (patrz `is_admin` oraz
 * `admin_users` w supabase/schema.sql).
 *
 * Konsekwencja jest taka, że panel nie da się „odblokować" po tej stronie:
 * kto podmieni sobie sprawdzenie w kodzie Electrona, dostanie z serwera
 * pustą listę i odmowę zapisu. Granica jest w bazie, nie w oknie.
 *
 * ══ DWA PYTANIA, DWIE DROGI ══
 *
 *   1. CO JA MOGĘ ZOBACZYĆ — `mine()`. Pyta każdy, przy starcie. Odpowiedź
 *      steruje tym, czego w oknie nie ma.
 *   2. KTO SIĘ ZAREJESTROWAŁ I CO MU WŁĄCZYĆ — reszta. Pyta wyłącznie
 *      admin, i tylko wtedy, gdy otworzy panel.
 *
 * Plik nie zna Electrona: dostaje klienta Supabase i oddaje dane. Dlatego
 * sprawdza go zwykły Node — patrz scripts/admin-test.js.
 */

/**
 * Funkcje, o które w ogóle chodzi.
 *
 * Spis jest TUTAJ, a nie w bazie, i to jest rozstrzygnięcie, nie
 * przeoczenie: nazwa i opis należą do aplikacji, bo to ona wie, co ta
 * funkcja robi w jej oknie. W bazie leży sam STAN — jedno słowo na
 * funkcję. Przepisany tam opis rozjechałby się z tym, co widać na ekranie,
 * i nikt by nie wiedział, które jest prawdziwe.
 *
 * `code` musi zgadzać się z wierszem w `public.features`.
 */
const FEATURES = [
  {
    code: "meetings",
    label: "Notatki ze spotkań",
    note: "Nagrywanie rozmowy, transkrypcja i podsumowanie.",
    /* Czego w oknie nie ma, gdy funkcja jest wyłączona. Nazwa zakładki
       w pasku bocznym — renderer nie musi wiedzieć nic więcej. */
    view: "meetings",
  },
  {
    code: "briefing",
    label: "Poranek",
    note: "Podsumowanie dnia z kalendarza i poczty.",
    view: null,
  },
  {
    code: "cloud",
    label: "Notatki w chmurze",
    note: "Synchronizacja notatek między komputerami.",
    view: null,
  },
];

const CODES = new Set(FEATURES.map((item) => item.code));
const STATES = new Set(["on", "off", "invited"]);

/**
 * Co ten człowiek może zobaczyć.
 *
 * ══ ODMOWA NIE JEST ODPOWIEDZIĄ „NIC" ══
 *
 * Gdy nie ma sieci, nie ma konta albo baza nie zna jeszcze tych tabel,
 * pytanie zostaje BEZ ODPOWIEDZI — i wtedy widać wszystko, tak jak przed
 * wprowadzeniem przełączników. Odwrotnie byłoby okrutnie: aplikacja
 * odcięta od sieci gasiłaby połowę własnych funkcji, a człowiek nie miałby
 * jak się dowiedzieć dlaczego.
 *
 * Wyłączenie funkcji jest decyzją, którą trzeba USŁYSZEĆ od serwera.
 * Milczenie decyzją nie jest.
 *
 * @param {object} cloud  klient z main/supabase.js
 * @returns {Promise<string[]|null>} kody funkcji albo null = „nie wiadomo"
 */
async function mine(cloud) {
  if (!cloud?.configured || !cloud.signedIn) return null;
  try {
    const { data } = await cloud.rest("/rpc/my_features", { method: "POST", body: {} });
    if (!Array.isArray(data)) return null;
    /* PostgREST oddaje `setof text` jako listę napisów albo listę obiektów
       z jedną kolumną — zależnie od wersji. Przyjmujemy obie. */
    return data
      .map((row) => (typeof row === "string" ? row : (row?.my_features ?? null)))
      .filter((code) => typeof code === "string");
  } catch {
    return null; // brak sieci, stara baza, wygasła sesja — patrz wyżej
  }
}

/**
 * Czy tę funkcję wolno pokazać.
 *
 * Bierze to, co oddało `mine`. `null` znaczy „nie wiadomo" i wtedy wolno
 * wszystko — z tego samego powodu, dla którego `mine` oddaje null.
 */
function allowed(features, code) {
  if (!Array.isArray(features)) return true;
  return features.includes(code);
}

/** Spis zarejestrowanych. Odmowa po stronie bazy wraca jako pusta lista. */
async function users(cloud) {
  const { data } = await cloud.rest("/rpc/admin_users", { method: "POST", body: {} });
  return Array.isArray(data) ? data : [];
}

/**
 * Stan przełączników — z bazy, wzbogacony o opisy z tego pliku.
 *
 * Funkcja, której nie ma w bazie, pokazuje się jako włączona: tak wygląda
 * baza, do której nie wgrano jeszcze nowego schematu, i tak samo wygląda
 * aplikacja przed wprowadzeniem przełączników.
 */
async function features(cloud) {
  let rows = [];
  try {
    const { data } = await cloud.rest("/features?select=code,state,updated_at");
    if (Array.isArray(data)) rows = data;
  } catch {
    /* stara baza — pokazujemy same domyślne */
  }
  const state = new Map(rows.map((row) => [row.code, row.state]));
  return FEATURES.map((item) => ({
    ...item,
    state: STATES.has(state.get(item.code)) ? state.get(item.code) : "on",
    known: state.has(item.code),
  }));
}

/**
 * Przestawienie przełącznika.
 *
 * Sprawdzamy nazwę i stan PRZED wysłaniem — nie dlatego, że baza tego nie
 * zrobi (zrobi, ma `check`), tylko dlatego, że jej odmowa wraca jako
 * komunikat PostgREST-a o naruszeniu ograniczenia, a nie jako zdanie,
 * z którym da się cokolwiek zrobić.
 */
async function setState(cloud, code, state) {
  if (!CODES.has(code)) throw new Error(`Nie ma takiej funkcji: ${code}`);
  if (!STATES.has(state)) throw new Error(`Nieznany stan: ${state}`);
  await cloud.rest(`/features?code=eq.${encodeURIComponent(code)}`, {
    method: "PATCH",
    body: { state, updated_at: new Date().toISOString() },
    headers: { Prefer: "return=minimal" },
  });
  return { code, state };
}

/**
 * Nadanie albo odebranie funkcji jednej osobie.
 *
 * Ma sens wyłącznie przy stanie „invited" — ale nadanie przy „off" nie
 * jest błędem i nie kasujemy go: stan wraca później na „invited", a nadania
 * mają wtedy zostać takie, jak były.
 */
async function grant(cloud, code, userId, on) {
  if (!CODES.has(code)) throw new Error(`Nie ma takiej funkcji: ${code}`);
  if (!userId) throw new Error("Nie wiadomo, komu.");

  if (on) {
    await cloud.rest("/feature_grants", {
      method: "POST",
      body: { feature: code, user_id: userId },
      // Nadanie drugi raz nie jest błędem — jest tym samym nadaniem.
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  } else {
    await cloud.rest(
      `/feature_grants?feature=eq.${encodeURIComponent(code)}&user_id=eq.${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: { Prefer: "return=minimal" } },
    );
  }
  return { code, userId, on: !!on };
}

module.exports = { FEATURES, CODES, STATES, mine, allowed, users, features, setState, grant };
