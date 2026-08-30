"use strict";
/**
 * Poranek — rozstrzygnięcia, bez sieci, bez okien i bez konta Google.
 *   node scripts/briefing-test.js
 *
 * Sprawdzamy to, co naprawdę decyduje o tym, czy okno jest pomocne:
 * czy należy się dziś, które maile wybierają reguły, co z nich wychodzi
 * do modelu i czy odpowiedź modelu daje się przeczytać. Sieć, pęk kluczy
 * i rysowanie są gdzie indziej i są sprawdzane inaczej.
 */
const assert = require("assert");

const {
  due,
  dayKey,
  dayPlan,
  needsAttention,
  buildPrompt,
  readAnswer,
  addressOf,
  nameOf,
} = require("../src/main/briefing");
const { parse, headlines } = require("../src/main/rss");

let passed = 0;
const ok = (label) => (console.log(`✓ ${label}`), (passed += 1));

/* ── Kiedy się należy ──────────────────────────────────────────── */

const rano = new Date(2026, 7, 30, 8, 15);
const wieczor = new Date(2026, 7, 30, 22, 40);
const noc = new Date(2026, 7, 30, 2, 30);

assert.equal(due({ lastAt: null, now: rano }), true);
ok("Pierwszy raz w życiu — poranek się należy");

assert.equal(due({ lastAt: new Date(2026, 7, 29, 9, 0).toISOString(), now: rano }), true);
ok("Wczoraj to nie dziś — poranek się należy");

assert.equal(due({ lastAt: new Date(2026, 7, 30, 7, 0).toISOString(), now: wieczor }), false);
ok("Dziś już był — drugi raz tego samego dnia nie wyskakuje");

assert.equal(due({ lastAt: null, now: noc }), false);
ok("O wpół do trzeciej w nocy poranek czeka na ludzką porę");

assert.equal(
  due({ lastAt: new Date(2026, 7, 29, 23, 50).toISOString(), now: new Date(2026, 7, 30, 8, 0) }),
  true,
);
ok("Dziesięć minut po północy to już inny dzień pracy");

/* ── Adresy ────────────────────────────────────────────────────── */

assert.equal(addressOf("Magdalena Nowak <magda@example.com>"), "magda@example.com");
assert.equal(addressOf("  BOSS@Example.COM "), "boss@example.com");
assert.equal(nameOf('"Nowak, Magdalena" <magda@example.com>'), "Nowak, Magdalena");
assert.equal(nameOf("ktos@example.com"), "ktos@example.com");
ok("Nadawca rozkłada się na nazwę i adres, także w cudzysłowie");

/* ── Plan dnia ─────────────────────────────────────────────────── */

const teraz = new Date(2026, 7, 30, 10, 0);
const dzien = (h, m = 0) => new Date(2026, 7, 30, h, m).getTime();

const plan = dayPlan(
  [
    { id: "a", title: "Stand-up", from: dzien(9), to: dzien(9, 15),
      people: ["Ania"], emails: ["ania@example.com"] },
    { id: "b", title: "Przegląd tygodnia", from: dzien(14), to: dzien(15), guests: 4,
      people: ["Magdalena Nowak", "Ja"], emails: ["Magda@Example.com", "ja@example.com"] },
    { id: "c", title: "Dentysta", from: dzien(11, 30), to: dzien(12) },
    { id: "d", title: "Jutro", from: new Date(2026, 7, 31, 10).getTime(), to: new Date(2026, 7, 31, 11).getTime() },
  ],
  teraz,
);

assert.deepEqual(plan.all.map((e) => e.title), ["Stand-up", "Dentysta", "Przegląd tygodnia"]);
ok("Plan dnia bierze tylko dzisiaj i układa po godzinach");

assert.deepEqual(plan.done.map((e) => e.title), ["Stand-up"]);
assert.equal(plan.next.title, "Dentysta");
assert.equal(plan.minutesToNext, 90);
ok("Wiadomo, co już minęło i ile zostało do następnej rzeczy");

/* Dentysta zostaje w planie dnia, choć nie jest spotkaniem do nagrania —
   to jest właśnie różnica między tym widokiem a zakładką Spotkania. */
assert.ok(plan.all.some((e) => e.title === "Dentysta"));
ok("Wpis bez rozmówców też jest planem dnia");

/* Adres uczestnika wpisany wielkimi literami ma pasować tak samo — to jest
   ten sam człowiek, a nie drugi. */
assert.ok(plan.all.find((e) => e.id === "b").emails.includes("magda@example.com"));
ok("Adresy uczestników są porównywalne bez względu na wielkość liter");

