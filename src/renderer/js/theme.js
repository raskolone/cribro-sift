"use strict";
/**
 * Most między tokenami a canvasem.
 *
 * Sito w Ustawieniach i pierścień w HUD-zie są rysowane, nie stylowane —
 * a `ctx.strokeStyle` nie rozumie `var(--accent)`. Bez tego mostu kolor
 * motywu musiałby istnieć drugi raz, wpisany na sztywno w JS, i przy każdej
 * zmianie motywu jedno z dwóch źródeł zostawałoby w tyle.
 *
 *   themeRgb("--accent")  →  "114, 240, 180"
 */
window.themeRgb = (function () {
  const cache = new Map();

  return function themeRgb(name) {
    if (cache.has(name)) return cache.get(name);

    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    let triplet = "255, 255, 255";

    if (raw.startsWith("#")) {
      const hex = raw.slice(1);
      const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
      triplet = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(", ");
    } else if (raw.startsWith("rgb")) {
      triplet = raw.replace(/^rgba?\(|\)$/g, "").split(/[,/]/).slice(0, 3).map((n) => n.trim()).join(", ");
    }

    cache.set(name, triplet);
    return triplet;
  };
})();
