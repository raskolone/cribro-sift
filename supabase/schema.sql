-- ════════════════════════════════════════════════════════════════════════
--  Cribro Sift — backend notatek, kont i limitów
--
--  Wklej ten plik do SQL Editora w panelu Supabase i naciśnij Run.
--  Albo, jeśli masz CLI:  supabase db push
--
--  Skrypt jest idempotentny: można go puścić drugi raz i nic się nie stanie.
--  Przy zmianie progów w cenniku puszcza się go ponownie — wartości w tabeli
--  `plans` zostaną nadpisane, reszta zostanie nietknięta.
--
--  Co tu jest i czego tu NIE ma:
--
--    JEST   konta (auth.users — obsługuje je sam Supabase), profil
--           użytkownika, notatki, progi cenowe i licznik zużycia.
--
--    NIE MA historii dyktowania. To decyzja, nie przeoczenie: historia
--           trzyma surowe transkrypty razem z nazwą aplikacji, do której
--           mówiłeś. Zostaje na dysku i nigdzie nie jedzie.
--
--  KOLEJNOŚĆ W TYM PLIKU NIE JEST DOWOLNA. Polityki dostępu do notatek
--  wołają funkcję sprawdzającą plan, więc plany i funkcje muszą powstać
--  wcześniej niż notatki.
-- ════════════════════════════════════════════════════════════════════════


-- ── Progi ──────────────────────────────────────────────────────────────
--
-- Cennik jako wiersze, nie jako `if` w kodzie. Zmiana limitu to wtedy jedno
-- zapytanie, a nie nowa wersja aplikacji u każdego klienta — i, co ważniejsze,
-- limit jest tam, gdzie jest egzekwowany.
--
-- Model transkrypcji też leży tutaj, bo to jest różnica między progami,
-- która kosztuje: transkrypcja to ~85% rachunku, sito to grosze.

create table if not exists public.plans (
  code              text primary key,          -- 'free' | 'pro'
  label             text not null,
  minutes_per_month integer not null,
  max_clip_seconds  integer not null,          -- najdłuższe pojedyncze nagranie
  cloud_notes       boolean not null default false,
  stt_model         text not null,
  sieve_model       text not null
);

insert into public.plans (code, label, minutes_per_month, max_clip_seconds, cloud_notes, stt_model, sieve_model)
values
  ('free', 'Free',  30, 180, false, 'gpt-4o-mini-transcribe', 'gpt-5.6-luna'),
  ('pro',  'Pro',  600, 900, true,  'gpt-transcribe',         'gpt-5.6-luna')
on conflict (code) do update set
  label             = excluded.label,
  minutes_per_month = excluded.minutes_per_month,
  max_clip_seconds  = excluded.max_clip_seconds,
  cloud_notes       = excluded.cloud_notes,
  stt_model         = excluded.stt_model,
  sieve_model       = excluded.sieve_model;

alter table public.plans enable row level security;

-- Cennik jest jawny — aplikacja pokazuje z niego, co daje Pro.
drop policy if exists "progi: każdy czyta" on public.plans;
create policy "progi: każdy czyta"
  on public.plans for select
  using (true);


-- ── Profil ─────────────────────────────────────────────────────────────
--
-- auth.users należy do Supabase i nie wolno go zmieniać. Wszystko własne
-- o użytkowniku mieszka więc obok, w tabeli powiązanej kluczem.

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Plan i jego termin. `plan_until` puste znaczy „bezterminowo" — tak wygląda
-- konto darmowe i tak wyglądałby wpis nadany ręcznie.
alter table public.profiles add column if not exists plan text not null default 'free';
alter table public.profiles add column if not exists plan_until timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_plan_fkey') then
    alter table public.profiles
      add constraint profiles_plan_fkey foreign key (plan) references public.plans (code);
  end if;
end $$;

alter table public.profiles enable row level security;

