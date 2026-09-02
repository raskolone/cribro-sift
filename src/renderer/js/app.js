/* Cribro Sift — okno główne.
   Jedna zasada w całym interfejsie: pokazuj wynik, nie proces.
   Szczegóły (surowy transkrypt, czasy, model) czekają schowane,
   aż ktoś ich naprawdę zażąda. */

const api = window.cribro;

const MESH = {
  zgrubne: { name: "Zgrubne", hint: "Zostaje prawie wszystko. Znikają tylko zacięcia.", density: 5 },
  srednie: { name: "Średnie", hint: "Czysta wypowiedź, twój głos.", density: 8 },
  drobne: { name: "Drobne", hint: "Zwięźle i formalnie. Gotowe do wysłania.", density: 13 },
};

const VIEWS = {
  start: { title: "Start", subtitle: "Cztery kroki do pierwszego dyktowania — i wszystko, co już przesiane." },
  notes: {
    title: "Notatki",
    subtitle: "Lista po lewej, notatka po prawej. Podwójne kliknięcie otwiera ją w osobnym okienku.",
  },
  meetings: {
    title: "Meeting Notes",
    subtitle: "Zapis rozmowy i wniosek z niej. Spis po lewej, spotkanie po prawej.",
  },
  sieve: { title: "Funkcja sita", subtitle: "Jedno pokrętło: jak gęsto przesiewać." },
  grains: { title: "Ziarna", subtitle: "Słowa, których sito nigdy nie tknie." },
  commands: { title: "Polecenia", subtitle: "Zdania, po których sito wie, co zrobić." },
  settings: { title: "Ustawienia", subtitle: "Skróty, dostawcy, prywatność." },
  admin: {
    title: "Panel admina",
    subtitle: "Kto się zarejestrował i co widzi. Na czas wdrażania.",
  },
};

const KEY_GLYPH = { Alt: "⌥", Ctrl: "⌃", Shift: "⇧", Meta: "⌘", Space: "␣" };

const state = {
  view: "start",
  settings: null,
  history: [],
  stats: null,
  status: { backend: "none", accessibility: true, microphone: "granted" },
  query: "",
  /* Różnica surowe→przesiane pokazuje się DOMYŚLNIE, przy każdym wpisie —
     to jest sedno tego, co ta zakładka pokazuje, więc nie ma po co chować
     go za kliknięciem. Zbiór trzyma więc WYJĄTKI: identyfikatory wpisów,
     które ktoś świadomie zwinął. Puste znaczy „wszystko rozwinięte". */
  collapsedDiffs: new Set(),
  runtime: "idle",
  error: null,
  providers: { stt: {}, sieve: {}, shot: {} },
  tests: {}, // wynik ostatniego sprawdzenia każdego silnika
  conflicts: null, // wynik ostatniego sprawdzenia konfliktów skrótów
  cloud: { configured: false, signedIn: false, enabled: false, autoSync: true },
  /* Adres i hasło żyją poza `settings`, bo nie są ustawieniem — są
     wpisywane raz, po to żeby zaraz zniknąć. Trzymamy je tu wyłącznie
     dlatego, że widok przerysowuje się w całości i inaczej kasowałby
     wpisany tekst w połowie logowania. */
  cloudForm: { email: "", password: "" },
  /* Adresy powrotne do wpisania w panelu Supabase. Liczy je proces główny
     — tutaj tylko leżą, bo karta konta musi je pokazać. */
  redirects: [],
  /* Wynik ostatniego „Sprawdź połączenie" z kartą Notion. Poza `settings`,
     bo to nie jest ustawienie — to odpowiedź na pytanie zadane przed
     chwilą i znika razem z oknem. */
  notionCheck: null,
  /* Stan poranka: konto, właściciel, czy konto się z nim zgadza. Poza
     `settings`, bo to nie jest ustawienie — to odpowiedź procesu głównego
     na pytanie „co teraz z tym kontem". */
  briefing: null,
  /* Polecenie w trakcie edycji — kopia, nie oryginał. Widok przerysowuje się
     w całości, więc wpisywany tekst musi mieć gdzie przeczekać; ta sama
     sztuczka co przy formularzu konta. `null` znaczy „nikt nic nie edytuje". */
  commandDraft: null,
  /* Pole próby i jej wynik. Próba nie jest ustawieniem — jest odpowiedzią
     na pytanie zadane przed chwilą i znika razem z oknem. */
  probeText: "",
  probe: null,
  /* Nasłuch klawiszy. Poza `settings`, bo to nie jest ustawienie, tylko
     chwila między kliknięciem „Ustaw klawisze" a naciśnięciem ich — jak
     formularz konta i próba polecenia.

     Trzyma ŚCIEŻKĘ ustawienia, do którego łapiemy, a nie samo „tak/nie":
     skrótów wybieranych ręką jest więcej niż jeden i muszą się nawzajem
     wypychać. Dwa nasłuchy naraz zapisałyby te same klawisze w dwóch
     miejscach — a raz ustawiony skrót nie ma prawa zależeć od tego, który
     przycisk kliknięto pierwszy. */
  keysFor: null,
};

/* ── Pomocnicze ───────────────────────────────────────────────── */

const $ = (selector) => document.querySelector(selector);
const escape = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
  if (minutes < 1) return t("przed chwilą");
  if (minutes < 60) return t("{n} min temu", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("{n} godz. temu", { n: hours });
  return new Date(iso).toLocaleDateString(uiLocale(), { day: "numeric", month: "short" });
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("in");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("in"), 2200);
}

/* Kolory rysunku pochodzą z tokenów, nie z JS — motyw ma jedno źródło prawdy. */
const ACCENT = themeRgb("--accent");
const QUIET = themeRgb("--text-mute");

/** Sito jako rysunek: im gęstsza siatka, tym mniej przechodzi. */
function drawMesh(canvas, density, active) {
  const size = canvas.width;
  const ctx = canvas.getContext("2d");
  const r = size / 2 - 2;
  ctx.clearRect(0, 0, size, size);

  ctx.strokeStyle = active ? `rgba(${ACCENT}, 0.75)` : `rgba(${QUIET}, 0.45)`;
  ctx.lineWidth = size / 40;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = active ? `rgba(${ACCENT}, 0.4)` : `rgba(${QUIET}, 0.22)`;
  ctx.lineWidth = size / 70;
  const step = (r * 2) / density;
  for (let i = 1; i < density; i++) {
    const offset = -r + step * i;
    const half = Math.sqrt(Math.max(0, r * r - offset * offset));
    ctx.beginPath();
    ctx.moveTo(size / 2 - half, size / 2 + offset);
    ctx.lineTo(size / 2 + half, size / 2 + offset);
    ctx.moveTo(size / 2 + offset, size / 2 - half);
    ctx.lineTo(size / 2 + offset, size / 2 + half);
    ctx.stroke();
  }
}

function mountCanvases(root) {
  root.querySelectorAll("canvas[data-density]").forEach((canvas) => {
    const scale = window.devicePixelRatio || 2;
    const css = parseFloat(getComputedStyle(canvas).width) || 52;
    canvas.width = css * scale;
    canvas.height = css * scale;
    drawMesh(canvas, Number(canvas.dataset.density), canvas.dataset.active === "true");
  });
}

/* ── Widok: Start ─────────────────────────────────────────────── */

function chip(ok, okText, badText) {
  return `<span class="pill ${ok ? "pill--mint" : "pill--amber"}">${ok ? okText : badText}</span>`;
}

/**
 * Start i dawne Przesiane w jednym widoku.
 *
 * Były dwiema osobnymi zakładkami, a mówiły w gruncie rzeczy o jednym: co
 * ta aplikacja dla ciebie zrobiła. Cztery kroki pierwszego uruchomienia są
 * na górze razem ze statystykami — to jest właściwe miejsce na pierwszy
 * rzut oka, PRZED kreską — a spis wszystkiego, co kiedykolwiek przesiano,
 * rośnie pod kreską, tak jak rosło w dawnym „Przesianym". Różnica surowe →
 * przesiane pokazuje się przy każdym wpisie od razu (patrz collapsedDiffs
 * w state) — to jest sedno tego, co tu widać, a nie coś do odkrycia
 * dopiero po kliknięciu.
 */
function renderStart() {
  const { settings, status, tests, stats } = state;
  const micOk = status.microphone === "granted";
  const axOk = !!status.accessibility;
  /* Klucz może być wpisany w którymkolwiek kroku, jeśli oba chodzą na tym
     samym dostawcy — tak samo, jak rozstrzyga to backend w keyFor().

     Zwykły użytkownik nie widzi tu ani dostawcy, ani klucza (patrz
     main/owner.js), więc odpowiedź „czy jest czym mówić" przychodzi gotowa
     z procesu głównego, jednym polem `enginesReady`. */
  const hasKey = (stage) => {
    if (!settings.owner) return settings.enginesReady !== false;
    const mine = settings[stage];
    const other = settings[stage === "stt" ? "sieve" : "stt"];
    if (mine.provider === "mock") return true;
    return !!mine.apiKey || (other.provider === mine.provider && !!other.apiKey);
  };
  const sttOk = hasKey("stt");
  const sieveOk = hasKey("sieve");
  const last = state.history[0];

  const testLine = (key) => {
    const result = tests[key];
    if (!result) return "";
    return `<div class="setup__result ${result.ok ? "is-ok" : "is-bad"}" data-i18n="skip">${escape(result.note)}</div>`;
  };

  const tiles = [
    { label: "Sesje", value: stats?.sessions ?? 0, note: "przesianych dyktowań" },
    { label: "Słowa zachowane", value: stats?.wordsKept ?? 0, note: "trafiły do schowka" },
    { label: "Szum odsiany", value: stats?.wordsSifted ?? 0, note: "zniknęło po drodze" },
    {
      label: "Czas oddany",
      value: stats?.minutesSaved ?? 0,
      unit: "min",
      note: "wobec pisania na klawiaturze",
    },
  ];

  const query = state.query.trim().toLowerCase();
  const entries = state.history.filter(
    (entry) => !query || entry.text.toLowerCase().includes(query) || (entry.app ?? "").toLowerCase().includes(query),
  );

  $("#view-start").innerHTML = `
    <!-- Statystyki na samej górze, ZAWSZE w jednym wierszu — cztery kafle,
         cztery kolumny (repeat(4, 1fr), nie auto-fit): mają się ściskać
         i rosnąć razem z oknem, nie łamać do dwóch rzędów. Patrz .tiles
         w css/app.css po powód, dla którego to jest osobna reguła niż
         w reszcie aplikacji. -->
    <div class="tiles tiles--one-line tiles--glow">
      ${tiles
        .map(
          (tile) => `
        <div class="tile">
          <div class="label">${escape(tile.label)}</div>
          <div class="tile__value">${tile.value}${tile.unit ? `<small>${tile.unit}</small>` : ""}</div>
          <div class="tile__note">${escape(tile.note)}</div>
        </div>`,
        )
        .join("")}
    </div>

    <div class="card">
      <h2>Pierwsze dyktowanie</h2>
      <p class="sub">Cztery kroki. Potem już tylko trzymasz dwa klawisze i mówisz.</p>

      <ol class="setup">
        <li class="setup__row" data-done="${micOk}">
          <span class="setup__num">1</span>
          <div class="setup__body">
            <strong>Mikrofon</strong>
            <span>macOS zapyta raz. Bez zgody nie usłyszymy nic.</span>
          </div>
          <div class="setup__act">
            ${chip(micOk, "Przyznany", "Brakuje")}
            ${micOk ? "" : `<button class="btn btn--sm" data-act="perm-microphone">Poproś</button>`}
          </div>
        </li>

        <li class="setup__row" data-done="${axOk}">
          <span class="setup__num">2</span>
          <div class="setup__body">
            <strong>Dostępność <em>(opcjonalnie)</em></strong>
            <span>
              Potrzebna do skrótu ⌃+⌥ i wklejania pod kursor.
              Bez niej nagrywasz przyciskiem, a tekst ląduje w schowku.
            </span>
          </div>
          <div class="setup__act">
            ${chip(axOk, "Przyznana", "Pominięta")}
            ${axOk ? "" : `<button class="btn btn--sm" data-act="perm-accessibility">Otwórz</button>`}
          </div>
        </li>

        ${
          /* Krok trzeci wygląda inaczej u właściciela i inaczej u wszystkich
             pozostałych. Właściciel widzi, co jest pod spodem, i ma czym to
             sprawdzić. Reszta widzi odpowiedź na jedyne pytanie, jakie
             naprawdę zadaje: czy to działa. Nazwy modeli nie ma tu wcale —
             aplikacja obiecuje wynik, a nie markę (patrz main/owner.js). */
          settings.owner
            ? `<li class="setup__row" data-done="${sttOk && sieveOk}">
                 <span class="setup__num">3</span>
                 <div class="setup__body">
                   <strong>Silniki</strong>
                   <span>
                     Transkrypcja: <b>${escape(settings.stt.model)}</b> ·
                     sito: <b>${escape(settings.sieve.model)}</b>.
                     ${sttOk && sieveOk ? "Klucze na miejscu." : "Klucze wpiszesz w Ustawieniach."}
                   </span>
                   ${testLine("stt")}
                   ${testLine("sieve")}
                 </div>
                 <div class="setup__act">
                   <button class="btn btn--sm" data-act="test-stt">Sprawdź transkrypcję</button>
                   <button class="btn btn--sm" data-act="test-sieve">Sprawdź sito</button>
                 </div>
               </li>`
            : `<li class="setup__row" data-done="${sttOk && sieveOk}">
                 <span class="setup__num">3</span>
                 <div class="setup__body">
                   <strong>Sito</strong>
                   <span>
                     ${
                       sttOk && sieveOk
                         ? "Gotowe — transkrypcja i sito działają od pierwszego dyktowania. Nie ma tu czego ustawiać."
                         : "Sito milczy — sprawdź połączenie z siecią i spróbuj jeszcze raz."
                     }
                   </span>
                 </div>
                 <div class="setup__act">${chip(sttOk && sieveOk, "Gotowe", "Milczy")}</div>
               </li>`
        }

        <li class="setup__row" data-done="${!!last}">
          <span class="setup__num">4</span>
          <div class="setup__body">
            <strong>Powiedz coś</strong>
            <span>
              Naciśnij, mów przez kilka sekund i naciśnij ponownie.
              Tekst wyląduje w schowku${settings.autoPaste ? " i pod kursorem" : ""}.
            </span>
          </div>
          <div class="setup__act">
            <!-- Ta sama akcja co „Dyktuj" na górze, więc drugoplanowa: pełny akcent
                 należy się jednej akcji na ekranie, nie dwóm. -->
            <button class="btn ${state.runtime === "listening" ? "btn--amber" : ""}" data-act="capture">
              ${state.runtime === "listening" ? "Zatrzymaj i przesiej" : "Nagraj teraz"}
            </button>
          </div>
        </li>
      </ol>
    </div>

    ${
      last
        ? `<div class="card">
             <h2>Ostatni wynik</h2>
             <p class="sub">
               ${escape(timeAgo(last.at))} · ${t("{n} słów na wejściu, {out} na wyjściu", {
                 n: last.rawWords ?? 0,
                 out: last.siftedWords ?? 0,
               })}${last.timings?.total ? ` · ${(last.timings.total / 1000).toFixed(1)} s` : ""}
             </p>
             <div class="entry__text" data-i18n="skip">${escape(last.text)}</div>
             ${last.raw ? renderDiff(last) : ""}
           </div>`
        : ""
    }

    <!-- Kreska NA DOLE tego, co było dawną zakładką „Start" — od tego
         miejsca w dół zaczyna się dawne „Przesiane": cały zapis, ze
         wszystkim, co kiedykolwiek przesiano. -->
    <div class="section-head">
      <span class="label">Zapis</span>
      <hr />
      <div class="search">
        <svg><use href="#i-search" /></svg>
        <input type="text" id="search" placeholder="Szukaj w przesianych…" value="${escape(state.query)}" />
      </div>
      <button class="btn btn--ghost btn--sm" id="clearHistory">Wyczyść</button>
    </div>

    ${
      entries.length
        ? `<div class="entries">${entries.map(renderEntry).join("")}</div>`
        : `<div class="empty">
             <canvas data-density="9" style="width:96px;height:96px"></canvas>
             <h3>${state.history.length ? "Nic nie pasuje" : "Sito jest puste"}</h3>
             <p>${
               state.history.length
                 ? "Spróbuj innego słowa."
                 : "Przytrzymaj skrót, powiedz, co masz do powiedzenia, i puść. Reszta dzieje się sama."
             }</p>
           </div>`
    }`;

  mountCanvases($("#view-start"));
}

