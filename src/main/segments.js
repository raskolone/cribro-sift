"use strict";

/**
 * Krojenie toru na odcinki — pierwsza połowa E2.
 *
 * Godzina rozmowy to 115 MB dźwięku na tor, a `stt.js` ma twardy limit
 * 18 MB na żądanie. Odcinki są więc konieczne tak czy inaczej. Skoro tak,
 * niech lecą OD RAZU, w trakcie rozmowy: po naciśnięciu „Koniec" transkrypt
 * jest gotowy w kilka sekund zamiast w kilka minut, pamięć nie rośnie,
 * a rachunek nie zaskakuje na końcu.
 *
 * Trzy rzeczy, na których takie krojenie się wykłada:
 *
 *   1. SŁOWO NA GRANICY. Cięcie co równe dwie minuty przecina wyraz w pół
 *      i żaden z odcinków nie ma go w całości. Stąd ZAKŁADKA: każdy odcinek
 *      zaczyna się kilka sekund przed końcem poprzedniego, więc słowo
 *      z granicy jest w całości w co najmniej jednym z nich. Powtórzenie
 *      z zakładki zdejmuje potem splot (patrz main/merge.js).
 *
 *   2. CISZA KOSZTUJE TYLE SAMO CO MOWA. W godzinnym spotkaniu mówisz może
 *      kwadrans — pozostałe czterdzieści pięć minut tor mikrofonu nagrywa
 *      ciszę, za którą zapłaciłbyś jak za mowę. Bramka odcina odcinki bez
 *      mowy, zanim wyjdą z tego pliku.
 *
 *   3. CZAS MUSI ZOSTAĆ PRAWDZIWY. Odcinek pominięty przez bramkę nie może
 *      przesunąć zegara pozostałych — inaczej znaczniki w transkrypcji
 *      rozjeżdżają się z nagraniem i przestają być czymkolwiek.
 *
 * Plik nie zna Electrona ani sieci: wchodzą bajty, wychodzą odcinki.
 * Dlatego sprawdza go zwykły Node — patrz scripts/segments-test.js.
 */

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** Ile dźwięku w jednym odcinku. Dwie minuty to kompromis między
 *  liczbą wywołań (koszt stały) a tym, jak szybko widać pierwszy tekst. */
const SPAN = 120;
/** Ile z końca poprzedniego odcinka wchodzi na początek następnego. */
const OVERLAP = 3;
/**
 * Poniżej ilu dBFS odcinek uznajemy za ciszę.
 *
 * Zmierzone sondą E0: cisza w pokoju to około −49 dBFS, mowa w rozmowie
 * −30…−17 dBFS. Próg −45 leży między nimi i z zapasem — bo pomyłka w jedną
 * stronę kosztuje grosze, a w drugą gubi wypowiedź.
 */
const FLOOR = -45;

/**
 * Na jak krótkich kawałkach mierzymy głośność.
 *
 * ══ DLACZEGO NIE NA CAŁYM ODCINKU ══
 *
 * Tu był błąd, który kosztował całą godzinę zajęć. Bramka liczyła jedną
 * średnią z CAŁYCH dwóch minut — a średnia z dwóch minut, w których ktoś
 * mówił przez piętnaście sekund, to prawie sama cisza. Godzinna lekcja
 * zapisała się z niej dwiema linijkami: odcinek za odcinkiem wypadał jako
 * „cichy", choć w każdym padały zdania.
 *
 * Pół sekundy to długość, na której sylaba jest jeszcze głośna, a przerwa
 * między zdaniami już cicha. Odcinek jest cichy dopiero wtedy, gdy NAJGŁOŚNIEJSZY
 * z takich kawałków nie przekroczył progu — czyli gdy w tych dwóch minutach
 * naprawdę nie padło ani jedno słowo.
 */
const WINDOW = 0.5;

/**
 * Najgłośniejszy półsekundowy kawałek porcji, w dBFS — i ile z niej jest
 * głośne.
 *
 * Jeden przebieg po próbkach na obie odpowiedzi, bo przebieg po dwóch
 * minutach dźwięku to prawie cztery miliony odczytów i nie ma powodu robić
 * go dwa razy.
 *
 * @returns {{peak: number, voiced: number}} peak w dBFS, voiced w sekundach
 */
function survey(pcm, { window = WINDOW, floor = FLOOR } = {}) {
  const step = Math.max(1, Math.round(window * SAMPLE_RATE)) * BYTES_PER_SAMPLE;
  let peak = -120;
  let voiced = 0;

  for (let start = 0; start < pcm.length; start += step) {
    const stop = Math.min(start + step, pcm.length);
    let sum = 0;
    let count = 0;
    for (let at = start; at + 1 < stop; at += BYTES_PER_SAMPLE) {
      const value = pcm.readInt16LE(at) / 32768;
      sum += value * value;
      count += 1;
    }
    if (!count) continue;
    const rms = Math.sqrt(sum / count);
    const db = rms > 0 ? 20 * Math.log10(rms) : -120;
    if (db > peak) peak = db;
    if (db >= floor) voiced += count / SAMPLE_RATE;
  }

  return { peak, voiced };
}

