"use strict";

/* ═══════════════════════════════════════════════════════════════════
   Pytanie przed rzeczą nieodwracalną.

   ── DLACZEGO NIE `window.confirm` ──

   Systemowe okno robi trzy rzeczy, z których żadnej tu nie chcemy:

     1. ZATRZYMUJE CAŁE OKNO. Nie tylko rysowanie — także zapis notatki
        z opóźnieniem, który w tej aplikacji chodzi w tle i jest jedynym
        zapisem, jaki w ogóle jest (nie ma przycisku „Zapisz"). Pytanie
        wiszące pół minuty to pół minuty niezapisanego tekstu.
     2. Rysuje je system, więc w oknie o własnym motywie wygląda jak
        wklejka z innego programu.
     3. Staje na środku EKRANU, a nie przy rzeczy, o którą pyta — trzeba
        przenieść wzrok z przycisku na środek i z powrotem.

   To pytanie wychodzi spod przycisku, który je wywołał, wygląda jak
   reszta okna i niczego nie zatrzymuje.

   ── DLACZEGO OSOBNY PLIK, A NIE W notes-core.js ──

   Bo kasować da się nie tylko notatkę. Spotkanie ginie razem z NAGRANIEM,
   czyli z jedyną rzeczą w tej aplikacji, której nie da się odtworzyć —
   a okno pojedynczego spotkania (meeting.html) nie ładuje notes-core.js
   i ładować nie powinno: nie ma tam notatek ani paska czynności.
   Dwa pytania w dwóch plikach rozjechałyby się przy pierwszej poprawce,
   a rozjazd w miejscu, w którym stoi „Usuń", nie jest kosmetyczny.

   Użycie:

       const zgoda = await CribroAsk.danger({
         anchor: przycisk,
         title: "Skasować to spotkanie?",
         body: "Zniknie razem z nagraniem — nie da się go odtworzyć.",
         confirm: "Skasuj",
       });
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  const t = (text) => (typeof window.t === "function" ? window.t(text) : text);

  /** Tekst wchodzi do pytania jako TEKST, nie jako znaczniki. */
  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
    );
  }

  /**
   * Pyta i czeka na odpowiedź.
   *
   * @param {object} options
   * @param {Element|null} options.anchor   przycisk, spod którego wyjdzie pytanie
   * @param {string} options.title          nagłówek — czynność, nie „Uwaga"
   * @param {string} options.body           co się stanie i że tego nie da się cofnąć
   * @param {string} [options.confirm]      napis na przycisku, który to robi
   * @param {string} [options.cancel]       napis na przycisku, który tego nie robi
   * @returns {Promise<boolean>}  true, jeżeli człowiek potwierdził
   */
  function danger({ anchor, title, body, confirm = "Skasuj", cancel = "Zostaw" }) {
    /* Nie ma do czego przypiąć pytania — a milcząca odmowa byłaby gorsza
       niż brak pytania, bo wyglądałaby jak zepsuty przycisk. */
    if (!anchor || !anchor.isConnected) return Promise.resolve(true);

    const host = anchor.closest("[data-ask-slot]") || anchor.parentElement;
    if (!host) return Promise.resolve(true);

    /* Pozycjonujemy się względem gospodarza, więc musi mieć układ
       odniesienia. Jeżeli go nie ma (zwykły `static`), dokładamy go na
       czas pytania i zdejmujemy po nim — cudzych stylów nie zostawiamy. */
    const had = host.style.position;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    host.querySelector("[data-ask]")?.remove();

    const box = document.createElement("div");
    box.className = "ask";
    box.setAttribute("data-ask", "");
    box.setAttribute("role", "alertdialog");
    box.innerHTML = `
      <b>${escapeHtml(t(title))}</b>
      <p>${escapeHtml(t(body))}</p>
      <div class="ask__row">
        <button type="button" data-ask-answer="no">${escapeHtml(t(cancel))}</button>
        <button type="button" data-ask-answer="yes" class="ask__go">${escapeHtml(t(confirm))}</button>
      </div>`;
    host.appendChild(box);

    /* Domknięcie do krawędzi okna. Pytanie jest szersze niż przycisk,
       a przyciski kasowania z natury stoją na końcu pasków, czyli przy
       krawędzi — bez tego wychodziłoby poza okno dokładnie tak, jak
       wychodziło menu „Udostępnij". */
    const EDGE = 8;
    const box2 = box.getBoundingClientRect();
    const room = document.documentElement.clientWidth;
    if (box2.left < EDGE) box.style.transform = `translateX(${Math.round(EDGE - box2.left)}px)`;
    else if (box2.right > room - EDGE)
      box.style.transform = `translateX(${Math.round(room - EDGE - box2.right)}px)`;

    return new Promise((decide) => {
      let done = false;
      function finish(answer) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("mousedown", onOutside, true);
        box.remove();
        host.style.position = had;
        decide(answer);
      }
      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }
      function onOutside(event) {
        if (!box.contains(event.target)) finish(false);
      }
      box.addEventListener("click", (event) => {
        const answer = event.target.closest("[data-ask-answer]")?.dataset.askAnswer;
        if (answer) finish(answer === "yes");
      });
      document.addEventListener("keydown", onKey, true);
      /* O jedną kolejkę później: bez tego kliknięcie, KTÓRE WŁAŚNIE otworzyło
         to pytanie, dobiegłoby tu jako „kliknięcie na zewnątrz" i zamknęło
         je w tej samej klatce. */
      setTimeout(() => document.addEventListener("mousedown", onOutside, true), 0);
      /* Kursor siada na „Zostaw", nie na „Skasuj": Enter naciśnięty
         odruchowo ma nie kasować niczego. */
      box.querySelector('[data-ask-answer="no"]')?.focus();
    });
  }

  window.CribroAsk = { danger };
})();