function renderEntry(entry) {
  const open = !state.collapsedDiffs.has(entry.id);
  const mesh = MESH[entry.mesh]?.name ?? entry.mesh;
  const removed = Math.max(0, (entry.rawWords ?? 0) - (entry.siftedWords ?? 0));
  const seconds = entry.timings?.total ? `${(entry.timings.total / 1000).toFixed(1)}s` : null;

  return `
    <article class="entry" data-id="${entry.id}" data-pinned="${!!entry.pinned}">
      <div class="entry__meta">
        <span>${escape(timeAgo(entry.at))}</span>
        ${entry.app ? `<span class="dot">·</span><span>${escape(entry.app)}</span>` : ""}
        <span class="dot">·</span><span>${t("Sito {mesh}", { mesh: escape(mesh) })}</span>
        ${removed ? `<span class="dot">·</span><span>${t("−{n} słów", { n: removed })}</span>` : ""}
        ${seconds ? `<span class="dot">·</span><span>${seconds}</span>` : ""}
        ${
          entry.command
            ? `<span class="dot">·</span><span class="pill pill--amber" style="padding:2px 8px" data-i18n="skip">${escape(entry.command.name)}</span>`
            : ""
        }
        ${entry.pinned ? `<span class="pill pill--mint" style="padding:2px 8px">Przypięte</span>` : ""}
      </div>

      <div class="entry__text">${escape(entry.text)}</div>

      ${open && entry.raw ? renderDiff(entry) : ""}

      <div class="entry__actions">
        <button class="btn btn--ghost btn--sm" data-act="copy">Kopiuj</button>
        ${
          entry.raw
            ? `<button class="btn btn--ghost btn--sm" data-act="toggle">${open ? "Ukryj różnicę" : "Co odpadło"}</button>`
            : ""
        }
        <button class="btn btn--ghost btn--sm" data-act="resift">Przesiej ponownie</button>
        ${
          entry.command && entry.raw
            ? `<button class="btn btn--ghost btn--sm" data-act="unsift">Bez polecenia</button>`
            : ""
        }
        <span class="spacer"></span>
        <button class="btn btn--ghost btn--sm" data-act="pin">${entry.pinned ? "Odepnij" : "Przypnij"}</button>
        <button class="btn btn--ghost btn--sm" data-act="delete">Usuń</button>
      </div>
    </article>`;
}

function renderDiff(entry) {
  const parts = window.diffWords(entry.raw, entry.text);
  const body = parts
    .map((part) => `<span class="${part.type}">${escape(part.text)}</span>`)
    .join("");
  return `
    <div class="sifted-out" data-i18n="skip">
      ${body}
      <div class="sifted-out__legend">
        <span><span style="color:var(--text)">▪</span> zostało</span>
        <span><span style="color:var(--danger)">▪</span> odsiane</span>
        <span><span style="color:var(--accent)">▪</span> poprawione</span>
      </div>
    </div>`;
}

/* ── Widok: Sito ──────────────────────────────────────────────── */

/* Katalog języków dyktowania. Kody są takie same jak w languages.js
   w procesie głównym — tam decydują o prompcie, tu tylko o etykiecie. */
const DICTATION_LANGUAGES = [
  ["pl", "Polski"],
  ["en", "English"],
  ["de", "Deutsch"],
  ["fr", "Français"],
  ["es", "Español"],
  ["it", "Italiano"],
  ["uk", "Українська"],
  ["cs", "Čeština"],
];

const langOptions = (selected) =>
  DICTATION_LANGUAGES.map(
    ([code, label]) => `<option value="${code}" ${selected === code ? "selected" : ""}>${label}</option>`,
  ).join("");

function renderSieve() {
  const { settings } = state;
  const language = settings.language ?? {};
  $("#view-sieve").innerHTML = `
    <div class="card">
      <h2>Gęstość oczek</h2>
      <p class="sub">Im drobniejsze sito, tym mniej przechodzi. Zmienisz to też z paska menu.</p>
      <div class="mesh-grid">
        ${Object.entries(MESH)
          .map(
            ([key, mesh]) => `
          <button class="mesh" role="radio" data-mesh="${key}" aria-checked="${settings.mesh === key}">
            <canvas data-density="${mesh.density}" data-active="${settings.mesh === key}"></canvas>
            <strong>${mesh.name}</strong>
            <span>${mesh.hint}</span>
          </button>`,
          )
          .join("")}
      </div>
    </div>

    <div class="card">
      <h2>Język</h2>
      <p class="sub">
        Dyktowanie dwujęzyczne to nie to samo, co rozpoznawanie automatyczne.
        Automat wybiera jeden język dla całego nagrania; para języków pozwala
        przełączać się w środku zdania.
      </p>
      <div class="field">
        <div class="field__label">
          <strong>Tryb rozpoznawania</strong>
          <span>Przy dwóch językach model wie, że przeplatanie jest zamierzone, i nie tłumaczy wtrąceń w żadną stronę.</span>
        </div>
        <div class="field__control">
          <select data-setting="language.mode">
            ${[
              ["bilingual", "Dwujęzycznie — dwa języki naraz"],
              ["single", "Jeden język"],
              ["auto", "Rozpoznaj automatycznie"],
            ]
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${language.mode === value ? "selected" : ""}>${label}</option>`,
              )
              .join("")}
          </select>
        </div>
      </div>

      ${
        language.mode === "auto"
          ? ""
          : `<div class="field">
        <div class="field__label">
          <strong>Pierwszy język</strong>
          <span>Ten język dostaje dostawca wprost — najmniej miejsca na pomyłkę.</span>
        </div>
        <div class="field__control">
          <select data-setting="language.primary">${langOptions(language.primary)}</select>
        </div>
      </div>`
      }

      ${
        language.mode === "bilingual"
          ? `<div class="field">
        <div class="field__label">
          <strong>Drugi język</strong>
          <span>Drugi język pary. Terminy w nim wypowiedziane zostają w nim, nawet w środku zdania.</span>
        </div>
        <div class="field__control">
          <select data-setting="language.secondary">${langOptions(language.secondary)}</select>
        </div>
      </div>`
          : ""
      }
    </div>

    <div class="card">
      <h2>Własna wytyczna</h2>
      <p class="sub">Jedno zdanie, które sito dostaje przy każdym dyktowaniu. Zostaw puste, jeśli nie masz potrzeby.</p>
      <textarea data-setting="sieve.customInstruction" placeholder="np. Pisz zawsze bezokolicznikami w listach zadań. Nie używaj wykrzykników.">${escape(
        settings.sieve.customInstruction,
      )}</textarea>
    </div>`;

  mountCanvases($("#view-sieve"));
}

/* ── Widok: Ziarna ────────────────────────────────────────────── */

function renderGrains() {
  const grains = state.settings.grains ?? [];
  $("#view-grains").innerHTML = `
    <div class="card">
      <h2>Ziarna</h2>
      <p class="sub">
        Nazwiska, nazwy produktów, żargon. Sito przepuszcza je w niezmienionej formie —
        nawet jeśli transkrypcja usłyszała coś podobnego.
      </p>
      <div class="field" style="border:none;padding-top:4px">
        <div class="field__label" style="flex:none;width:auto">
          <input type="text" id="grainInput" placeholder="Dodaj słowo i wciśnij Enter" style="min-width:280px" />
        </div>
        <button class="btn btn--sm" id="grainAdd">Dodaj</button>
      </div>
      ${
        grains.length
          ? `<div class="grains">${grains
              .map(
                (grain, index) =>
                  `<span class="grain">${escape(grain)}<button data-grain="${index}" title="Usuń">×</button></span>`,
              )
              .join("")}</div>`
          : `<p style="color:var(--text-mute);font-size:var(--fs-xs);margin:14px 0 0">Jeszcze nic tu nie ma.</p>`
      }
    </div>`;
}

/* ── Widok: Polecenia ─────────────────────────────────────────── */

/* Dokąd trafia wynik. Kolejność jest kolejnością rozwijanej listy: od tego,
   co dzieje się zawsze, po to, co zabiera tekst sprzed oczu. */
const OUTLETS = {
  cursor: ["Pod kursor", "Tak jak zwykle: wklejenie w aktywnej aplikacji i schowek."],
  note: ["Do notatki", "Dopisuje do notatki, do której dyktujesz. Spod kursora — zakłada nową."],
  "new-note": ["Nowa notatka", "Zawsze zakłada osobną notatkę i tam odkłada tekst."],
  clipboard: ["Tylko schowek", "Nic się nigdzie nie wkleja."],
};

const PLACES = {
  edge: "Na początku albo na końcu",
  start: "Tylko na początku",
  end: "Tylko na końcu",
};

/* Komendy, które sito zna z urodzenia — siedzą w jego kontrakcie i nie da
   się ich zmienić. Do tej pory nie było ich nigdzie widać, a przecież
   działają przy każdym dyktowaniu; karta poleceń jest ich pierwszym
   miejscem w interfejsie. */
const INLINE_COMMANDS = [
  ["nowy akapit", "pusta linia"],
  ["nowa linia", "złamanie wiersza"],
  ["punkt", "element listy"],
  ["kropka, przecinek, znak zapytania", "znak interpunkcyjny"],
];

const blankCommand = () => ({
  id: `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  name: "",
  enabled: true,
  where: "edge",
  triggers: [],
  rules: "",
  mesh: null,
  outlet: "cursor",
});

const options = (entries, selected) =>
  entries
    .map(
      ([value, label]) =>
        `<option value="${value}" ${String(selected ?? "") === value ? "selected" : ""}>${escape(label)}</option>`,
    )
    .join("");

/**
 * Polecenie w edycji.
 *
 * Formularz jest jeden — dla nowego polecenia i dla zmienianego — bo to jest
 * ta sama rozmowa: jak się nazywa, po czym rusza, co robi i dokąd odkłada.
 */
function renderCommandForm(draft) {
  return `
    <div class="cmd cmd--edit">
      <div class="field">
        <div class="field__label"><strong>Nazwa</strong><span>Zobaczysz ją w pigułce podczas przesiewania i w zapisie.</span></div>
        <div class="field__control">
          <input type="text" data-draft="name" data-i18n="skip" placeholder="np. Checklista" value="${escape(draft.name)}" />
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Wywołania</strong>
          <span>Frazy, po których polecenie rusza. Warto dodać kilka wariantów, także po angielsku.</span>
        </div>
      </div>
      <div class="grains" data-i18n="skip">
        ${draft.triggers
          .map(
            (trigger, index) =>
              `<span class="grain">${escape(trigger)}<button data-trigger="${index}" title="Usuń">×</button></span>`,
          )
          .join("")}
      </div>
      <div class="field" style="border:none;padding-top:10px">
        <div class="field__label" style="flex:none;width:auto">
          <input type="text" id="triggerInput" placeholder="Dodaj wywołanie i wciśnij Enter" style="min-width:280px" />
        </div>
        <button class="btn btn--sm" data-act="trigger-add">Dodaj</button>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Gdzie może stać</strong>
          <span>Nigdy w środku zdania — inaczej „żeby zrobiła checklistę" uruchamiałoby polecenie w relacji z rozmowy.</span>
        </div>
        <div class="field__control">
          <select data-draft="where">${options(Object.entries(PLACES), draft.where)}</select>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Co sito ma zrobić</strong>
          <span>Wytyczna na to jedno dyktowanie. Pisz o formie, nie o treści — dopisywanie faktów zostaje zakazane tak czy owak.</span>
        </div>
      </div>
      <textarea data-draft="rules" data-i18n="skip" placeholder="np. Zapisz wypowiedź jako listę zadań: każdy punkt zaczyna się od „- [ ] &quot;.">${escape(draft.rules)}</textarea>

      <div class="field">
        <div class="field__label">
          <strong>Gęstość</strong>
          <span>Polecenie może przesiać drobniej, nie ruszając pokrętła w Sicie.</span>
        </div>
        <div class="field__control">
          <select data-draft="mesh">
            ${options(
              [
                ["", "Jak w Sicie"],
                ...Object.entries(MESH).map(([key, mesh]) => [key, mesh.name]),
              ],
              draft.mesh ?? "",
            )}
          </select>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Ujście</strong>
          <span>${escape(OUTLETS[draft.outlet]?.[1] ?? "")} Ujście słucha wyłącznie frazy wypowiedzianej dokładnie tak, jak ją zapisałeś.</span>
        </div>
        <div class="field__control">
          <select data-draft="outlet">
            ${options(
              Object.entries(OUTLETS).map(([key, [label]]) => [key, label]),
              draft.outlet,
            )}
          </select>
        </div>
      </div>

      <div class="cmd__acts cmd__acts--form">
        <button class="btn btn--primary btn--sm" data-act="cmd-save">Zapisz</button>
        <button class="btn btn--ghost btn--sm" data-act="cmd-cancel">Anuluj</button>
      </div>
    </div>`;
}

function renderCommandRow(command) {
  const outlet = OUTLETS[command.outlet]?.[0];
  const mesh = command.mesh ? t(MESH[command.mesh]?.name ?? command.mesh) : null;

  return `
    <article class="cmd" data-cmd="${escape(command.id)}" data-off="${!command.enabled}">
      <div class="cmd__head">
        <div class="cmd__name">
          <strong data-i18n="skip">${escape(command.name)}</strong>
          ${command.outlet !== "cursor" ? `<span class="pill">${escape(outlet)}</span>` : ""}
          ${mesh ? `<span class="pill pill--mint">${t("Sito {mesh}", { mesh: mesh.toLowerCase() })}</span>` : ""}
        </div>
        <div class="cmd__acts">
          <button class="switch" role="switch" data-cmd-toggle="${escape(command.id)}"
                  aria-checked="${!!command.enabled}" title="Włącz albo wyłącz"></button>
          <button class="btn btn--ghost btn--sm" data-act="cmd-edit">Zmień</button>
          <button class="btn btn--ghost btn--sm" data-act="cmd-delete">Usuń</button>
        </div>
      </div>
      <div class="grains cmd__triggers" data-i18n="skip">
        ${command.triggers.map((trigger) => `<span class="grain">${escape(trigger)}</span>`).join("")}
      </div>
      <p class="cmd__rules" data-i18n="skip">${escape(command.rules)}</p>
    </article>`;
}

/** Wynik próby — samo rozpoznanie, bez wywołania sita. */
function renderProbe() {
  const probe = state.probe;
  if (!probe) return "";

  const body = `<span class="probe__body" data-i18n="skip">„${escape(probe.body)}"</span>`;
  if (probe.bypassed) {
    return `<div class="probe probe--off">
      <strong>Furtka.</strong> Żadne polecenie nie ruszy. Sito dostanie: ${body}</div>`;
  }
  if (!probe.id) {
    return `<div class="probe probe--off">
      <strong>Nic nie rusza.</strong> To zwykły tekst do przesiania.
      <span class="probe__note">Sito może jeszcze rozpoznać wariant frazy po swojej stronie — próba sprawdza dopasowanie dokładne.</span>
    </div>`;
  }
  return `<div class="probe probe--on">
    <strong data-i18n="skip">${escape(probe.name)}</strong> rusza po frazie
    <span data-i18n="skip">„${escape(probe.trigger)}"</span>. Sito dostanie: ${body}</div>`;
}