-- Każda polityka osobno: „for all" wygląda krócej, ale wtedy jedna reguła
-- decyduje o czytaniu i o pisaniu, a to nie to samo pytanie.
drop policy if exists "profil: czytam swój" on public.profiles;
create policy "profil: czytam swój"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profil: zakładam swój" on public.profiles;
create policy "profil: zakładam swój"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profil: zmieniam swój" on public.profiles;
create policy "profil: zmieniam swój"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ══ TO JEST WAŻNIEJSZE, NIŻ WYGLĄDA ══
--
-- Polityka RLS mówi, KTÓRY WIERSZ wolno zmienić. Nie mówi ani słowa o tym,
-- KTÓRĄ KOLUMNĘ. Bez poniższego klient mógłby jednym żądaniem przepisać
-- sobie `plan` z 'free' na 'pro' — wiersz jest przecież jego własny, więc
-- polityka by go przepuściła.
--
-- Prawo zapisu dostaje więc jedna kolumna, ta jedyna, która należy do
-- użytkownika. `plan` i `plan_until` ustawia wyłącznie webhook płatności,
-- kluczem service_role.
revoke update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;


-- Profil zakłada się sam przy rejestracji. Inaczej aplikacja musiałaby
-- pamiętać, żeby go dopisać — a przy logowaniu z drugiego urządzenia albo
-- przez link e-mail nie ma takiego momentu.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ── Uprawnienia wynikające z planu ─────────────────────────────────────
--
-- Jedno miejsce, w którym zapada pytanie „na czym ten człowiek jest".
-- Rozsiane po politykach `case`i rozjechałyby się przy pierwszej zmianie
-- cennika, a rozjazd w regule dostępu jest niewidoczny do dnia, w którym
-- ktoś to zauważy.

create or replace function public.effective_plan(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- Wygasły Pro to Free. Termin jest twardy i liczy go baza, nie aplikacja.
  select case
           when p.plan <> 'free' and (p.plan_until is null or p.plan_until > now()) then p.plan
           else 'free'
         end
    from public.profiles p
   where p.id = uid;
$$;

-- Wołana z polityk, więc bez argumentu i zawsze o sobie. Gdyby brała uid,
-- każdy mógłby sprawdzać, na jakim planie siedzi kto inny.
create or replace function public.can_write_notes()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select pl.cloud_notes
       from public.plans pl
      where pl.code = public.effective_plan(auth.uid())),
    false);
$$;

-- effective_plan przyjmuje cudze uid, więc nie może być wołana z zewnątrz.
-- Funkcjom `security definer` powyżej to nie przeszkadza: w środku takiej
-- funkcji prawa sprawdzane są względem właściciela, nie wołającego.
revoke all on function public.effective_plan(uuid) from public, anon, authenticated;


-- ── Notatki ────────────────────────────────────────────────────────────
--
-- Dwa identyfikatory, bo to dwie różne rzeczy:
--
--   id        klucz w bazie. Nadaje go serwer.
--   local_id  identyfikator, którym notatkę nazywa aplikacja na dysku
--             („n1a2b3c-x4y5z"). Notatka powstaje offline i ma swoje id,
--             zanim ktokolwiek zobaczy serwer.
--
-- Para (user_id, local_id) jest unikalna — dzięki temu wysłanie tej samej
-- notatki drugi raz nadpisuje wiersz zamiast zakładać duplikat.

create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  local_id   text not null,

  text       text not null default '',
  pinned     boolean not null default false,

  -- Kolor karteczki na pulpicie. Własność notatki, nie tego biurka —
  -- inaczej niż „na wierzchu", które zostaje na jednym komputerze
  -- (patrz toggleWidget w src/renderer/js/notes.js).
  color      text not null default 'default',

  -- Czas z urządzenia. To on rozstrzyga, czyja wersja jest nowsza,
  -- gdy notatkę zmieniono w dwóch miejscach naraz.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Kasowanie zostawia ślad. Bez niego notatka skasowana na laptopie
  -- wracałaby z telefonu przy najbliższej synchronizacji — bo dla drugiego
  -- urządzenia „nie ma jej na serwerze" i „jeszcze jej tam nie wysłałem"
  -- wygląda identycznie.
  deleted_at timestamptz,

  -- Czas z serwera, ustawiany wyzwalaczem przy każdym zapisie. To po nim
  -- aplikacja pyta „co się zmieniło od ostatniego razu" — zegar urządzenia
  -- się do tego nie nadaje, bo bywa przestawiony.
  synced_at  timestamptz not null default now(),

  unique (user_id, local_id)
);