/* ── Które maile wymagają uwagi ────────────────────────────────── */

const ja = "ja@example.com";
const godzinTemu = (h) => teraz.getTime() - h * 3600_000;

const mail = (over) => ({
  id: "m" + Math.random().toString(36).slice(2, 7),
  threadId: "t1",
  from: "Ktoś <ktos@example.com>",
  to: [ja],
  subject: "Sprawa",
  snippet: "Treść.",
  at: godzinTemu(3),
  unread: true,
  starred: false,
  important: false,
  listUnsubscribe: null,
  isReply: false,
  ...over,
});

// Przeczytane wypada — to decyzja, którą człowiek już podjął.
assert.equal(needsAttention([mail({ unread: false })], { owner: ja, now: teraz }).length, 0);
ok("Przeczytany mail nie wraca co rano");

// Rozsyłka wypada, chyba że oznaczona gwiazdką.
assert.equal(
  needsAttention([mail({ listUnsubscribe: "<https://x/unsub>" })], { owner: ja, now: teraz }).length,
  0,
);
assert.equal(
  needsAttention([mail({ listUnsubscribe: "<https://x/unsub>", starred: true })], {
    owner: ja,
    now: teraz,
  }).length,
  1,
);
ok("Newsletter wypada — chyba że sam go oznaczyłeś");

assert.equal(needsAttention([mail({ from: "noreply@bank.example" })], { owner: ja, now: teraz }).length, 0);
ok("Adres, na który nie da się odpowiedzieć, nie wymaga uwagi");

// Własny mail w skrzynce nie jest sprawą do załatwienia.
assert.equal(needsAttention([mail({ from: `Ja <${ja}>` })], { owner: ja, now: teraz }).length, 0);
ok("Własnych maili sobie nie przypominamy");

// Uczestnik dzisiejszego spotkania bije wszystko inne.
const wybrane = needsAttention(
  [
    /* Tylko do wiadomości: mnie w „Do" nie ma, nikt o nic nie pyta, nic nie
       wisi. To jest coś, o czym mam wiedzieć — nie coś, co mam zrobić. */
    mail({ id: "doKopii", to: ["ktos@example.com"], cc: [ja], subject: "Do wiadomości", snippet: "FYI" }),
    mail({ id: "magda", from: "Magdalena <magda@example.com>", subject: "Grafik", snippet: "Potwierdzisz?" }),
  ],
  { owner: ja, plan, now: teraz },
);
assert.equal(wybrane[0].id, "magda");
assert.ok(wybrane[0].why.includes("jest dziś na Twoim spotkaniu"));
assert.ok(wybrane[0].why.includes("jest w nim pytanie"));
ok("Mail od kogoś z dzisiejszego kalendarza idzie na górę, z powodem");

// Mail „do wiadomości" bez żadnego innego powodu w ogóle nie wchodzi.
assert.ok(!wybrane.some((m) => m.id === "doKopii"));
ok("Sama nieprzeczytaność w kopii to za mało, żeby budzić");

/* Za to mail napisany WPROST do mnie wchodzi na samą tę okoliczność —
   bo od tego jest skrzynka i o to pyta się rano. */
const wprost = needsAttention([mail({ subject: "Umowa", snippet: "Przesyłam." })], {
  owner: ja,
  now: teraz,
});
assert.equal(wprost.length, 1);
assert.deepEqual(wprost[0].why, ["napisane wprost do Ciebie"]);
ok("Nieprzeczytany mail napisany wprost do Ciebie wystarcza sam za powód");

const wiszacy = needsAttention([mail({ at: godzinTemu(80), subject: "Faktura?" })], {
  owner: ja,
  now: teraz,
});
assert.ok(wiszacy[0].why.some((w) => w.startsWith("wisi")));
ok("Mail sprzed kilku dni mówi o sobie, że wisi");

const doKopii = needsAttention(
  [mail({ to: ["ktos@example.com", "inny@example.com", "trzeci@example.com", "czwarty@example.com"], starred: true })],
  { owner: ja, now: teraz },
);
assert.ok(!doKopii[0].why.includes("napisane wprost do Ciebie"));
ok("Mail do czterech osób nie udaje maila napisanego do Ciebie");

/* ── Materiał dla modelu ───────────────────────────────────────── */

