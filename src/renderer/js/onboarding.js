"use strict";

/**
 * Przewodnik — osiem slajdów o tym, co ta aplikacja właściwie robi.
 *
 * Cribro nie tłumaczy się samo i to nie jest wada interfejsu, tylko skutek
 * tego, czym jest: wszystko dzieje się POZA oknem. Skrót działa w cudzej
 * aplikacji, znaczek pływa nad wszystkim, przesiany tekst ląduje pod
 * kursorem gdzie indziej. Kto otworzy okno po pierwszym uruchomieniu,
 * widzi pustą listę przesianych wypowiedzi i nie ma z czego wywnioskować,
 * że trzeba przytrzymać dwa klawisze i zacząć mówić.
 *
 * TRZY RZECZY, KTÓRE WARTO WIEDZIEĆ, ZANIM SIĘ TO CZYTA:
 *
 *   1. RYSUNKI SĄ RUCHOME, bo funkcje są ruchem. Przytrzymanie klawiszy,
 *      przesypywanie się przez sito, rozkładanie tacy, zaznaczanie
 *      prostokąta na ekranie — nieruchomy obrazek każdej z tych rzeczy
 *      musi być opisany słowami, a opis czyta się dłużej, niż trwa gest.
 *      Same animacje siedzą w css/onboarding.css; tutaj są kształty.
 *
 *   2. TREŚĆ JEST PŁASKIM TEKSTEM, bez znaczników w środku zdania.
 *      Tłumaczenie interfejsu chodzi po węzłach tekstowych (patrz
 *      js/i18n.js), więc akapit rozbity na `<b>` i `<kbd>` rozpadłby się
 *      na kilka kluczy, z których każdy trzeba by tłumaczyć osobno —
 *      i żaden nie byłby zdaniem.
 *
 *   3. PRZEWODNIK POKAZUJE SIĘ RAZ SAM, a potem wyłącznie na żądanie.
 *      Zapamiętane jest samo „pokazał się" (tutorial.seen w ustawieniach),
 *      nie „obejrzany do końca": kto zamknął go na drugim slajdzie, też
 *      podjął decyzję. Wraca się do niego przyciskiem na dole paska
 *      bocznego, który stoi tam zawsze.
 */