-- Pobieranie zmian to zawsze „moje wiersze, nowsze niż kursor".
-- Kolumna dołożona po pierwszym wydaniu. Skrypt ma dać się puścić drugi raz
-- na bazie, która powstała bez niej — `create table if not exists` wyżej nie
-- dołoży kolumny do tabeli, która już stoi.
alter table public.notes
  add column if not exists color text not null default 'default';

-- Szuflada i etykiety. Dwie różne rzeczy: szuflada mówi, GDZIE notatka leży,
-- etykiety mówią, CZEGO dotyczy — i dlatego jedna jest tekstem, a drugie
-- tablicą. Obie dołożone po pierwszym wydaniu, więc znów `if not exists`.
--
-- Aplikacja umie chodzić bez nich: jeśli tych kolumn w bazie nie ma,
-- synchronizacja wykrywa to przy pierwszym żądaniu i pomija je do końca
-- uruchomienia (patrz missingColumn w src/main/sync.js). Notatki jeżdżą
-- wtedy normalnie, tyle że szuflada i etykiety zostają na tym komputerze.
alter table public.notes
  add column if not exists folder text;
alter table public.notes
  add column if not exists tags text[] not null default '{}';

-- Wyrównanie tekstu notatki: left | center | right | justify. Cecha
-- dokumentu, nie widoku — notatka wyjustowana na laptopie ma być
-- wyjustowana także na drugim komputerze.
alter table public.notes
  add column if not exists align text not null default 'left';

create index if not exists notes_user_synced_idx
  on public.notes (user_id, synced_at);

alter table public.notes enable row level security;

-- ══ CZYTANIE I KASOWANIE ZOSTAJĄ OTWARTE NA ZAWSZE ══
--
-- Także po wygaśnięciu Pro. Notatki są własnością człowieka, nie zastawem
-- pod abonament: kto przestał płacić, ma je pobrać, wyeksportować i skasować,
-- kiedy zechce. Blokujemy wyłącznie DOPISYWANIE nowych — bo to ono kosztuje
-- miejsce i to za nie się płaci.
drop policy if exists "notatki: czytam swoje" on public.notes;
create policy "notatki: czytam swoje"
  on public.notes for select
  using (auth.uid() = user_id);

drop policy if exists "notatki: kasuję swoje" on public.notes;
create policy "notatki: kasuję swoje"
  on public.notes for delete
  using (auth.uid() = user_id);

drop policy if exists "notatki: dopisuję swoje" on public.notes;
create policy "notatki: dopisuję swoje"
  on public.notes for insert
  with check (auth.uid() = user_id and public.can_write_notes());

drop policy if exists "notatki: zmieniam swoje" on public.notes;
create policy "notatki: zmieniam swoje"
  on public.notes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and public.can_write_notes());


-- synced_at nadaje serwer i tylko serwer. Gdyby ustawiała je aplikacja,
-- urządzenie ze spóźnionym zegarem wpisałoby czas z przeszłości i jego
-- zmiany nie przeszłyby przez kursor drugiego urządzenia — zniknęłyby
-- po cichu, co jest najgorszym rodzajem błędu synchronizacji.
create or replace function public.touch_synced_at()
returns trigger
language plpgsql
as $$
begin
  new.synced_at := now();
  return new;
end;
$$;

drop trigger if exists notes_touch_synced_at on public.notes;
create trigger notes_touch_synced_at
  before insert or update on public.notes
  for each row execute function public.touch_synced_at();


-- ── Licznik zużycia ────────────────────────────────────────────────────
--
-- Sekundy, nie sztuki. OpenAI liczy minuty audio, więc licznik odpowiada
-- rachunkowi jeden do jednego — a nagranie trzysekundowe i dziesięciominutowe
-- nie kosztują tyle samo, choć jako „sztuki" wyglądają identycznie.

create table if not exists public.usage (
  user_id uuid    not null references auth.users (id) on delete cascade,
  period  date    not null,                -- pierwszy dzień miesiąca
  seconds integer not null default 0,
  primary key (user_id, period)
);

alter table public.usage enable row level security;

-- Czytać wolno tylko o sobie. PISAĆ NIE WOLNO NIKOMU — brak polityk insert,
-- update i delete znaczy, że jedyną drogą do tej tabeli są funkcje poniżej,
-- a jedyną drogą do nich jest funkcja brzegowa z kluczem service_role.
drop policy if exists "zużycie: czytam swoje" on public.usage;
create policy "zużycie: czytam swoje"
  on public.usage for select
  using (auth.uid() = user_id);