/** Głośność skuteczna porcji próbek, w dBFS. */
function loudness(pcm) {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (!samples) return -120;
  let sum = 0;
  for (let at = 0; at + 1 < pcm.length; at += BYTES_PER_SAMPLE) {
    const value = pcm.readInt16LE(at) / 32768;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples);
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

const seconds = (bytes) => bytes / BYTES_PER_SAMPLE / SAMPLE_RATE;
const bytes = (secs) => Math.round(secs * SAMPLE_RATE) * BYTES_PER_SAMPLE;

/**
 * Krajalnica jednego toru.
 *
 * @param {object} [options]
 * @param {string} [options.lane]     nazwa toru, przepisywana na odcinki
 * @param {number} [options.span]     długość odcinka w sekundach
 * @param {number} [options.overlap]  zakładka w sekundach
 * @param {number} [options.floor]    próg ciszy w dBFS
 */
function cutter({ lane = "system", span = SPAN, overlap = OVERLAP, floor = FLOOR } = {}) {
  /* ══ DŹWIĘK LEŻY W KAWAŁKACH, A NIE W JEDNYM BUFORZE ══

     Wcześniej każda porcja z tapa doklejała się do wspólnego bufora przez
     `Buffer.concat`. Wygląda niewinnie, a jest rachunkiem kwadratowym:
     porcje przychodzą kilkadziesiąt razy na sekundę, bufor rośnie do
     czterech megabajtów i KAŻDA porcja przepisywała całość od nowa. Dwie
     minuty jednego toru to tak kilkanaście gigabajtów przepisanych bez
     powodu — czyli procesor główny zajęty kopiowaniem przez całe spotkanie
     i śmieci, po których sprzątanie widać jako zacięcia w oknie.

     Trzymamy więc listę kawałków i sumę ich długości. Sklejenie następuje
     RAZ, w chwili wydania odcinka — czyli co dwie minuty zamiast co
     dwudziestą sekundy. */
  let chunks = [];
  let size = 0;
  let origin = 0;
  let index = 0;

  /** Wszystko, co czeka, w jednym kawałku. Jedyne miejsce, które kopiuje. */
  const gather = () => {
    if (chunks.length === 1) return chunks[0];
    const whole = Buffer.concat(chunks, size);
    chunks = size ? [whole] : [];
    return whole;
  };

  const cut = (upTo) => {
    const whole = gather();
    const pcm = whole.subarray(0, upTo);
    /* Głośność mierzona półsekundowymi kawałkami, nie jedną średnią z całości
       — patrz `survey` wyżej po powód, dla którego to jest różnica między
       zapisem lekcji a dwiema linijkami. */
    const { peak, voiced } = survey(pcm, { floor });
    const piece = {
      lane,
      index: index++,
      from: origin,
      to: origin + seconds(upTo),
      pcm,
      level: peak,
      /* Ile w tym odcinku naprawdę mowy. Jedzie dalej, bo z tego liczy się
         potem pokrycie zapisu (patrz main/meeting.js): „zapis obejmuje
         12 z 58 minut" da się powiedzieć tylko wtedy, gdy wiadomo, ile
         minut w ogóle było czym zapisać. */
      voiced,
      // „Cichy" nie znaczy „pusty": odcinek zostaje w rachubie czasu
      // i w numeracji, tylko nie jedzie do transkrypcji.
      silent: peak < floor,
    };
    const keep = Math.min(bytes(overlap), upTo);
    origin += seconds(upTo - keep);
    const rest = whole.subarray(upTo - keep);
    chunks = rest.length ? [rest] : [];
    size = rest.length;
    return piece;
  };

  return {
    /**
     * Kolejna porcja z toru. Oddaje tyle odcinków, ile się uzbierało —
     * zwykle zero, czasem jeden, a przy nadrabianiu zaległości kilka.
     */
    push(pcm) {
      if (!pcm?.length) return [];
      /* Kopia, a nie widok. Porcja przyjeżdża jako wycinek wspólnego bufora
         tapa (patrz main/tap.js) i jest ważna tylko do końca tego wywołania;
         odłożona na później bez kopii trzymałaby przy życiu cały bufor,
         z którego pochodzi. */
      chunks.push(Buffer.from(pcm));
      size += pcm.length;

      const full = bytes(span);
      const out = [];
      while (size >= full) out.push(cut(full));
      return out;
    },

    /**
     * Koniec toru. Resztka wychodzi odcinkiem, choćby była krótka —
     * ostatnie zdanie spotkania pada zwykle w ostatnich sekundach.
     *
     * Ale nie resztka SAMEJ ZAKŁADKI: to jest materiał, który wyszedł już
     * poprzednim odcinkiem, i wydany drugi raz byłby powtórzeniem, którego
     * splot nie ma jak odróżnić od prawdziwego.
     */
    flush() {
      if (seconds(size) <= overlap + 0.05) return [];
      const piece = cut(size);
      chunks = [];
      size = 0;
      return [piece];
    },

    /** Ile sekund czeka jeszcze w buforze — do pokazania postępu. */
    get pending() {
      return seconds(size);
    },
  };
}

module.exports = { cutter, loudness, survey, SPAN, OVERLAP, FLOOR, WINDOW, SAMPLE_RATE };
