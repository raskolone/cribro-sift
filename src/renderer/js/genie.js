"use strict";

/**
 * Sylwetka efektu „genie" — tego, którym macOS wciąga okno w ikonę Docka.
 *
 * Osobny plik, bo to jedyny kawałek widgetu, który jest czystą geometrią:
 * wchodzi postęp, wychodzi wielokąt. Dzięki temu da się go sprawdzić bez
 * przeglądarki (scripts/genie-test.js), a kształtu animacji nie ocenia się
 * wtedy wyłącznie okiem.
 *
 * Dlaczego nie `transition` w CSS: bo szerokość zmienia się INACZEJ na każdej
 * wysokości kartki, a przejście CSS zna jedną krzywą na całą własność.
 * Tutaj każda z 27 poprzeczek ma własny rachunek, przeliczany co klatkę.
 *
 * Trzy rzeczy składają się na to, że kształt czyta się jak genie, a nie jak
 * rosnący prostokąt:
 *
 *   SZYJKA (neck)    tuż przy znaczku kartka jest wąska. Szyjka kurczy się
 *                    do zera, więc na końcu zostaje czysty prostokąt,
 *                    a nie kartka z ogonkiem.
 *
 *   ROZLEWANIE       kartka nie ma prawa osiągnąć pełnej szerokości, dopóki
 *   (spread)         nie wyszła cała. Bez tego przy jednej piątej drogi
 *                    z punktu robił się od razu szeroki lejek — pierwsza
 *                    wersja tak właśnie wyglądała i to był jej główny błąd.
 *
 *   CZOŁO (head)     góra strumienia jest zaokrąglona, nie ucięta nożem.
 *                    Zaokrąglenie znika razem z końcem ruchu.
 *
 * Oś kształtu wędruje: przy znaczku jest tam, gdzie znaczek, a dalej wraca
 * na środek kartki. Dokładnie tak zachowuje się genie, gdy ikona w Docku
 * nie stoi na wprost okna.
 */

(function () {
  const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t);
  const smooth = (t) => {
    const k = clamp01(t);
    return k * k * (3 - 2 * k);
  };

  const STEPS = 26;

  /**
   * Sylwetka strumienia dla zadanego postępu.
   *
   * Cztery kierunki, bo widget stoi tam, gdzie go postawiono — a kartka ma
   * wychodzić w stronę, w którą jest miejsce. Rachunek jest jeden: liczymy
   * wzdłuż OSI GŁÓWNEJ (od znaczka w głąb kartki) i w POPRZEK (szerokość
   * strumienia), a na końcu podmieniamy, która z nich jest pozioma.
   *
   * @param {number} p        postęp 0…1 (0 = wszystko w znaczku)
   * @param {object} opts
   * @param {number} opts.anchor   oś szyjki w poprzek kartki, 0…1
   * @param {number} opts.neckHalf połowa szerokości szyjki, 0…0.5
   * @param {"up"|"down"|"left"|"right"} opts.dir  strona, w którą kartka wychodzi
   * @returns {[number, number][]} punkty wielokąta w procentach
   */
  function points(p, { anchor = 0.5, neckHalf = 0.09, dir = "up" } = {}) {
    const q = clamp01(p);
    const cx = Math.min(0.92, Math.max(0.08, anchor));
    const nh = Math.min(0.45, Math.max(0.01, neckHalf));

    const neck = 0.34 * Math.pow(1 - q, 1.1);
    const spread = 0.18 + 0.82 * smooth(q);
    const widest = 0.5 * spread;

    // Oś pozioma znaczy, że kartka wychodzi w bok; „left" i „up" liczą się
    // od dalszej krawędzi, bo znaczek jest wtedy po stronie wyższych wartości.
    const sideways = dir === "left" || dir === "right";
    const reversed = dir === "up" || dir === "left";

    const near = [];
    const far = [];

    for (let i = 0; i <= STEPS; i += 1) {
      const u = (i / STEPS) * q; // odległość od znaczka: 0 … q

      // Szyjka. Przy q → 1 znika i cała długość ma pełną szerokość.
      const grown = neck < 0.0015 ? 1 : smooth(u / neck);

      // Czoło strumienia — zaokrąglenie, które rozpływa się na końcu ruchu.
      const tip = smooth((q - u) / 0.05 + 0.25);
      const head = 1 - (1 - tip) * (1 - smooth(q));

      const half = Math.max(nh * 0.5, nh + (widest - nh) * grown * head);
      const centre = cx + (0.5 - cx) * grown;

      const main = (reversed ? 1 - u : u) * 100;
      const lo = (centre - half) * 100;
      const hi = (centre + half) * 100;

      near.push(sideways ? [main, lo] : [lo, main]);
      far.push(sideways ? [main, hi] : [hi, main]);
    }

    far.reverse();
    return [...near, ...far];
  }

  /** Ten sam kształt gotowy do wstawienia w `clip-path`. */
  function path(p, opts) {
    const body = points(p, opts)
      .map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`)
      .join(", ");
    return `polygon(${body})`;
  }

  const Genie = { points, path, STEPS };

  if (typeof module !== "undefined" && module.exports) module.exports = Genie;
  if (typeof window !== "undefined") window.CribroGenie = Genie;
})();