-- ══ SERCE OCHRONY TWOICH PIENIĘDZY ══
--
-- Zajęcie limitu JEDNYM zapytaniem. Nie „odczytaj, sprawdź, zapisz" —
-- między tymi trzema krokami mieści się dziesięć innych żądań i wszystkie
-- zobaczą ten sam wolny limit. Tutaj warunek `where` siedzi w środku
-- `update`, więc dwadzieścia równoległych prób przechodzi po kolei
-- i tylko tyle z nich, ile mieści się pod progiem.
--
-- Sekundy zajmujemy PRZED wywołaniem OpenAI. Zajęcie po wywołaniu znaczyłoby,
-- że burst równoległych żądań przechodzi w całości, a rachunek przychodzi
-- potem.
create or replace function public.claim_audio(uid uuid, want_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  plan_code   text;
  plan_row    public.plans%rowtype;
  cap         integer;
  this_period date := date_trunc('month', now())::date;
  used_now    integer;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'brak-konta');
  end if;
  if want_seconds is null or want_seconds <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'puste-nagranie');
  end if;

  plan_code := public.effective_plan(uid);
  if plan_code is null then
    -- Konto bez profilu. Nie powinno się zdarzyć (jest wyzwalacz), ale
    -- „nie powinno" to za mało, gdy po drugiej stronie są pieniądze.
    return jsonb_build_object('ok', false, 'reason', 'brak-profilu');
  end if;

  select * into plan_row from public.plans where code = plan_code;

  if want_seconds > plan_row.max_clip_seconds then
    return jsonb_build_object('ok', false, 'reason', 'za-dlugie',
                              'max_clip_seconds', plan_row.max_clip_seconds);
  end if;

  cap := plan_row.minutes_per_month * 60;

  if want_seconds > cap then
    return jsonb_build_object('ok', false, 'reason', 'limit',
                              'used_seconds', 0, 'cap_seconds', cap);
  end if;

  insert into public.usage as u (user_id, period, seconds)
  values (uid, this_period, want_seconds)
  on conflict (user_id, period) do update
    set seconds = u.seconds + excluded.seconds
    where u.seconds + excluded.seconds <= cap
  returning seconds into used_now;

  if used_now is null then
    -- `where` przy on conflict nie przepuścił: limit wyczerpany.
    select coalesce(u2.seconds, 0) into used_now
      from public.usage u2 where u2.user_id = uid and u2.period = this_period;
    return jsonb_build_object('ok', false, 'reason', 'limit',
                              'used_seconds', coalesce(used_now, 0), 'cap_seconds', cap);
  end if;

  return jsonb_build_object(
    'ok', true,
    'plan', plan_code,
    'used_seconds', used_now,
    'cap_seconds', cap,
    'stt_model', plan_row.stt_model,
    'sieve_model', plan_row.sieve_model
  );
end;
$$;


-- Zwrot sekund, gdy OpenAI oddał błąd. Bez tego zerwane łącze kosztowałoby
-- człowieka minuty z limitu za nic — a to jest dokładnie ten rodzaj drobiazgu,
-- po którym ludzie przestają ufać licznikowi.
--
-- Funkcja NIE MOŻE być dostępna dla klienta. Inaczej pętla „zajmij →
-- przepisz → oddaj" robiłaby z limitu ozdobę. Odbieramy prawa niżej.
create or replace function public.release_audio(uid uuid, give_back integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  this_period date := date_trunc('month', now())::date;
  left_now    integer;
begin
  if uid is null or give_back is null or give_back <= 0 then
    return null;
  end if;

  update public.usage u
     set seconds = greatest(0, u.seconds - give_back)
   where u.user_id = uid and u.period = this_period
  returning seconds into left_now;

  return left_now;
end;
$$;


-- Jedyne, co o liczniku wolno wiedzieć aplikacji — i tylko o sobie.
-- Bez argumentu, bez zapisu, bez możliwości zapytania o cudze konto.
create or replace function public.usage_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid         uuid := auth.uid();
  plan_code   text;
  plan_row    public.plans%rowtype;
  this_period date := date_trunc('month', now())::date;
  used_now    integer;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'brak-konta');
  end if;

  plan_code := public.effective_plan(uid);
  select * into plan_row from public.plans where code = plan_code;
  select u.seconds into used_now
    from public.usage u where u.user_id = uid and u.period = this_period;

  return jsonb_build_object(
    'ok', true,
    'plan', plan_code,
    'label', plan_row.label,
    'used_seconds', coalesce(used_now, 0),
    'cap_seconds', plan_row.minutes_per_month * 60,
    'max_clip_seconds', plan_row.max_clip_seconds,
    'cloud_notes', plan_row.cloud_notes,
    'resets_at', (this_period + interval '1 month')
  );