const { system, user } = buildPrompt({ picks: wybrane, plan, feeds: [], now: teraz });
assert.ok(system.includes("Nie zgadujesz"));
assert.ok(user.includes("Magdalena"));
assert.ok(user.includes("Przegląd tygodnia"));
assert.ok(!user.includes("ktos@example.com"), "do modelu nie jedzie mail, którego reguły nie wybrały");
ok("Do modelu jedzie tylko to, co wybrały reguły — reszta skrzynki zostaje");

const pusty = buildPrompt({ picks: [], plan: dayPlan([], teraz), now: teraz });
assert.ok(pusty.user.includes("Nic nie wymaga uwagi"));
assert.ok(pusty.user.includes("Kalendarz na dziś jest pusty"));
ok("Pusty dzień mówi wprost, że jest pusty — zamiast milczeć");

/* ── Odpowiedź modelu ──────────────────────────────────────────── */

const czytane = readAnswer(`NAGŁÓWEK: Trzy spotkania, dzień zbity po południu.

POCZTA:
- Magdalena — czeka na potwierdzenie grafiku.
- Tomasz — pyta o link do zajęć.

DZIEŃ:
- 9:00 Stand-up
- 14:00 Przegląd tygodnia — cztery osoby.

ŚWIAT:
- Nowa wersja Electrona.`);

assert.equal(czytane.headline, "Trzy spotkania, dzień zbity po południu.");
assert.equal(czytane.mail.length, 2);
assert.equal(czytane.day.length, 2);
assert.equal(czytane.world.length, 1);
ok("Odpowiedź modelu rozkłada się na cztery sekcje");

const bezSwiata = readAnswer("NAGŁÓWEK: Spokojnie.\n\nPOCZTA:\n- Nic.\n\nDZIEŃ:\n- Pusto.");
assert.deepEqual(bezSwiata.world, []);
assert.equal(bezSwiata.mail.length, 1);
ok("Pominięta sekcja to pusta lista, a nie przesunięcie pozostałych");

assert.deepEqual(readAnswer(""), { headline: "", mail: [], day: [], world: [] });
ok("Milczenie modelu nie wywraca okna");

/* ── Kanały ────────────────────────────────────────────────────── */

const kanalRss = `<?xml version="1.0"?><rss><channel>
  <title>Serwis</title>
  <item><title><![CDATA[Pierwsza &amp; druga]]></title><link>https://a.example/1</link>
        <pubDate>Sat, 30 Aug 2026 07:00:00 GMT</pubDate></item>
  <item><title>Druga</title><link>https://a.example/2</link></item>
</channel></rss>`;

const wpisy = parse(kanalRss);
assert.equal(wpisy.length, 2);
assert.equal(wpisy[0].title, "Pierwsza & druga");
assert.equal(wpisy[0].link, "https://a.example/1");
assert.equal(wpisy[0].source, "Serwis");
ok("RSS: tytuł, adres i źródło wychodzą w całości, razem z encjami");

const kanalAtom = `<feed><title>Atom</title>
  <entry><title>Wpis</title><link href="https://b.example/x" /><updated>2026-08-30T06:00:00Z</updated></entry>
</feed>`;
const atom = parse(kanalAtom);
assert.equal(atom[0].link, "https://b.example/x");
assert.equal(atom[0].source, "Atom");
ok("Atom trzyma adres w atrybucie i też się czyta");

(async () => {
  // Kanał, który milczy albo kłamie, nie ma prawa zatrzymać poranka.
  const zebrane = await headlines(
    [
      { url: "https://dziala.example/feed", name: "Działa" },
      { url: "https://pada.example/feed", name: "Pada" },
    ],
    {
      now: Date.parse("2026-08-30T09:00:00Z"),
      get: async (url) => {
        if (url.includes("pada")) throw new Error("brak sieci");
        return { ok: true, text: async () => kanalRss };
      },
    },
  );
  assert.equal(zebrane.length, 2, "z dwóch kanałów jeden padł — oba wpisy drugiego mają dojść");
  assert.ok(zebrane.every((e) => e.source === "Działa"));
  ok("Padnięty kanał wypada sam, zamiast wywracać poranek");

  const stare = await headlines([{ url: "https://x/feed" }], {
    now: Date.parse("2026-09-30T09:00:00Z"),
    get: async () => ({ ok: true, text: async () => kanalRss }),
  });
  assert.ok(stare.every((e) => !e.at));
  ok("Wpis sprzed miesiąca wypada, ale wpis bez daty zostaje");

  console.log(`\nPoranek: ${passed} sprawdzeń przeszło.`);
})().catch((error) => {
  console.error("\n✗", error.message);
  process.exit(1);
});
