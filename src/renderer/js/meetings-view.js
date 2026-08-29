"use strict";

/**
 * Zakładka Meeting Notes w oknie głównym.
 *
 * Spotkanie jest w Cribro trzecią rzeczą, obok dyktowania i notatki, i ma
 * własną zakładkę dokładnie dlatego, że jest trzecią rzeczą — a nie
 * odmianą którejś z tamtych dwóch. Notatka ma treść; spotkanie ma metrykę
 * (kiedy, jak długo, kto mówił) i DWA teksty, z których jeden jest zapisem,
 * a drugi wnioskiem. To się nie mieści w jednym polu.
 *
 * Układ jest ten sam co w Notatniku — jedno spojrzenie ma wystarczyć,
 * a dwa widoki obok siebie nie mają uczyć dwóch nawyków:
 *
 *      ┌── spis ──────────────┬── spotkanie ─────────────────────┐
 *      │ Nagraj spotkanie     │ metryka: kiedy · ile trwało      │
 *      │ ──────────────────── │ ──────────────────────────────── │
 *      │ czwartek, 14:00      │ [Podsumowanie] [Transkrypcja]    │
 *      │ 48 min · 3 osoby     │                                  │
 *      │ …                    │   treść wybranej zakładki        │
 *      │                      │                                  │
 *      │                      │ ──────────────────────────────── │
 *      │ Ustawienia spotkań   │                                  │
 *      └──────────────────────┴──────────────────────────────────┘
 *
 * Na tym etapie transkrypcja i podsumowanie jeszcze nie powstają — moduł
 * dopiero nagrywa. Puste zakładki mówią o tym WPROST, zamiast udawać, że
 * czegoś nie znaleziono: „jeszcze tego nie ma" i „nie udało się" to dwie
 * różne wiadomości i nie wolno ich mylić.
 */

