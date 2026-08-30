"use strict";

/**
 * Okno jednego spotkania — cała jego zawartość to pięć linijek niżej.
 *
 * Rysowaniem zajmuje się js/meetings-view.js, ten sam, który rysuje
 * zakładkę Spotkania w oknie głównym; tutaj zostaje wyłącznie to, czego
 * tamten nie wie: KTÓRE spotkanie i skąd wziąć ustawienia.
 *
 * Meldunki z procesu głównego (zaczęło się nagrywanie, przyszedł odcinek
 * zapisu, zmieniły się ustawienia) idą tą samą drogą co w oknie głównym —
 * spotkanie ma wyglądać tak samo w obu miejscach, bo jest tym samym
 * spotkaniem.
 */

(function () {
  const api = window.cribro;
  const id = new URLSearchParams(location.search).get("meeting");
  const host = document.getElementById("solo");

  (async function boot() {
    const settings = await api.settings.get();
    window.setLanguage(settings.uiLanguage ?? "pl");
    await window.MeetingsView.show(host, settings, { solo: id });
    window.translateTree();
  })();

  api.settings.onChange?.((settings) => {
    window.setLanguage(settings.uiLanguage ?? "pl");
    window.MeetingsView.settings(settings);
    window.translateTree();
  });

  api.meetings.onChange?.((live) => window.MeetingsView.changed(live));

  /* Notatnik przy spotkaniu zapisuje się z chwilą zwłoki — zamknięcie okna
     w tej chwili zabrałoby ze sobą ostatnie zdanie. */
  window.addEventListener("beforeunload", () => window.MeetingsView.hide());

  // Escape zamyka okno jednego spotkania — tak jak w każdym innym okienku
  // tej aplikacji, w którym leży jedna rzecz.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (document.activeElement?.isContentEditable) return;
    window.close();
  });
})();