end;
$$;


-- ── Sprzątanie nagrobków ───────────────────────────────────────────────
--
-- Nagrobki nie mają leżeć w nieskończoność. Trzydzieści dni wystarczy,
-- żeby każde urządzenie zdążyło się dowiedzieć o skasowaniu.
--
-- Wywołanie jest ręczne (albo z pg_cron, jeśli masz go włączonego):
--   select public.purge_deleted_notes();
--
-- Funkcja jest `security definer`, czyli chodzi z prawami właściciela i nie
-- widzi RLS — sprząta nagrobki WSZYSTKICH kont. Dlatego zaraz pod nią
-- odbieramy prawo jej wywołania rolom, którymi łączy się aplikacja.
create or replace function public.purge_deleted_notes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.notes
   where deleted_at is not null
     and deleted_at < now() - interval '30 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;


-- ── Kto czego NIE może wywołać ─────────────────────────────────────────
--
-- Trzy funkcje księgują pieniądze albo sprzątają cudze dane. Żadna z nich
-- nie ma prawa być wystawiona przez PostgREST pod /rpc/… dla zalogowanego
-- człowieka. Woła je wyłącznie funkcja brzegowa kluczem service_role.
--
-- `from public` jest tu konieczne obok anon i authenticated: Postgres nadaje
-- nowym funkcjom domyślne prawo wykonania dla PUBLIC, więc bez tej linii
-- pozostałe dwie nic by nie dały.

revoke all on function public.claim_audio(uuid, integer)   from public, anon, authenticated;
revoke all on function public.release_audio(uuid, integer)  from public, anon, authenticated;
revoke all on function public.purge_deleted_notes()         from public, anon, authenticated;

grant execute on function public.claim_audio(uuid, integer)  to service_role;
grant execute on function public.release_audio(uuid, integer) to service_role;
grant execute on function public.purge_deleted_notes()        to service_role;

-- A ta jedna ma być dostępna — to jest licznik, który aplikacja pokazuje.
grant execute on function public.usage_snapshot() to authenticated;

-- Prawa do tabel. Supabase nadaje je nowym tabelom domyślnie, ale warstwa
-- dostępu to nie jest miejsce, w którym opłaca się polegać na cudzych
-- ustawieniach domyślnych. RLS i tak decyduje, KTÓRE wiersze widać.
grant select on table public.plans  to anon, authenticated;
grant select on table public.usage  to authenticated;


-- ── KONTO WŁAŚCICIELA ──────────────────────────────────────────────────
--
-- Od tej chwili notatki w chmurze są funkcją planu Pro: konto na 'free'
-- może swoje notatki CZYTAĆ i KASOWAĆ, ale nie dopisze nowych. Wysyłka
-- z takiego konta odbija się o politykę i wraca komunikatem
-- „new row violates row-level security policy for table notes".
--
-- Twoje własne konto też startuje na 'free', więc nadajemy mu Pro tutaj —
-- w tym samym pliku, który i tak się uruchamia. Wpisane w komentarzu było
-- krokiem do przeoczenia, a przeoczony kosztuje jedną nieudaną
-- synchronizację i kwadrans szukania, dlaczego.
--
-- `insert … on conflict` zamiast `update`, bo konto założone ZANIM ten plik
-- trafił do bazy nie ma jeszcze wiersza w `profiles` (wyzwalacza wtedy nie
-- było). Samo `update` nie miałoby wtedy czego zmienić i kończyło się
-- „Success. No rows returned" — co wygląda dokładnie jak sukces.
--
-- ZMIEŃ ADRES NA SWÓJ. Rozdając ten plik komuś innemu, ten jeden blok
-- usuń: reszta schematu jest o aplikacji, ten fragment o jednym koncie.

