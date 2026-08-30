"use strict";

/**
 * Poranek — jedno okno, raz dziennie, o tym co dziś.
 *
 * Odpowiada na dwa pytania, które i tak zadaje się sobie przy pierwszej
 * kawie: KTÓRE MAILE NIE MOGĄ CZEKAĆ i CO MAM DZIŚ W PLANIE. Trzecia
 * rzecz — kanały RSS — jest dodatkiem i stoi na końcu, bo świat może
 * poczekać do wypitej kawy, a Magdalena czekająca od wtorku nie.
 *
 * DLACZEGO REGUŁY, A DOPIERO POTEM MODEL. Skrzynka to kilkaset maili
 * tygodniowo i wpuszczenie ich wszystkich do modelu byłoby dwiema rzeczami
 * naraz: kosztem i wyniesieniem całej korespondencji na zewnątrz. Wybór
 * robią więc reguły, tutaj, na tym komputerze — i dopiero kilkanaście
 * wytypowanych maili jedzie do sita po jedno zdanie każdy. Reszta skrzynki
 * nigdy nie opuszcza dysku.
 *
 * DLACZEGO REGUŁY DAJĄ POWÓD, A NIE OCENĘ. „Ważne 87%" nie znaczy nic
 * i nie da się z tym pokłócić. „Pyta wprost, wisi trzeci dzień, jest
 * na dzisiejszym spotkaniu" — znaczy, i widać od razu, czy reguła się
 * pomyliła. Punkty służą wyłącznie do ustawienia kolejności.
 *
 * Wszystko w tym pliku jest czyste: wchodzą zwykłe obiekty, wychodzi
 * decyzja. Sieć, pęk kluczy i okna są gdzie indziej (main/google.js,
 * main/rss.js, main/main.js), a sprawdza to zwykły Node —
 * scripts/briefing-test.js.
 */

/** Ile maili najwyżej pokazujemy. Więcej to już jest skrzynka, nie briefing. */
const MAX_PICKS = 12;
/** Ile znaków fragmentu maila wpuszczamy do modelu. */
const SNIPPET = 400;
/** Po ilu dniach niezałatwiony mail zaczyna „wisieć". */
const STALE_DAYS = 2;

/* ── Kiedy się należy ──────────────────────────────────────────── */

