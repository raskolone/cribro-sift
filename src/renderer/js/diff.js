/* Porównanie surowej transkrypcji z przesianą.
   Nie chodzi o techniczny diff, tylko o jedno pytanie:
   co sito zabrało, a co zostawiło. */

(function () {
  const normalize = (word) =>
    word
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");

  function tokenize(text) {
    return (text || "").split(/(\s+)/).filter((token) => token.length);
  }

  /**
   * SUFIT NA JEDNO PORÓWNANIE — i nie jest to ostrożność na zapas.
   *
   * LCS na słowach kosztuje n×m: tyle komórek tablicy trzeba wypełnić
   * i tyle razy obrócić pętlą. Przy dyktowaniu, dla którego to pisano
   * (mediana w prawdziwej historii to pięćdziesiąt słów), wychodzi kilka
   * tysięcy komórek i jest to faktycznie darmowe. Ale koszt rośnie
   * KWADRATOWO, a lista historii liczy różnicę dla KAŻDEGO wpisu naraz,
   * synchronicznie, przy pierwszym rysowaniu okna — więc jedno długie
   * dyktowanie nie spowalnia okna, tylko je zatrzymuje.
   *
   * Zmierzone na prawdziwej historii: jeden wpis na 32 765 słów to
   * miliard komórek, piętnaście sekund zajętego wątku i dwa gigabajty
   * tablicy. Przez te piętnaście sekund okno jest otwarte, narysowane
   * do połowy i głuche na wszystko — nie do odróżnienia od zawieszonej
   * aplikacji, bo to JEST zawieszona aplikacja.
   *
   * Szesnaście milionów komórek to około trzydziestu megabajtów tablicy
   * i setka milisekund — czyli najdłuższe dyktowanie, jakie ktoś naprawdę
   * wypowie (jakieś cztery tysiące słów po każdej stronie) mieści się
   * z zapasem, a to, co się nie mieści, nie zabiera okna ze sobą.
   *
   * Przy okazji ten sufit domyka drugą, cichszą usterkę: tablica jest
   * z Uint16Array, więc długość LCS powyżej 65 535 przekręciłaby się
   * i wyszłaby z niej różnica bez sensu. Pod sufitem krótszy bok ma
   * najwyżej cztery tysiące pozycji, więc nie ma z czego się przekręcić.
   */
  const MAX_CELLS = 16_000_000;

  /**
   * Różnica słowo po słowie.
   *
   * @returns {Array<{type: "kept"|"gone"|"added", text: string}>|null}
   *   `null` znaczy „za duże, żeby to policzyć" — patrz MAX_CELLS.
   *   Wywołujący ma wtedy pokazać sam przesiany tekst, a nie czekać.
   */
  function diffWords(raw, sifted) {
    const a = tokenize(raw);
    const b = tokenize(sifted);
    const aKeys = a.map(normalize);
    const bKeys = b.map(normalize);

    /* Wspólny początek i koniec zdejmujemy PRZED tablicą. To nie jest
       sama oszczędność: przesiany tekst jest w większości tym samym
       tekstem, co surowy, więc zwykle zdejmuje to grubą część roboty —
       a wpis, w którym sito niczego nie zmieniło (albo go wcale nie
       było), schodzi do zera komórek i liczy się natychmiast.

       Wspólny przedrostek i przyrostek zawsze da się włożyć do któregoś
       z optymalnych dopasowań, więc różnica wychodzi ta sama. */
    const same = (i, j) => aKeys[i] === bKeys[j];

    let i0 = 0;
    let j0 = 0;
    let i1 = a.length;
    let j1 = b.length;

    const head = [];
    while (i0 < i1 && j0 < j1 && same(i0, j0)) {
      head.push(b[j0]);
      i0++;
      j0++;
    }

    const tail = [];
    while (i1 > i0 && j1 > j0 && same(i1 - 1, j1 - 1)) {
      i1--;
      j1--;
      tail.push(b[j1]);
    }
    tail.reverse();

    const n = i1 - i0;
    const m = j1 - j0;
    if (n * m > MAX_CELLS) return null;

    const out = [];
    const push = (type, text) => {
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };

    for (const text of head) push("kept", text);

    // LCS na słowach — już tylko na tym, co po obu stronach naprawdę
    // różne, i tylko wtedy, gdy zmieściło się pod sufitem.
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] =
          aKeys[i0 + i] === bKeys[j0 + j] && aKeys[i0 + i] !== ""
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    /* `same` obejmuje oba przypadki, które stały tu wcześniej osobno:
       dwa jednakowe słowa i dwa odstępy (obu normalize daje pusty klucz).
       Odstępy przechodzą razem, ale do długości LCS wyżej się nie liczą —
       inaczej sam rytm spacji trzymałby dopasowanie zamiast słów. */
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (same(i0 + i, j0 + j)) {
        push("kept", b[j0 + j]);
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        push("gone", a[i0 + i]);
        i++;
      } else {
        push("added", b[j0 + j]);
        j++;
      }
    }
    while (i < n) push("gone", a[i0 + i++]);
    while (j < m) push("added", b[j0 + j++]);

    for (const text of tail) push("kept", text);

    // Same odstępy niech nie krzyczą kolorem.
    return out.map((part) => (part.text.trim() === "" ? { type: "kept", text: part.text } : part));
  }

  window.diffWords = diffWords;
  window.diffWords.MAX_CELLS = MAX_CELLS;
})();