insert into public.profiles (id, display_name, plan, plan_until)
select u.id, split_part(u.email, '@', 1), 'pro', null
  from auth.users u
 where u.email = 'maciej.wyrozumski@gmail.com'
on conflict (id) do update set plan = 'pro', plan_until = null;


-- ════════════════════════════════════════════════════════════════════════
--  PANEL ADMINA — kto to widzi i co może włączyć
--
--  Powstało na czas wdrażania: aplikacja idzie do ludzi z funkcjami, które
--  są jeszcze w becie, i musi być sposób, żeby je WYŁĄCZYĆ bez wydawania
--  nowej wersji. Notatki ze spotkań są pierwszą taką funkcją.
--
--  ── DLACZEGO W BAZIE, A NIE W USTAWIENIACH APLIKACJI ──
--
--  Bo ustawienie w aplikacji zmienia ten, kto ją ma. Przełącznik „notatki
--  ze spotkań: włączone", który stoi u użytkownika, jest przełącznikiem
--  użytkownika — a chodzi dokładnie o odwrotność: o decyzję podejmowaną
--  raz, po naszej stronie, obowiązującą wszystkich naraz i zmienialną bez
--  aktualizacji.
--
--  ── TRZY STANY, NIE DWA ──
--
--    on       widzą wszyscy
--    off      nie widzi nikt (poza adminem — on musi mieć czym testować)
--    invited  widzą ci, którym nadano to imiennie
--
--  Trzeciego nie da się zastąpić dwoma: „wpuść na razie pięć osób" to
--  najczęstszy stan wdrożenia i bez niego trzeba wybierać między „nikt"
--  a „wszyscy".
-- ════════════════════════════════════════════════════════════════════════


-- ── Kto jest adminem ───────────────────────────────────────────────────
--
-- Adresem, nie identyfikatorem: konto da się skasować i założyć od nowa,
-- a wtedy uuid jest inny, a człowiek ten sam. Tabela zamiast stałej
-- w funkcji, bo adres bywa więcej niż jeden i dopisanie drugiego nie ma
-- wymagać zmiany kodu.

