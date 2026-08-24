"use strict";

/**
 * Tłumaczenie interfejsu w rendererze.
 *
 * Dwie drogi, bo interfejs powstaje na dwa sposoby:
 *
 *   t("tekst")        — dla napisów składanych w kodzie (liczby, czasy,
 *                       komunikaty). Tu tłumaczenie musi być jawne, bo
 *                       gotowy napis zależy od zmiennych.
 *
 *   translateTree()   — dla napisów wpisanych wprost w szablony HTML.
 *                       Widoki i tak powstają przez innerHTML, więc zamiast
 *                       oplatać `${t(...)}` sto kilkadziesiąt miejsc w kodzie
 *                       (i psuć czytelność polskich szablonów), po każdym
 *                       renderowaniu przechodzimy po tekstach i podmieniamy
 *                       te, które zna słownik.
 *
 * Napis, którego słownik nie zna, zostaje bez zmian — dlatego treść
 * użytkownika jest bezpieczna z samej konstrukcji. Tam, gdzie mogłaby
 * przypadkiem trafić na klucz (tytuł notatki „Ustawienia"), stawiamy
 * `data-i18n="skip"` i cała gałąź jest pomijana.
 */

(function () {
  const { translator, LANG_NAMES } = window.CribroStrings;

  let current = "pl";
  let translate = translator("pl");

  const ATTRS = ["title", "placeholder", "aria-label"];

  window.t = (text, vars) => translate(text, vars);
  window.uiLang = () => current;
  window.uiLocale = () => (current === "en" ? "en-GB" : "pl-PL");
  window.LANG_NAMES = LANG_NAMES;

  window.setLanguage = (lang) => {
    current = LANG_NAMES[lang] ? lang : "pl";
    translate = translator(current);
    document.documentElement.lang = current;
  };

  window.translateTree = (root = document.body) => {
    if (current === "pl") return; // polski jest źródłem, nie tłumaczeniem

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('[data-i18n="skip"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const raw = node.nodeValue;
      const trimmed = raw.trim();
      const out = translate(trimmed);
      // Podmiana zachowuje wcięcia szablonu — inaczej HTML by się posypał
      // wizualnie tam, gdzie białe znaki mają znaczenie.
      if (out !== trimmed) node.nodeValue = raw.replace(trimmed, out);
    }

    for (const element of root.querySelectorAll("[title],[placeholder],[aria-label]")) {
      if (element.closest('[data-i18n="skip"]')) continue;
      for (const attr of ATTRS) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        const out = translate(value);
        if (out !== value) element.setAttribute(attr, out);
      }
    }
  };
})();