(function () {
  const api = window.cribro;
  const $ = (selector) => document.querySelector(selector);

  /* ── Rysunki ────────────────────────────────────────────────────
     Każda scena to jeden SVG w tym samym układzie 320×200. Klasy `gart-*`
     niosą wygląd i ruch (css/onboarding.css), a tutaj zostaje geometria:
     co gdzie stoi i w jakiej kolejności rusza. */

  /** Ziarna sypiące się na sito — te, które przechodzą, i te, które nie. */
  const grains = () => {
    const drop = [
      { x: 128, delay: 0, through: true },
      { x: 146, delay: 0.35, through: false },
      { x: 160, delay: 0.7, through: true },
      { x: 176, delay: 0.2, through: false },
      { x: 192, delay: 0.55, through: true },
      { x: 138, delay: 0.9, through: false },
    ];
    return drop
      .map(
        ({ x, delay, through }) => `
        <circle cx="${x}" cy="96" r="3.6"
                class="${through ? "gart-fill" : "gart-dim"} gart-grain${through ? " gart-grain--through" : ""}"
                style="animation-delay: ${delay}s" />`,
      )
      .join("");
  };

  const ART = {
    /* 1. Sito. Cała aplikacja w jednym rysunku, więc stoi jako pierwsza. */
    sieve: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <g class="gart-sieve-ring">
          <circle cx="160" cy="96" r="46" class="gart-accent" opacity=".6" />
          <path d="M116 82h88M116 96h88M116 110h88" class="gart-accent" stroke-width="1.1" opacity=".3" />
          <path d="M138 53v86M160 50v92M182 53v86" class="gart-accent" stroke-width="1.1" opacity=".3" />
        </g>
        ${grains()}
        <path d="M96 168h128" class="gart-edge" opacity=".5" />
      </svg>`,

    /* 2. Skrót. Klawisze, głos, tekst — w tej kolejności i tylko w tej. */
    hotkey: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <g class="gart-key" style="animation-delay: 0s">
          <rect x="70" y="46" width="46" height="40" rx="11" class="gart-plate" />
          <text x="93" y="72" text-anchor="middle" class="gart-text" font-size="18">⌃</text>
        </g>
        <g class="gart-key" style="animation-delay: 0.06s">
          <rect x="126" y="46" width="46" height="40" rx="11" class="gart-plate" />
          <text x="149" y="72" text-anchor="middle" class="gart-text" font-size="18">⌥</text>
        </g>
        <g class="gart-wave">
          <rect x="196" y="52" width="4" height="28" rx="2" class="gart-rec" style="animation-delay: 0s" />
          <rect x="206" y="44" width="4" height="44" rx="2" class="gart-rec" style="animation-delay: 0.09s" />
          <rect x="216" y="50" width="4" height="32" rx="2" class="gart-rec" style="animation-delay: 0.18s" />
          <rect x="226" y="40" width="4" height="52" rx="2" class="gart-rec" style="animation-delay: 0.27s" />
          <rect x="236" y="54" width="4" height="24" rx="2" class="gart-rec" style="animation-delay: 0.36s" />
        </g>
        <rect x="70" y="122" width="180" height="34" rx="10" class="gart-plate" />
        <g class="gart-typed">
          <rect x="82" y="132" width="102" height="5" rx="2.5" class="gart-fill" opacity=".85" />
          <rect x="82" y="143" width="58" height="5" rx="2.5" class="gart-fill" opacity=".45" />
        </g>
      </svg>`,

    /* 3. Gęstość. Trzy słupki i wypowiedź, która gubi kolejne kawałki. */
    mesh: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <g transform="translate(58 60)">
          <rect x="0" y="30" width="12" height="26" rx="6" class="gart-fill gart-step" />
          <rect x="20" y="14" width="12" height="42" rx="6" class="gart-fill gart-step gart-step--2" />
          <rect x="40" y="0" width="12" height="56" rx="6" class="gart-fill gart-step gart-step--3" />
        </g>
        <g transform="translate(140 56)">
          <rect x="0" y="0" width="122" height="6" rx="3" class="gart-dim" opacity=".75" />
          <rect x="0" y="16" width="96" height="6" rx="3" class="gart-dim gart-shed" opacity=".75" />
          <rect x="0" y="32" width="112" height="6" rx="3" class="gart-dim" opacity=".75" />
          <rect x="0" y="48" width="74" height="6" rx="3" class="gart-dim gart-shed gart-shed--3" opacity=".75" />
          <rect x="0" y="64" width="104" height="6" rx="3" class="gart-fill" opacity=".8" />
          <rect x="0" y="80" width="64" height="6" rx="3" class="gart-fill" opacity=".8" />
        </g>
      </svg>`,

    /* 4. Polecenie. Fraza gaśnie, a z wypowiedzi robi się kształt maila. */
    command: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <g class="gart-phrase" transform="translate(56 34)">
          <rect x="0" y="0" width="132" height="24" rx="12" class="gart-plate" />
          <text x="14" y="16" class="gart-text gart-text--accent" font-size="11">zrób z tego maila</text>
        </g>
        <rect x="56" y="66" width="208" height="104" rx="14" class="gart-accent gart-frame"
              opacity=".55" stroke-width="1.4" />
        <g transform="translate(76 88)">
          <rect x="0" y="0" width="52" height="6" rx="3" class="gart-fill gart-row"
                style="animation-delay: 0s" opacity=".85" />
          <rect x="0" y="20" width="164" height="5" rx="2.5" class="gart-dim gart-row"
                style="animation-delay: 0.09s" opacity=".8" />
          <rect x="0" y="33" width="140" height="5" rx="2.5" class="gart-dim gart-row"
                style="animation-delay: 0.16s" opacity=".8" />
          <rect x="0" y="56" width="68" height="6" rx="3" class="gart-fill gart-row"
                style="animation-delay: 0.24s" opacity=".55" />
        </g>
      </svg>`,

    /* 5. Notatki. Kartka, na której odhacza się zadanie i dopisuje linijka. */
    notes: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <rect x="72" y="28" width="176" height="146" rx="16" class="gart-plate" />
        <rect x="92" y="48" width="86" height="7" rx="3.5" class="gart-fill" opacity=".85" />
        <g transform="translate(92 76)">
          <rect x="0" y="0" width="15" height="15" rx="5" class="gart-accent" stroke-width="1.5" />
          <path d="M3.6 7.6 6.6 10.6 12 4.6" class="gart-accent gart-check" stroke-width="2" />
          <rect x="26" y="4" width="96" height="6" rx="3" class="gart-dim" opacity=".35" />
          <path d="M26 7h96" class="gart-line gart-strike" opacity=".85" />
        </g>
        <g transform="translate(92 104)">
          <rect x="0" y="0" width="15" height="15" rx="5" class="gart-edge" stroke-width="1.5" />
          <rect x="26" y="4" width="76" height="6" rx="3" class="gart-dim" opacity=".7" />
        </g>
        <g transform="translate(92 132)">
          <rect x="0" y="0" width="15" height="15" rx="5" class="gart-edge" stroke-width="1.5" />
          <rect x="26" y="4" width="108" height="6" rx="3" class="gart-fill gart-new-line" opacity=".7" />
        </g>
      </svg>`,

    /* 6. Widget. Ten sam ruch i to samo tempo co w prawdziwej tacy —
       slajd ma uczyć gestu, a nie pokazywać inny. */
    widget: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <circle cx="160" cy="56" r="30" class="gart-accent gart-halo" opacity=".5" stroke-width="1.2" />
        <circle cx="160" cy="56" r="22" class="gart-plate" />
        <circle cx="160" cy="56" r="13" class="gart-accent" stroke-width="1.4" opacity=".8" />
        <path d="M147 52h26M147 60h26M156 44v24M164 44v24" class="gart-accent" stroke-width=".9" opacity=".45" />
        <g class="gart-slot" style="animation-delay: 0.02s">
          <circle cx="160" cy="98" r="13" class="gart-fill" opacity=".9" />
        </g>
        <g class="gart-slot" style="animation-delay: 0.08s">
          <circle cx="160" cy="128" r="13" class="gart-plate" />
        </g>
        <g class="gart-slot" style="animation-delay: 0.14s">
          <circle cx="160" cy="158" r="13" class="gart-plate" />
        </g>
        <g class="gart-slot" style="animation-delay: 0.2s">
          <circle cx="118" cy="56" r="13" class="gart-plate" />
        </g>
        <g class="gart-cursor">
          <path d="M186 74l0 20 5-5 4 8 4-2-4-8 7 0z" class="gart-pointer" opacity=".85" />
        </g>
      </svg>`,

    /* 7. Tekst z ekranu. Prostokąt obiega kawałek cudzego okna, a to, co
       w środku, robi się czytelnym tekstem. */
    shot: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <rect x="52" y="28" width="216" height="144" rx="14" class="gart-edge" opacity=".6" />
        <path d="M52 50h216" class="gart-edge" opacity=".6" />
        <g class="gart-blur-line">
          <rect x="70" y="66" width="120" height="7" rx="3.5" class="gart-dim" />
          <rect x="70" y="82" width="164" height="7" rx="3.5" class="gart-dim" />
          <rect x="70" y="98" width="98" height="7" rx="3.5" class="gart-dim" />
          <rect x="70" y="126" width="140" height="7" rx="3.5" class="gart-dim" />
          <rect x="70" y="142" width="86" height="7" rx="3.5" class="gart-dim" />
        </g>
        <rect x="62" y="58" width="184" height="56" rx="8" class="gart-accent gart-marquee"
              stroke-width="1.4" />
        <g transform="translate(70 126)">
          <rect x="0" y="0" width="140" height="7" rx="3.5" class="gart-fill gart-read"
                style="animation-delay: 0s" opacity=".85" />
          <rect x="0" y="16" width="86" height="7" rx="3.5" class="gart-fill gart-read"
                style="animation-delay: 0.1s" opacity=".85" />
        </g>
      </svg>`,

    /* 8. Klucz. Jedyna rzecz, bez której nic nie ruszy. */
    key: `
      <svg viewBox="40 12 240 164" aria-hidden="true">
        <g class="gart-spark">
          <circle cx="196" cy="100" r="46" class="gart-accent" opacity=".3" stroke-width="1.2" />
          <circle cx="196" cy="100" r="62" class="gart-accent" opacity=".14" stroke-width="1.2" />
        </g>
        <circle cx="196" cy="100" r="30" class="gart-plate" />
        <circle cx="196" cy="100" r="10" class="gart-accent" stroke-width="1.6" />
        <path d="M196 110v16" class="gart-accent" stroke-width="1.6" />
        <g class="gart-key-turn">
          <circle cx="98" cy="100" r="15" class="gart-accent" stroke-width="2" />
          <path d="M113 100h48M150 100v11M160 100v8" class="gart-accent" stroke-width="2" />
        </g>
      </svg>`,
  };

  /* ── Slajdy ─────────────────────────────────────────────────────
     Kolejność jest drogą, którą przechodzi każdy nowy użytkownik: najpierw
     co to w ogóle jest, potem gest, którym się to robi, potem pokrętło,
     potem rzeczy, po które sięga się później. Klucz jest na końcu, bo
     bez pozostałych slajdów nie wiadomo, po co go wpisywać. */

  const SLIDES = [
    {
      label: "Sito",
      title: "Mów swobodnie. Zostaje esencja.",
      body: "Cribro Sift zamienia mówienie w tekst i przepuszcza go przez sito: znikają wahania, zająknięcia, powtórzenia i fałszywe starty. Zostaje to, co chciałeś powiedzieć — a nie zapis tego, jak się mówiło.",
      art: "sieve",
    },
    {
      label: "Skrót",
      title: "Trzymaj ⌃⌥ i mów",
      body: "Puszczasz klawisze — sito pracuje, a przesiany tekst ląduje pod kursorem w aplikacji, w której właśnie jesteś. Nie chcesz trzymać? Stuknij te same klawisze dwa razy, a nagrywanie zostaje włączone; kolejne stuknięcie je kończy. Escape kasuje nagranie bez śladu.",
      art: "hotkey",
    },
    {
      label: "Gęstość",
      title: "Jedno pokrętło: jak gęsto przesiewać",
      body: "Zgrubne zostawia prawie wszystko i usuwa same zacięcia. Średnie daje czystą wypowiedź twoim głosem. Drobne przepisuje ją zwięźle i formalnie, gotową do wysłania. Przestawisz je w zakładce Sito, w pasku menu i na tacy widgetu.",
      art: "mesh",
    },
    {
      label: "Polecenia",
      title: "Powiedz, czym ma być ten tekst",
      body: "„Zrób z tego maila”, „zrób z tego listę” — fraza rzucona na początku albo na końcu wypowiedzi przestawia sito na to jedno dyktowanie i sama znika z wyniku. Polecenia są twoje: dopisujesz własne frazy i własne reguły w zakładce Polecenia.",
      art: "command",
    },
    {
      label: "Notatki",
      title: "Notatki, do których się mówi",
      body: "Notatnik z listą po lewej i notatką po prawej, szybka notatka w jednym małym oknie, dyktowanie prosto do otwartej notatki. Listy zadań, nagłówki i cytaty są tam, gdzie się ich szuka, a wszystko zapisuje się samo.",
      art: "notes",
    },
    {
      label: "Widget",
      title: "Znaczek nad wszystkim",
      body: "Pływające kółko, które nie znika, gdy przełączasz okna. Najechanie kursorem rozkłada tacę: dyktowanie, szybka notatka, gęstość sita, język i okno aplikacji. Kliknięcie otwiera notatki odłożone „na wierzch” — listę przy znaczku albo karteczki rozłożone na pulpicie.",
      art: "widget",
    },
    {
      label: "Ekran",
      title: "Tekst, którego nie da się zaznaczyć",
      body: "Cudzy PDF, slajd z prezentacji, zrzut z rozmowy. Zaznaczasz kawałek ekranu, a to, co na nim widać, staje się notatką. Model tutaj wyłącznie czyta: nie poprawia literówek i nie odpowiada na to, co przeczytał.",
      art: "shot",
    },
    {
      label: "Start",
      title: "Zostaje jedno: klucz",
      body: "Sito i transkrypcja korzystają z modelu, więc potrzebują twojego klucza — wpisujesz go raz w Ustawieniach. Do przewodnika wracasz zawsze przyciskiem na dole paska po lewej.",
      art: "key",
      cta: "Otwórz Ustawienia",
    },
  ];

  /* ── Budowa ─────────────────────────────────────────────────── */

  let at = 0;
  let built = false;

  function build() {
    if (built) return;
    built = true;

    $("#guideStage").innerHTML = SLIDES.map(
      (slide, index) => `
      <article class="guide__slide" data-slide="${index}" data-on="false">
        <div class="guide__art">${ART[slide.art]}</div>
        <div class="guide__say">
          <div class="guide__step">
            <span>${slide.label}</span>
            <span class="guide__count" data-i18n="skip">${index + 1} / ${SLIDES.length}</span>
          </div>
          <h2>${slide.title}</h2>
          <p>${slide.body}</p>
        </div>
      </article>`,
    ).join("");

    $("#guideDots").innerHTML = SLIDES.map(
      (slide, index) =>
        `<button data-go="${index}" aria-current="false" title="${slide.label}"
                 aria-label="${slide.label}"></button>`,
    ).join("");
  }

  function show(index) {
    at = Math.max(0, Math.min(SLIDES.length - 1, index));

    for (const slide of document.querySelectorAll(".guide__slide")) {
      const on = Number(slide.dataset.slide) === at;
      /* Ten jeden atrybut robi trzy rzeczy naraz: pokazuje slajd, wpuszcza
         na niego kliknięcia i URUCHAMIA scenę od pierwszej klatki — patrz
         reguła [data-on="false"] .guide__art * w css/onboarding.css. */
      slide.dataset.on = on ? "true" : "false";
    }
    for (const dot of document.querySelectorAll("#guideDots button")) {
      dot.setAttribute("aria-current", String(Number(dot.dataset.go) === at));
    }

    const last = at === SLIDES.length - 1;
    $("#guidePrev").disabled = at === 0;
    $("#guideNext").textContent = last ? t(SLIDES[at].cta ?? "Zaczynajmy") : t("Dalej");
    $("#guideStage").scrollTop = 0;
  }

  /* ── Otwieranie i zamykanie ─────────────────────────────────────
     „Pokazał się" zapisujemy przy OTWARCIU, nie przy dojściu do końca.
     Kto zamknął przewodnik na drugim slajdzie, też podjął decyzję — a okno,
     które wraca przy każdym starcie, dopóki nie klikniesz go do końca,
     jest natrętne, a nie pomocne. */

  function open(from = 0) {
    build();
    $("#guide").hidden = false;
    $("#guide").setAttribute("aria-hidden", "false");
    show(from);
    translateTree($("#guide"));
    $("#guideNext").focus();
    void api.settings.save({ tutorial: { seen: true } });
  }

  function close() {
    $("#guide").hidden = true;
    $("#guide").setAttribute("aria-hidden", "true");
  }

  const isOpen = () => !$("#guide").hidden;

  /* ── Sterowanie ─────────────────────────────────────────────── */

  $("#guide").addEventListener("click", (event) => {
    // Kliknięcie w tło zamyka — tak samo jak każde okno tego rodzaju.
    if (event.target.id === "guide") return close();
    if (event.target.closest("#guideClose")) return close();
    if (event.target.closest("#guidePrev")) return show(at - 1);

    const dot = event.target.closest("#guideDots button");
    if (dot) return show(Number(dot.dataset.go));

    if (event.target.closest("#guideNext")) {
      if (at < SLIDES.length - 1) return show(at + 1);
      close();
      // Ostatni slajd prowadzi tam, gdzie wpisuje się klucz — bo bez niego
      // wszystko, co przed chwilą pokazaliśmy, nie ma czym pracować.
      // Tą samą drogą co kliknięcie w pasku bocznym — widok przełącza się
      // wtedy dokładnie tak, jak przełącza się go ręką.
      if (SLIDES[at].cta) document.querySelector('#nav [data-view="settings"]')?.click();
    }
  });

  /* Strzałki przewracają slajdy, Escape zamyka. Nasłuch idzie w fazie
     PRZECHWYTYWANIA i zabiera zdarzenie reszcie okna: Escape ma tu zamknąć
     przewodnik, a nie schować całe okno do paska menu (patrz nasłuch
     Escape w js/app.js, który sprawdza defaultPrevented). */
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return close();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        return show(at + 1);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        return show(at - 1);
      }
    },
    true,
  );

  window.CribroGuide = { open, close, isOpen };
})();
