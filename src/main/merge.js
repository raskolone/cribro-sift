"use strict";

/**
 * Splot dwóch torów w jeden zapis rozmowy — druga połowa E2.
 *
 * Dostaje przepisane odcinki z obu torów i oddaje to, co człowiek nazwie
 * transkrypcją: kto, kiedy, co powiedział. Podziału na osoby NIE ZGADUJE —
 * tor mikrofonu to ty, tor systemu to oni, i tak wynika z okablowania.
 *
 * Do zrobienia zostają trzy rzeczy, wszystkie z gatunku tych, które psują
 * transkrypcję po cichu:
 *
 *   1. ZAKŁADKA. Odcinki zachodzą na siebie o kilka sekund (patrz
 *      main/segments.js), więc koniec jednego i początek następnego mówią
 *      to samo. Zostawione powtarza w zapisie po kilka słów co dwie minuty.
 *
 *   2. PRZESŁUCH. To jest ten problem, który zmierzyła sonda E0: przy
 *      głośnikach cudza mowa wchodzi TAKŻE twoim mikrofonem, na −27,6 dBFS,
 *      raptem 10 dB poniżej toru systemu. Bez tego kroku każde zdanie
 *      drugiej strony pada w zapisie dwa razy — raz jako ich, raz jako
 *      twoje. To nie jest zabezpieczenie na wszelki wypadek, tylko warunek
 *      działania modułu przy rozmowie bez słuchawek.
 *
 *   3. SIEKANIE. Odcinek to jednostka techniczna, nie wypowiedź. Zapis
 *      pocięty co dwie minuty czyta się jak protokół z automatu.
 *
 * Plik nie zna Electrona ani sieci — wchodzą odcinki, wychodzi zapis.
 */

/** Kto mówi, dopóki nie wiadomo, kto konkretnie. */
const SPEAKER = { mic: "Ty", system: "Rozmówcy" };

/**
 * Uproszczenie do PORÓWNANIA imion: bez ogonków, bez wielkości liter.
 *
 * „Ł" trzeba wymienić osobno i nie jest to przeoczenie Unicode'u: rozkład
 * NFD zdejmuje znaki diakrytyczne dopisane do litery, a Ł jest jedną
 * literą z przekreśleniem, nie L z ogonkiem. Bez tej linijki „Łukasz"
 * z kalendarza nigdy nie zgadza się z „Lukasz" z konta systemowego.
 */
const plain = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[łŁ]/g, "l")
    .toLowerCase()
    .trim();

/**
 * Jak podpisać drugą stronę, gdy kalendarz zna nazwiska.
 *
 * ROZMOWA W DWIE OSOBY jest jedynym przypadkiem, w którym da się to
 * powiedzieć na pewno: skoro w spotkaniu jest dwóch ludzi i jednym z nich
 * jesteś ty, drugi tor należy do tego drugiego. Przy trzech osobach tor
 * systemu miesza ich wszystkich w jedno i podpisanie go czyimkolwiek
 * imieniem byłoby przypisaniem cudzych słów konkretnej osobie — a to jest
 * gorsze niż „Rozmówcy", bo wygląda na wiedzę.
 *
 * @param {string[]} people  imiona z kalendarza (z tobą włącznie)
 * @param {string} me        twoje imię i nazwisko z systemu
 */
function speakerFor(people, me) {
  const named = (people ?? []).map((name) => String(name ?? "").trim()).filter(Boolean);
  if (named.length !== 2) return SPEAKER.system;
  const mine = plain(me);
  if (!mine) return SPEAKER.system;
  const others = named.filter((name) => {
    const one = plain(name);
    // „Maciej" wśród „Maciej Wyrozumski" i odwrotnie — kalendarze zapisują
    // to samo nazwisko na kilka sposobów.
    return !(one === mine || one.includes(mine) || mine.includes(one));
  });
  return others.length === 1 ? others[0] : SPEAKER.system;
}

/* Normalizacja do PORÓWNYWANIA, nie do zapisu. Zapisujemy to, co padło;
   porównujemy to, co zostaje po zdjęciu interpunkcji i wielkości liter —
   bo dwa przebiegi transkrypcji różnią się właśnie tym najczęściej. */