/** Dzień w strefie użytkownika, jako „2026-08-30" — po tym poznajemy dobę. */
function dayKey(when) {
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Czy poranek należy się TERAZ.
 *
 * Doba, nie doba zegarowa: liczy się kalendarzowy dzień, bo o to samo
 * pyta człowiek („czy widziałem już dziś podsumowanie"). Komputer włączony
 * o 23:50 i odblokowany o 00:10 to dwa dni i dwa poranki — i tak ma być,
 * bo to naprawdę dwa różne dni pracy.
 *
 * Godzina najwcześniejsza jest po to, żeby okno nie wskoczyło przed
 * ludzką porą, gdy ktoś sięga po komputer w nocy po jedną rzecz.
 */
function due({ lastAt, now = new Date(), notBefore = 4 } = {}) {
  const today = dayKey(now);
  if (!today) return false;
  const at = now instanceof Date ? now : new Date(now);
  if (at.getHours() < notBefore) return false;
  return dayKey(lastAt) !== today;
}

/* ── Plan dnia ─────────────────────────────────────────────────── */

const MINUTE = 60_000;

/**
 * Dzisiejsze wpisy z kalendarza, w kolejności, z podziałem na przeszłe
 * i przyszłe.
 *
 * Bierzemy WSZYSTKO z dzisiaj, a nie tylko spotkania z rozmówcami — bo to
 * jest plan dnia, a nie lista rozmów do nagrania. Dentysta i odebranie
 * dziecka są w nim tak samo ważne jak przegląd tygodnia; główna zakładka
 * pyta o co innego (patrz main/agenda.js) i dlatego filtruje inaczej.
 */
function dayPlan(events, now = new Date()) {
  const today = dayKey(now);
  const at = (now instanceof Date ? now : new Date(now)).getTime();

  const rows = (events ?? [])
    .filter((event) => dayKey(event.from) === today)
    .map((event) => ({
      id: String(event.id ?? ""),
      title: String(event.title ?? "").trim() || "Bez nazwy",
      from: Number(event.from),
      to: Number(event.to),
      where: event.where ?? event.link ?? null,
      guests: Number(event.guests ?? 0),
      /* Dwie różne listy i dwa różne zastosowania. IMIONA idą na ekran
         i (przy spotkaniach) do modelu — po nich rozpoznaje się wpis.
         ADRESY nie idą nigdzie: służą wyłącznie do porównania z nadawcą
         maila, tutaj, na tym komputerze. */
      people: (event.people ?? []).map((name) => String(name).trim()).filter(Boolean),
      emails: (event.emails ?? []).map((mail) => String(mail).toLowerCase()).filter(Boolean),
    }))
    .filter((event) => Number.isFinite(event.from))
    .sort((a, b) => a.from - b.from);

  const done = rows.filter((event) => (event.to || event.from) < at);
  const ahead = rows.filter((event) => (event.to || event.from) >= at);
  return {
    all: rows,
    done,
    ahead,
    /* Najbliższy wpis stoi osobno, bo to on odpowiada na pytanie zadawane
       najczęściej: „ile mam czasu do następnej rzeczy". */
    next: ahead[0] ?? null,
    minutesToNext: ahead[0] ? Math.round((ahead[0].from - at) / MINUTE) : null,
  };
}

/** Wszyscy, z którymi mam się dziś widzieć — po adresie, małymi literami. */
function peopleToday(plan) {
  const out = new Set();
  for (const event of plan?.all ?? []) for (const mail of event.emails ?? []) out.add(mail);
  return out;
}

/* ── Które maile wymagają uwagi ────────────────────────────────── */

/** Sam adres z „Jan Kowalski <jan@example.com>". */
function addressOf(text) {
  const raw = String(text ?? "");
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim().toLowerCase();
}

/** Nazwa nadawcy, a gdy jej nie ma — sam adres. */
function nameOf(text) {
  const raw = String(text ?? "").trim();
  const angled = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = angled?.[1]?.trim();
  return name || addressOf(raw);
}

const listish = (mail) =>
  !!mail.listUnsubscribe ||
  /\bno-?reply|do-?not-?reply|newsletter|mailer|notifications?@|bounce/i.test(
    addressOf(mail.from),
  );

/**
 * Wybór maili, które wymagają uwagi — regułami, tutaj, bez sieci.
 *
 * Każda reguła dokłada punkty I POWÓD. Powód jest ważniejszy od punktów:
 * to on trafia na ekran obok maila i to po nim widać, czy reguła się
 * pomyliła. Punkty ustawiają wyłącznie kolejność.
 *
 * @param {Array} mails    maile z ostatnich dni (patrz main/google.js)
 * @param {object} context { plan, owner, now }
 */
function needsAttention(mails, { plan = null, owner = "", now = new Date() } = {}) {
  const me = String(owner ?? "").trim().toLowerCase();
  const meeting = peopleToday(plan);
  const at = (now instanceof Date ? now : new Date(now)).getTime();

  const picks = [];
  for (const mail of mails ?? []) {
    const from = addressOf(mail.from);
    // Własnych maili sobie nie przypominamy.
    if (me && from === me) continue;

    const why = [];
    let score = 0;

    /* Nieprzeczytane to warunek wstępny, a nie powód. Mail przeczytany
       i zostawiony bez odpowiedzi jest decyzją, którą ktoś już podjął —
       przypominanie o niej co rano byłoby kłóceniem się z człowiekiem. */
    if (!mail.unread) continue;

    /* Rozsyłka nie „wymaga uwagi" — najwyżej bywa ciekawa. Wypada
       z wyboru, chyba że ktoś ją oznaczył gwiazdką sam. */
    if (listish(mail) && !mail.starred) continue;

    if (meeting.has(from)) {
      score += 5;
      why.push("jest dziś na Twoim spotkaniu");
    }

    /* Do mnie WPROST, a nie do kopii. Adres w „Do" znaczy, że ktoś czegoś
       ode mnie chce; w „DW" — że mam wiedzieć. To są dwie różne rzeczy
       i tylko pierwsza jest robotą. */
    const to = (mail.to ?? []).map(addressOf);
    if (me && to.includes(me) && to.length <= 3) {
      score += 3;
      why.push("napisane wprost do Ciebie");
    } else if (me && !to.includes(me)) {
      score -= 1;
    }

    if (mail.starred) {
      score += 3;
      why.push("oznaczone gwiazdką");
    }
    if (mail.important) score += 1;

    const text = `${mail.subject ?? ""} ${mail.snippet ?? ""}`;
    if (/\?/.test(text)) {
      score += 2;
      why.push("jest w nim pytanie");
    }
    if (/\b(do (jutra|dziś|piątku|poniedziałku)|deadline|termin|pilne|asap)\b/i.test(text)) {
      score += 2;
      why.push("pada termin");
    }

    /* Odpowiedź na wątek, który ja zacząłem — czyli ktoś oddaje piłkę.
       Rozpoznajemy po tym, że wątek ma historię, a ostatni w nim jest ktoś
       inny; pełnej rozmowy nie ściągamy, bo to byłaby cała skrzynka. */
    if (mail.isReply) {
      score += 2;
      why.push("odpowiedź w Twoim wątku");
    }

    const days = Number.isFinite(mail.at) ? Math.floor((at - mail.at) / 86_400_000) : 0;
    if (days >= STALE_DAYS) {
      score += Math.min(3, days - STALE_DAYS + 1);
      why.push(days === 1 ? "wisi od wczoraj" : `wisi ${days} dni`);
    }

    // Nic poza „nieprzeczytane" — to jeszcze nie jest powód do budzenia.
    if (!why.length) continue;

    picks.push({
      id: mail.id,
      threadId: mail.threadId ?? mail.id,
      from: nameOf(mail.from),
      address: from,
      subject: String(mail.subject ?? "").trim() || "(bez tematu)",
      snippet: String(mail.snippet ?? "").slice(0, SNIPPET),
      at: mail.at ?? null,
      link: mail.threadId
        ? `https://mail.google.com/mail/u/0/#inbox/${mail.threadId}`
        : null,
      why,
      score,
    });
  }

  return picks
    .sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX_PICKS);
}

/* ── Pytanie do sita ───────────────────────────────────────────── */

/**
 * Umowa, której nie zmienia żaden szablon ani żadne ustawienie.
 *
 * Ta sama zasada, co przy podsumowaniu spotkania: model ma OPISAĆ to, co
 * dostał, i nie wolno mu niczego dopowiedzieć. Wymyślony termin w porannym
 * podsumowaniu jest gorszy niż brak podsumowania, bo zaczyna się od niego
 * dzień.
 */
const CONTRACT = `Jesteś asystentem, który układa jedno krótkie podsumowanie poranne.

Dostajesz trzy rzeczy: wybrane maile (już wytypowane przez reguły — nie oceniasz, czy wybór jest trafny), plan dnia z kalendarza i nagłówki z kanałów RSS.

ZASADY, KTÓRYCH NIE WOLNO ZŁAMAĆ:
- Piszesz WYŁĄCZNIE o tym, co dostałeś. Nie zgadujesz treści maila po temacie, nie dopowiadasz ustaleń, nie wymyślasz terminów.
- Jeśli czegoś nie ma w materiale, nie ma tego w podsumowaniu. „Nie wiem" jest poprawną odpowiedzią.
- Nie streszczasz maila, którego treści nie widzisz — piszesz, czego dotyczy i czego się po nim spodziewać.
- Nie moralizujesz, nie zachęcasz, nie życzysz miłego dnia. To jest notatka, nie wiadomość.
- Piszesz po polsku, w drugiej osobie, zwięźle.

FORMAT ODPOWIEDZI — dokładnie taki, bez niczego dookoła:

NAGŁÓWEK: jedno zdanie o dniu jako całości (ile spotkań, co go określa).

POCZTA:
- <nadawca> — <o co chodzi i czego się po tym spodziewać, jedno zdanie>
(jedna linia na mail, w kolejności, w jakiej je dostałeś; pomijasz maile, o których nie masz nic do powiedzenia)

DZIEŃ:
- <godzina> <nazwa> — <jedno zdanie, jeśli jest co dodać; inaczej sama nazwa>

ŚWIAT:
- <jedno zdanie na temat, najwyżej trzy linie; pomijasz sekcję, jeśli nic nie przyszło>`;

/** Godzina „9:05" ze znacznika czasu. */
function clock(ms) {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Materiał dla modelu — to samo, co widać na ekranie, tylko tekstem. */
function buildPrompt({ picks = [], plan = null, feeds = [], now = new Date() } = {}) {
  const parts = [];

  const at = now instanceof Date ? now : new Date(now);
  parts.push(`Dziś jest ${at.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" })}, godzina ${clock(at.getTime())}.`);

  if (picks.length) {
    parts.push(
      "\n=== MAILE WYTYPOWANE PRZEZ REGUŁY ===",
      ...picks.map(
        (mail, index) =>
          `${index + 1}. Od: ${mail.from} <${mail.address}>\n` +
          `   Temat: ${mail.subject}\n` +
          `   Dlaczego wybrany: ${mail.why.join(", ")}\n` +
          `   Fragment: ${mail.snippet || "(brak)"}`,
      ),
    );
  } else {
    parts.push("\n=== MAILE ===\nNic nie wymaga uwagi.");
  }

  const rows = plan?.all ?? [];
  if (rows.length) {
    parts.push(
      "\n=== PLAN DNIA ===",
      ...rows.map(
        (event) =>
          `${clock(event.from)}–${clock(event.to)} ${event.title}` +
          (event.guests ? ` (osób: ${event.guests})` : ""),
      ),
    );
  } else {
    parts.push("\n=== PLAN DNIA ===\nKalendarz na dziś jest pusty.");
  }

  if (feeds.length) {
    parts.push(
      "\n=== KANAŁY ===",
      ...feeds.map((item) => `- [${item.source}] ${item.title}`),
    );
  }

  return { system: CONTRACT, user: parts.join("\n") };
}

/**
 * Odpowiedź modelu na sekcje.
 *
 * Czytamy PO NAGŁÓWKACH, a nie po kolejności: model bywa oszczędny i pomija
 * sekcję, w której nic nie ma. Brak sekcji to pusta lista, nie przesunięcie
 * wszystkiego o jedną w górę.
 */
function readAnswer(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { headline: "", mail: [], day: [], world: [] };

  /* Koniec sekcji to NASTĘPNY nagłówek albo koniec całego tekstu — i to
     drugie musi być zapisane jako „nie ma już ani jednego znaku", a nie
     jako `$`. Przy fladze `m` dolar znaczy „koniec dowolnej linii", więc
     leniwa grupa zamykała się od razu na pierwszym łamaniu i każda sekcja
     wychodziła pusta. */
  const grab = (name) => {
    const found = text.match(
      new RegExp(
        `^\\s*${name}\\s*:?\\s*$([\\s\\S]*?)(?=^\\s*(?:POCZTA|DZIEŃ|ŚWIAT|NAGŁÓWEK)\\s*:?\\s*$|(?![\\s\\S]))`,
        "mi",
      ),
    );
    return found?.[1] ?? "";
  };

  const lines = (block) =>
    block
      .split("\n")
      .map((line) => line.replace(/^\s*[-•*]\s*/, "").trim())
      .filter(Boolean);

  /* Nagłówek bywa napisany w jednej linii z etykietą („NAGŁÓWEK: dziś…"),
     bo tak jest naturalniej — i dlatego pytamy o oba zapisy. */
  const inline = text.match(/^\s*NAGŁÓWEK\s*:\s*(.+)$/mi);
  const headline = (inline?.[1] ?? lines(grab("NAGŁÓWEK"))[0] ?? "").trim();

  return {
    headline,
    mail: lines(grab("POCZTA")),
    day: lines(grab("DZIEŃ")),
    world: lines(grab("ŚWIAT")),
  };
}

module.exports = {
  due,
  dayKey,
  dayPlan,
  peopleToday,
  needsAttention,
  buildPrompt,
  readAnswer,
  addressOf,
  nameOf,
  CONTRACT,
  MAX_PICKS,
  STALE_DAYS,
};
