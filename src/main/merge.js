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
function trimRepeat(before, after, cap = 40, minWords = 2) {
  const repeated = repeatLength(before, after, cap);
  // Jedno słowo to za mało na zakładkę dźwiękową (3s mowy to kilka słów)
  // i odcięcie go kasowało zwykłe spójniki na początku zdań („to", „nie", „i").
  if (repeated < minWords) return String(after ?? "");
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

/* ══ TRZY OSOBY W JEDNYM KABLU ══

   Tor systemu to jedno wejście, w którym siedzą WSZYSCY zdalni rozmówcy.
   Bez rozbicia zajęcia w cztery osoby zapisują się dwiema etykietami: „Ty"
   i „Rozmówcy" — czyli trzy czwarte sali mówi jednym głosem.

   Deepgram umie podzielić to na mówców (`diarize`, patrz main/stt.js)
   i oddaje numer przy każdym słowie. Problem jest jeden i trzeba go
   rozwiązać tutaj: NUMER JEST LOKALNY DLA JEDNEGO ODCINKA. Ta sama osoba
   bywa „0" w pierwszej minucie i „2" w trzeciej, bo model liczy od nowa
   przy każdym żądaniu. Zostawione tak, jak przyszły, numery dawałyby
   dwudziestu „rozmówców" na godzinnych zajęciach czterech osób.

   Zszywa je ZAKŁADKA. Odcinki zachodzą na siebie o trzy sekundy
   (OVERLAP w main/segments.js), więc koniec jednego i początek następnego
   to ten sam dźwięk — a skoro ten sam dźwięk, to i ten sam człowiek.
   Dopasowujemy więc pierwsze tury nowego odcinka do ostatnich tur
   poprzedniego po TREŚCI, i przenosimy numer z tamtej strony.

   Czego to nie zrobi: nie rozpozna, że osoba milcząca przez dziesięć minut
   wraca jako ta sama. Po dłuższej ciszy numer bywa nowy — i to jest
   uczciwsza odpowiedź niż sklejenie dwóch osób w jedną na podstawie
   niczego. Nazwać mówców można ręką, raz, w zakładce spotkania. */

/** Ile słów z brzegu odcinka bierzemy pod uwagę przy zszywaniu numerów. */
const SEAM_WORDS = 12;

/** Ostatnie / pierwsze `count` słów tekstu, znormalizowane do porównania. */
const edgeWords = (text, count, fromEnd) => {
  const all = words(text);
  return fromEnd ? all.slice(-count) : all.slice(0, count);
};

/** Ile słów wspólnych mają dwa brzegi — prosta miara „to ten sam dźwięk". */
function seamScore(before, after) {
  const tail = new Set(edgeWords(before, SEAM_WORDS, true));
  if (!tail.size) return 0;
  const head = edgeWords(after, SEAM_WORDS, false);
  if (!head.length) return 0;
  let hits = 0;
  for (const word of head) if (tail.has(word)) hits += 1;
  return hits / head.length;
}

/**
 * Odcinki z turami diaryzacji → odcinki z globalnym numerem mówiącego.
 *
 * Tor mikrofonu przechodzi nietknięty: tam mówi jedna osoba i wiadomo która,
 * bo to wynika z kabla, a nie z modelu. Rozbijamy WYŁĄCZNIE tor systemu.
 *
 * @param {Array} pieces  odcinki, część z polem `turns`
 * @param {object} [options]
 * @param {number} [options.seam]  od jakiego podobieństwa brzegów uznajemy
 *   turę za ciąg dalszy tej samej osoby
 * @returns {Array} odcinki, gdzie tor systemu ma dodatkowo `who` (0,1,2…)
 */
function expandTurns(pieces, { seam = 0.34 } = {}) {
  const out = [];
  /* Ostatnia znana tura każdego GLOBALNEGO mówiącego — po niej rozpoznajemy
     go w następnym odcinku. */
  let lastByGlobal = [];
  let nextGlobal = 0;

  for (const piece of pieces ?? []) {
    if (piece.lane !== "system" || !Array.isArray(piece.turns) || !piece.turns.length) {
      out.push(piece);
      continue;
    }

    const localToGlobal = new Map();
    const fresh = [];

    for (const turn of piece.turns) {
      const text = String(turn.text ?? "").trim();
      if (!text) continue;

      let global = localToGlobal.get(turn.speaker);
      if (global === undefined) {
        /* Numer lokalny widziany w tym odcinku pierwszy raz. Szukamy, czy
           to ktoś, kto mówił na końcu poprzedniego odcinka — po zakładce. */
        let best = -1;
        let bestScore = seam;
        for (let id = 0; id < lastByGlobal.length; id += 1) {
          const score = seamScore(lastByGlobal[id] ?? "", text);
          if (score > bestScore) {
            bestScore = score;
            best = id;
          }
        }
        global = best >= 0 ? best : nextGlobal++;
        localToGlobal.set(turn.speaker, global);
      }

      fresh.push({
        ...piece,
        turns: undefined,
        who: global,
        /* Czas tury jest liczony od początku ODCINKA, a odcinek ma swoje
           miejsce w spotkaniu — bez tego dodania wszystkie tury każdego
           odcinka lądowałyby na jego początku. */
        from: piece.from + Number(turn.from ?? 0),
        to: piece.from + Number(turn.to ?? 0),
        text,
      });
    }

    for (const item of fresh) lastByGlobal[item.who] = item.text;
    out.push(...fresh);
  }

  return out;
}

/** Jak podpisać mówiącego numer `n` z toru systemu. */
const speakerName = (who, speakers) =>
  speakers?.[`system:${who}`] ?? (who === undefined ? SPEAKER.system : `Rozmówca ${who + 1}`);

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
function splice(pieces, { echo = 0.6, slack = 2, gap = 12, maxSpan = MAX_SPAN, speakers, keepEcho = false } = {}) {
  // Podpisy mówiących wchodzą z zewnątrz, o ile ktoś je zna — patrz
  // speakerFor wyżej i main/meeting.js.
  const who = { ...SPEAKER, ...(speakers ?? {}) };
  /* Tor systemu rozbity na osoby, o ile diaryzacja coś powiedziała.
     Bez niej wszystko idzie dalej tak, jak szło — jedną etykietą. */
  const split = expandTurns(pieces);
  const usable = (split ?? [])
    .filter((piece) => piece && String(piece.text ?? "").trim())
    .map((piece) => ({ ...piece, text: String(piece.text).trim() }))
    .sort((a, b) => a.from - b.from || (a.lane === "system" ? -1 : 1));

  /* 1. Zakładka — osobno w każdym torze, bo powtórzenie bierze się
        z cięcia tego samego toru, a nie ze zderzenia dwóch.

        Po rozbiciu na mówców klucz jest parą TOR + OSOBA: powtórzenie
        z zakładki wraca w ustach tej samej osoby, a porównywanie jej
        z poprzednikiem, który mówił co innego, nie zdjęłoby niczego. */
  const key = (piece) => (piece.who === undefined ? piece.lane : `${piece.lane}:${piece.who}`);
  const last = {};
  const trimmed = [];
  for (const piece of usable) {
    const text = trimRepeat(last[key(piece)] ?? "", piece.text);
    last[key(piece)] = piece.text;
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
    /* ══ ECHO JEST ZNACZONE, A NIE KASOWANE ══

       Wcześniej zdanie uznane za przesłuch po prostu znikało. Przy rozmowie
       to jest rachunek do przyjęcia; przy ZAJĘCIACH już nie, bo mówienie
       równolegle z dźwiękiem z komputera jest tam normalną sytuacją —
       prowadzący komentuje to, co właśnie leci — a filtr nie odróżnia
       komentarza od echa tego samego zdania.

       Skoro nagranie zostaje na dysku (patrz archive w main/meeting.js),
       pomyłka filtra przestaje być stratą — ale tylko wtedy, gdy dane
       przeżyły. Zdanie zostaje więc w zapisie z chorągiewką `echo`, a widok
       domyślnie je chowa. Kto szuka swojego zdania, ma je gdzie znaleźć. */
    const lines = sentences(piece.text).map((line) => ({
      line,
      echo: words(line).length >= MIN_ECHO_WORDS && echoRatio(line, around) >= echo,
    }));
    const clean = lines.filter((item) => !item.echo).map((item) => item.line).join(" ").trim();
    const bounced = lines.filter((item) => item.echo).map((item) => item.line).join(" ").trim();
    if (clean) kept.push({ ...piece, text: clean });
    if (bounced && keepEcho) kept.push({ ...piece, text: bounced, echo: true });
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
      // Zmiana osoby kończy wypowiedź tak samo jak zmiana toru — inaczej
      // zdanie jednego rozmówcy dokleiłoby się do zdania drugiego.
      previous.who === piece.who &&
      !previous.echo === !piece.echo &&
      piece.from - previous.to <= gap &&
      piece.to - previous.at <= maxSpan
    ) {
      previous.text = `${previous.text} ${piece.text}`.trim();
      previous.to = piece.to;
      continue;
    }
    lines.push({
      speaker:
        piece.lane === "system" && piece.who !== undefined
          ? speakerName(piece.who, speakers)
          : (who[piece.lane] ?? piece.lane),
      lane: piece.lane,
      who: piece.who,
      echo: !!piece.echo,
      at: piece.from,
      to: piece.to,
      text: piece.text,
    });
  }

  return lines.map(({ speaker, lane, who: person, echo: bounced, at, text }) => {
    const line = { speaker, lane, at, text };
    if (person !== undefined) line.who = person;
    if (bounced) line.echo = true;
    return line;
  });
}

module.exports = {
  splice,
  expandTurns,
  speakerName,
  seamScore,
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