const words = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[.,;:!?…„”"'()\[\]—–-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Najdłuższy ogon `before`, który jest jednocześnie początkiem `after`.
 *
 * @returns {number} ile SŁÓW się powtarza
 */
function repeatLength(before, after, cap) {
  const tail = words(before);
  const head = words(after);
  const most = Math.min(cap, tail.length, head.length);
  for (let size = most; size > 0; size -= 1) {
    let same = true;
    for (let at = 0; at < size; at += 1) {
      if (tail[tail.length - size + at] !== head[at]) {
        same = false;
        break;
      }
    }
    if (same) return size;
  }
  return 0;
}

/**
 * Początek `after` bez tego, co powiedział już `before`.
 *
 * Ucinamy po SŁOWACH w tekście oryginalnym, a porównujemy na
 * znormalizowanym — inaczej zapis traciłby interpunkcję na styku odcinków.
 */
function trimRepeat(before, after, cap = 40) {
  const repeated = repeatLength(before, after, cap);
  if (!repeated) return String(after ?? "");
  const raw = String(after ?? "").trimStart();
  let seen = 0;
  let at = 0;
  while (at < raw.length && seen < repeated) {
    while (at < raw.length && /\s/.test(raw[at])) at += 1;
    while (at < raw.length && !/\s/.test(raw[at])) at += 1;
    seen += 1;
  }
  return raw.slice(at).trimStart();
}

/**
 * Na ile `quiet` jest echem `loud` — długość NAJDŁUŻSZEGO CIĄGU słów, który
 * w obu tekstach stoi pod rząd, w stosunku do długości cichszego.
 *
 * ══ DLACZEGO POD RZĄD, A NIE „W TEJ SAMEJ KOLEJNOŚCI" ══
 *
 * Wcześniej liczyło się to jako podciąg: ile słów cichszego toru da się
 * odnaleźć w głośniejszym, byle po kolei — z dowolnymi dziurami. Brzmi
 * ostrożnie, a jest siatką o oczkach wielkości rozmowy: przy jednym odcinku
 * mikrofonu filtr ogląda kilka minut cudzego tekstu, a w kilku minutach
 * dowolnej mowy „the … you … about … the … next … week" stoi po kolei
 * ZAWSZE. Zmierzone na zajęciach z angielskiego: przy stu siedemdziesięciu
 * słowach drugiej strony wypadało co czwarte prawdziwe zdanie ucznia,
 * a przy pełnym oknie — większość. Tor potrafił zniknąć w całości.
 *
 * Echo jest zaś fizycznie tym samym nagraniem, więc powtarza słowa
 * NIEPRZERWANIE. Ciąg pod rząd trafia w nie tak samo pewnie, a nie trafia
 * w dwie osoby mówiące o tym samym.
 *
 * @returns {number} 0…1
 */
function echoRatio(quiet, loud) {
  const mine = words(quiet);
  const theirs = words(loud);
  if (!mine.length || !theirs.length) return 0;

  /* Najdłuższy wspólny ciąg — klasyczna tabelka, ale w dwóch wierszach:
     zdanie ma kilkanaście słów, a druga strona bywa ma ich kilkaset i pełna
     tabela byłaby megabajtem na każde porównanie. */
  let previous = new Uint16Array(theirs.length + 1);
  let current = new Uint16Array(theirs.length + 1);
  let best = 0;

  for (let a = 1; a <= mine.length; a += 1) {
    for (let b = 1; b <= theirs.length; b += 1) {
      current[b] = mine[a - 1] === theirs[b - 1] ? previous[b - 1] + 1 : 0;
      if (current[b] > best) best = current[b];
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }

  return best / mine.length;
}

const overlaps = (a, b, slack) => a.from < b.to + slack && b.from < a.to + slack;

/**
 * Podział na zdania — do OCENY echa, nie do zapisu.
 *
 * Odcinek trwa dwie minuty i mieści w sobie i twoją wypowiedź, i przesłuch
 * z głośników. Ocenianie echa na całym odcinku rozcieńcza je do zera:
 * pięć twoich zdań i jedno cudze dają udział, który nie przekroczy żadnego
 * progu. Echo wycina się więc zdaniami, bo zdaniem wchodzi.
 */
const sentences = (text) =>
  String(text ?? "")
    .split(/(?<=[.!?…])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Ile najmniej słów musi mieć zdanie, żeby wolno je było uznać za echo.
 *
 * Poniżej tego progu echa NIE DA SIĘ odróżnić od zgody: „Tak", „Jasne",
 * „Dobrze" padają w rozmowie po obu stronach i padają naprawdę. Koszt
 * pomyłki jest tu niesymetryczny — zostawione echo to jedno zdanie za dużo,
 * wycięta zgoda to czyjaś wypowiedź, której w zapisie nie ma.
 */
const MIN_ECHO_WORDS = 4;

/**
 * Jak długa może być jedna wypowiedź w zapisie, w sekundach.
 *
 * Cztery minuty: tyle, żeby zdanie przecięte granicą odcinka zostało jednym
 * zdaniem, i nie tyle, żeby znacznik czasu przestał cokolwiek znaczyć.
 */
const MAX_SPAN = 240;

/**
 * Odcinki w jeden zapis rozmowy.
 *
 * @param {Array<{lane, from, to, text}>} pieces
 * @param {object} [options]
 * @param {number} [options.echo]  od jakiego udziału uznajemy przesłuch
 * @param {number} [options.slack] o ile sekund tory mogą się rozjechać
 * @param {number} [options.gap]   przerwa, po której zaczyna się nowa wypowiedź
 * @param {number} [options.maxSpan] jak długa może być jedna wypowiedź w zapisie
 * @returns {Array<{speaker, lane, at, text}>}
 */
function splice(pieces, { echo = 0.6, slack = 2, gap = 12, maxSpan = MAX_SPAN, speakers } = {}) {
  // Podpisy mówiących wchodzą z zewnątrz, o ile ktoś je zna — patrz
  // speakerFor wyżej i main/meeting.js.
  const who = { ...SPEAKER, ...(speakers ?? {}) };
  const usable = (pieces ?? [])
    .filter((piece) => piece && String(piece.text ?? "").trim())
    .map((piece) => ({ ...piece, text: String(piece.text).trim() }))
    .sort((a, b) => a.from - b.from || (a.lane === "system" ? -1 : 1));

  /* 1. Zakładka — osobno w każdym torze, bo powtórzenie bierze się
        z cięcia tego samego toru, a nie ze zderzenia dwóch. */
  const last = {};
  const trimmed = [];
  for (const piece of usable) {
    const text = trimRepeat(last[piece.lane] ?? "", piece.text);
    last[piece.lane] = piece.text;
    if (text) trimmed.push({ ...piece, text });
  }

  /* 2. Przesłuch — z toru mikrofonu wypada to, co w tym samym czasie padło
        w torze systemu. Kierunek jest jednostronny i to nie jest symetria
        do poprawienia: głośnik oddaje do mikrofonu, mikrofon do głośnika
        nie. Wygrywa zawsze tor systemu, bo tam ta mowa jest oryginałem. */
  const theirs = trimmed.filter((piece) => piece.lane === "system");
  const kept = [];
  for (const piece of trimmed) {
    if (piece.lane !== "mic") {
      kept.push(piece);
      continue;
    }
    const around = theirs
      .filter((other) => overlaps(piece, other, slack))
      .map((other) => other.text)
      .join(" ");
    if (!around) {
      kept.push(piece);
      continue;
    }
    const mine = sentences(piece.text).filter((line) => {
      if (words(line).length < MIN_ECHO_WORDS) return true;
      return echoRatio(line, around) < echo;
    });
    const text = mine.join(" ").trim();
    if (text) kept.push({ ...piece, text });
  }

  /* 3. Sklejanie w wypowiedzi. Ten sam tor bez długiej przerwy to dalej
        ta sama wypowiedź, choćby padła na przestrzeni trzech odcinków.

        ══ ALE NIE BEZ KOŃCA ══

        Odcinki jednego toru stykają się z definicji (następny zaczyna się
        o zakładkę PRZED końcem poprzedniego), więc „przerwa" między nimi
        jest zawsze ujemna i warunek niżej był spełniony ZAWSZE. Dopóki
        druga strona coś mówiła, sklejanie przerywała zmiana toru i nikt
        tego nie widział. Gdy druga strona zamilkła — albo gdy wycięło ją
        echo — cała godzina zlewała się w JEDNĄ wypowiedź ze znacznikiem
        0:00. Tak wyglądał w zapisie wykład i tak wyglądały zajęcia, na
        których mówi głównie jedna osoba.

        Wypowiedź ma więc górną długość. Nie dlatego, że po czterech
        minutach ktoś przestaje mówić, tylko dlatego, że znacznik czasu ma
        do czegoś służyć: zapisu, w którym jeden znacznik obejmuje godzinę,
        nie da się z niczym zestawić — ani z nagraniem, ani z pamięcią. */
  const lines = [];
  for (const piece of kept) {
    const previous = lines[lines.length - 1];
    if (
      previous &&
      previous.lane === piece.lane &&
      piece.from - previous.to <= gap &&
      piece.to - previous.at <= maxSpan
    ) {
      previous.text = `${previous.text} ${piece.text}`.trim();
      previous.to = piece.to;
      continue;
    }
    lines.push({
      speaker: who[piece.lane] ?? piece.lane,
      lane: piece.lane,
      at: piece.from,
      to: piece.to,
      text: piece.text,
    });
  }

  return lines.map(({ speaker, lane, at, text }) => ({ speaker, lane, at, text }));
}

module.exports = {
  splice,
  trimRepeat,
  echoRatio,
  repeatLength,
  words,
  sentences,
  speakerFor,
  SPEAKER,
  MIN_ECHO_WORDS,
  MAX_SPAN,
};
