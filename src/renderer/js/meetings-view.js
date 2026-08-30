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
    tab: "summary", // summary | talk | transcript | notes
    recording: false,
    seconds: 0,
    settings: null,
    // Notatka napisana, a jeszcze niezapisana — patrz flushNotes.
    notes: null,
    // Czego szukamy w spisie — patrz matches niżej.
    query: "",
    // Co widać w kalendarzu — przychodzi tą samą wiadomością co stan
    // nagrywania (patrz meetingState w main/main.js).
    agenda: null,
  };

  let ticker = null;
  let noteTimer = null;
  /* Chwila zwłoki przed zapisem notatnika. Ta sama, co przy kartce
     w widgecie: pisze się zdaniami, nie literami. */
  const SAVE_DELAY = 600;

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
        // Notatnik ginie razem z przerysowaniem, więc zapisujemy go
        // ZANIM zniknie z ekranu.
        await flushNotes();
        state.tab = tab.dataset.meetTab;
        paint();
        return;
      }

      /* Zdanie do wklejenia na czat. Uprzedzenie o nagrywaniu jest w wielu
         miejscach wymagane, a wszędzie jest zwyczajną uczciwością — i nie
         powinno wymagać układania go od nowa za każdym razem. */
      const say = event.target.closest("[data-meet-say]");
      if (say) {
        await api.system.copy(
          t(
            "Nagrywam to spotkanie, żeby zrobić z niego notatki — nagranie i zapis zostają na moim komputerze. Powiedzcie, proszę, jeśli wolicie, żebym tego nie robił.",
          ),
        );
        say.textContent = t("Skopiowane");
        setTimeout(() => paint(), 1600);
        return;
      }

      /* Odsłuch fragmentu. Element audio żyje POZA przerysowywanym HTML-em,
         bo inaczej każde odświeżenie zapisu przerywałoby granie w połowie
         zdania — czyli dokładnie wtedy, gdy się słucha. */
      const play = event.target.closest("[data-meet-play]");
      if (play) {
        const sound = ear();
        const url = `file://${encodeURI(play.dataset.meetPlay)}`;
        if (sound.dataset.src !== url) {
          sound.src = url;
          sound.dataset.src = url;
        }
        sound.currentTime = Number(play.dataset.meetFrom) || 0;
        sound.play().catch(() => {
          /* nagrania już nie ma albo system nie umie go otworzyć */
        });
        return;
      }

      const mark = event.target.closest("[data-meet-mark]");
      if (mark) {
        const sheet = root.querySelector("[data-meet-notes]");
        if (sheet) {
          sheet.focus();
          document.execCommand("insertText", false, `[${duration(state.seconds)}] `);
          state.notes = { id: sheet.dataset.meetNotes, text: sheet.innerText };
          sheet.dataset.empty = "false";
          void flushNotes();
        }
        return;
      }

      const sift = event.target.closest("[data-meet-sift]");
      if (sift) {
        await api.meetings.polish(sift.dataset.meetSift);
        return;
      }

      const toNote = event.target.closest("[data-meet-note]");
      if (toNote) {
        await flushNotes();
        const note = await api.meetings.toNote(toNote.dataset.meetNote, true);
        // Notatka jest po to, żeby z nią coś zrobić — otwieramy ją od razu
        // w Notatniku, zamiast mówić „zapisano" i zostawiać szukanie.
        if (note?.id) await api.notes.openWindow(note.id);
        return;
      }

      const copy = event.target.closest("[data-meet-copy]");
      if (copy) {
        await flushNotes();
        await api.meetings.copy(copy.dataset.meetCopy);
        copy.textContent = t("Skopiowane");
        setTimeout(() => paint(), 1400);
        return;
      }

      const again = event.target.closest("[data-meet-again]");
      if (again) {
        await api.meetings.retranscribe(again.dataset.meetAgain);
        return;
      }

      const write = event.target.closest("[data-meet-sum]");
      if (write) {
        // Notatki najpierw na dysk: podsumowanie ma je uwzględnić, a leżą
        // jeszcze w niezapisanym polu obok.
        await flushNotes();
        await api.meetings.summarize(write.dataset.meetSum);
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

    /* Notatnik przy spotkaniu zapisuje się sam, z chwilą zwłoki — tak samo
       jak kartka w widgecie. Nie ma tu przycisku „Zapisz" i nie ma go
       nigdzie w tej aplikacji. */
    root.addEventListener("input", (event) => {
      const find = event.target.closest?.("[data-meet-find]");
      if (find) {
        state.query = find.value;
        // Sam spis, nie całe spotkanie: przerysowanie prawej strony
        // zabrałoby kursor z pola, w którym się właśnie pisze.
        paintList();
        const fresh = root.querySelector("[data-meet-find]");
        if (fresh) {
          fresh.focus();
          fresh.setSelectionRange(fresh.value.length, fresh.value.length);
        }
        return;
      }

      const sheet = event.target.closest?.("[data-meet-notes]");
      if (!sheet) return;
      state.notes = { id: sheet.dataset.meetNotes, text: sheet.innerText };
      // Podpowiedź gaśnie z pierwszą literą. Pytamy o treść, a nie
      // o :empty — po skasowaniu wszystkiego zostaje w środku <br>.
      sheet.dataset.empty = sheet.innerText.trim() ? "false" : "true";
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => void flushNotes(), SAVE_DELAY);
    });
    root.addEventListener("focusout", (event) => {
      if (event.target.closest?.("[data-meet-notes]")) void flushNotes();
    });

    root.addEventListener("change", (event) => {
      const arm = event.target.closest("[data-meet-arm]");
      if (arm) {
        api.meetings.arm(arm.dataset.meetArm, arm.checked);
        return;
      }

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

  /**
   * Czy to spotkanie odpowiada temu, czego szukamy.
   *
   * Szukamy w tytule, w podsumowaniu I W ZAPISIE ROZMOWY — bo pytanie, po
   * które sięga się do archiwum, brzmi „kiedy ustaliliśmy termin raportu",
   * a nie „jak nazwałem tamto spotkanie". Słowa muszą wystąpić wszystkie,
   * ale w dowolnym miejscu i w dowolnej kolejności.
   */
  function matches(meeting, query) {
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [
      meeting.title ?? "",
      meeting.where ?? "",
      meeting.summary ?? "",
      meeting.notes ?? "",
      ...(meeting.people ?? []),
      ...(meeting.transcript ?? []).map((line) => line.text ?? ""),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => hay.includes(word));
  }

  /* ── Spis ──────────────────────────────────────────────────── */

  function paintList() {
    const live = state.recording;
    const found = state.meetings.filter((meeting) => matches(meeting, state.query));
    const rows = found
      .map((meeting) => {
        const chosen = meeting.id === state.selected;
        const failed = meeting.state === "failed";
        const running = meeting.state === "recording";
        /* Czas pokazujemy tylko wtedy, gdy jest co pokazać. Nagranie
           przerwane na starcie ma zero sekund, a „0:00 przerwane" wygląda
           jak awaria zegara, nie jak przerwana rozmowa. */
        const meta = [];
        if (running) meta.push(`<em class="meet__live">${t("nagrywa się")}</em>`);
        else if (meeting.seconds >= 1) meta.push(duration(meeting.seconds));
        if (failed) meta.push(`<em class="meet__failed">${t("przerwane")}</em>`);
        return `
          <button class="meet__row${chosen ? " is-chosen" : ""}" data-meet-id="${meeting.id}">
            <span class="meet__row-title">${escape(title(meeting))}</span>
            <span class="meet__row-meta">${meta.join(" · ")}</span>
          </button>`;
      })
      .join("");

    $("#meetList").innerHTML = `
      <div class="meet__head">
        <button class="btn ${live ? "btn--air" : "btn--primary"} meet__record" data-meet-record>
          ${live ? `${t("Zakończ")} · ${duration(state.seconds)}` : t("Nagraj spotkanie")}
        </button>
      </div>
      ${agendaCard()}
      ${
        state.meetings.length > 3 || state.query
          ? `<label class="meet__find">
               <input type="search" data-meet-find value="${escape(state.query)}"
                      placeholder="${t("Szukaj w rozmowach")}" />
             </label>`
          : ""
      }
      <div class="meet__rows">
        ${
          rows ||
          `<p class="meet__empty">${
            state.query
              ? t("Nic takiego nie padło w żadnej z nagranych rozmów.")
              : t("Nagrane spotkania pojawią się tutaj.")
          }</p>`
        }
      </div>
      ${settingsCard()}
    `;
  }

  /* ── Kalendarz ─────────────────────────────────────────────────
     Co ma się zacząć — i pytanie o to JEDEN RAZ, przed czasem. Zgoda
     wyrażona teraz jest warta więcej niż pytanie zadane w chwili, w której
     rozmowa już trwa i trzeba jej słuchać, a nie klikać. */

  /** Godzina wpisu, bez daty tam, gdzie wystarczy „dziś". */
  function clock(ms) {
    const at = new Date(ms);
    if (Number.isNaN(at.getTime())) return "";
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    if (at.toDateString() === new Date().toDateString()) return time;
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }

  function agendaCard() {
    const plan = state.agenda;
    if (!state.settings?.meetings?.calendar) return "";

    if (plan?.access === "denied") {
      return `<div class="meet__plan">
          <p class="meet__legend">${t("Nadchodzące")}</p>
          <p class="meet__empty">${t("Brak zgody na kalendarz — przyznaj ją w Ustawieniach systemowych, w sekcji Kalendarz.")}</p>
        </div>`;
    }
    if (!plan?.events?.length) {
      return `<div class="meet__plan">
          <p class="meet__legend">${t("Nadchodzące")}</p>
          <p class="meet__empty">${t("Nic w planie na najbliższe godziny.")}</p>
        </div>`;
    }

    const armed = new Set(plan.armed ?? []);
    const rows = plan.events
      .map(
        (event) => `
        <label class="meet__plan-row">
          <span class="meet__plan-when">${clock(event.from)}</span>
          <span class="meet__plan-title">${escape(event.title || t("Spotkanie"))}</span>
          <input type="checkbox" data-meet-arm="${escape(event.id)}" ${armed.has(event.id) ? "checked" : ""} />
          <span class="meet__flip meet__flip--sm" aria-hidden="true"
                title="${t("Notuj to spotkanie")}"></span>
        </label>`,
      )
      .join("");

    return `<div class="meet__plan">
        <p class="meet__legend">${t("Nadchodzące")}</p>
        ${rows}
        <p class="meet__note meet__note--tight">${t("Włączone nagra się samo, gdy nadejdzie jego godzina.")}</p>
      </div>`;
  }

  /* ── Ustawienia spotkań ────────────────────────────────────── */

  function settingsCard() {
    const meet = state.settings?.meetings ?? {};
    /** Kółko wyboru — jedno z kilku. */
    const pick = (group, key, value, label, hint) => `
      <label class="meet__opt">
        <input type="radio" name="${group}" value="${value}" data-meet-set="${key}"
               ${meet[key] === value ? "checked" : ""} />
        <span><b>${t(label)}</b><i>${t(hint)}</i></span>
      </label>`;
    const option = (value, label, hint) => pick("meetDetect", "detect", value, label, hint);
    const shape = (value, label, hint) => pick("meetTemplate", "template", value, label, hint);
    /** Przełącznik — jedno pytanie, dwie odpowiedzi. */
    const flip = (key, label, hint, on) => `
      <label class="meet__set">
        <span class="meet__set-text"><b>${t(label)}</b><i>${t(hint)}</i></span>
        <input type="checkbox" data-meet-set="${key}" ${on ? "checked" : ""} />
        <span class="meet__flip" aria-hidden="true"></span>
      </label>`;

    return `
      <div class="meet__settings">
        <h3>${t("Jak działają spotkania")}</h3>

        <div class="meet__group">
          <p class="meet__legend">${t("Kiedy zacząć nagrywać")}</p>
          ${option("off", "Nigdy sam", "Nagrywanie tylko z menu albo stąd.")}
          ${option("ask", "Pytaj", "Znaczek pyta, gdy wygląda na spotkanie. Jedno kliknięcie.")}
          ${option("auto", "Sam z siebie", "Wykryte spotkanie nagrywa się bez pytania.")}
        </div>

        <div class="meet__group">
          ${flip(
            "keepAudio",
            "Zachowaj nagranie",
            "Domyślnie nagranie ginie po transkrypcji — tak samo jak przy dyktowaniu.",
            !!meet.keepAudio,
          )}
        </div>

        <div class="meet__group">
          ${flip(
            "calendar",
            "Pokaż kalendarz",
            "Nadchodzące spotkania z kalendarza macOS — także z konta Google, jeśli jest tam dodane.",
            !!meet.calendar,
          )}
        </div>

        <div class="meet__group">
          <p class="meet__legend">${t("Po rozmowie")}</p>
          ${flip("summarize", "Podsumuj samo", "Zaraz po zakończeniu, z zapisu i z notatek.", meet.summarize !== false)}
          ${flip("rename", "Nazwij spotkanie z treści", "Zamiast kodu pokoju z okna przeglądarki.", meet.rename !== false)}
          ${flip("stopWithMeeting", "Kończ razem ze spotkaniem", "Gdy okno rozmowy zniknie, nagranie też.", meet.stopWithMeeting !== false)}
        </div>

        <div class="meet__group">
          <p class="meet__legend">${t("Jakie podsumowanie")}</p>
          ${shape("generic", "Zwykłe podsumowanie", "O czym było, co ustalono, co komu zostało.")}
          ${shape("custom", "Własne wytyczne", "Piszesz sam, czego od niego oczekujesz.")}
          <label class="meet__field${meet.template === "custom" ? "" : " is-off"}">
            <textarea rows="4" data-meet-set="instructions"
                      placeholder="${t("Np. Same zadania, w punktach, po angielsku. Bez wstępu.")}">${escape(meet.instructions ?? "")}</textarea>
          </label>
        </div>

        <div class="meet__group">
          <label class="meet__field">
            <span class="meet__field-name">${t("Krótsze nagranie to pomyłka")}</span>
            <span class="meet__field-in">
              <input type="number" min="0" max="600" step="10" value="${meet.minSeconds ?? 90}"
                     data-meet-set="minSeconds" />
              <em>${t("sekund")}</em>
            </span>
          </label>

          <label class="meet__field">
            <span class="meet__field-name">${t("Szuflada na podsumowania")}</span>
            <input type="text" value="${escape(meet.folder ?? "")}" data-meet-set="folder" />
          </label>
        </div>

        <p class="meet__note">
          ${t("Nagrywanie dotyczy ludzi, którzy w tej aplikacji niczego nie klikali. Znaczek świeci przez cały czas nagrywania, a macOS pokazuje przy nim własny wskaźnik.")}
        </p>
        <div class="meet__act meet__act--tight">
          <button class="btn btn--ghost btn--sm" data-meet-say>${t("Skopiuj zdanie do wklejenia")}</button>
        </div>
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

    const live = meeting.state === "recording";
    // Metryka: kiedy, skąd i jak długo. „Skąd" pojawia się tylko wtedy, gdy
    // spotkanie zostało rozpoznane — nagranie z menu nie wie, gdzie było.
    const meta = [when(meeting.at)];
    if (meeting.where) meta.push(escape(meeting.where));
    meta.push(live ? `<em class="meet__air">${t("nagrywa się")}</em>` : duration(meeting.seconds));

    $("#meetDetail").innerHTML = `
      <header class="meet__bar">
        <div class="meet__meta">
          <h2>${escape(title(meeting))}</h2>
          <p>${meta.join(" · ")}</p>
        </div>
        <div class="meet__tabs">
          ${tab("summary", "Podsumowanie")}
          ${tab("talk", "Rozmowa")}
          ${tab("transcript", "Transkrypcja")}
          ${tab("notes", "Notatki")}
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
   * znaleziono. „Jeszcze tego nie ma" i „nie udało się" to dwie różne
   * wiadomości i nie wolno ich mylić.
   *
   * W TRAKCIE ROZMOWY zakładka nie jest kartką z napisem „poczekaj":
   * transkrypcja rośnie na oczach (odcinkami, patrz main/segments.js),
   * a notatnik obok jest pusty i czeka. Po to się tu wchodzi w trakcie.
   */
  function body(meeting) {
    const live = meeting.state === "recording";

    if (state.tab === "notes") return notepad(meeting);

    if (meeting.state === "failed") {
      return `<p class="meet__blank meet__blank--warn">
        ${t("Nagranie zostało przerwane")}${meeting.error ? `: ${escape(meeting.error)}` : "."}
        ${t("To, co zdążyło wejść na dysk, zostało — bywa całą rozmową bez ostatniej minuty.")}
      </p>`;
    }

    /* ROZMOWA PRZESIANA — trzecia postać tej samej rozmowy. Zapis mówi,
       co padło; podsumowanie, co z tego wynika; to jest pomiędzy. */
    if (state.tab === "talk") {
      if (meeting.sifting) {
        return `<p class="meet__blank meet__blank--work">${t("Przesiewam rozmowę…")}</p>`;
      }
      const sift = meeting.transcript?.length
        ? `<div class="meet__act">
             <button class="btn btn--sm" data-meet-sift="${meeting.id}">
               ${t(meeting.talk?.length ? "Przesiej jeszcze raz" : "Przesiej rozmowę")}
             </button>
           </div>`
        : "";
      if (meeting.talkError) {
        return `<p class="meet__blank meet__blank--warn">
            ${t("Przesiewanie się nie udało")}: ${escape(meeting.talkError)}
          </p>${sift}`;
      }
      if (meeting.talk?.length) {
        return `${transcript({ transcript: meeting.talk }, false)}${sift}`;
      }
      return `<p class="meet__blank">
          ${
            live
              ? t("Rozmowę przesiejemy po jej zakończeniu.")
              : meeting.transcript?.length
                ? t("Ten sam zapis bez szumu: bez „yyy”, bez „słychać mnie?”, bez trzech minut o pogodzie — a wciąż jako rozmowa.")
                : t("Najpierw musi powstać zapis rozmowy.")
          }
        </p>${sift}`;
    }

    if (state.tab === "transcript") {
      if (meeting.transcribing) {
        return `<p class="meet__blank meet__blank--work">${t("Przepisuję nagranie…")}</p>
          ${meeting.transcript?.length ? transcript(meeting, false) : ""}`;
      }

      /* Nagranie da się przepisać jeszcze raz — dopóki leży na dysku.
         To jest jedyny krok w tym module, który wolno powtórzyć, i jedyny
         ratunek dla rozmowy nagranej bez klucza API albo bez sieci. */
      const again = meeting.tracks?.mic
        ? `<div class="meet__act">
             <button class="btn btn--sm" data-meet-again="${meeting.id}">
               ${t(meeting.transcript?.length ? "Przepisz jeszcze raz" : "Przepisz nagranie")}
             </button>
           </div>`
        : "";

      if (meeting.transcriptError) {
        return `<p class="meet__blank meet__blank--warn">
            ${t("Przepisywanie się nie udało")}: ${escape(meeting.transcriptError)}
          </p>${again}`;
      }
      if (meeting.transcript?.length) return `${transcript(meeting, live)}${live ? "" : again}`;
      return `<p class="meet__blank">
          ${
            live
              ? t("Pierwsze zdania pojawią się tu za chwilę — zapis powstaje odcinkami.")
              : meeting.tracks?.mic
                ? t("Nagranie leży na dysku, ale nie zostało jeszcze przepisane.")
                : t("Nagranie zostało skasowane, a tekstu z niego nie ma — nie ma już czego pokazać.")
          }
        </p>${again}`;
    }

    return summary(meeting, live);
  }

  /**
   * Zakładka podsumowania.
   *
   * Podsumowanie jest jedyną rzeczą w tym module, którą DA SIĘ powtórzyć
   * bez końca — transkrypcja leży, wytyczne można zmienić i poprosić
   * jeszcze raz. Dlatego przycisk stoi tu zawsze, a nie tylko wtedy, gdy
   * czegoś brakuje.
   */
  function summary(meeting, live) {
    if (live) {
      return `<p class="meet__blank">${t("Podsumowanie powstanie po zakończeniu rozmowy.")}</p>`;
    }
    if (meeting.summarizing) {
      return `<p class="meet__blank meet__blank--work">${t("Piszę podsumowanie…")}</p>`;
    }

    const nothing = !meeting.transcript?.length && !String(meeting.notes ?? "").trim();
    const again = meeting.summary ? "Napisz jeszcze raz" : "Napisz podsumowanie";
    /* Wyjście z aplikacji prowadzi przez Notatnik — i tylko tamtędy.
       Notatka umie już PDF, Notion, Apple Notes i chmurę; drugi zestaw
       tych samych przycisków tutaj byłby drugim miejscem do poprawiania. */
    const out = meeting.summary
      ? `<button class="btn btn--sm" data-meet-note="${meeting.id}">${t("Zapisz jako notatkę")}</button>
         <button class="btn btn--ghost btn--sm" data-meet-copy="${meeting.id}">${t("Kopiuj")}</button>`
      : "";
    const button = nothing
      ? ""
      : `<div class="meet__act">
           <button class="btn btn--sm" data-meet-sum="${meeting.id}">${t(again)}</button>
           ${out}
         </div>`;

    if (meeting.summaryError) {
      return `<p class="meet__blank meet__blank--warn">
          ${t("Podsumowanie się nie udało")}: ${escape(meeting.summaryError)}
        </p>${button}`;
    }

    if (meeting.summary) {
      /* Model pisze Markdownem (pogrubione nagłówki, listy) — pokazujemy to
         tym samym tłumaczem, którym notatka zamienia gwiazdki na pogrubienie.
         Zapisany zostaje Markdown, bo z niego da się zrobić notatkę. */
      const rich = window.CribroRichtext?.markdownToHtml?.(meeting.summary);
      return `<div class="meet__summary prose">${rich ?? escape(meeting.summary)}</div>${button}`;
    }

    return `<p class="meet__blank">
        ${
          nothing
            ? t("Nie ma z czego zrobić podsumowania — nie ma ani zapisu, ani notatek.")
            : t("Podsumowanie powstaje z zapisu rozmowy i z notatek, według wybranych wytycznych.")
        }
      </p>${button}`;
  }

  /** Zapis rozmowy: kto, kiedy, co. */
  function transcript(meeting, live) {
    /* ZNACZNIK CZASU JEST PRZYCISKIEM, o ile nagranie jeszcze leży na
       dysku. Zapis bywa niedokładny i wtedy jedyną odpowiedzią na pytanie
       „co on właściwie powiedział" jest posłuchanie tego. Gramy TEN tor,
       do którego należy wypowiedź: dwóch naraz i tak nie dałoby się
       zsynchronizować, a każda wypowiedź ma swoją stronę rozmowy. */
    const tracks = meeting.tracks ?? null;
    const lines = meeting.transcript
      .map((line) => {
        const track = tracks?.[line.lane ?? ""] ?? null;
        const at = duration(line.at ?? 0);
        const stamp = track
          ? `<button class="meet__at meet__at--play" data-meet-play="${escape(track)}"
                     data-meet-from="${Math.round(line.at ?? 0)}"
                     title="${t("Posłuchaj tego fragmentu")}">${at}</button>`
          : `<span class="meet__at">${at}</span>`;
        return `
        <p class="meet__line" data-speaker="${escape(line.speaker ?? "")}">
          <span class="meet__who">${escape(line.speaker ?? t("Nieznany"))}</span>
          ${stamp}
          <span class="meet__said">${escape(line.text ?? "")}</span>
        </p>`;
      })
      .join("");
    /* Ogon mówi, że to jeszcze nie koniec. Bez niego zapis urwany
       w połowie zdania wygląda jak zapis, który się zepsuł. */
    const tail = live
      ? `<p class="meet__more">${t("zapis rośnie w trakcie rozmowy")}</p>`
      : "";
    return `<div class="meet__transcript">${lines}${tail}</div>`;
  }

  /**
   * Notatnik przy spotkaniu — pusta kartka na to, czego w nagraniu nie ma.
   *
   * Osobno od transkrypcji i od podsumowania, bo to jedyna z tych trzech
   * rzeczy, której nie da się odtworzyć z dźwięku: „zrobić do czwartku",
   * „spytać Anię", nazwisko, które padło bez kontekstu. Transkrypcję da się
   * zrobić jeszcze raz z pliku, podsumowanie jeszcze raz z transkrypcji —
   * a tego nie da się już z niczego.
   */
  function notepad(meeting) {
    /* Znacznik chwili. Notatka „sprawdzić budżet" znaczy dwa razy więcej,
       gdy wiadomo, w której minucie padła — podsumowanie zestawia ją wtedy
       z tym, co wtedy mówiono. Wstawia się go ręką i tylko w trakcie
       rozmowy, bo tylko wtedy jest co znaczyć. */
    const mark =
      meeting.state === "recording"
        ? `<div class="meet__act meet__act--tight">
             <button class="btn btn--ghost btn--sm" data-meet-mark>${t("Znacznik chwili")}</button>
           </div>`
        : "";
    return mark + `
      <div
        class="meet__pad"
        contenteditable="plaintext-only"
        spellcheck="true"
        data-i18n="skip"
        data-meet-notes="${meeting.id}"
        data-empty="${meeting.notes ? "false" : "true"}"
        data-placeholder="${t("Co warto zapamiętać poza tym, co słychać.")}"
      >${escape(meeting.notes ?? "")}</div>`;
  }

  /* ── Przebieg ──────────────────────────────────────────────── */

  const $ = (selector) => root.querySelector(selector);

  /**
   * Gdzie w tej zakładce ktoś właśnie pisze.
   *
   * Przerysowanie buduje HTML od nowa, więc zabiera kursor ze środka
   * zdania. A meldunki o zmianie przychodzą tu co odcinek zapisu, czyli
   * co dwie minuty przez całą rozmowę — akurat wtedy, gdy pisze się
   * notatki. Odświeżamy więc tę połowę widoku, w której nikt nie pisze.
   *
   * @returns {Element|null} pole z kursorem
   */
  /**
   * Głośnik do odsłuchu fragmentów — jeden na cały widok.
   *
   * Stoi poza tym, co się przerysowuje: zapis odświeża się co odcinek,
   * a element audio zbudowany od nowa przerywa granie w pół słowa.
   */
  let sound = null;
  function ear() {
    if (sound?.isConnected) return sound;
    sound = document.createElement("audio");
    sound.id = "meetSound";
    sound.preload = "none";
    document.body.appendChild(sound);
    return sound;
  }

  function busyField() {
    const spot = document.activeElement;
    if (!spot || !root?.contains(spot)) return null;
    const writable =
      spot.isContentEditable || spot.tagName === "TEXTAREA" || spot.tagName === "INPUT";
    return writable ? spot : null;
  }

  /** Notatnik na dysk. Wywoływane z opóźnieniem, przy wyjściu i przy zmianie
      zakładki — czyli wszędzie tam, gdzie kartka może zniknąć z ekranu. */
  async function flushNotes() {
    clearTimeout(noteTimer);
    const pending = state.notes;
    if (!pending) return;
    state.notes = null;
    await api.meetings.note(pending.id, pending.text);
    // Trzymamy też u siebie: najbliższe odświeżenie spisu przyszłoby
    // z procesu głównego i cofnęłoby to, co dopiero co napisane.
    const meeting = state.meetings.find((item) => item.id === pending.id);
    if (meeting) meeting.notes = pending.text;
  }

  function paint() {
    if (!root) return;
    const busy = busyField();
    if (!busy?.closest(".meet__list")) paintList();
    if (!busy?.closest(".meet__detail")) paintDetail();
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

  /**
   * Trwające spotkanie wychodzi na wierzch.
   *
   * Wejście w zakładkę w trakcie rozmowy ma pokazać TĘ rozmowę, a nie spis,
   * w którym trzeba jej szukać — a przy samym rozpoczęciu otwiera się od
   * razu na transkrypcji, bo to jedyna rzecz, która w trakcie rośnie.
   * Podsumowania jeszcze nie ma i długo nie będzie.
   */
  function follow(live, opened) {
    if (!live?.recording || !live.id) return;
    state.selected = live.id;
    if (opened) state.tab = "transcript";
  }

  const MeetingsView = {
    async show(host, settings) {
      root = host;
      state.settings = settings;
      if (!root.querySelector(".meet")) build();
      const live = await api.meetings.state();
      state.recording = live.recording;
      state.seconds = live.seconds;
      state.agenda = live.agenda ?? null;
      follow(live, state.tab === "summary");
      await reload();
      tick(state.recording);
    },

    hide() {
      tick(false);
      // Zakładka schodzi z ekranu — dźwięk razem z nią.
      if (sound) sound.pause();
      // Zakładka znika razem z notatnikiem — to, co w nim napisano,
      // ma zostać na dysku, a nie w pamięci widoku.
      void flushNotes();
    },

    settings(next) {
      state.settings = next;
      if (root?.querySelector(".meet")) paint();
    },

    /** Meldunek z procesu głównego: zaczęło się, skończyło albo przybyło
        odcinka zapisu. */
    changed(live) {
      const started = !!live?.recording && !state.recording;
      state.recording = !!live?.recording;
      state.seconds = live?.seconds ?? 0;
      if (live?.agenda) state.agenda = live.agenda;
      follow(live, started);
      tick(state.recording);
      if (root?.querySelector(".meet")) reload();
    },
  };

  window.MeetingsView = MeetingsView;
})();