create table if not exists public.admins (
  email      text primary key,
  added_at   timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Spisu adminów NIE CZYTA NIKT z aplikacji. Nie jest sekretem w sensie
-- bezpieczeństwa (i tak wynika z zachowania panelu), ale nie ma powodu,
-- żeby lista adresów jechała komukolwiek na komputer.
-- Polityk brak = przy włączonym RLS nie przeczyta go klient żaden.

insert into public.admins (email) values ('maciej.wyrozumski@gmail.com')
on conflict (email) do nothing;

-- Czy TEN, kto właśnie pyta, jest adminem.
--
-- Adres bierzemy z tokenu (`auth.jwt()`), a nie z tabeli profili — token
-- podpisuje Supabase i nie da się go przepisać po drodze. `security definer`,
-- bo wołający nie ma prawa czytać tabeli adminów; sprawdzenie ma działać,
-- a spis ma zostać niewidoczny.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
     where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

grant execute on function public.is_admin() to authenticated;


-- ── Funkcje pod przełącznikiem ─────────────────────────────────────────

create table if not exists public.features (
  code        text primary key,
  label       text not null,
  note        text,
  state       text not null default 'on' check (state in ('on', 'off', 'invited')),
  updated_at  timestamptz not null default now()
);

insert into public.features (code, label, note, state) values
  ('meetings', 'Notatki ze spotkań',
   'Nagrywanie rozmowy, transkrypcja i podsumowanie. W becie.', 'invited'),
  ('briefing', 'Poranek',
   'Podsumowanie dnia z kalendarza i poczty.', 'on'),
  ('cloud', 'Notatki w chmurze',
   'Synchronizacja notatek między komputerami.', 'on')
on conflict (code) do nothing;   -- stan zostaje taki, jaki ustawiono w panelu

alter table public.features enable row level security;

-- Każdy zalogowany czyta spis: aplikacja musi wiedzieć, co pokazać.
-- Sam spis nie jest tajemnicą — tajemnicą byłoby, kto ma co nadane.
drop policy if exists "funkcje: każdy zalogowany czyta" on public.features;
create policy "funkcje: każdy zalogowany czyta"
  on public.features for select
  to authenticated
  using (true);

drop policy if exists "funkcje: pisze admin" on public.features;
create policy "funkcje: pisze admin"
  on public.features for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Kolumna `state` i nic więcej. Nazwa i opis funkcji należą do aplikacji,
-- nie do panelu — przepisane w bazie rozjechałyby się z tym, co pokazuje
-- okno, i nikt by nie wiedział, które jest prawdziwe.
revoke update on public.features from anon, authenticated;
grant update (state, updated_at) on public.features to authenticated;


-- ── Nadania imienne ────────────────────────────────────────────────────

create table if not exists public.feature_grants (
  feature    text not null references public.features (code) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (feature, user_id)
);

alter table public.feature_grants enable row level security;

-- Swoje nadania widzi każdy — z nich aplikacja liczy, co pokazać.
-- Cudzych nie widzi nikt poza adminem.
drop policy if exists "nadania: swoje albo admin" on public.feature_grants;
create policy "nadania: swoje albo admin"
  on public.feature_grants for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "nadania: nadaje admin" on public.feature_grants;
create policy "nadania: nadaje admin"
  on public.feature_grants for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "nadania: odbiera admin" on public.feature_grants;
create policy "nadania: odbiera admin"
  on public.feature_grants for delete
  to authenticated
  using (public.is_admin());


-- ── Co widzi TEN użytkownik ────────────────────────────────────────────
--
-- Jedno pytanie, jedna odpowiedź: lista kodów funkcji, które wolno mu
-- pokazać. Aplikacja nie liczy tego sama — inaczej reguła „invited"
-- mieszkałaby w dwóch miejscach i rozjechała się przy pierwszej zmianie.
--
-- ADMIN WIDZI WSZYSTKO, także wyłączone. Musi mieć czym sprawdzić funkcję,
-- zanim ją komukolwiek włączy.

create or replace function public.my_features()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select f.code
    from public.features f
   where public.is_admin()
      or f.state = 'on'
      or (f.state = 'invited'
          and exists (select 1
                        from public.feature_grants g
                       where g.feature = f.code
                         and g.user_id = auth.uid()));
$$;

grant execute on function public.my_features() to authenticated;


-- ── Spis użytkowników dla panelu ───────────────────────────────────────
--
-- `auth.users` należy do Supabase i klientowi nie wolno go czytać — także
-- adminowi, bo RLS nie ma tam nic do rzeczy. Dlatego jedna funkcja
-- `security definer`, która ODMAWIA, gdy pyta nie-admin.
--
-- Oddaje tylko to, co panel naprawdę pokazuje. Bez tokenów, bez haseł,
-- bez metadanych logowania.

create or replace function public.admin_users()
returns table (
  id            uuid,
  email         text,
  display_name  text,
  plan          text,
  created_at    timestamptz,
  last_sign_in  timestamptz,
  confirmed     boolean,
  features      text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select u.id,
         u.email::text,
         p.display_name,
         coalesce(public.effective_plan(u.id), 'free') as plan,
         u.created_at,
         u.last_sign_in_at,
         (u.email_confirmed_at is not null) as confirmed,
         coalesce(
           (select array_agg(g.feature order by g.feature)
              from public.feature_grants g
             where g.user_id = u.id),
           '{}'::text[]) as features
    from auth.users u
    left join public.profiles p on p.id = u.id
   where public.is_admin()
   order by u.created_at desc;
$$;

revoke all on function public.admin_users() from public, anon;
grant execute on function public.admin_users() to authenticated;


-- ── KOMU CO NADANO ─────────────────────────────────────────────────────
--
-- Ostatnie zapytanie w pliku, więc to jego wynik zostaje na ekranie po
-- naciśnięciu Run. `plan_efektywny` liczy to samo, co polityki dostępu:
-- wygasły Pro pokaże się tu jako 'free', choć w kolumnie `plan` stoi 'pro'.

select u.email,
       p.id is not null as ma_profil,
       p.plan,
       p.plan_until,
       public.effective_plan(u.id) as plan_efektywny
  from auth.users u
  left join public.profiles p on p.id = u.id
 order by u.created_at;
