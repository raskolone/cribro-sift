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
  /* Bufor trzyma to, co jeszcze nie wyszło odcinkiem, RAZEM z zakładką
     poprzedniego. `origin` to czas pierwszej próbki w buforze — i to on,
     a nie liczba wydanych odcinków, jest zegarem: odcinek pominięty przez
     bramkę też przesuwa czas, bo dźwięk się wydarzył. */
  let buffer = Buffer.alloc(0);
  let origin = 0;
  let index = 0;

  const cut = (upTo) => {
    const pcm = buffer.subarray(0, upTo);
    const level = loudness(pcm);
    const piece = {
      lane,
      index: index++,
      from: origin,
      to: origin + seconds(upTo),
      pcm,
      level,
      // „Cichy" nie znaczy „pusty": odcinek zostaje w rachubie czasu
      // i w numeracji, tylko nie jedzie do transkrypcji.
      silent: level < floor,
    };
    const keep = Math.min(bytes(overlap), upTo);
    origin += seconds(upTo - keep);
    buffer = buffer.subarray(upTo - keep);
    return piece;
  };

  return {
    /**
     * Kolejna porcja z toru. Oddaje tyle odcinków, ile się uzbierało —
     * zwykle zero, czasem jeden, a przy nadrabianiu zaległości kilka.
     */
    push(pcm) {
      if (!pcm?.length) return [];
      buffer = buffer.length ? Buffer.concat([buffer, pcm]) : Buffer.from(pcm);
      const full = bytes(span);
      const out = [];
      while (buffer.length >= full) out.push(cut(full));
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
      if (seconds(buffer.length) <= overlap + 0.05) return [];
      const piece = cut(buffer.length);
      buffer = Buffer.alloc(0);
      return [piece];
    },

    /** Ile sekund czeka jeszcze w buforze — do pokazania postępu. */
    get pending() {
      return seconds(buffer.length);
    },
  };
}

module.exports = { cutter, loudness, SPAN, OVERLAP, FLOOR, SAMPLE_RATE };