function renderCommands() {
  const config = state.settings.commands ?? {};
  const items = config.items ?? [];
  const draft = state.commandDraft;
  const bypass = config.bypass ?? [];

  $("#view-commands").innerHTML = `
    <div class="card">
      <h2>Wykrywanie poleceń</h2>
      <p class="sub">
        Sito nigdy nie odpowiada na to, co usłyszało — „napisz maila do Ani" zapisuje jako
        to zdanie. Polecenia są jedynym wyjątkiem i właśnie dlatego nie zgaduje ich żaden
        model: ruszają wyłącznie frazy zapisane tutaj, a fraza znika z tekstu, zamiast
        zostać w nim jako słowa.
      </p>
      ${switchField(
        "commands.enabled",
        "Wykrywaj polecenia",
        "Wyłączone: każde zdanie jest zwykłym tekstem, tak jak przed dodaniem tej karty.",
        config.enabled,
      )}
      <div class="field">
        <div class="field__label">
          <strong>Furtka</strong>
          <span>Wypowiedź zaczynająca się od tej frazy nie uruchamia żadnego polecenia. Potrzebna wtedy, gdy chcesz podyktować „zrób checklistę" jako tekst.</span>
        </div>
      </div>
      <div class="grains" data-i18n="skip">
        ${bypass
          .map(
            (phrase, index) =>
              `<span class="grain">${escape(phrase)}<button data-bypass="${index}" title="Usuń">×</button></span>`,
          )
          .join("")}
      </div>
      <div class="field" style="border:none;padding-top:10px">
        <div class="field__label" style="flex:none;width:auto">
          <input type="text" id="bypassInput" placeholder="Dodaj frazę i wciśnij Enter" style="min-width:280px" />
        </div>
        <button class="btn btn--sm" data-act="bypass-add">Dodaj</button>
      </div>
    </div>

    <div class="card">
      <h2>Twoje polecenia</h2>
      <p class="sub">
        Polecenie zmienia FORMĘ tego, co powiedziałeś — nigdy nie dopisuje treści, której
        nie było. Musi też mieć na czym pracować: sama fraza „zrób checklistę" bez niczego
        dalej zostaje zwykłym zdaniem.
      </p>
      ${items.map((command) => (draft?.id === command.id ? renderCommandForm(draft) : renderCommandRow(command))).join("")}
      ${draft && !items.some((command) => command.id === draft.id) ? renderCommandForm(draft) : ""}
      ${
        !items.length && !draft
          ? `<p style="color:var(--text-mute);font-size:var(--fs-xs);margin:14px 0 0">Jeszcze nic tu nie ma.</p>`
          : ""
      }
      ${draft ? "" : `<div class="cmd__acts cmd__acts--form"><button class="btn btn--sm" data-act="cmd-add">Dodaj polecenie</button></div>`}
    </div>

    <div class="card">
      <h2>Próba</h2>
      <p class="sub">
        Wpisz zdanie tak, jak byś je powiedział. Próba sprawdza samo rozpoznanie — sita nie
        woła, więc odpowiada od razu i nic nie kosztuje.
      </p>
      <div class="field" style="border:none;padding-top:4px">
        <div class="field__label" style="flex:none;width:auto">
          <input type="text" id="probeText" data-i18n="skip" placeholder="np. Zrób checklistę: mleko, chleb i masło"
                 style="min-width:340px" value="${escape(state.probeText)}" />
        </div>
        <button class="btn btn--sm" data-act="cmd-probe">Sprawdź</button>
      </div>
      ${renderProbe()}
    </div>

    <div class="card">
      <h2>Komendy formatujące</h2>
      <p class="sub">
        Te działają zawsze, także w środku zdania, i nie mają nic wspólnego z powyższymi —
        sito zna je z urodzenia i nie da się ich zmienić.
      </p>
      ${INLINE_COMMANDS.map(
        ([phrase, effect]) =>
          `<div class="cmd__inline"><b data-i18n="skip">„${escape(phrase)}"</b><span>${escape(effect)}</span></div>`,
      ).join("")}
    </div>`;
}

/* ── Widok: Ustawienia ────────────────────────────────────────── */

/** Wynik sprawdzenia konfliktów — pokazuje też, czego nie dało się sprawdzić. */
function renderConflicts() {
  const report = state.conflicts;
  if (!report) return "";
  if (report.pending) return `<div class="setup__result">${t("Sprawdzam…")}</div>`;

  const lines = report.results.flatMap((item) =>
    item.conflicts.length
      ? item.conflicts.map(
          (c) => `${item.label} (${escape(item.accelerator)}) — ${t("zajęty:")} ${escape(c.name)}`,
        )
      : item.unknown
        ? [`${item.label} — ${escape(item.note)}`]
        : [`${item.label} (${escape(item.accelerator)}) — ${t("wolny")}`],
  );

  const clash = report.results.some((item) => item.conflicts.length);
  return `<div class="setup__result ${clash ? "is-bad" : "is-ok"}">${lines.join("<br />")}</div>`;
}

function renderSettings() {
  const { settings, status } = state;
  const hold = settings.hotkey.hold.map((key) => KEY_GLYPH[key] ?? key);
  const quickKeys = state.keysFor === KEYS.quickNote.path;
  const holdKeys = state.keysFor === KEYS.hold.path;

  const toggle = (path, label, hint, value) => `
    <div class="field">
      <div class="field__label"><strong>${label}</strong><span>${hint}</span></div>
      <div class="field__control">
        <button class="switch" role="switch" data-toggle="${path}" aria-checked="${!!value}"></button>
      </div>
    </div>`;

  $("#view-settings").innerHTML = `
    <div class="card">
      <h2>Skrót</h2>
      <p class="sub">
        Jeden komplet klawiszy, dwa sposoby mówienia. Escape zawsze przerywa
        nagranie i je kasuje — nic nie idzie wtedy do transkrypcji.
      </p>

      <div class="field">
        <div class="field__label">
          <strong>Trzymanie</strong>
          <span>
            ${
              holdKeys
                ? `Przytrzymaj dwa albo trzy modyfikatory naraz — ⌘, ⌃, ⌥, ⇧. Sama litera
                   tu nie wejdzie: trzymanie ⌥ i „S” wsypywałoby „s” do aplikacji, do
                   której właśnie mówisz. Escape przerywa.`
                : "Przytrzymaj klawisze i mów. Puszczasz — sito pracuje. Do jednego zdania w biegu."
            }
          </span>
        </div>
        <div class="field__control" style="display: flex; gap: 6px; align-items: center">
          ${hold.map((key) => `<kbd>${key}</kbd>`).join('<span style="color:var(--text-mute)">+</span>')}
          <button class="btn btn--sm${holdKeys ? " btn--amber" : ""}"
                  data-act="keys-record" data-keys="hold" style="margin-left: var(--s-2)">
            ${holdKeys ? "Czekam na klawisze…" : "Zmień"}
          </button>
          ${
            hold.join("") === "⌃⌥"
              ? ""
              : `<button class="btn btn--sm" data-act="keys-clear" data-keys="hold">Przywróć ⌃⌥</button>`
          }
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Bez trzymania (hands-off)</strong>
          <span>
            Stuknij te same klawisze dwa razy pod rząd — nagrywanie zostaje
            włączone, ręce wolne. Kolejne stuknięcie kończy i przesiewa.
            Działa zawsze, obok trzymania: nie ma czego włączać, bo o sposobie
            decyduje gest, a nie ustawienie.
          </span>
        </div>
        <div class="field__control" style="display: flex; gap: 6px; align-items: center">
          ${hold.map((key) => `<kbd>${key}</kbd>`).join('<span style="color:var(--text-mute)">+</span>')}
          <span style="color: var(--text-mute)">× 2</span>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Szybka notatka</strong>
          <span>
            ${
              quickKeys
                ? "Naciśnij klawisze razem z modyfikatorem. Escape przerywa."
                : `Otwiera małe okno z jednym polem tekstowym. ⌘⇧N działa, gdy Cribro
                   jest z przodu; własne klawisze działają zawsze — po to, żeby zdanie,
                   które przyszło do głowy w cudzym oknie, nie musiało czekać.`
            }
          </span>
          ${
            /* Zajęte klawisze wyglądają dokładnie jak brak klawiszy, więc
               mówimy o tym wprost — inaczej jedyną informacją byłoby to,
               że nic się nie dzieje. */
            settings.hotkey.quickNote && status.quickNoteHotkey === false
              ? `<div class="setup__result is-bad">Te klawisze zajęła inna aplikacja. Z menu działa dalej.</div>`
              : ""
          }
        </div>
        <div class="field__control" style="display: flex; gap: var(--s-2); align-items: center">
          ${
            settings.hotkey.quickNote
              ? `<kbd>${escape(glyphs(settings.hotkey.quickNote))}</kbd>`
              : `<span class="pill">nie ustawiono</span>`
          }
          <button class="btn btn--sm${quickKeys ? " btn--amber" : ""}"
                  data-act="keys-record" data-keys="quickNote">
            ${quickKeys ? "Czekam na klawisze…" : settings.hotkey.quickNote ? "Zmień" : "Ustaw klawisze"}
          </button>
          ${
            settings.hotkey.quickNote
              ? `<button class="btn btn--sm" data-act="keys-clear" data-keys="quickNote">Skasuj</button>`
              : ""
          }
          <button class="btn btn--sm" data-act="quick-note">Wypróbuj</button>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Konflikty</strong>
          <span>
            Sprawdza skrót w ustawieniach systemu i pyta system, czy pozwoli go
            zarejestrować. Aplikacji podsłuchujących klawiaturę — jak narzędzia
            do dyktowania — nie widzi żaden interfejs, więc ich nie wykryje.
          </span>
          ${renderConflicts()}
        </div>
        <div class="field__control">
          <button class="btn btn--sm" data-act="check-hotkeys">Sprawdź konflikty</button>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Silnik skrótu</strong>
          <span>${
            status.backend === "uiohook"
              ? "uiohook — trzymanie i hands-off działają"
              : status.backend === "globalShortcut"
                ? "globalShortcut — brak zgody „Dostępność”, działa tylko przełącznik"
                : "brak — skrót nie działa, użyj przycisku Dyktuj"
          }</span>
        </div>
        <div class="field__control">
          <span class="pill ${status.backend === "uiohook" ? "pill--mint" : "pill--amber"}">${escape(status.backend)}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Dock</h2>
      <p class="sub">
        Jak aplikacja pokazuje się poza oknem: ikoną w Docku i przełącznikiem ⌘Tab.
      </p>
      ${toggle("showInDock", "Ikona w Docku", "Wyłączenie zostawia Cribro w pasku menu. Ikona wraca sama na czas, w którym stoi otwarte okno aplikacji — po to, żeby dało się do niego wrócić ⌘Tabem.", settings.showInDock !== false)}
    </div>

    ${renderBriefingCard()}

    ${renderWidgetCard()}

    <div class="card">
      <h2>Zachowanie</h2>
      <p class="sub">Co dzieje się w chwili, gdy tekst jest gotowy.</p>
      <div class="field">
        <div class="field__label">
          <strong>Język interfejsu</strong>
          <span>Zmienia napisy w oknach, w pasku menu i na widgecie. Język dyktowania ustawia się osobno, w zakładce Funkcja sita.</span>
        </div>
        <div class="field__control">
          <select data-setting="uiLanguage">
            <option value="pl" ${settings.uiLanguage !== "en" ? "selected" : ""}>Polski</option>
            <option value="en" ${settings.uiLanguage === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
      </div>
      ${toggle("autoPaste", "Wklejaj pod kursor", "Poza schowkiem symuluje ⌘V w aktywnej aplikacji.", settings.autoPaste)}
      ${toggle("playSound", "Dźwięk potwierdzenia", "Krótki sygnał, gdy tekst trafi do schowka.", settings.playSound)}
      ${toggle("launchAtLogin", "Uruchamiaj przy starcie", "Cribro czeka w pasku menu.", settings.launchAtLogin)}
      ${toggle("keepRaw", "Zachowuj surowy transkrypt", "Bez tego nie zobaczysz, co sito odsiało.", settings.keepRaw)}
    </div>

    ${renderSpellcheck()}

    ${renderEngines()}

    ${renderShotCard()}

    ${renderCloud()}

    ${renderNotion()}

    <div class="card">
      <h2>Prywatność</h2>
      <p class="sub">
        Nagranie ginie zaraz po transkrypcji — na dysku zostaje tylko tekst.
        Historia dyktowania leży w twoim katalogu użytkownika i nie opuszcza tego
        komputera: nie ma jej w chmurze i nie ma dokąd jej wysłać. Notatki jadą na
        serwer wyłącznie wtedy, gdy sam włączysz konto powyżej.
      </p>
      <div class="field">
        <div class="field__label"><strong>Uprawnienia systemowe</strong><span>Mikrofon: ${escape(
          status.microphone,
        )} · Dostępność: ${status.accessibility ? "przyznana" : "brak"}</span></div>
        <div class="field__control">
          <button class="btn btn--sm" data-act="perm-accessibility">Otwórz Ustawienia systemowe</button>
        </div>
      </div>
    </div>`;
}

/**
 * Skróty, które wybiera się ręką — jedno miejsce dla wszystkich.
 *
 * Każdy z nich ma tę samą mechanikę (kliknij, naciśnij klawisze, sprawdź
 * czy wolne) i tę samą pułapkę: skrót, którego nie udało się zarejestrować,
 * milczy dokładnie tak jak skrót, którego nie ma. Trzymanie ich w katalogu,
 * a nie w dwóch bliźniaczych gałęziach kodu, znaczy, że dołożenie trzeciego
 * jest jednym wpisem, a nie kolejną kopią obsługi klawiatury.
 *
 * `cleared` mówi, co zostaje po skasowaniu klawiszy — bo w obu wypadkach
 * funkcja nie ginie, tylko wraca do menu, i człowiek ma o tym usłyszeć.
 */
const KEYS = {
  shot: {
    path: "shot.hotkey",
    label: "Tekst z ekranu",
    cleared: "Skrót skasowany — zostaje menu.",
  },
  quickNote: {
    path: "hotkey.quickNote",
    label: "Szybka notatka",
    cleared: "Skrót skasowany — zostaje ⌘⇧N przy Cribro z przodu.",
  },
  /* Trzymanie ma INNY KSZTAŁT niż dwa powyżej i dlatego ma własny rodzaj.
     Tam zapisujemy jeden napis dla systemu („Control+Alt+N"); tutaj listę
     modyfikatorów, którą czyta silnik skrótu (patrz KEY w main/hotkeys.js),
     bo trzymanie nie jest skrótem systemowym — jest stanem klawiatury. */
  hold: {
    path: "hotkey.hold",
    label: "Trzymanie",
    kind: "hold",
    /* Nie „skasuj", a „przywróć": bez klawiszy do trzymania funkcja nie
       wraca do menu, tylko przestaje istnieć. Zawsze musi być jakiś komplet. */
    fallback: ["Ctrl", "Alt"],
    cleared: "Wróciło ⌃⌥ — domyślny komplet.",
  },
};

/** Modyfikatory w kolejności, w jakiej je zapisujemy — zawsze tej samej. */
const HOLD_KEYS = [
  ["ctrlKey", "Ctrl"],
  ["altKey", "Alt"],
  ["shiftKey", "Shift"],
  ["metaKey", "Meta"],
];

/* Zapis skrótu w klawiszach, nie w nazwach: „Control+Alt+S" to zapis dla
   systemu, a „⌃⌥S" — dla oczu. */
const ACCEL_GLYPH = {
  command: "⌘", cmd: "⌘", meta: "⌘", super: "⌘",
  control: "⌃", ctrl: "⌃",
  alt: "⌥", option: "⌥",
  shift: "⇧",
  space: "␣", plus: "+", return: "⏎", enter: "⏎", tab: "⇥", backspace: "⌫", delete: "⌦",
  up: "↑", down: "↓", left: "←", right: "→",
};

const glyphs = (accelerator) =>
  String(accelerator ?? "")
    .split("+")
    .map((part) => ACCEL_GLYPH[part.trim().toLowerCase()] ?? part.trim().toUpperCase())
    .join("");

/**
 * Tekst z ekranu.
 *
 * Trzecia droga, którą tekst wchodzi do Cribro — obok głosu i klawiatury.
 * Karta jest jedna, choć ustawienia są z dwóch różnych porządków (klawisze
 * i dostawca), bo z punktu widzenia użytkownika to jedna funkcja i pytanie
 * „czemu to nie działa" ma mieć jedną odpowiedź w jednym miejscu.
 *
 * Skrót jest tu, a nie w karcie „Skrót" na górze: tamta mówi o dyktowaniu,
 * którego klawiszy się nie wybiera. Tego się wybiera i to jest jedyne
 * miejsce w aplikacji, w którym klawisze ustawia się samemu.
 */
function renderShotCard() {
  const shot = state.settings.shot ?? {};
  const listening = state.keysFor === KEYS.shot.path;

  return `
    <div class="card">
      <h2>Tekst z ekranu</h2>
      <p class="sub">
        Zaznaczasz kawałek ekranu, a to, co na nim widać, staje się notatką.
        Cudzy PDF, slajd z prezentacji, zrzut z rozmowy. Model tutaj wyłącznie
        czyta: nie poprawia literówek i nie odpowiada na to, co przeczytał.
      </p>

      <div class="field">
        <div class="field__label">
          <strong>Skrót</strong>
          <span>
            ${
              listening
                ? "Naciśnij klawisze razem z modyfikatorem. Escape przerywa."
                : "Działa spoza Cribro — po to jest, bo zaznacza się cudze okno. macOS trzyma już ⌘⇧3, ⌘⇧4 i ⌘⇧5."
            }
          </span>
        </div>
        <div class="field__control" style="display: flex; gap: var(--s-2); align-items: center">
          ${
            shot.hotkey
              ? `<kbd>${escape(glyphs(shot.hotkey))}</kbd>`
              : `<span class="pill">nie ustawiono</span>`
          }
          <button class="btn btn--sm${listening ? " btn--amber" : ""}"
                  data-act="keys-record" data-keys="shot">
            ${listening ? "Czekam na klawisze…" : shot.hotkey ? "Zmień" : "Ustaw klawisze"}
          </button>
          ${shot.hotkey ? `<button class="btn btn--sm" data-act="keys-clear" data-keys="shot">Skasuj</button>` : ""}
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Przechwyć teraz</strong>
          <span>
            Zaznaczenie to krzyżyk na ekranie: spacja łapie całe okno, Escape przerywa.
            Obrazek, który już leży na dysku — załącznik, zdjęcie z telefonu, plik
            z Pobranych — nie musi przez ekran przechodzić: czyta się go wprost.
          </span>
        </div>
        <div class="field__control" style="display: flex; gap: var(--s-2); align-items: center">
          <button class="btn btn--sm" data-act="shot-grab">Zaznacz obszar</button>
          <button class="btn btn--sm" data-act="shot-file">Wybierz plik…</button>
        </div>
      </div>

      ${switchField(
        "shot.ask",
        "Pytaj, dokąd trafia",
        "Okienko z wyborem: nowa notatka, dopisanie do istniejącej albo pod kursor — i w jakiej formie. Bez pytania odczyt idzie tam, gdzie ostatnim razem.",
        shot.ask !== false,
      )}
      ${switchField(
        "shot.copy",
        "Kopiuj odczyt do schowka",
        "Tak samo jak przesiane dyktowanie — najczęstsze, co się robi z tekstem wyjętym z cudzego okna, to wklejenie go gdzie indziej.",
        shot.copy !== false,
      )}

      ${engineBlock("shot", "Odczyt", "Czyta tekst z obrazka. Zadanie odtwórcze, więc domyślnie najtańszy model — różnicę widać na rachunku, nie w wyniku.")}
    </div>`;
}

/**
 * Karta „Silniki" — dostawca, model i klucz dla trzech kroków potoku.
 *
 * WIDZI JĄ WYŁĄCZNIE WŁAŚCICIEL. Nie jest to blokada w interfejsie: proces
 * główny nie wysyła tu ani katalogu dostawców, ani nazw modeli, ani kluczy,
 * więc `state.providers` jest u wszystkich pozostałych pustym obiektem
 * i nie ma z czego zbudować ani jednego pola. Dlaczego — mówi nagłówek
 * main/owner.js.
 *
 * Na miejscu karty nie zostaje nic. Wyszarzone pole nadal mówi, co w nim
 * stało, a napis „ta funkcja jest niedostępna w twojej wersji" jest
 * obietnicą, której nikt tu nikomu nie składał: transkrypcja i sito po
 * prostu działają.
 */
function renderEngines() {
  if (!state.settings?.owner) return "";
  const { settings } = state;
  return `
    <div class="card">
      <h2>Silniki</h2>
      <p class="sub">
        Dwa osobne kroki. Najpierw ktoś zamienia głos na tekst, potem ktoś inny
        ten tekst czyści. Możesz dać oba jednemu dostawcy albo je rozdzielić.
      </p>
      ${engineBlock("stt", "Krok 1 — transkrypcja", "Zamienia nagranie na wierny zapis, razem z wahaniami i zacięciami.")}
      ${engineBlock("sieve", "Krok 2 — sito", "Czyści zapis: usuwa szum mowy, rozstrzyga autopoprawki, stawia interpunkcję.")}
      ${
        settings.stt.provider === settings.sieve.provider && settings.stt.provider !== "mock"
          ? `<p class="hintline">Oba kroki chodzą na tym samym dostawcy — klucz wystarczy wpisać raz, w dowolnym z nich.</p>`
          : ""
      }
    </div>`;
}

/** Przełącznik w kształcie pola ustawień — ten sam co w renderSettings. */
function switchField(path, label, hint, value) {
  return `
    <div class="field">
      <div class="field__label"><strong>${label}</strong><span>${hint}</span></div>
      <div class="field__control">
        <button class="switch" role="switch" data-toggle="${path}" aria-checked="${!!value}"></button>
      </div>
    </div>`;
}

/**
 * Widget — pływający znaczek z notatkami na wierzchu.
 *
 * O tym, KTÓRE notatki w nim są, decyduje się przy samej notatce — i tak ma
 * być, bo to jest decyzja o notatce, a nie o widgecie. Tutaj zostaje pytanie
 * o coś innego: co się z nimi dzieje po kliknięciu w znaczek.
 *
 * Dwa widoki, bo to są dwa sposoby pracy, a nie dwa wyglądy tego samego.
 * Kompaktowy trzyma notatki schowane i wydaje po jednej — zajmuje róg
 * ekranu. Pulpitowy trzyma je wyłożone, bo po to się je odłożyło na wierzch:
 * plan dnia ma być widoczny, a nie do odszukania. Wspólne mają jedno i to
 * jest cała umowa z użytkownikiem: kliknięcie w znaczek chowa wszystko.
 */
/**
 * Poranek — karta w Ustawieniach.
 *
 * Prowadzi przez trzy kroki w kolejności, w której naprawdę trzeba je
 * zrobić: klient OAuth, podłączenie konta, kanały. Każdy następny ma sens
 * dopiero po poprzednim, więc każdy następny jest wyszarzony, dopóki
 * poprzedni nie jest zrobiony — zamiast trzech pól obok siebie i pytania,
 * od którego zacząć.
 */
function renderBriefingCard() {
  const settings = state.settings ?? {};
  const config = settings.briefing ?? {};
  const account = state.briefing?.account ?? { configured: false, signedIn: false, email: null };
  const feeds = config.feeds ?? [];

  const toggle = (path, label, hint, value) => `
    <div class="field">
      <div class="field__label"><strong>${label}</strong><span>${hint}</span></div>
      <div class="field__control">
        <button class="switch" role="switch" data-toggle="${path}" aria-checked="${!!value}"></button>
      </div>
    </div>`;

  /* Stan konta jednym zdaniem. „Podłączone" nie wystarcza: przy poranku
     liczy się, KTÓRE konto — i dlatego adres stoi na wierzchu. */
  const state_ = () => {
    if (!account.configured) return ["pill--amber", "brak klienta OAuth"];
    if (state.briefing?.mismatch) return ["pill--amber", `cudze konto: ${account.email}`];
    if (account.signedIn) return ["pill--mint", account.email ?? "podłączone"];
    return ["pill--amber", "niepodłączone"];
  };
  const [pill, label] = state_();

  return `
    <div class="card">
      <h2>Poranek</h2>
      <p class="sub">
        Jedno okno raz dziennie, przy pierwszym siadaniu do komputera: co
        w poczcie wymaga uwagi i co jest w planie dnia. Poczta czytana jest
        tylko do odczytu i tylko z konta wpisanego niżej; wybór maili robią
        reguły na tym komputerze, a do modelu jedzie dopiero kilkanaście
        wytypowanych.
      </p>

      ${toggle("briefing.enabled", "Pokazuj poranek", "Raz na dobę, przy pierwszym uruchomieniu albo odblokowaniu ekranu.", config.enabled)}

      <div class="field">
        <div class="field__label">
          <strong>Konto Google</strong>
          <span>
            Poranek należy do jednego konta. Zalogowanie innego jest odrzucane —
            razem z sesją.
          </span>
        </div>
        <div class="field__control">
          <span class="pill ${pill}">${escape(label)}</span>
          ${
            account.signedIn
              ? `<button class="btn btn--sm" data-brief="disconnect">Odłącz</button>`
              : `<button class="btn btn--sm btn--primary" data-brief="connect" ${account.configured ? "" : "disabled"}>Podłącz</button>`
          }
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Identyfikator klienta OAuth</strong>
          <span>
            Zakładasz go u siebie w Google Cloud (typ „Desktop app", zakres
            gmail.readonly). Klient zostawiony w trybie „Testing" z jednym
            adresem na liście testerów sprawia, że tą drogą nie zaloguje się
            nikt poza Tobą. Dlatego tego klucza nie ma w aplikacji.
          </span>
        </div>
        <div class="field__control">
          <input type="text" style="min-width:320px" data-setting="briefing.google.clientId"
                 placeholder="…apps.googleusercontent.com"
                 value="${escape(config.google?.clientId ?? "")}" />
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Tajemnica klienta</strong>
          <span>
            Google wydaje ją także klientom desktopowym i nie jest sekretem
            (leży w każdej kopii aplikacji), ale bywa wymagana przy wymianie
            kodu. Zostaw puste, jeśli logowanie działa bez niej.
          </span>
        </div>
        <div class="field__control">
          <input type="password" style="min-width:320px" data-setting="briefing.google.clientSecret"
                 placeholder="opcjonalne"
                 value="${escape(config.google?.clientSecret ?? "")}" />
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Kanały</strong>
          <span>
            Adresy RSS albo Atom, po jednym w wierszu. Kanał, który milczy,
            wypada sam — nie zatrzymuje poranka. Puste pole znaczy „bez
            sekcji Świat".
          </span>
        </div>
        <div class="field__control">
          <textarea rows="3" style="min-width:320px" data-brief-feeds
                    placeholder="https://serwis.example/feed">${escape(feeds.map((feed) => feed.url ?? feed).join("\n"))}</textarea>
        </div>
      </div>

      <div class="meet__act meet__act--tight">
        <button class="btn btn--sm" data-brief="show">Pokaż teraz</button>
      </div>
    </div>`;
}

function renderWidgetCard() {
  const widget = state.settings.widget ?? {};
  const desk = widget.mode === "desk";

  return `
    <div class="card">
      <h2>Widget</h2>
      <p class="sub">
        Znaczek pływający nad wszystkimi aplikacjami — jedyne, co Cribro
        pokazuje poza swoimi oknami. Najechanie kursorem rozkłada pod nim
        cztery czynności robione w biegu: dyktowanie, szybką notatkę, gęstość
        sita i język. Z boku wychodzi przejście do notatek na wierzchu.
      </p>

      ${switchField(
        "widget.enabled",
        "Pokazuj widget",
        "Pływa nad wszystkim i nie przejmuje fokusu, dopóki się w niego nie kliknie.",
        widget.enabled,
      )}

      <div class="field">
        <div class="field__label">
          <strong>Widok</strong>
          <span>
            ${
              desk
                ? "Każda notatka z wierzchu dostaje własną kartkę na pulpicie — jak karteczki przyklejone do ekranu. Kartki leżą tam, gdzie je położysz, zmieniają rozmiar uchwytem w rogu i zostają nad wszystkimi oknami, także po przełączeniu pulpitu. Schodzą z wierzchu tylko na wyraźny gest: kliknięcie w znaczek albo Escape — wszystkie naraz."
                : "Kliknięcie w znaczek rozwija przy nim listę notatek z wierzchu, a wybrana wychodzi z niej kartką. Wszystko w jednym rogu ekranu i wszystko znika razem ze znaczkiem."
            }
          </span>
        </div>
        <div class="field__control">
          <select data-setting="widget.mode">
            <option value="compact" ${desk ? "" : "selected"}>Kompaktowy — lista</option>
            <option value="desk" ${desk ? "selected" : ""}>Pulpit — wszystkie kartki</option>
          </select>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Wielkość pisma na kartkach</strong>
          <span>
            Dotyczy notatek na wierzchu — i tej w szybie przy znaczku, i tych
            leżących na pulpicie. Kartka jest mała, więc pismo na niej jest
            mniejsze niż w Notatniku; jak bardzo, decydujesz tutaj, a nie
            wielkość ekranu.
          </span>
        </div>
        <div class="field__control">
          <select data-setting="widget.textSize">
            <option value="s" ${widget.textSize === "s" ? "selected" : ""}>Drobne</option>
            <option value="m" ${(widget.textSize ?? "m") === "m" ? "selected" : ""}>Zwykłe</option>
            <option value="l" ${widget.textSize === "l" ? "selected" : ""}>Duże</option>
            <option value="xl" ${widget.textSize === "xl" ? "selected" : ""}>Bardzo duże</option>
          </select>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Które notatki</strong>
          <span>
            Otwórz notatkę w Notatniku albo w zakładce Notatki i włącz przy niej
            „Widoczna w widgecie". Wybór zostaje na tym komputerze — na drugim
            ta sama notatka może leżeć schowana.
          </span>
        </div>
        <div class="field__control">
          <button class="btn btn--sm" data-act="open-notes">Otwórz Notatnik</button>
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Położenie</strong>
          <span>Widget przeciąga się za znaczek w dowolne miejsce ekranu i tam zostaje. Jeśli przepadł razem z drugim monitorem — tędy wraca.</span>
        </div>
        <div class="field__control">
          <button class="btn btn--sm" data-act="widget-reset">Przywróć na miejsce</button>
        </div>
      </div>
    </div>`;
}

/**
 * Pisownia.
 *
 * Karta wygląda inaczej na macOS niż na reszcie świata i to nie jest
 * niedbałość: na macOS sprawdzaniem zajmuje się system, sam rozpoznaje
 * język i nie przyjmuje listy z zewnątrz. Pokazywanie tam wyboru języków
 * byłoby pokrętłem, które nic nie robi.
 */
function renderSpellcheck() {
  const spell = state.settings.spellcheck ?? {};
  const mac = api.platform === "darwin";
  const enabled = spell.enabled !== false;
  const follows = spell.followDictation !== false;
  const chosen = spell.languages ?? [];

  const languages = DICTATION_LANGUAGES.map(
    ([code, name]) => `
      <label class="grain grain--pick">
        <input type="checkbox" data-spell-lang="${code}" ${chosen.includes(code) ? "checked" : ""} />
        ${escape(name)}
      </label>`,
  ).join("");

  return `
    <div class="card">
      <h2>Pisownia</h2>
      <p class="sub">
        Podkreślanie błędów w notatkach i w szybkiej notatce. Podpowiedzi
        siedzą pod prawym przyciskiem myszy — tam też jest „Naucz się tego
        słowa" dla nazwisk i nazw własnych.
      </p>

      ${switchField(
        "spellcheck.enabled",
        "Sprawdzaj pisownię",
        "Czerwona fala pod słowem, którego słownik nie zna. Nie zmienia niczego sama z siebie.",
        enabled,
      )}

      ${
        !enabled
          ? ""
          : mac
            ? `<p class="hintline">
                 Językiem zajmuje się macOS: rozpoznaje go sam z pisanego tekstu
                 i korzysta ze słownika wspólnego dla wszystkich aplikacji.
                 Listę języków ustawia się w Ustawieniach systemowych →
                 Klawiatura → Tekst.
               </p>`
            : `${switchField(
                 "spellcheck.followDictation",
                 "Języki jak przy dyktowaniu",
                 "Ten sam człowiek pisze w tych samych językach, w których mówi. Wyłącz, żeby wybrać osobno.",
                 follows,
               )}
               ${
                 follows
                   ? ""
                   : `<div class="field">
                        <div class="field__label">
                          <strong>Języki sprawdzania</strong>
                          <span>Bez zaznaczenia żadnego słownik wraca do angielskiego.</span>
                        </div>
                      </div>
                      <div class="grains">${languages}</div>`
               }`
      }
    </div>`;
}

/**
 * Notion.
 *
 * To NIE jest druga chmura. Cribro niczego stamtąd nie czyta i niczego nie
 * uzgadnia — notatka jedzie w jedną stronę, tak jak jedzie do Notatek Apple
 * albo do pliku .md. Kartę stawiamy więc obok konta, a nie w nim: konto jest
 * o tym, gdzie notatki mieszkają, a to jest o tym, dokąd się je wysyła.
 *
 * Dwa pola i jeden przycisk, bo tyle wystarczy — i jedno zdanie o kroku,
 * który wszyscy pomijają (udostępnienie strony integracji). Ten krok jest
 * powodem, dla którego pierwsza próba zwykle nie działa, a komunikat Notion
 * („Could not find page") nie mówi ani słowa o tym, co zrobić.
 */
function renderNotion() {
  const cfg = state.settings.notion ?? {};
  const ready = !!String(cfg.token ?? "").trim() && !!String(cfg.parent ?? "").trim();
  const check = state.notionCheck ?? null;

  const message = !check
    ? ""
    : check.ok
      ? `<div class="setup__result is-ok">${escape(check.note)}</div>`
      : `<div class="setup__result is-bad">${escape(check.note)}</div>`;

  return `
    <div class="card">
      <h2>Notion</h2>
      <p class="sub">
        Notatka jako strona w Notion — z nagłówkami, listami zadań i składanymi
        sekcjami. Wysłana drugi raz odświeża tę samą stronę, zamiast robić
        drugą obok. W jedną stronę: z Notion nic tu nie wraca.
      </p>

      <div class="field">
        <div class="field__label">
          <strong>Token integracji</strong>
          <span>
            notion.so/my-integrations → „New integration" → „Internal Integration
            Secret". To nie jest hasło do konta i samo z siebie nie daje dostępu
            do niczego.
          </span>
        </div>
        <div class="field__control">
          <input type="password" data-setting="notion.token" value="${escape(cfg.token ?? "")}"
                 placeholder="ntn_…" />
        </div>
      </div>

      <div class="field">
        <div class="field__label">
          <strong>Strona, pod którą wpadają notatki</strong>
          <span>Wklej jej adres z przeglądarki — sam identyfikator też przejdzie.</span>
        </div>
        <div class="field__control">
          <input type="text" data-setting="notion.parent" value="${escape(cfg.parent ?? "")}"
                 placeholder="https://www.notion.so/Notatki-2f1a3b4c…" />
        </div>
      </div>

      <p class="hintline">
        ⚠︎ Krok, który wszyscy pomijają: otwórz tę stronę w Notion, kliknij „•••"
        w prawym górnym rogu → „Connections" → i dodaj swoją integrację. Bez tego
        Notion odpowie, że strony nie ma — choć widzisz ją na ekranie.
      </p>

      <div class="field">
        <div class="field__label">
          <strong>Sprawdzenie</strong>
          <span>Czy token działa i czy integracja naprawdę widzi tę stronę.</span>
        </div>
        <div class="field__control">
          <button class="btn btn--sm" data-act="notion-check" ${ready ? "" : "disabled"}>
            Sprawdź połączenie
          </button>
        </div>
      </div>
      ${message}
    </div>`;
}

/**
 * Konto i kopia notatek w Supabase.
 *
 * Karta prowadzi przez trzy stany po kolei, bo takie są trzy pytania:
 * dokąd wysyłać (projekt), kim jestem (konto) i co się właśnie dzieje
 * (synchronizacja). Każdy następny pokazuje się dopiero, gdy poprzedni
 * ma odpowiedź — inaczej pierwszy ekran byłby ścianą pól.
 */
function renderCloud() {
  const cfg = state.settings.cloud ?? {};
  const cloud = state.cloud;
  const form = state.cloudForm;

  const message = cloud.error
    ? `<div class="setup__result is-bad">${escape(cloud.error)}</div>`
    : cloud.note
      ? `<div class="setup__result is-ok">${escape(cloud.note)}</div>`
      : "";

  const project = `
    <div class="field">
      <div class="field__label">
        <strong>Adres projektu</strong>
        <span>Panel Supabase → Project Settings → API → Project URL.</span>
      </div>
      <div class="field__control">
        <input type="text" data-setting="cloud.url" value="${escape(cfg.url ?? "")}"
               placeholder="https://abcdefgh.supabase.co" />
      </div>
    </div>
    <div class="field">
      <div class="field__label">
        <strong>Klucz publiczny (anon)</strong>
        <span>
          Ten sam ekran, pole „anon public". Klucz service_role nie ma tu czego
          szukać — omija reguły dostępu i otwiera wszystkie konta naraz.
        </span>
      </div>
      <div class="field__control">
        <input type="password" data-setting="cloud.anonKey" value="${escape(cfg.anonKey ?? "")}"
               placeholder="eyJhbGciOi…" />
      </div>
    </div>
    <p class="hintline">
      Tabele zakłada się raz: wklej plik supabase/schema.sql z katalogu projektu
      do SQL Editora w panelu i naciśnij Run.
    </p>`;

  /* Adresy powrotne. Bez nich logowanie przez Google kończy się stroną
     błędu Supabase, a komunikat na niej („requested path is invalid") nie
     mówi ani co jest nie tak, ani gdzie to poprawić. Lepiej mieć je pod
     ręką w oknie, w którym się to konfiguruje, niż w README. */
  const redirects = `
    <details class="engine">
      <summary>Adresy powrotne dla logowania przez Google</summary>
      <p class="hintline">
        Panel Supabase → Authentication → URL Configuration → Redirect URLs.
        Dopisz wszystkie trzy — aplikacja bierze pierwszy wolny port. Ostatnia
        linijka zastępuje tamte trzy, jeśli wolisz jedną.
      </p>
      <pre class="pre" data-i18n="skip">${escape(
        [...(state.redirects ?? []), "http://127.0.0.1:*/auth/callback"].join("\n"),
      )}</pre>
      <div class="field">
        <div class="field__label">
          <strong>Do schowka</strong>
          <span>Wklej do panelu jeden pod drugim.</span>
        </div>
        <div class="field__control">
          <button class="btn btn--sm" data-act="cloud-copy-redirects">Kopiuj adresy</button>
        </div>
      </div>
    </details>`;

  /* Logo Google jest kolorowe, choć cała reszta aplikacji nie jest.
     To nie niekonsekwencja: ten znaczek ma być rozpoznany w ćwierć sekundy
     jako „to jest to konto, które już masz", a przemalowany na zielono
     przestaje być tym znaczkiem. Jest jedyny taki w całym oknie. */
  const googleMark = `
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4.1H24v7.5h12.1c-.2 1.9-1.6 4.8-4.5 6.8l6.9 5.3c4.1-3.8 6.6-9.4 6.6-15.5z"/>
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.3c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8.1 41.1 15.5 46 24 46z"/>
      <path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.7-4.5l-7.1-5.5C2.8 17 2 20.4 2 24s.8 7 2.3 10z"/>
      <path fill="#EA4335" d="M24 9.5c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 3.4 29.9 1 24 1 15.5 1 8.1 5.9 4.3 13l7.1 5.5C13.3 13.3 18.2 9.5 24 9.5z"/>
    </svg>`;

  /* Czekanie na przeglądarkę jest osobnym ekranem, nie zgaszonym
     przyciskiem. Logowanie dzieje się teraz w cudzym oknie i karta konta
     ma powiedzieć dokładnie to — razem z wyjściem awaryjnym dla kogoś,
     kto tamto okno zamknął albo się rozmyślił. */
  const waiting = `
    <div class="field">
      <div class="field__label">
        <strong>Czekam na przeglądarkę</strong>
        <span>
          Dokończ logowanie w oknie, które się właśnie otworzyło. Wrócisz tu sam —
          ta karta zmieni się w chwili, gdy konto się potwierdzi.
        </span>
      </div>
      <div class="field__control">
        <button class="btn btn--sm" data-act="cloud-cancel">Przerwij</button>
      </div>
    </div>`;

  const signInForm = `
    <div class="field">
      <div class="field__label">
        <strong>Konto Google</strong>
        <span>
          Logowanie otwiera się w przeglądarce, nie tutaj — dzięki temu hasła
          do Google nie wpisujesz w oknie, które narysowała ta aplikacja.
        </span>
      </div>
      <div class="field__control">
        <button class="btn btn--sm" data-act="cloud-google">${googleMark}Zaloguj przez Google</button>
      </div>
    </div>
    <p class="hintline">
      Albo adresem i hasłem — konto jest to samo, jeśli adres w Google jest ten sam.
    </p>
    <div class="field">
      <div class="field__label"><strong>Adres e-mail</strong></div>
      <div class="field__control">
        <input type="email" id="cloudEmail" value="${escape(form.email)}"
               autocomplete="username" placeholder="ty@example.com" />
      </div>
    </div>
    <div class="field">
      <div class="field__label">
        <strong>Hasło</strong>
        <span>Co najmniej 6 znaków. Nie jest nigdzie zapisywane — zostaje token sesji.</span>
      </div>
      <div class="field__control">
        <input type="password" id="cloudPassword" value="${escape(form.password)}"
               autocomplete="current-password" placeholder="••••••••" />
      </div>
    </div>
    <div class="field">
      <div class="field__label">
        <strong>Konto</strong>
        <span>
          Notatki z tego komputera trafią do konta, na które się zalogujesz —
          razem z tymi, które powstały, zanim konto istniało.
        </span>
      </div>
      <div class="field__control" style="display: flex; gap: var(--s-2)">
        <button class="btn btn--sm" data-act="cloud-signin">Zaloguj</button>
        <button class="btn btn--sm" data-act="cloud-signup">Załóż konto</button>
      </div>
    </div>
    <div class="field">
      <div class="field__label"><strong>Nie pamiętam hasła</strong><span>Wyślemy link na podany adres.</span></div>
      <div class="field__control">
        <button class="btn btn--sm" data-act="cloud-reset">Wyślij link</button>
      </div>
    </div>`;

  const account = `
    <div class="field">
      <div class="field__label">
        <strong>Zalogowany</strong>
        <span data-i18n="skip">${escape(cloud.email ?? "")}${
          cloud.provider && cloud.provider !== "email" ? ` · ${escape(cloud.provider)}` : ""
        }</span>
      </div>
      <div class="field__control">
        <button class="btn btn--sm" data-act="cloud-signout">Wyloguj</button>
      </div>
    </div>
    ${switchField(
      "cloud.autoSync",
      "Synchronizuj w tle",
      "Po każdej zmianie i co pięć minut. Wyłączone — tylko przyciskiem obok.",
      cfg.autoSync !== false,
    )}
    <div class="field">
      <div class="field__label">
        <strong>Ostatnia synchronizacja</strong>
        <span>${
          cloud.syncing
            ? "Trwa…"
            : cloud.lastSyncAt
              ? escape(timeAgo(cloud.lastSyncAt))
              : "jeszcze nie było"
        }</span>
      </div>
      <div class="field__control">
        <button class="btn btn--sm" data-act="cloud-sync" ${cloud.syncing ? "disabled" : ""}>Synchronizuj teraz</button>
      </div>
    </div>`;

  return `
    <div class="card">
      <h2>Konto i notatki w chmurze</h2>
      <p class="sub">
        Kopia notatek na własnym projekcie Supabase — po to, żeby ta sama notatka
        była na dwóch komputerach. Wyłączone znaczy wyłączone: nic nie wychodzi
        z tego dysku. Historia dyktowania nie jedzie tam nigdy.
      </p>

      ${switchField(
        "cloud.enabled",
        "Włącz kopię w chmurze",
        "Bez tego reszta karty nic nie robi, a notatki zostają wyłącznie tutaj.",
        cfg.enabled,
      )}

      ${
        !cfg.enabled
          ? ""
          : cloud.configured
            ? cloud.signedIn
              ? account
              : cloud.waitingFor
                ? waiting
                : signInForm
            : project
      }
      ${cfg.enabled && cloud.configured && !cloud.signedIn ? `<details class="engine"><summary>Zmień projekt</summary>${project}</details>` : ""}
      ${cfg.enabled && cloud.configured && !cloud.signedIn ? redirects : ""}
      ${message}
    </div>`;
}

/* Jeden krok potoku: dostawca, model, klucz i przycisk sprawdzający.
   Lista modeli zmienia się wraz z dostawcą, więc nie da się wybrać
   modelu, którego wybrany dostawca nie zna. */
function engineBlock(stage, title, hint) {
  /* Bez katalogu dostawców nie ma czego rysować — i to nie jest usterka,
     tylko odpowiedź. Proces główny wysyła katalog wyłącznie właścicielowi
     (patrz providers:get w main/main.js i nagłówek main/owner.js). */
  if (!state.settings?.owner) return "";
  const cfg = state.settings[stage];
  const catalogue = state.providers[stage] ?? {};
  const provider = catalogue[cfg.provider];
  const result = state.tests[stage];

  const options = (entries, current) =>
    entries
      .map(([value, label]) => `<option value="${escape(value)}"${current === value ? " selected" : ""}>${escape(label)}</option>`)
      .join("");

  return `
    <div class="engine">
      <div class="engine__head">
        <strong>${escape(title)}</strong>
        <span>${escape(hint)}</span>
      </div>

      <div class="field">
        <div class="field__label"><strong>Dostawca</strong></div>
        <div class="field__control">
          <select data-setting="${stage}.provider">
            ${options(Object.entries(catalogue).map(([key, value]) => [key, value.label]), cfg.provider)}
          </select>
        </div>
      </div>

      <div class="field">
        <div class="field__label"><strong>Model</strong></div>
        <div class="field__control">
          <select data-setting="${stage}.model">
            ${options(provider?.models ?? [], cfg.model)}
          </select>
        </div>
      </div>

      ${
        provider?.needsKey
          ? `<div class="field">
               <div class="field__label">
                 <strong>Klucz API</strong>
                 <span>Zostaje na tym dysku. <a href="${escape(provider.keyUrl)}" data-act="open-link">Skąd go wziąć</a></span>
               </div>
               <div class="field__control">
                 <input type="password" data-setting="${stage}.apiKey"
                        value="${escape(cfg.apiKey)}" placeholder="${escape(provider.keyHint ?? "")}" />
               </div>
             </div>`
          : ""
      }

      <div class="field">
        <div class="field__label">
          <strong>Sprawdź połączenie</strong>
          <span>Woła dostawcę naprawdę — od razu wiesz, czy klucz i model działają.</span>
        </div>
        <div class="field__control">
          <button class="btn btn--sm" data-act="test-${stage}">Sprawdź</button>
        </div>
      </div>

      ${result ? `<div class="setup__result ${result.ok ? "is-ok" : "is-bad"}">${escape(result.note)}</div>` : ""}
    </div>`;
}

/* ── Pasek uprawnień ──────────────────────────────────────────── */

/* Błąd zostaje na ekranie, dopóki go nie zamkniesz. Toast na 2 sekundy
   jest bezużyteczny, gdy właśnie patrzyłeś w inną aplikację i mówiłeś. */
function renderErrorBar() {
  const { error } = state;
  if (!error) {
    $("#errorBar").innerHTML = "";
    return;
  }

  // Puste nagranie to nie awaria — nic się nie zepsuło, po prostu nie było
  // czego przesiać. Pasek mówi to miną i jednym zdaniem, zamiast straszyć
  // czerwienią i etapem, na którym „się nie udało".
  $("#errorBar").innerHTML = error.empty
    ? `<div class="banner banner--quiet">
         <div class="banner__icon banner__icon--face">😔</div>
         <div class="banner__body">
           <h3>${escape(error.message)}</h3>
           <p>Mów bliżej mikrofonu albo trzymaj klawisze dłużej niż sekundę.</p>
         </div>
         <button class="btn btn--sm" data-act="dismiss-error">Zamknij</button>
       </div>`
    : `<div class="banner banner--error">
         <div class="banner__icon"><svg><use href="#i-alert" /></svg></div>
         <div class="banner__body">
           <h3>Nie udało się — etap: ${escape(error.stage ?? "nieznany")}</h3>
           <p>${escape(error.message)}</p>
         </div>
         <button class="btn btn--sm" data-act="dismiss-error">Zamknij</button>
       </div>`;
}

function renderBanner() {
  const { status } = state;
  if (status.accessibility) {
    $("#banner").innerHTML = "";
    return;
  }

  // Bez uiohooka skrót nie ginie — zostaje przełącznik ⌃⌥Spacja. Warto o tym
  // powiedzieć wprost, zamiast zostawiać człowieka z samym komunikatem o błędzie.
  const fallback =
    status.backend === "globalShortcut"
      ? "<p>Do tego czasu działa przełącznik <b>⌃⌥Spacja</b>: raz włącza nagrywanie, drugi raz kończy.</p>"
      : "";

  $("#banner").innerHTML = `<div class="banner">
       <div class="banner__icon"><svg><use href="#i-alert" /></svg></div>
       <div class="banner__body">
         <h3>Cribro potrzebuje zgody „Dostępność"</h3>
         <p>Bez niej nie usłyszy skrótu na klawiaturze ani nie wklei tekstu pod kursor. Sam schowek działa i tak.</p>
         ${fallback}
         <p class="banner__hint">Jeśli Cribro jest już na liście, ale zgoda nie działa: usuń wpis przyciskiem „−", wróć tutaj i kliknij ponownie.</p>
       </div>
       <button class="btn btn--amber" data-act="perm-accessibility">Przyznaj dostęp</button>
     </div>`;
}


/* ── Panel admina ──────────────────────────────────────────────────
   Kto się zarejestrował i co ma widzieć. Osobna zakładka, nie karta
   w Ustawieniach — dlaczego, mówi komentarz przy pozycji w nawigacji
   (index.html).

   Widok jest CIENKI z założenia: pyta proces główny o stan i odsyła mu
   kliknięcia. Reguła „on / off / tylko zaproszeni" mieszka w bazie
   (supabase/schema.sql), opisy funkcji w main/admin.js, a tutaj zostaje
   sam rysunek. */

const ADMIN_STATES = [
  ["on", "Wszyscy", "Funkcja jest widoczna dla każdego zalogowanego."],
  ["invited", "Zaproszeni", "Widzą ją tylko ci, którym nadano ją imiennie."],
  ["off", "Nikt", "Nie widzi jej nikt poza Tobą — masz czym testować."],
];

const admin = { users: [], features: [], loading: false, error: null, busy: null };

async function renderAdmin() {
  const root = $("#view-admin");

  if (!admin.users.length && !admin.error && !admin.loading) {
    admin.loading = true;
    root.innerHTML = `<div class="card"><p class="muted">Pytam serwer…</p></div>`;
    try {
      const state = await api.admin.state();
      admin.users = state.users ?? [];
      admin.features = state.features ?? [];
      admin.error = null;
    } catch (problem) {
      admin.error = String(problem.message ?? problem);
    } finally {
      admin.loading = false;
    }
  }

  if (admin.error) {
    /* Najczęstsza przyczyna nie jest awarią, tylko brakiem: schematu nie
       wgrano jeszcze do bazy. Mówimy o tym wprost i podajemy plik, bo to
       jest cała robota do wykonania. */
    root.innerHTML = `
      <div class="card">
        <h3>Panel nie odpowiada</h3>
        <p class="muted">${escape(admin.error)}</p>
        <p class="muted">Jeśli to pierwszy raz: wklej <code>supabase/schema.sql</code>
           do SQL Editora w panelu Supabase i naciśnij Run.</p>
        <button class="btn" data-admin="reload">Spróbuj ponownie</button>
      </div>`;
    return translateTree(root);
  }

  root.innerHTML = `
    <div class="card">
      <h3>Funkcje</h3>
      <p class="muted">Co widzą subskrybenci. Zmiana działa u nich od następnego uruchomienia aplikacji.</p>
      <div class="admin__features">${admin.features.map(featureRow).join("")}</div>
    </div>

    <div class="card">
      <h3>Zarejestrowani <span class="pill">${admin.users.length}</span></h3>
      <p class="muted">Konta z bazy. Znaczek w kolumnie funkcji znaczy: nadane imiennie.</p>
      ${admin.users.length ? usersTable() : '<p class="muted">Jeszcze nikogo.</p>'}
    </div>`;
  translateTree(root);
}

function featureRow(feature) {
  const buttons = ADMIN_STATES.map(
    ([value, label, why]) => `
      <button class="seg__btn" data-admin="state" data-code="${feature.code}"
              data-value="${value}" aria-pressed="${String(feature.state === value)}"
              title="${escape(why)}">${label}</button>`,
  ).join("");
  return `
    <div class="admin__feature">
      <div>
        <b>${escape(feature.label)}</b>
        <span class="muted">${escape(feature.note ?? "")}</span>
        ${feature.known ? "" : '<span class="admin__warn">brak w bazie — wgraj schemat</span>'}
      </div>
      <div class="seg">${buttons}</div>
    </div>`;
}

function usersTable() {
  /* Kolumna na funkcję, ale tylko na te wpuszczane imiennie. Przełącznik
     przy funkcji widocznej dla wszystkich nic by nie zmieniał, a wyglądał
     na coś, co zmienia. */
  const invited = admin.features.filter((item) => item.state === "invited");
  const head = invited.map((item) => `<th title="${escape(item.note ?? "")}">${escape(item.label)}</th>`).join("");

  const rows = admin.users
    .map((user) => {
      const cells = invited
        .map((item) => {
          const on = (user.features ?? []).includes(item.code);
          return `<td class="admin__cell">
            <button class="admin__grant" data-admin="grant" data-code="${item.code}"
                    data-user="${user.id}" aria-pressed="${String(on)}"
                    title="${on ? "Odbierz dostęp" : "Nadaj dostęp"}">${on ? "✓" : "—"}</button>
          </td>`;
        })
        .join("");
      return `
        <tr>
          <td>
            <b>${escape(user.email ?? "—")}</b>
            ${user.confirmed ? "" : '<span class="admin__warn">niepotwierdzony</span>'}
          </td>
          <td class="muted">${escape(user.display_name ?? "")}</td>
          <td><span class="pill">${escape(user.plan ?? "free")}</span></td>
          <td class="muted">${shortDate(user.created_at)}</td>
          <td class="muted">${user.last_sign_in ? shortDate(user.last_sign_in) : "—"}</td>
          ${cells}
        </tr>`;
    })
    .join("");

  return `
    <div class="admin__scroll">
      <table class="admin__table">
        <thead><tr>
          <th>Adres</th><th>Nazwa</th><th>Plan</th><th>Konto od</th><th>Ostatnio</th>${head}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Data w postaci, którą czyta się bez liczenia. */
function shortDate(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleDateString(uiLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

async function onAdminClick(event) {
  const button = event.target.closest("[data-admin]");
  if (!button) return;
  const what = button.dataset.admin;

  if (what === "reload") {
    admin.error = null;
    admin.users = [];
    return void render();
  }

  /* Podwójne kliknięcie w trakcie żądania wysłałoby drugie, sprzeczne
     z pierwszym — a wynik zależałby od tego, które wróci później. */
  if (admin.busy) return;
  admin.busy = what;
  button.disabled = true;

  try {
    if (what === "state") {
      const { code, value } = button.dataset;
      await api.admin.setFeature(code, value);
      const feature = admin.features.find((item) => item.code === code);
      if (feature) feature.state = value;
      toast(t("Zapisane."));
    } else if (what === "grant") {
      const { code, user } = button.dataset;
      const on = button.getAttribute("aria-pressed") !== "true";
      await api.admin.grant(code, user, on);
      const person = admin.users.find((item) => item.id === user);
      if (person) {
        const have = new Set(person.features ?? []);
        if (on) have.add(code);
        else have.delete(code);
        person.features = [...have];
      }
    }
    await renderAdmin();
  } catch (problem) {
    toast(String(problem.message ?? problem));
    button.disabled = false;
  } finally {
    admin.busy = null;
  }
}

/* ── Render ───────────────────────────────────────────────────── */

function render() {
  /* Zakładka schodzi z ekranu razem z tym, co na niej stało — a uchwyt
     przenoszenia linii stoi na współrzędnych OKNA, nie notatki, i sam się
     o tym nie dowie: kursor nie drgnął, więc nic mu nie powie, że notatki
     pod nim już nie ma. Zostawał wtedy sześcioma kropkami na obcej
     zakładce i łapał kliknięcia zamiast tego, co pod nim. */
  window.CribroEditor?.parkAll();

  const view = VIEWS[state.view];
  $("#title").textContent = view.title;
  /* Podtytuł Ustawień wymieniał „dostawców" — a dostawców widzi wyłącznie
     właściciel (patrz main/owner.js). Zapowiadanie czegoś, czego na stronie
     nie ma, jest gorsze niż brak zapowiedzi. */
  $("#subtitle").textContent =
    state.view === "settings" && state.settings && !state.settings.owner
      ? t("Skróty, konto, prywatność.")
      : view.subtitle;
  $("#titlePill").textContent = state.settings
    ? t("Sito {mesh}", { mesh: t(MESH[state.settings.mesh].name) })
    : "";

  /* ══ CZEGO W TYM OKNIE NIE MA ══

     Dwie różne granice, oba razy chowające całą zakładkę, a nie blokujące
     ją napisem „niedostępne":

       PANEL należy do właściciela (main/owner.js). Zwykły użytkownik nie ma
       się dowiedzieć, że taka zakładka istnieje.

       NOTATKI ZE SPOTKAŃ są w becie i wolno je wyłączyć zdalnie, bez
       wydawania nowej wersji (main/admin.js). Odpowiedź przychodzi
       z serwera; gdy nie przyszła, widać wszystko — wyłączenie jest
       decyzją, milczenie nie.

     Zakładka schowana, a nie wyszarzona, bo wyszarzona nadal mówi, co
     w niej stało — a przy funkcji w becie to jest obietnica, której nikt
     nie składał. */
  const showFeature = (code) => state.settings?.features?.[code] !== false;
  const visible = (view) =>
    view === "admin" ? !!state.settings?.owner : showFeature(view);

  document.querySelectorAll(".nav__item").forEach((item) => {
    const shown = visible(item.dataset.view);
    item.hidden = !shown;
    item.setAttribute("aria-selected", String(shown && item.dataset.view === state.view));
  });

  /* Zakładka mogła zniknąć pod ręką — po wylogowaniu albo po zdalnym
     wyłączeniu funkcji. Stanie na niej znaczyłoby puste okno bez wyjścia. */
  if (!visible(state.view)) {
    state.view = "start";
    return render();
  }
  document.querySelectorAll(".view").forEach((section) => {
    section.hidden = section.id !== `view-${state.view}`;
  });

  renderBanner();
  renderErrorBar();
  if (state.view === "start") renderStart();
  if (state.view === "notes") NotesView.show();
  /* Widok spotkań sam pyta proces główny o spis i o to, czy coś się właśnie
     nagrywa — dlatego dostaje tylko ustawienia, a resztę bierze sobie sam. */
  if (state.view === "meetings") MeetingsView.show($("#view-meetings"), state.settings);
  else MeetingsView.hide();
  if (state.view === "sieve") renderSieve();
  if (state.view === "grains") renderGrains();
  if (state.view === "commands") renderCommands();
  if (state.view === "settings") renderSettings();
  if (state.view === "admin") void renderAdmin();

  const hold = state.settings?.hotkey.hold.map((key) => KEY_GLYPH[key] ?? key) ?? [];
  $("#keycap").innerHTML =
    hold.map((key) => `<kbd>${key}</kbd>`).join("") + `<span>${t("trzymaj i mów")}</span>`;

  // Widoki powstają z polskich szablonów; jeśli interfejs ma być angielski,
  // podmiana dzieje się tu, na gotowym drzewie.
  translateTree();
}

/* ── Zdarzenia ────────────────────────────────────────────────── */

function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let cursor = object;
  for (const key of keys) cursor = cursor[key] ??= {};
  cursor[last] = value;
}

function patchFor(path, value) {
  const patch = {};
  setPath(patch, path, value);
  return patch;
}

async function save(path, value) {
  setPath(state.settings, path, value);
  state.settings = await api.settings.save(patchFor(path, value));
}

document.addEventListener("click", async (event) => {
  // Panel admina ma własny obieg — idzie pierwszy, bo jego przyciski nie
  // przypominają niczego innego w tym oknie i nie ma z czym kolidować.
  if (event.target.closest("[data-admin]")) return void onAdminClick(event);

  const link = event.target.closest('[data-act="open-link"]');
  if (link) {
    event.preventDefault();
    await api.system.openExternal(link.getAttribute("href"));
    return;
  }

  if (event.target.closest("#railToggle")) {
    setRail(!$("#app").classList.contains("is-rail"));
    return;
  }

  // Przewodnik. Otwiera się zawsze od pierwszego slajdu — kto do niego
  // wraca, wraca po całość, a nie po miejsce, w którym skończył.
  if (event.target.closest("#guideOpen")) {
    window.CribroGuide?.open(0);
    return;
  }

  if (event.target.closest('[data-act="quick-note"]')) {
    await api.notes.quick();
    return;
  }

  /* Zaznaczanie ekranu z Ustawień. Okno główne zostaje w tle: krzyżyk
     rysuje system i to on jest teraz na wierzchu, a my nie mamy nic
     do pokazania, dopóki człowiek czegoś nie zaznaczy. */
  if (event.target.closest('[data-act="shot-grab"]')) {
    await api.shot.grab();
    return;
  }

  if (event.target.closest('[data-act="shot-file"]')) {
    await api.system.readShotFile();
    return;
  }

  /* Nasłuch klawiszy. Zapisujemy dopiero przy klawiszu ZNAKOWYM — sam
     modyfikator nie jest skrótem w rozumieniu systemu i nie da się go
     zarejestrować (patrz detectConflicts w main/shortcuts.js). */
  const recordKeys = event.target.closest('[data-act="keys-record"]');
  if (recordKeys) {
    const target = KEYS[recordKeys.dataset.keys];
    /* Kliknięcie w ten sam przycisk drugi raz przerywa, a kliknięcie
       w cudzy — przenosi nasłuch. Nasłuch jest jeden, więc nie ma stanu,
       w którym dwa pola czekają na te same klawisze. */
    state.keysFor = state.keysFor === target.path ? null : target.path;
    render();
    return;
  }

  const clearKeys = event.target.closest('[data-act="keys-clear"]');
  if (clearKeys) {
    const target = KEYS[clearKeys.dataset.keys];
    state.keysFor = null;
    await save(target.path, target.fallback ?? null);
    render();
    toast(t(target.cleared));
    return;
  }

  if (event.target.closest('[data-act="check-hotkeys"]')) {
    state.conflicts = { pending: true, results: [] };
    render();

    // Sprawdzamy oba skróty naraz: sam przełącznik nie mówi nic o tym,
    // czy szybka notatka nie wejdzie mu w drogę, kiedy dostanie klawisze.
    const targets = [
      { label: "Przełącznik dyktowania", accelerator: state.settings.hotkey.toggleAccelerator },
      { label: "Szybka notatka", accelerator: state.settings.hotkey.quickNote },
      { label: "Tekst z ekranu", accelerator: state.settings.shot?.hotkey },
    ].filter((item) => item.accelerator);

    const results = [];
    for (const target of targets) {
      const report = await api.system.checkHotkey(target.accelerator);
      results.push({ ...report, label: target.label });
    }
    state.conflicts = { pending: false, results };
    render();
    return;
  }

  const nav = event.target.closest(".nav__item");
  if (nav && nav.dataset.view) {
    state.view = nav.dataset.view;
    render();
    return;
  }

  /* Poranek: podłączenie konta, odłączenie i pokazanie na żądanie.
     Wszystkie trzy mogą zawieść w sposób, o którym trzeba powiedzieć —
     „cudze konto" i „brak klienta OAuth" to nie są awarie, tylko odpowiedzi. */
  const brief = event.target.closest("[data-brief]");
  if (brief) {
    const what = brief.dataset.brief;
    const was = brief.textContent;
    try {
      if (what === "connect") {
        brief.textContent = t("Czekam na przeglądarkę…");
        brief.disabled = true;
        state.briefing = await api.briefing.connect();
        state.settings = await api.settings.get();
  /* Czyja to instalacja — jednym słowem dla całego okna. Przewodnik
     (js/onboarding.js) rysuje z tego inny ostatni slajd; patrz
     main/owner.js. */
  window.CribroOwner = !!state.settings.owner;
        toast(t("Konto podłączone."));
      } else if (what === "disconnect") {
        state.briefing = await api.briefing.disconnect();
        toast(t("Konto odłączone."));
      } else if (what === "show") {
        await api.briefing.show();
      }
    } catch (error) {
      toast(String(error.message ?? error));
    } finally {
      brief.textContent = was;
      brief.disabled = false;
      render();
    }
    return;
  }

  const mesh = event.target.closest("[data-mesh]");
  if (mesh) {
    await save("mesh", mesh.dataset.mesh);
    render();
    toast(t("Sito {mesh}", { mesh: t(MESH[mesh.dataset.mesh].name).toLowerCase() }));
    return;
  }

  const toggleEl = event.target.closest("[data-toggle]");
  if (toggleEl) {
    const next = toggleEl.getAttribute("aria-checked") !== "true";
    toggleEl.setAttribute("aria-checked", String(next));
    await save(toggleEl.dataset.toggle, next);
    return;
  }

  const grainRemove = event.target.closest("[data-grain]");
  if (grainRemove) {
    const grains = [...state.settings.grains];
    grains.splice(Number(grainRemove.dataset.grain), 1);
    await save("grains", grains);
    render();
    return;
  }

  if (event.target.closest("#grainAdd")) return addGrain();

  if (event.target.closest("#clearHistory")) {
    state.history = await api.history.clear();
    state.stats = await api.history.stats();
    render();
    toast(t("Wyczyszczone. Przypięte zostały."));
    return;
  }

  if (event.target.closest("#dictate") || event.target.closest('[data-act="capture"]')) {
    state.error = null;
    try {
      await api.system.capture();
    } catch (error) {
      state.error = { stage: "nagrywanie", message: String(error.message || error) };
      render();
    }
    return;
  }

  const cloudAct = event.target.closest(
    '[data-act="cloud-signin"], [data-act="cloud-signup"], [data-act="cloud-signout"], [data-act="cloud-sync"], [data-act="cloud-reset"], [data-act="cloud-google"], [data-act="cloud-cancel"], [data-act="cloud-copy-redirects"]',
  );
  if (cloudAct) {
    await runCloudAction(cloudAct.dataset.act, cloudAct);
    return;
  }

  const notionAct = event.target.closest('[data-act="notion-check"]');
  if (notionAct) {
    notionAct.disabled = true;
    state.notionCheck = { ok: true, note: t("Pytam Notion…") };
    render();
    try {
      await api.system.checkNotion();
      state.notionCheck = { ok: true, note: t("Działa — Notion widzi tę stronę.") };
    } catch (error) {
      state.notionCheck = { ok: false, note: plainError(error) };
    }
    render();
    return;
  }

  if (event.target.closest('[data-act="widget-reset"]')) {
    await api.widget.reset();
    toast(t("Widget wrócił na swoje miejsce"));
    return;
  }

  if (event.target.closest('[data-act="open-notes"]')) {
    await api.notes.open();
    return;
  }

  if (event.target.closest('[data-act="dismiss-error"]')) {
    state.error = null;
    render();
    return;
  }

  if (event.target.closest('[data-act="perm-microphone"]')) {
    await api.system.request("microphone");
    state.status = await api.system.status();
    render();
    return;
  }

  const test = event.target.closest(
    '[data-act="test-stt"], [data-act="test-sieve"], [data-act="test-shot"]',
  );
  if (test) {
    const which = test.dataset.act.replace("test-", "");
    test.disabled = true;
    state.tests[which] = { ok: false, note: t("Sprawdzam…") };
    render();
    try {
      const result =
        which === "stt"
          ? await api.system.testStt()
          : which === "shot"
            ? await api.system.testShot()
            : await api.system.testSieve();
      state.tests[which] =
        which === "stt" || which === "shot"
          ? { ok: result.ok !== false, note: result.note ?? "Połączono." }
          : {
              ok: result.ok,
              note: result.ok
                ? `Sito odpowiedziało w ${result.ms} ms (${result.model}): „${result.text}"`
                : "Brak klucza — sito odda surowy transkrypt.",
            };
    } catch (error) {
      state.tests[which] = { ok: false, note: String(error.message || error) };
    }
    render();
    return;
  }

  if (event.target.closest('[data-act="perm-accessibility"]')) {
    await api.system.request("accessibility");
    state.status = await api.system.status();
    render();
    return;
  }

  /* ── Polecenia ── */
  const cmdToggle = event.target.closest("[data-cmd-toggle]");
  if (cmdToggle) {
    const id = cmdToggle.dataset.cmdToggle;
    const items = (state.settings.commands?.items ?? []).map((item) =>
      item.id === id ? { ...item, enabled: !item.enabled } : item,
    );
    await save("commands.items", items);
    render();
    return;
  }

  const triggerRemove = event.target.closest("[data-trigger]");
  if (triggerRemove && state.commandDraft) {
    state.commandDraft.triggers.splice(Number(triggerRemove.dataset.trigger), 1);
    render();
    return;
  }

  const bypassRemove = event.target.closest("[data-bypass]");
  if (bypassRemove) {
    const list = [...(state.settings.commands?.bypass ?? [])];
    list.splice(Number(bypassRemove.dataset.bypass), 1);
    await save("commands.bypass", list);
    render();
    return;
  }

  const cmdAct = event.target.closest(
    '[data-act="cmd-add"], [data-act="cmd-edit"], [data-act="cmd-delete"], [data-act="cmd-save"], [data-act="cmd-cancel"], [data-act="trigger-add"], [data-act="bypass-add"], [data-act="cmd-probe"]',
  );
  if (cmdAct) {
    await commandAction(cmdAct);
    return;
  }

  /* Akcje na wpisie */
  const action = event.target.closest("[data-act]");
  const article = event.target.closest(".entry");
  if (!action || !article) return;

  const id = article.dataset.id;
  const entry = state.history.find((item) => item.id === id);
  if (!entry) return;

  switch (action.dataset.act) {
    case "copy":
      await api.system.copy(entry.text);
      toast(t("Skopiowane do schowka"));
      break;
    case "toggle":
      state.collapsedDiffs.has(id) ? state.collapsedDiffs.delete(id) : state.collapsedDiffs.add(id);
      render();
      break;
    case "pin":
      await api.history.update(id, { pinned: !entry.pinned });
      entry.pinned = !entry.pinned;
      render();
      break;
    case "delete":
      await api.history.remove(id);
      state.history = state.history.filter((item) => item.id !== id);
      state.stats = await api.history.stats();
      render();
      toast(t("Usunięte"));
      break;
    case "unsift": {
      toast(t("Przesiewam bez polecenia…"));
      try {
        const updated = await api.history.resift(id, entry.mesh, true);
        if (updated) Object.assign(entry, updated);
        render();
      } catch (error) {
        toast(String(error.message || error));
      }
      break;
    }
    case "resift": {
      const order = ["zgrubne", "srednie", "drobne"];
      const next = order[(order.indexOf(entry.mesh) + 1) % order.length];
      toast(t("Przesiewam ponownie — sito {mesh}…", { mesh: t(MESH[next].name).toLowerCase() }));
      try {
        const updated = await api.history.resift(id, next);
        if (updated) Object.assign(entry, updated);
        render();
      } catch (error) {
        toast(String(error.message || error));
      }
      break;
    }
  }
});

document.addEventListener("input", (event) => {
  // Formularz konta przeżywa przerysowanie widoku tylko dlatego, że
  // trzymamy jego zawartość obok — patrz state.cloudForm.
  if (event.target.id === "cloudEmail") state.cloudForm.email = event.target.value;
  if (event.target.id === "cloudPassword") state.cloudForm.password = event.target.value;

  // Formularz polecenia — ta sama sztuczka: wpisywane pola żyją w drafcie,
  // nie w DOM-ie, bo widok przerysowuje się w całości.
  if (event.target.id === "probeText") state.probeText = event.target.value;
  const draftField = event.target.closest("[data-draft]");
  if (draftField && state.commandDraft) {
    const key = draftField.dataset.draft;
    state.commandDraft[key] = key === "mesh" ? draftField.value || null : draftField.value;
    // Wyjaśnienie pod „Ujściem" mówi, czym te cztery pozycje się różnią —
    // musi więc nadążać za wyborem.
    if (key === "outlet") render();
  }

  if (event.target.id === "search") {
    state.query = event.target.value;
    const focus = document.activeElement === event.target;
    renderStart();
    if (focus) {
      const input = $("#search");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

document.addEventListener("change", async (event) => {
  /* Kanały zapisujemy przy WYJŚCIU z pola, nie przy każdej literze:
     w trakcie pisania adresu połowa wierszy to jeszcze nie są adresy,
     a każdy zapis przerysowuje widok i zabiera kursor. */
  const feeds = event.target.closest("[data-brief-feeds]");
  if (feeds) {
    const rows = feeds.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((url) => ({ url, name: "" }));
    await save("briefing.feeds", rows);
    return;
  }

  const lang = event.target.closest("[data-spell-lang]");
  if (lang) {
    const chosen = new Set(state.settings.spellcheck?.languages ?? []);
    lang.checked ? chosen.add(lang.dataset.spellLang) : chosen.delete(lang.dataset.spellLang);
    await save("spellcheck.languages", [...chosen]);
    return;
  }

  const field = event.target.closest("[data-setting]");
  if (!field) return;
  await save(field.dataset.setting, field.value);

  // Po zmianie dostawcy stary model prawie na pewno u niego nie istnieje —
  // przestawiamy na pierwszy z jego listy, zamiast czekać na błąd 404.
  const [stage, key] = field.dataset.setting.split(".");
  if (key === "provider" && (stage === "stt" || stage === "sieve")) {
    const first = state.providers[stage]?.[field.value]?.models?.[0]?.[0];
    if (first) await save(`${stage}.model`, first);
    state.tests[stage] = null;
    render();
    return;
  }
  if (field.dataset.setting === "uiLanguage") {
    setLanguage(field.value);
    render();
    return;
  }
  // Zmiana widoku widgetu przepisuje wyjaśnienie pod pokrętłem — a jest
  // ono tym, co w ogóle mówi, czym te dwa widoki się różnią.
  const rerender = ["mesh", "hotkey", "language", "widget.mode"];
  if (rerender.some((prefix) => field.dataset.setting.startsWith(prefix))) render();
});

/**
 * Nazwa klawisza w zapisie, który rozumie system.
 *
 * Bierzemy `code`, a nie `key`, i to jest cała sztuczka: na macOS ⌥+S
 * daje `key === "ß"`, a ⌥+A daje „å". Zapisany tak skrót nie zarejestruje
 * się nigdy, bo systemowi chodzi o klawisz pod palcem, a nie o znak, który
 * z niego wypadł. `code` mówi o klawiszu.
 */
function accelKey(event) {
  const code = event.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;

  const NAMED = {
    Space: "Space", Enter: "Return", Tab: "Tab",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  };
  return NAMED[code] ?? null;
}

/* Ustawianie klawiszy do zrzutu ekranu — jedyne miejsce w aplikacji,
   w którym skrót wybiera się palcami, a nie z listy.

   Nasłuch idzie w fazie przechwytywania i zabiera zdarzenie reszcie okna.
   Bez tego Escape zamykałby okno zamiast przerywać ustawianie, a ⌘F
   otwierało szukanie w notatkach w trakcie zapisywania skrótu. */
document.addEventListener(
  "keydown",
  async (event) => {
    if (!state.keysFor) return;
    const target = Object.values(KEYS).find((item) => item.path === state.keysFor);
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      state.keysFor = null;
      return render();
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      state.keysFor = null;
      await save(target.path, target.fallback ?? null);
      render();
      return toast(t(target.cleared));
    }

    /* TRZYMANIE JEST STANEM KLAWIATURY, NIE SKRÓTEM SYSTEMOWYM — i dlatego
       kończy się tutaj, przed całą resztą. Nie ma czego rejestrować, nie ma
       kogo pytać o konflikt (żaden interfejs nie widzi aplikacji, która
       podsłuchuje klawiaturę) i nie ma klawisza znakowego pod modyfikatorami.

       Dwa modyfikatory to minimum, i nie jest to ostrożność na zapas: jeden
       trzyma się przy zwykłym pisaniu dziesiątki razy na minutę, więc skrót
       na jednym ruszałby nagranie sam. Trzy to maksimum, bo czwarty nie
       zostawia już ręki na nic innego. */
    if (target.kind === "hold") {
      const held = HOLD_KEYS.filter(([flag]) => event[flag]).map(([, name]) => name);
      if (accelKey(event)) {
        return toast(t("Do trzymania biorą się same modyfikatory — bez litery."));
      }
      if (held.length < 2) return; // czekamy, aż dojdzie drugi
      if (held.length > 3) return toast(t("Najwyżej trzy klawisze — czwarty nie zostawia ręki."));

      state.keysFor = null;
      await save(target.path, held);
      render();
      return toast(
        t("{skrót} ustawione do trzymania.", {
          skrót: held.map((key) => KEY_GLYPH[key] ?? key).join(""),
        }),
      );
    }

    const key = accelKey(event);
    if (!key) return; // sam modyfikator — czekamy na klawisz pod nim

    const mods = [];
    if (event.ctrlKey) mods.push("Control");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.metaKey) mods.push("Command");
    /* Gołe „S" zabrałoby tę literę całemu systemowi — każdemu polu
       tekstowemu w każdej aplikacji. Skrót globalny musi mieć modyfikator. */
    if (!mods.length) return toast(t("Skrót globalny potrzebuje ⌘, ⌃, ⌥ albo ⇧."));

    const accelerator = [...mods, key].join("+");
    state.keysFor = null;
    await save(target.path, accelerator);
    render();

    /* Od razu sprawdzamy, czy klawisze są wolne. Skrót, który się nie
       zarejestrował, milczy dokładnie tak samo jak skrót, którego nie ma —
       i to jest najgorsza rzecz, jaką może zrobić ustawienie. */
    const report = await api.system.checkHotkey(accelerator);
    const clash = report?.conflicts?.[0];
    toast(
      clash
        ? t("{skrót} jest zajęty: {kto}", { skrót: glyphs(accelerator), kto: clash.name })
        : t("{skrót} ustawiony.", { skrót: glyphs(accelerator) }),
    );
  },
  true,
);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (event.target.id === "grainInput") addGrain();
  if (event.target.id === "triggerInput") commandAction({ dataset: { act: "trigger-add" } });
  if (event.target.id === "bypassInput") commandAction({ dataset: { act: "bypass-add" } });
  if (event.target.id === "probeText") commandAction({ dataset: { act: "cmd-probe" } });
});

/* Escape ma tu cztery zadania i kolejność między nimi jest ustalona: najpierw
   przerywa to, co trwa, potem zdejmuje to, co leży na wierzchu, a dopiero
   gdy nie ma już czego zdjąć — zamyka okno.

   1. NAGRANIE. Kasuje je w całości, bez transkrypcji i bez wpisu. Silnik
      skrótu łapie Escape globalnie; to jest droga na wypadek, gdy fokus
      siedzi w oknie, bo wtedy klawisz nie wychodzi na zewnątrz.
   2. PISANIE. Pierwszy Escape wychodzi z pola, dopiero drugi zamyka okno —
      odruchowe „escape" w środku notatki nie ma prawa sprzątnąć okna sprzed
      nosa. Zmiany i tak są zapisane, ale zniknięcie okna to zaskoczenie.
   3. KARTKI NA PULPICIE. Leżą nad wszystkim i schodzą z wierzchu wyłącznie
      na wyraźny gest — Escape jest tym gestem tak samo jak kliknięcie
      w znaczek. Przed oknem, bo talia jest wierzchnią warstwą: schowanie
      okna zostawiłoby ją na ekranie.
   4. OKNO. Chowa się do paska menu, nie znika: aplikacja żyje dalej i czeka
      na skrót. Wraca przez znaczek w pasku, ⌘Tab albo Dock.

   Rzeczy, które Escape obsługują same u siebie (przepisywanie tytułu na
   liście notatek), zaznaczają to przez preventDefault i tu nie dochodzą. */
const isEditing = (node) =>
  !!node &&
  (node.isContentEditable ||
    node.tagName === "INPUT" ||
    node.tagName === "TEXTAREA" ||
    node.tagName === "SELECT");

document.addEventListener("keydown", async (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();

  if (state.runtime === "listening") {
    api.system.cancelCapture?.();
    return;
  }
  if (isEditing(document.activeElement)) {
    document.activeElement.blur();
    return;
  }
  // Talia mieszka w innych oknach, więc o to, czy w ogóle leży, pyta się
  // proces główny — odpowiedź „nie było czego chować" przepuszcza Escape dalej.
  if (await api.deck.escape()) return;
  api.system.close();
});

/* Skróty formatowania działają w zakładce Notatki — ⌘B i ⌘I obsługuje
   sam edytor, tutaj zostaje reszta paska. */
const FORMAT_KEYS = {
  h: "h2", // ⌘⇧H zostaje „nagłówkiem" bez numeru — tym, po który sięga ręka
  1: "h1",
  2: "h2",
  3: "h3",
  "!": "h1", // te same klawisze z ⇧ na klawiaturze polskiej i amerykańskiej
  "@": "h2",
  "#": "h3",
  e: "toggle",
  "-": "divider",
  _: "divider",
  j: "justify",
  8: "bullet",
  9: "todo",
  "'": "quote",
  "*": "bullet",
  "(": "todo",
  '"': "quote",
};

document.addEventListener("keydown", (event) => {
  if (state.view !== "notes" || !event.metaKey || event.defaultPrevented) return;

  if (event.key === "f") {
    event.preventDefault();
    NotesView.focusSearch();
    return;
  }
  if (!event.shiftKey) return;

  // ⌘⇧L — lista notatek w bok i z powrotem. To samo robi uchwyt na jej
  // krawędzi i strzałka w pasku narzędzi notatki.
  if (event.key.toLowerCase() === "l") {
    if (NotesView.toggleList()) event.preventDefault();
    return;
  }

  const kind = FORMAT_KEYS[event.key.toLowerCase()];
  if (kind && NotesView.format(kind)) event.preventDefault();
});

/**
 * Komunikat błędu bez rusztowania mostu.
 *
 * `ipcRenderer.invoke` opakowuje każdy wyjątek w „Error invoking remote
 * method 'cloud:signIn': Error: …". Przy sprawdzaniu klucza API to tylko
 * brzydkie, ale przy logowaniu jedyne, co człowiek ma przeczytać, to zdanie
 * o haśle — a nie nazwa kanału IPC.
 */
const plainError = (error) =>
  String(error?.message ?? error)
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "");

/** Konto: logowanie, rejestracja, wylogowanie i synchronizacja na żądanie. */
async function runCloudAction(act, button) {
  const { email, password } = state.cloudForm;
  state.cloud = { ...state.cloud, error: null, note: null };
  button.disabled = true;

  try {
    if (act === "cloud-signin" || act === "cloud-signup") {
      if (!email.trim() || !password) throw new Error(t("Podaj adres e-mail i hasło."));
      if (act === "cloud-signin") {
        state.cloud = { ...(await api.cloud.signIn(email, password)), note: t("Zalogowano.") };
      } else {
        const result = await api.cloud.signUp(email, password);
        state.cloud = {
          ...result,
          note: result.needsConfirmation
            ? t("Konto założone. Kliknij link z poczty, potem zaloguj się tutaj.")
            : t("Konto założone i zalogowane."),
        };
      }
      // Hasło znika z pamięci interfejsu, gdy tylko przestało być potrzebne.
      state.cloudForm.password = "";
    } else if (act === "cloud-google") {
      // Odpowiedź przychodzi dopiero po powrocie z przeglądarki — może to
      // potrwać minutę. Ekran „czekam" pokazuje się w międzyczasie sam,
      // rozgłoszeniem z procesu głównego (cloud:changed).
      state.cloud = { ...(await api.cloud.signInWith("google")), note: t("Zalogowano.") };
    } else if (act === "cloud-cancel") {
      state.cloud = { ...(await api.cloud.cancelSignIn()), note: null };
    } else if (act === "cloud-copy-redirects") {
      await api.system.copy((state.redirects ?? []).join("\n"));
      state.cloud = { ...state.cloud, note: t("Adresy w schowku.") };
    } else if (act === "cloud-signout") {
      state.cloud = { ...(await api.cloud.signOut()), note: t("Wylogowano. Notatki zostają na tym dysku.") };
    } else if (act === "cloud-reset") {
      if (!email.trim()) throw new Error(t("Podaj adres, na który wysłać link."));
      await api.cloud.resetPassword(email);
      state.cloud = { ...state.cloud, note: t("Link poszedł na podany adres.") };
    } else if (act === "cloud-sync") {
      const result = await api.cloud.sync();
      state.cloud = {
        ...result,
        note: t("Przyjęte: {taken}, wysłane: {pushed}.", {
          taken: result.report.taken,
          pushed: result.report.pushed,
        }),
      };
    }
  } catch (error) {
    state.cloud = { ...state.cloud, error: plainError(error) };
  }

  render();
}

/** Zapis kilku pól poleceń naraz — kasowanie rusza listę i zakładkę razem. */
async function saveCommands(patch) {
  Object.assign(state.settings.commands, patch);
  state.settings = await api.settings.save({ commands: patch });
}

/**
 * Wszystko, co da się zrobić na karcie Poleceń.
 *
 * Jedna funkcja, bo to jedna rozmowa o jednej liście — a przycisk „Dodaj"
 * i Enter w polu obok mają robić dokładnie to samo (stąd wołanie z atrapą
 * elementu w obsłudze klawiatury).
 */
async function commandAction(element) {
  const act = element.dataset.act;
  const items = [...(state.settings.commands?.items ?? [])];
  const id = element.closest?.("[data-cmd]")?.dataset.cmd;

  if (act === "cmd-add") {
    state.commandDraft = blankCommand();
    render();
    $("#triggerInput")?.focus();
    return;
  }

  if (act === "cmd-edit") {
    const command = items.find((item) => item.id === id);
    if (command) state.commandDraft = structuredClone(command);
    render();
    return;
  }

  if (act === "cmd-cancel") {
    state.commandDraft = null;
    render();
    return;
  }

  if (act === "cmd-delete") {
    const command = items.find((item) => item.id === id);
    /* Wbudowane trafia na listę skasowanych, inaczej wróciłoby przy
       najbliższej aktualizacji — patrz migrate w main/store.js. */
    const removed = [...(state.settings.commands?.removedBuiltins ?? [])];
    if (command?.builtin && !removed.includes(id)) removed.push(id);
    if (state.commandDraft?.id === id) state.commandDraft = null;
    await saveCommands({ items: items.filter((item) => item.id !== id), removedBuiltins: removed });
    render();
    toast(t("Usunięte"));
    return;
  }

  if (act === "trigger-add") {
    const value = $("#triggerInput")?.value.trim();
    if (!value || !state.commandDraft) return;
    if (!state.commandDraft.triggers.includes(value)) state.commandDraft.triggers.push(value);
    render();
    $("#triggerInput")?.focus();
    return;
  }

  if (act === "bypass-add") {
    const value = $("#bypassInput")?.value.trim();
    if (!value) return;
    const list = [...(state.settings.commands?.bypass ?? [])];
    if (!list.includes(value)) list.push(value);
    await save("commands.bypass", list);
    render();
    $("#bypassInput")?.focus();
    return;
  }

  if (act === "cmd-probe") {
    const text = state.probeText.trim();
    if (!text) return;
    state.probe = await api.system.probeCommand(text);
    render();
    $("#probeText")?.focus();
    return;
  }

  if (act === "cmd-save") {
    const draft = state.commandDraft;
    if (!draft) return;
    draft.name = draft.name.trim();
    draft.rules = draft.rules.trim();
    // Polecenie bez którejkolwiek z trzech części nie jest poleceniem:
    // nie miałoby jak ruszyć, nie miałoby co zrobić albo nie dałoby się
    // go rozpoznać w zapisie.
    if (!draft.name || !draft.triggers.length || !draft.rules) {
      toast(t("Polecenie potrzebuje nazwy, wywołania i wytycznej."));
      return;
    }
    const next = items.some((item) => item.id === draft.id)
      ? items.map((item) => (item.id === draft.id ? draft : item))
      : [...items, draft];
    state.commandDraft = null;
    await save("commands.items", next);
    render();
    toast(t("Zapisane"));
    return;
  }
}

async function addGrain() {
  const input = $("#grainInput");
  const value = input?.value.trim();
  if (!value) return;
  await save("grains", [...(state.settings.grains ?? []), value]);
  render();
  $("#grainInput")?.focus();
}

/* ── Stan z procesu głównego ──────────────────────────────────── */

const STATUS_COPY = {
  idle: "Gotowe",
  listening: "Słucham",
  sifting: "Przesiewam",
  done: "W schowku",
};

api.onState(async ({ state: next, entry }) => {
  state.runtime = next;
  $("#status").dataset.state = next;
  $("#statusText").textContent = STATUS_COPY[next] ?? next;
  // Podczas nasłuchu przycisk zatrzymuje; podczas przesiewania jest martwy.
  const dictate = $("#dictate");
  dictate.disabled = next === "sifting" || next === "done";
  dictate.querySelector("span")?.remove();
  dictate.lastChild.textContent = next === "listening" ? " Zatrzymaj" : " Dyktuj";
  dictate.classList.toggle("btn--amber", next === "listening");
  dictate.classList.toggle("btn--primary", next !== "listening");
  if (next === "listening") state.error = null;
  if (next === "done" && entry) {
    state.stats = await api.history.stats();
    state.history = await api.history.get();
  }
  if (state.view === "start") renderStart();
});

api.history.onNew((entry) => {
  if (!state.history.some((item) => item.id === entry.id)) state.history.unshift(entry);
});

/* „Nowa notatka" z menu aplikacji trafia tam, gdzie użytkownik patrzy. */
api.notes.onNew?.(async () => {
  state.view = "notes";
  render();
  await NotesView.createNote();
});

api.onGoToView?.((view) => {
  /* „guide" nie jest widokiem, tylko oknem nad widokami — ale przychodzi
     tym samym kanałem, bo z punktu widzenia paska menu to jest ta sama
     rzecz: pokaż mi to. */
  if (view === "guide") return void window.CribroGuide?.open(0);
  if (VIEWS[view]) {
    state.view = view;
    render();
  }
});

api.onError(({ message, stage, empty }) => {
  state.error = { message, stage, empty };
  render();
});
api.settings.onChange((settings) => {
  state.settings = settings;
  window.CribroOwner = !!settings.owner;
  setLanguage(settings.uiLanguage ?? "pl");
  MeetingsView.settings(settings);
  render();
});

/* Spotkanie zaczyna się i kończy także spoza tego okna — z menu, z tacy
   paska, a niedługo samo z siebie. Widok musi o tym wiedzieć niezależnie
   od tego, kto nacisnął, bo przycisk w spisie zmienia wtedy napis. */
api.meetings?.onChange?.((live) => MeetingsView.changed(live));

/* Synchronizacja chodzi w tle i sama z siebie — karta konta ma pokazywać
   jej stan także wtedy, gdy nikt niczego nie kliknął. Komunikat spod
   ostatniej akcji zostaje: proces główny nie wie, co tu przed chwilą
   napisaliśmy. */
api.cloud?.onChange?.((next) => {
  state.cloud = { ...next, note: state.cloud.note, error: next.error ?? null };
  if (state.view === "settings") render();
});

// Zgoda „Dostępność" potrafi się pojawić, kiedy okno stoi z boku — główny
// proces pilnuje tego za nas i przysyła gotowe zdjęcie stanu.
api.onPermissions?.((status) => {
  state.status = status;
  render();
});

/* ── Pas boczny i panel Notatnika ─────────────────────────────── */

function setRail(collapsed) {
  $("#app").classList.toggle("is-rail", collapsed);
  $("#railToggle").title = collapsed ? t("Rozwiń pas boczny") : t("Zwiń pas boczny");
  // Zwykła preferencja widoku — nie ma po co jeździć z nią przez most.
  localStorage.setItem("cribro:rail", collapsed ? "1" : "0");
}

/* ── Start ────────────────────────────────────────────────────── */

(async function boot() {
  NotesView.mount($("#view-notes"));

  state.settings = await api.settings.get();
  /* Czyja to instalacja — jednym słowem dla całego okna. Przewodnik
     (js/onboarding.js) rysuje z tego inny ostatni slajd; patrz
     main/owner.js. */
  window.CribroOwner = !!state.settings.owner;
  state.history = await api.history.get();
  state.stats = await api.history.stats();
  state.status = await api.system.status();
  state.providers = await api.system.providers();
  state.cloud = await api.cloud.state();
  state.redirects = (await api.cloud.redirects?.()) ?? [];
  state.briefing = (await api.briefing?.state?.()) ?? null;

  // Różnica między surowym a przesianym jest teraz otwarta od razu przy
  // każdym wpisie (patrz collapsedDiffs) — nie ma już czego tu podpierać
  // dla samego podglądu w przeglądarce.

  setLanguage(state.settings.uiLanguage ?? "pl");
  if (localStorage.getItem("cribro:rail") === "1") setRail(true);

  render();

  /* ══ PIERWSZE URUCHOMIENIE ══

     Aplikacja, w której wszystko dzieje się poza oknem, nie tłumaczy się
     sama: pierwszy ekran jest listą przesianych wypowiedzi, która jest
     pusta, i nie ma z czego wywnioskować, że trzeba przytrzymać dwa
     klawisze i zacząć mówić. Przewodnik pokazuje się więc raz, sam,
     i od tej chwili tylko na żądanie — przyciskiem na dole paska.

     Po `render()`, a nie przed: slajdy mają wyjść NA gotowe okno, nie
     zamiast niego. Zamknięcie przewodnika ma odsłaniać aplikację, a nie
     puste tło, które dopiero się rysuje. */
  if (!state.settings.tutorial?.seen) window.CribroGuide?.open(0);
})();
