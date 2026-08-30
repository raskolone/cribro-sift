"use strict";

/**
 * Poranek — rysowanie.
 *
 * Cała treść przychodzi gotowa z procesu głównego jedną wiadomością
 * (`briefing:data`); tutaj nie ma ani jednej decyzji o tym, CO pokazać.
 * To jest celowe: wybór maili i kolejność dnia rozstrzyga main/briefing.js
 * i sprawdza je zwykły Node, bez przeglądarki. Widok, który zaczynałby
 * filtrować po swojemu, byłby drugim miejscem z regułami — i pierwszym,
 * którego nikt nie testuje.
 *
 * Zdanie od modelu (`words`) jest DODATKIEM do listy, nie jej zamiennikiem.
 * Gdy modelu nie było albo odmówił, lista maili i plan dnia stoją same
 * i są kompletne. Odwrotnie się nie da: samo zdanie bez listy nie mówi,
 * co otworzyć.
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

  /** „za 25 min", „za 2 godz." — to, o co się naprawdę pyta. */
  function inMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) return "";
    if (minutes < 1) return t("za chwilę");
    if (minutes < 90) return t("za {n} min", { n: minutes });
    return t("za {n} godz.", { n: Math.round(minutes / 60) });
  }

  /**
   * Zdanie modelu dopasowane do pozycji listy.
   *
   * Model dostaje maile ponumerowane i oddaje je w tej samej kolejności,
   * ale bywa oszczędny i pomija te, o których nie ma nic do powiedzenia.
   * Dlatego dopasowujemy PO NADAWCY, a nie po numerze wiersza: pomylone
   * przesunięcie przypisałoby zdanie o Magdalenie do maila od Tomasza,
   * czyli skłamałoby dokładnie tam, gdzie ma pomagać.
   */
  function saidAbout(subject, lines) {
    const who = String(subject ?? "").trim().toLowerCase();
    const first = who.split(/\s+/)[0];
    if (!first || first.length < 3) return "";
    const hit = (lines ?? []).find((line) => line.toLowerCase().includes(first));
    if (!hit) return "";

    /* „Magdalena — czeka na potwierdzenie." → zostaje samo zdanie.
       Myślnik MUSI stać w otoczeniu spacji i musi być myślnikiem, a nie
       dywizem: „Stand-up zespołu" ma w środku kreskę, po której cięcie
       zostawiało na ekranie „up zespołu". Widać to było jako urwane słowo
       pod przekreśloną pozycją planu dnia. */
    const cut = hit.match(/^(.{0,60}?)\s[—–]\s(.+)$/);
    const said = (cut ? cut[2] : hit).trim();

    /* Zdanie, które tylko powtarza to, przy czym stoi, nie wnosi niczego —
       a wygląda jak usterka. Model bywa oszczędny i przepisuje samą nazwę. */
    const bare = said.toLowerCase().replace(/[.\s]+$/, "");
    if (!bare || who.includes(bare) || bare.includes(who)) return "";
    return said;
  }

  /* ── Rysowanie ─────────────────────────────────────────────── */

  function renderMail(picks, said) {
    if (!picks.length) {
      return `<p class="empty">${t("Nic nie czeka na Twoją odpowiedź. Tak też bywa.")}</p>`;
    }
    return picks
      .map((mail) => {
        const sentence = saidAbout(mail.from, said);
        const body = `
          <div>
            <span class="mail__from">${escape(mail.from)}</span>
            <span class="mail__subject">${escape(mail.subject)}</span>
          </div>
          ${sentence ? `<p class="mail__said">${escape(sentence)}</p>` : ""}
          <div class="mail__why">${escape(mail.why.join(" · "))}</div>`;
        /* Kliknięcie otwiera wątek w przeglądarce — jedyna czynność w tym
           oknie. Mail bez wątku (zdarza się) zostaje zwykłym akapitem,
           zamiast udawać odnośnik, który nigdzie nie prowadzi. */
        return mail.link
          ? `<a class="mail" href="${escape(mail.link)}" target="_blank" rel="noreferrer">${body}</a>`
          : `<div class="mail">${body}</div>`;
      })
      .join("");
  }

  function renderDay(plan, said) {
    const rows = plan?.all ?? [];
    if (!rows.length) {
      return `<p class="empty">${t("Kalendarz na dziś jest pusty.")}</p>`;
    }
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
      <section>
        <h2>${t("Świat")}</h2>
        ${feeds
          .map(
            (entry) => `
          <a class="feed" href="${escape(entry.link)}" target="_blank" rel="noreferrer">
            <em>${escape(entry.source)}</em>${escape(entry.title)}
          </a>`,
          )
          .join("")}
      </section>`;
  }

  function render(data) {
    const at = new Date(data.at ?? Date.now());
    const date = at.toLocaleDateString("pl-PL", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const words = data.words ?? {};

    $("#wait").hidden = true;
    $("#stage").innerHTML = `
      <header class="head">
        <div class="date">${escape(date)}</div>
        <h1>${t("Dzień dobry.")}</h1>
        ${words.headline ? `<p>${escape(words.headline)}</p>` : ""}
      </header>

      <section>
        <h2>${t("Wymaga uwagi")}</h2>
        ${renderMail(data.picks ?? [], words.mail)}
      </section>

      <section>
        <h2>${t("Plan dnia")}</h2>
        ${renderDay(data.plan, words.day)}
      </section>

      ${renderFeeds(data.feeds)}

      ${
        data.problems?.length
          ? `<div class="trouble">${data.problems.map((line) => escape(line)).join("<br />")}</div>`
          : ""
      }`;
  }

  /* ── Zdarzenia ─────────────────────────────────────────────── */

  api.briefing?.onData?.((data) => render(data ?? {}));

  /* Odnośniki wychodzą do przeglądarki, a nie otwierają się w tym oknie.
     Okno poranka wczytujące Gmaila przestałoby być porankiem. */
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='http']");
    if (!link) return;
    event.preventDefault();
    api.system?.openExternal?.(link.href);
  });

  // Escape zamyka — tak jak w każdym innym okienku tej aplikacji.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.close();
  });
})();
