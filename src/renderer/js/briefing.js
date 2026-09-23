"use strict";

/**
 * Poranek — centrum dowodzenia: pięć modułowych, zwijanych sekcji zamiast
 * jednej listy od góry do dołu.
 *
 * DWA ŹRÓDŁA, JEDEN EKRAN. Treść przychodzi z dwóch niezależnych torów,
 * które kończą w różnym czasie:
 *   1. `briefing:data` — plan dnia, maile wytypowane regułami (main/briefing.js)
 *      i kanały RSS. Przychodzi raz, gotowe.
 *   2. `api.mail.analyze()` — segregacja skrzynki modelem, z osobnym cyklem
 *      życia (main/inbox-triage.js): kategorie odebranych ORAZ wysłane
 *      czekające na odpowiedź. Może skończyć wcześniej albo później.
 * Stąd jeden stan (`state`) i jedna funkcja rysująca (`render`), wołana
 * z obu torów niezależnie — żaden z nich nie czeka na drugi.
 *
 * BEZ FILTROWANIA W WIDOKU. Wybór treści rozstrzygają main/briefing.js
 * i main/inbox-triage.js i sprawdza je zwykły Node, bez przeglądarki. Ten
 * plik tylko układa to, co dostał, w pięciu sekcjach z licznikami.
 *
 * DOMYŚLNE ZWINIĘCIE ŻYJE W HTML-u. Sekcje "Pilne" i "Oczekujące" mają
 * atrybut `open` wpisany w briefing.html, reszta go nie ma — i JS nigdy
 * tego atrybutu nie rusza, żeby ręczne rozwinięcie/zwinięcie przez
 * człowieka przeżyło każde odświeżenie treści.
 *
 * Human-in-the-loop: to okno nigdy samo nie usuwa. Zaznaczenie i klik
 * w „Przenieś do Kosza" to jedyna droga do mail:trashSelected.
 */

