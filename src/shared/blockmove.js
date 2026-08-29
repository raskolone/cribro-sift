"use strict";

/**
 * Przenoszenie linii w notatce — rozstrzygnięcia, nie ruszanie węzłów.
 *
 * Przeciąganie punktu listy wygląda na rzecz prostą („weź i połóż niżej"),
 * ale kryją się w nim pytania, na które trzeba odpowiedzieć ZANIM cokolwiek
 * ruszy w drzewie. Te, które da się rozstrzygnąć bez przeglądarki, siedzą
 * tutaj, a nie w js/editor.js:
 *
 *   1. CZYM STANIE SIĘ TO, CO PRZENIESIONE. Punkt listy upuszczony między
 *      akapity nie może zostać punktem — w Markdownie nie ma punktu bez
 *      listy. Akapit upuszczony w środek listy zadań musi dostać stan
 *      odhaczenia, bo bez niego byłby punktem, którego nie da się odhaczyć.
 *
 *   2. DO KTÓREJ SZCZELINY. Odległość liczy się do KRAWĘDZI między liniami,
 *      nie do ich środków — inaczej upuszczenie tuż nad linią trafia za nią.
 *
 *   3. CZY W OGÓLE COŚ SIĘ ZMIENI. Odłożenie linii na jej własne miejsce
 *      nie ma prawa liczyć się jako zmiana notatki.
 *
 * Plik jest wspólny dla renderera i dla testu w Node, więc eksportuje się
 * na oba sposoby — tak samo jak shared/richtext.js.
 */

(function () {
  /**
   * Czym ma się stać przenoszona linia po wylądowaniu.
   *
   * @param {{tag: string, done: string|null}} line  co jedzie
   * @param {{list: boolean, task: boolean}} target  dokąd
   * @returns {{tag: string, done: string|null}}
   */
  function landing(line, target) {
    const tag = String(line?.tag ?? "P").toUpperCase();

    if (target?.list) {
      return {
        tag: "LI",
        // Stan odhaczenia zachowujemy przy przeprowadzce między listami
        // zadań: przeniesienie zrobionego zadania nie może go cofnąć.
        // Do zwykłej listy stan nie należy i przepada razem z punktorem.
        done: target.task ? (line?.done === "true" ? "true" : "false") : null,
      };
    }

    // Poza listą punkt nie ma jak istnieć — zostaje akapitem. Reszta
    // bloków zachowuje swój rodzaj: nagłówek przeniesiony niżej ma dalej
    // być nagłówkiem.
    return { tag: tag === "LI" ? "P" : tag, done: null };
  }

  /* ILE LINII JEDZIE RAZEM — tego tu nie ma i nie powinno być.
     Zwinięty nagłówek zabiera ze sobą treść, której nie widać, a „co należy
     do tego nagłówka” rozstrzyga już #foldRange w js/editor.js — to samo
     pytanie zadaje przy chowaniu i pokazywaniu. Napisana tutaj druga
     odpowiedź musiałaby zgadywać po liście linii WIDOCZNYCH, czyli po
     liście, z której schowana treść jest właśnie wykluczona. Wychodziło
     z tego jedno: nagłówek jechał sam, a jego treść zostawała w miejscu. */

  /**
   * Która szczelina jest najbliżej kursora.
   *
   * Szczelin jest o jedną więcej niż linii: przed każdą i jedna na końcu.
   * `edges` to ich współrzędne w pionie, w kolejności.
   *
   * @param {number[]} edges
   * @param {number} y
   * @returns {number} indeks szczeliny albo -1, gdy nie ma żadnej
   */
  function nearest(edges, y) {
    if (!edges?.length) return -1;
    let best = 0;
    let bestGap = Math.abs(edges[0] - y);
    for (let at = 1; at < edges.length; at += 1) {
      const gap = Math.abs(edges[at] - y);
      // Ostry warunek, nie „mniejsze lub równe": przy remisie wygrywa
      // szczelina wcześniejsza, czyli ta, nad którą kursor już stoi.
      if (gap < bestGap) {
        best = at;
        bestGap = gap;
      }
    }
    return best;
  }

  /**
   * Czy przeniesienie w tę szczelinę cokolwiek zmieni.
   *
   * Szczelina tuż nad złapaną linią i tuż pod nią to jest to samo miejsce,
   * w którym linia już stoi. Bez tego sprawdzenia każde odłożenie linii
   * na miejsce zapisywałoby notatkę i podbijało jej czas zmiany.
   *
   * @param {number} from  indeks pierwszej przenoszonej linii
   * @param {number} count ile linii jedzie
   * @param {number} slot  indeks szczeliny
   */
  function pointless(from, count, slot) {
    return slot >= from && slot <= from + count;
  }

  const api = { landing, nearest, pointless };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.CribroBlockMove = api;
})();