(function () {
  const api = window.cribro;
  const t = (text, vars) => window.t(text, vars);

  let root = null;
  const state = {
    meetings: [],
    selected: null,
    tab: "summary", // summary | transcript
    recording: false,
    seconds: 0,
    settings: null,
  };

  let ticker = null;

  /* ── Drobiazgi ─────────────────────────────────────────────── */

  const pad = (value) => String(value).padStart(2, "0");

  /** Czas trwania w postaci, którą czyta się bez liczenia. */
  function duration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}:${pad(total % 60)}`;
    return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(total % 60)}`;
  }

  /** Kiedy — po ludzku, bez daty tam, gdzie wystarczy „dziś". */
  function when(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "";
    const now = new Date();
    const sameDay = at.toDateString() === now.toDateString();
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    if (sameDay) return `${t("dziś")} ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (at.toDateString() === yesterday.toDateString()) return `${t("wczoraj")} ${time}`;
    return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
  }

  function title(meeting) {
    return meeting.title || `${t("Spotkanie")} · ${when(meeting.at)}`;
  }

  const escape = (text) =>
    String(text ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

  /* ── Szkielet ──────────────────────────────────────────────── */

  const SKELETON = `
    <div class="meet">
      <aside class="meet__list" id="meetList"></aside>
      <section class="meet__detail" id="meetDetail"></section>
    </div>
  `;

  function build() {
    root.innerHTML = SKELETON;

    root.addEventListener("click", async (event) => {
      const record = event.target.closest("[data-meet-record]");
      if (record) {
        await api.meetings.toggle();
        return;
      }

      const row = event.target.closest("[data-meet-id]");
      if (row) {
        state.selected = row.dataset.meetId;
        paint();
        return;
      }

      const tab = event.target.closest("[data-meet-tab]");
      if (tab) {
        state.tab = tab.dataset.meetTab;
        paint();
        return;
      }

      const remove = event.target.closest("[data-meet-remove]");
      if (remove) {
        const id = remove.dataset.meetRemove;
        // Nagranie jest jedyną rzeczą w tej aplikacji, której nie da się
        // odtworzyć — pytamy, zamiast kasować po cichu.
        if (!window.confirm(t("Skasować to spotkanie razem z nagraniem?"))) return;
        await api.meetings.remove(id);
        if (state.selected === id) state.selected = null;
        await reload();
      }
    });

    root.addEventListener("change", (event) => {
      const field = event.target.closest("[data-meet-set]");
      if (!field) return;
      const key = field.dataset.meetSet;
      const value =
        field.type === "checkbox"
          ? field.checked
          : field.type === "number"
            ? Number(field.value)
            : field.value;
      api.settings.save({ meetings: { [key]: value } });
    });
  }

  /* ── Spis ──────────────────────────────────────────────────── */

  function paintList() {
    const live = state.recording;
    const rows = state.meetings
      .map((meeting) => {
        const chosen = meeting.id === state.selected;
        const failed = meeting.state === "failed";
        const running = meeting.state === "recording";
        return `
          <button class="meet__row${chosen ? " is-chosen" : ""}" data-meet-id="${meeting.id}">
            <span class="meet__row-title">${escape(title(meeting))}</span>
            <span class="meet__row-meta">
              ${running ? `<em class="meet__live">${t("nagrywa się")}</em>` : duration(meeting.seconds)}
              ${failed ? `<em class="meet__failed">${t("przerwane")}</em>` : ""}
            </span>
          </button>`;
      })
      .join("");

    $("#meetList").innerHTML = `
      <div class="meet__head">
        <button class="btn ${live ? "btn--rec" : "btn--primary"} meet__record" data-meet-record>
          ${live ? `${t("Zakończ")} · ${duration(state.seconds)}` : t("Nagraj spotkanie")}
        </button>
      </div>
      <div class="meet__rows">
        ${rows || `<p class="meet__empty">${t("Nagrane spotkania pojawią się tutaj.")}</p>`}
      </div>
      ${settingsCard()}
    `;
  }

  /* ── Ustawienia spotkań ────────────────────────────────────── */

  function settingsCard() {
    const meet = state.settings?.meetings ?? {};
    const option = (value, label, hint) => `
      <label class="meet__opt">
        <input type="radio" name="meetDetect" value="${value}" data-meet-set="detect"
               ${meet.detect === value ? "checked" : ""} />
        <span><b>${t(label)}</b><i>${t(hint)}</i></span>
      </label>`;

    return `
      <div class="meet__settings">
        <h3>${t("Jak działają spotkania")}</h3>

        <p class="meet__legend">${t("Kiedy zacząć nagrywać")}</p>
        ${option("off", "Nigdy sam", "Nagrywanie tylko z menu albo stąd.")}
        ${option("ask", "Pytaj", "Powiadomienie, gdy wygląda na spotkanie. Jedno kliknięcie.")}
        ${option("auto", "Sam z siebie", "Wykryte spotkanie nagrywa się bez pytania.")}

        <label class="meet__switch">
          <input type="checkbox" data-meet-set="keepAudio" ${meet.keepAudio ? "checked" : ""} />
          <span><b>${t("Zachowaj nagranie")}</b><i>${t("Domyślnie nagranie ginie po transkrypcji — tak samo jak przy dyktowaniu.")}</i></span>
        </label>

        <label class="meet__field">
          <span>${t("Krótsze niż (sekundy) to pomyłka")}</span>
          <input type="number" min="0" max="600" step="10" value="${meet.minSeconds ?? 90}"
                 data-meet-set="minSeconds" />
        </label>

        <label class="meet__field">
          <span>${t("Szuflada na podsumowania")}</span>
          <input type="text" value="${escape(meet.folder ?? "")}" data-meet-set="folder" />
        </label>

        <p class="meet__note">
          ${t("Nagrywanie dotyczy ludzi, którzy w tej aplikacji niczego nie klikali. Znaczek w pasku menu świeci na fioletowo przez cały czas nagrywania, a macOS pokazuje przy nim własny wskaźnik.")}
        </p>
      </div>`;
  }

  /* ── Spotkanie ─────────────────────────────────────────────── */

  function paintDetail() {
    const meeting = state.meetings.find((item) => item.id === state.selected);
    if (!meeting) {
      $("#meetDetail").innerHTML = `
        <div class="meet__blank">
          <p>${t("Wybierz spotkanie z listy albo nagraj nowe.")}</p>
        </div>`;
      return;
    }

    const tab = (key, label) => `
      <button class="meet__tab${state.tab === key ? " is-chosen" : ""}" data-meet-tab="${key}">
        ${t(label)}
      </button>`;

    $("#meetDetail").innerHTML = `
      <header class="meet__bar">
        <div class="meet__meta">
          <h2>${escape(title(meeting))}</h2>
          <p>${when(meeting.at)} · ${duration(meeting.seconds)}</p>
        </div>
        <div class="meet__tabs">
          ${tab("summary", "Podsumowanie")}
          ${tab("transcript", "Transkrypcja")}
        </div>
        <button class="btn btn--ghost btn--sm" data-meet-remove="${meeting.id}">${t("Usuń")}</button>
      </header>
      <div class="meet__body">${body(meeting)}</div>
    `;
  }

  /**
   * Treść zakładki.
   *
   * Puste zakładki mówią, CZEGO JESZCZE NIE MA — nie udają, że czegoś nie
   * znaleziono. Nagranie istnieje i leży na dysku; brakuje kroku, który
   * zamienia je w tekst, i to jest zdanie, które ma tu paść.
   */
  function body(meeting) {
    if (meeting.state === "recording") {
      return `<p class="meet__blank">${t("Trwa nagrywanie. Tekst pojawi się po zakończeniu.")}</p>`;
    }
    if (meeting.state === "failed") {
      return `<p class="meet__blank meet__blank--warn">
        ${t("Nagranie zostało przerwane")}${meeting.error ? `: ${escape(meeting.error)}` : "."}
        ${t("To, co zdążyło wejść na dysk, zostało — bywa całą rozmową bez ostatniej minuty.")}
      </p>`;
    }

    if (state.tab === "transcript") {
      if (meeting.transcript?.length) return transcript(meeting);
      return `<p class="meet__blank">
        ${t("Nagranie leży na dysku, ale nie zostało jeszcze przepisane.")}
      </p>`;
    }

    if (meeting.summary) return `<div class="meet__summary">${escape(meeting.summary)}</div>`;
    return `<p class="meet__blank">
      ${t("Podsumowanie powstaje z transkrypcji, według wybranego szablonu.")}
    </p>`;
  }

  /** Zapis rozmowy: kto, kiedy, co. Wypełni się w następnym etapie. */
  function transcript(meeting) {
    return `<div class="meet__transcript">${meeting.transcript
      .map(
        (line) => `
        <p class="meet__line" data-speaker="${escape(line.speaker ?? "")}">
          <span class="meet__who">${escape(line.speaker ?? t("Nieznany"))}</span>
          <span class="meet__at">${duration(line.at ?? 0)}</span>
          <span class="meet__said">${escape(line.text ?? "")}</span>
        </p>`,
      )
      .join("")}</div>`;
  }

  /* ── Przebieg ──────────────────────────────────────────────── */

  const $ = (selector) => root.querySelector(selector);

  function paint() {
    if (!root) return;
    paintList();
    paintDetail();
    window.translateTree(root);
  }

  async function reload() {
    state.meetings = await api.meetings.list();
    if (state.selected && !state.meetings.some((item) => item.id === state.selected)) {
      state.selected = null;
    }
    paint();
  }

  /* Zegar biegnie tylko w trakcie nagrywania i tylko wtedy, gdy zakładka
     jest na wierzchu — licznik odmierzany w tle to sekundowe przerysowanie
     widoku, którego nikt nie ogląda. */
  function tick(on) {
    clearInterval(ticker);
    ticker = null;
    if (!on) return;
    ticker = setInterval(() => {
      state.seconds += 1;
      const button = root?.querySelector(".meet__record");
      if (button) button.textContent = `${t("Zakończ")} · ${duration(state.seconds)}`;
    }, 1000);
  }

  const MeetingsView = {
    async show(host, settings) {
      root = host;
      state.settings = settings;
      if (!root.querySelector(".meet")) build();
      const live = await api.meetings.state();
      state.recording = live.recording;
      state.seconds = live.seconds;
      await reload();
      tick(state.recording);
    },

    hide() {
      tick(false);
    },

    settings(next) {
      state.settings = next;
      if (root?.querySelector(".meet")) paint();
    },

    /** Meldunek z procesu głównego: zaczęło się albo skończyło. */
    changed(live) {
      state.recording = !!live?.recording;
      state.seconds = live?.seconds ?? 0;
      tick(state.recording);
      if (root?.querySelector(".meet")) reload();
    },
  };

  window.MeetingsView = MeetingsView;
})();