(function () {
  const api = window.cribro;
  const $ = (selector) => document.querySelector(selector);
  const t = (text, vars) => window.t(text, vars);

  const escape = (text) =>
    String(text ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

  const pad = (n) => String(n).padStart(2, "0");
  const clock = (ms) => {
    const at = new Date(ms);
    return Number.isNaN(at.getTime()) ? "" : `${at.getHours()}:${pad(at.getMinutes())}`;
  };

  function inMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return "";
    if (minutes < 1) return t("za chwilę");
    if (minutes < 90) return t("za {n} min", { n: minutes });
    return t("za {n} godz.", { n: Math.round(minutes / 60) });
  }

  /**
   * Zdanie modelu dopasowane do pozycji listy — po nadawcy, nie po numerze
   * wiersza, bo model bywa oszczędny i pomija te, o których nie ma nic do
   * powiedzenia.
   */
  function saidAbout(subject, lines) {
    const who = String(subject ?? "").trim().toLowerCase();
    const first = who.split(/\s+/)[0];
    if (!first || first.length < 3) return "";
    const hit = (lines ?? []).find((line) => line.toLowerCase().includes(first));
    if (!hit) return "";
    const cut = hit.match(/^(.{0,60}?)\s[—–]\s(.+)$/);
    const said = (cut ? cut[2] : hit).trim();
    const bare = said.toLowerCase().replace(/[.\s]+$/, "");
    if (!bare || who.includes(bare) || bare.includes(who)) return "";
    return said;
  }

  /* ── Stan ──────────────────────────────────────────────────────
     `briefing` — dane z briefing:data (plan, picks, feeds, words).
     `triage`   — stan segregacji skrzynki (mail.analyze). */
  const state = {
    briefing: null,
    triage: { status: "loading" },
  };

  /* ── Sekcja: Pilne i ważne ────────────────────────────────────── */

  function renderMailList(picks, said) {
    return picks
      .map((mail) => {
        const sentence = saidAbout(mail.from, said);
        const body = `
          <div>
            <span class="mail__from">${escape(mail.from)}</span>
            <span class="mail__subject">${escape(mail.subject)}</span>
          </div>
          ${sentence ? `<p class="mail__said">${escape(sentence)}</p>` : ""}
          <div class="mail__why">${escape((mail.why ?? [mail.reason]).filter(Boolean).join(" · "))}</div>`;
        return mail.link
          ? `<a class="mail" href="${escape(mail.link)}" target="_blank" rel="noreferrer">${body}</a>`
          : `<div class="mail">${body}</div>`;
      })
      .join("");
  }

  function nextDeadlines(plan) {
    const rows = (plan?.ahead ?? []).slice(0, 2);
    if (!rows.length) return "";
    return `
      <div class="subhead">${t("Kluczowe terminy dnia")}</div>
      ${rows
        .map(
          (event) => `
        <div class="slot">
          <div class="slot__at">${clock(event.from)}</div>
          <div class="slot__what"><div class="slot__title">${escape(event.title)}</div></div>
        </div>`,
        )
        .join("")}`;
  }

  function renderUrgent() {
    const picks = state.briefing?.picks ?? [];
    const said = state.briefing?.words?.mail ?? [];
    const requiresAction = state.triage.data?.requiresAction ?? [];
    const plan = state.briefing?.plan;

    const parts = [];
    if (picks.length) {
      parts.push(`<div class="subhead">${t("Z ostatnich dni")}</div>`, renderMailList(picks, said));
    }
    if (requiresAction.length) {
      parts.push(`<div class="subhead">${t("Skrzynka — wymaga akcji")}</div>`, renderMailList(requiresAction, []));
    }
    const deadlines = nextDeadlines(plan);
    if (deadlines) parts.push(deadlines);

    if (!parts.length) {
      parts.push(`<p class="empty">${t("Nic pilnego nie czeka. Tak też bywa.")}</p>`);
    }
    return { html: parts.join(""), count: picks.length + requiresAction.length };
  }

  /* ── Sekcja: Oczekujące na odpowiedź ──────────────────────────── */

  function renderWaiting() {
    const items = state.triage.data?.awaitingReply ?? [];
    if (state.triage.status === "loading") {
      return { html: `<p class="empty">${t("Sprawdzam wysłane…")}</p>`, count: 0 };
    }
    if (!items.length) {
      return { html: `<p class="empty">${t("Wszystko, co wysłałeś, doczekało się odpowiedzi.")}</p>`, count: 0 };
    }
    const html = items
      .map((mail) => {
        const body = `
          <span class="row__body">
            <span class="row__line"><span class="row__from">${escape(mail.to)}</span><span class="row__subject">${escape(mail.about)}</span></span>
            <span class="row__reason">${escape(mail.reason)}</span>
          </span>
          <span class="row__days">${mail.days} ${dni(mail.days)}</span>`;
        return mail.link
          ? `<a class="row mail" href="${escape(mail.link)}" target="_blank" rel="noreferrer" style="display:flex">${body}</a>`
          : `<div class="row">${body}</div>`;
      })
      .join("");
    return { html, count: items.length };
  }

  /** „1 dzień", „3 dni" — polska liczba mnoga. */
  function dni(count) {
    return count === 1 ? t("dzień") : t("dni");
  }

  /* ── Sekcje skrzynki: glance / trash (checkboxy + kasowanie) ──── */

  function triageRow(mail, { checkbox = false, checked = false } = {}) {
    const box = checkbox
      ? `<input type="checkbox" class="row__box" data-triage-box data-id="${escape(mail.id)}" data-domain="${escape(mail.domain)}" ${checked ? "checked" : ""} />`
      : "";
    return `
      <label class="row">
        ${box}
        <span class="row__body">
          <span class="row__line"><span class="row__from">${escape(mail.from)}</span><span class="row__subject">${escape(mail.subject)}</span></span>
          <span class="row__reason">${escape(mail.reason)}</span>
        </span>
      </label>`;
  }

  function renderGlance() {
    const items = state.triage.data?.glanceOnly ?? [];
    if (state.triage.status === "loading") return { html: `<p class="empty">${t("Analizuję skrzynkę…")}</p>`, count: 0 };
    if (state.triage.status === "error") return { html: `<p class="empty">${escape(state.triage.message)}</p>`, count: 0 };
    if (!items.length) return { html: `<p class="empty">${t("Pusto — nic w tej grupie.")}</p>`, count: 0 };
    return { html: items.map((mail) => triageRow(mail)).join(""), count: items.length };
  }

  function renderTrash() {
    if (state.triage.status === "loading") return { html: `<p class="empty">${t("Analizuję skrzynkę…")}</p>`, count: 0 };
    if (state.triage.status === "error") return { html: `<p class="empty">${escape(state.triage.message)}</p>`, count: 0 };

    const items = state.triage.data?.trashCandidate ?? [];
    const note = state.triage.degraded
      ? `<p class="triage__note">${t("Model niedostępny — segregacja regułami lokalnymi.")}</p>`
      : "";
    const rows = items.length
      ? items.map((mail) => triageRow(mail, { checkbox: true, checked: true })).join("")
      : `<p class="empty">${t("Pusto — nic w tej grupie.")}</p>`;
    const action = items.length
      ? `<button class="bulk-act" data-triage-trash>${t("Przenieś zaznaczone do Kosza")}</button>`
      : "";
    return { html: `${note}${rows}${action}`, count: items.length };
  }

  /* ── Placeholder: Kalendarz i przegląd dnia ───────────────────── */

  function renderDay(plan, said) {
    const rows = plan?.all ?? [];
    if (!rows.length) return `<p class="empty">${t("Kalendarz na dziś jest pusty.")}</p>`;
    const nextId = plan.next?.id ?? null;
    return rows
      .map((event) => {
        const note = saidAbout(event.title, said);
        const soon =
          event.id === nextId && Number.isFinite(plan.minutesToNext)
            ? `<span class="slot__soon">${inMinutes(plan.minutesToNext)}</span>`
            : "";
        return `
          <div class="slot" data-done="${(plan.done ?? []).some((d) => d.id === event.id)}"
               data-next="${event.id === nextId}">
            <div class="slot__at">${clock(event.from)}–${clock(event.to)}</div>
            <div class="slot__what">
              <div class="slot__title">${escape(event.title)}${soon}</div>
              ${note ? `<p class="slot__note">${escape(note)}</p>` : ""}
            </div>
          </div>`;
      })
      .join("");
  }

  function renderFeeds(feeds) {
    if (!feeds?.length) return "";
    return `
      <div class="subhead">${t("Świat")}</div>
      ${feeds
        .map(
          (entry) => `
        <a class="feed" href="${escape(entry.link)}" target="_blank" rel="noreferrer">
          <em>${escape(entry.source)}</em>${escape(entry.title)}
        </a>`,
        )
        .join("")}`;
  }

  function renderCalendar() {
    const plan = state.briefing?.plan;
    const feeds = state.briefing?.feeds ?? [];
    if (!state.briefing) return { html: "", count: 0 };
    const said = state.briefing.words?.day ?? [];
    const html = `
      <p class="placeholder-note">${t("Ten moduł jest jeszcze placeholderem — pełny przegląd dnia dojedzie tu później.")}</p>
      <div class="subhead">${t("Plan dnia")}</div>
      ${renderDay(plan, said)}
      ${renderFeeds(feeds)}`;
    return { html, count: plan?.all?.length ?? 0 };
  }

  /* ── Rysowanie całości ─────────────────────────────────────────── */

  function fill(id, countId, { html, count }) {
    const body = document.getElementById(id);
    if (body) body.innerHTML = html;
    const badge = document.getElementById(countId);
    if (badge) badge.textContent = String(count);
  }

  function render() {
    fill("body-urgent", "count-urgent", renderUrgent());
    fill("body-waiting", "count-waiting", renderWaiting());
    fill("body-glance", "count-glance", renderGlance());
    fill("body-trash", "count-trash", renderTrash());
    fill("body-calendar", "count-calendar", renderCalendar());
  }

  function renderHeader() {
    const data = state.briefing;
    if (!data) return;
    const at = new Date(data.at ?? Date.now());
    const date = at.toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" });
    $("#date").textContent = date;
    const headline = data.words?.headline;
    const headEl = $("#headline");
    if (headline) {
      headEl.textContent = headline;
      headEl.hidden = false;
    } else {
      headEl.hidden = true;
    }

    const problems = data.problems ?? [];
    $("#trouble").innerHTML = problems.length
      ? `<div class="trouble">${problems.map((line) => escape(line)).join("<br />")}</div>`
      : "";
  }

  /* ── Zdarzenia: briefing:data ──────────────────────────────────── */

  api.briefing?.onData?.((data) => {
    state.briefing = data ?? {};
    $("#wait").hidden = true;
    $("#stage").hidden = false;
    renderHeader();
    render();
  });

  /* ── Raport Skrzynki: segregacja modelem, osobny cykl życia ─────
     Rusza od razu, niezależnie od briefing:data — patrz komentarz
     na górze pliku. */

  async function loadTriage() {
    state.triage = { status: "loading" };
    render();
    try {
      const data = await api.mail.analyze();
      state.triage = { status: "ready", data, degraded: !!data.degraded };
    } catch (error) {
      state.triage = { status: "error", message: error?.message || t("Nie udało się przeanalizować skrzynki.") };
    }
    render();
  }

  /** Zdejmuje zaznaczone pozycje z widoku „Auto-trash" po zatwierdzeniu. */
  function dropTrashed(ids) {
    if (!state.triage.data) return;
    const gone = new Set(ids);
    state.triage.data.trashCandidate = state.triage.data.trashCandidate.filter((mail) => !gone.has(mail.id));
    render();
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-triage-trash]")) return;
    event.preventDefault();
    const host = $("#body-trash");
    const boxes = [...(host?.querySelectorAll("[data-triage-box]:checked") ?? [])];
    if (!boxes.length) return;
    const items = boxes.map((box) => ({ id: box.dataset.id, domain: box.dataset.domain }));
    const btn = event.target.closest("[data-triage-trash]");
    btn.disabled = true;
    btn.textContent = t("Przenoszę…");
    api.mail
      .trashSelected(items)
      .then(() => dropTrashed(items.map((item) => item.id)))
      .catch(() => {
        btn.disabled = false;
        btn.textContent = t("Przenieś zaznaczone do Kosza");
      });
  });

  void loadTriage();

  /* Odnośniki wychodzą do przeglądarki, a nie otwierają się w tym oknie. */
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='http']");
    if (!link) return;
    event.preventDefault();
    api.system?.openExternal?.(link.href);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.close();
  });
})();
