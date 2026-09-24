"use strict";

/**
 * Kartki linków w notatce — trzy tryby wyświetlania adresu URL:
 *   "text"  — zwykły klikalny link (domyślny)
 *   "big"   — duża karta z banerem (16:9) i tytułem
 *   "small" — kompaktowa miniaturka z tytułem inline
 *
 * Dane karty (format i metadane) są przechowywane w note.linkCards.
 * Markdown notatki pozostaje czystym tekstem z gołym URL-em.
 */

(function () {
  const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

  function domain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return url; }
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ── Renderowanie kart ────────────────────────────────────────── */

  function buildCardInner(url, format, meta) {
    const d   = meta?.domain ?? domain(url);
    const ttl = meta?.title  ?? d;
    const img = meta?.image  ?? null;
    const fav = meta?.favicon ?? null;

    if (format === "big") {
      return `
        <a class="lc-big__link" href="${esc(url)}" data-url="${esc(url)}" tabindex="-1">
          ${img
            ? `<div class="lc-big__banner"><img class="lc-big__img" src="${esc(img)}" alt="" loading="lazy"/></div>`
            : `<div class="lc-big__banner lc-big__banner--empty">${fav ? `<img class="lc-fav-xl" src="${esc(fav)}" alt=""/>` : "🔗"}</div>`
          }
          <div class="lc-big__body">
            <div class="lc-big__title">${esc(ttl)}</div>
            <div class="lc-big__meta">${fav ? `<img class="lc-fav" src="${esc(fav)}" alt=""/>` : ""}<span class="lc-domain">${esc(d)}</span></div>
          </div>
        </a>
        <div class="lc-actions">
          <button class="lc-btn" data-do="small" title="Mała miniatura">🔲</button>
          <button class="lc-btn" data-do="text"  title="Zwykły link">🔗</button>
        </div>`;
    }
    return `
      <a class="lc-small__link" href="${esc(url)}" data-url="${esc(url)}" tabindex="-1">
        <div class="lc-small__thumb">${img
          ? `<img src="${esc(img)}" alt="" loading="lazy"/>`
          : fav ? `<img class="lc-fav-xl" src="${esc(fav)}" alt=""/>` : `<span class="lc-small__fallback">🔗</span>`
        }</div>
        <div class="lc-small__info">
          <div class="lc-small__title">${esc(ttl)}</div>
          <div class="lc-small__domain">${fav ? `<img class="lc-fav" src="${esc(fav)}" alt=""/>` : ""}${esc(d)}</div>
        </div>
      </a>
      <div class="lc-actions">
        <button class="lc-btn" data-do="big"  title="Duża karta">🖼️</button>
        <button class="lc-btn" data-do="text" title="Zwykły link">🔗</button>
      </div>`;
  }

  function skeletonInner() {
    return `<div class="lc-skeleton"><div class="lc-sk-banner"></div><div class="lc-sk-body"><div class="lc-sk-line lc-sk-line--long"></div><div class="lc-sk-line lc-sk-line--short"></div></div></div>`;
  }

  function insertCard(urlNode, url, format, meta) {
    const fig = document.createElement("figure");
    fig.className = `link-card link-card--${format}`;
    fig.dataset.url = url;
    fig.dataset.format = format;
    fig.setAttribute("contenteditable", "false");
    fig.innerHTML = buildCardInner(url, format, meta);
    urlNode.replaceWith(fig);
    const after = document.createElement("p");
    after.appendChild(document.createElement("br"));
    fig.after(after);
    return fig;
  }

  function refreshCard(fig, format, meta) {
    const url = fig.dataset.url;
    fig.className = `link-card link-card--${format}`;
    fig.dataset.format = format;
    fig.innerHTML = buildCardInner(url, format, meta);
  }

  /* ── Popover ──────────────────────────────────────────────────── */

  let popover = null;
  let popoverTimer = null;
  let popoverCb = null;

  const FMT = [
    { fmt: "text",  icon: "🔗", label: "Tekst" },
    { fmt: "big",   icon: "🖼️", label: "Duża karta" },
    { fmt: "small", icon: "🔲", label: "Miniatura" },
  ];

  function buildPopover() {
    if (popover) return;
    popover = document.createElement("div");
    popover.className = "lc-popover";
    popover.hidden = true;
    popover.innerHTML = FMT.map(({ fmt, icon, label }) =>
      `<button class="lc-pop-btn" data-fmt="${fmt}"><span class="lc-pop-icon">${icon}</span><span class="lc-pop-label">${label}</span></button>`
    ).join("");
    document.body.appendChild(popover);

    popover.addEventListener("pointerdown", (e) => {
      const btn = e.target.closest("[data-fmt]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (popoverCb) popoverCb(btn.dataset.fmt);
      hidePopover(true);
    });
  }

  function showPopover(anchor, currentFmt, cb) {
    buildPopover();
    clearTimeout(popoverTimer);
    popoverCb = cb;
    popover.hidden = false;
    const box = anchor.getBoundingClientRect();
    const pw  = 230;
    let left  = box.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    popover.style.cssText = `left:${Math.max(8, left)}px;top:${box.bottom + 6}px;`;
    for (const btn of popover.querySelectorAll("[data-fmt]")) {
      btn.classList.toggle("lc-pop-btn--active", btn.dataset.fmt === currentFmt);
    }
  }

  function hidePopover(now) {
    if (!popover) return;
    if (now) { popover.hidden = true; }
    else { popoverTimer = setTimeout(() => { if (popover) popover.hidden = true; }, 200); }
  }

  /* ── LinkCardManager ────────────────────────────────────────────── */

  class LinkCardManager {
    constructor(root, { onSave } = {}) {
      this.root  = root;
      this.onSave = onSave ?? (() => {});
      this._cards = {};
      this._setupClicks();
    }

    loadNote(note) {
      this._cards = { ...(note?.linkCards ?? {}) };
      this._rehydrate();
    }

    /* Wywołaj po każdej zmianie treści (np. w onInput). */
    sync(note) {
      this._cards = { ...(note?.linkCards ?? {}) };
      this._rehydrate();
    }

    /* Wywołaj z handlera paste, przekazując wklejony tekst. */
    async handlePaste(text) {
      if (!window.cribro?.links?.fetchPreview) return;
      const urls = [...(text.matchAll(URL_RE) ?? [])].map(m => m[0]);
      if (!urls.length) return;
      await new Promise(r => setTimeout(r, 100));
      for (const url of urls) {
        const anchor = this._findAnchor(url);
        if (!anchor) continue;
        const current = this._cards[url]?.format ?? "text";
        showPopover(anchor, current, (fmt) => this._setFormat(url, fmt, anchor));
      }
    }

    getCards() { return { ...this._cards }; }

    _findAnchor(url) {
      const fig = this.root.querySelector(`.link-card[data-url="${CSS.escape(url)}"]`);
      if (fig) return fig;
      for (const bl of this.root.children) {
        if ((bl.textContent?.trim() ?? "") === url) return bl;
      }
      return null;
    }

    _rehydrate() {
      /* Usuń karty, których URL zniknął z _cards. */
      for (const fig of [...this.root.querySelectorAll(".link-card")]) {
        if (!this._cards[fig.dataset.url]) {
          const p = document.createElement("p");
          p.textContent = fig.dataset.url;
          fig.replaceWith(p);
        }
      }
      /* Zamień akapity-URL na karty (jeśli mamy zapisany format inny niż text). */
      for (const bl of [...this.root.children]) {
        if (bl.classList?.contains("link-card")) continue;
        const txt = bl.textContent?.trim() ?? "";
        if (!/^https?:\/\/[^\s]+$/.test(txt)) continue;
        const card = this._cards[txt];
        if (!card || card.format === "text") continue;
        insertCard(bl, txt, card.format, card.meta ?? null);
      }
    }

    async _setFormat(url, format, anchorEl) {
      const existing = this._cards[url] ?? {};
      let meta = existing.meta ?? null;

      if (format !== "text") {
        /* Wyświetl skeleton, gdy brak meta. */
        let fig = anchorEl?.classList?.contains("link-card") ? anchorEl : null;
        if (!meta) {
          if (!fig) {
            fig = document.createElement("figure");
            fig.className = "link-card link-card--big";
            fig.dataset.url = url;
            fig.setAttribute("contenteditable", "false");
            fig.innerHTML = skeletonInner();
            const after = document.createElement("p");
            after.appendChild(document.createElement("br"));
            anchorEl.replaceWith(fig);
            fig.after(after);
          } else {
            fig.innerHTML = skeletonInner();
          }

          try { meta = await window.cribro.links.fetchPreview(url); }
          catch { meta = null; }

          const fresh = this.root.querySelector(`.link-card[data-url="${CSS.escape(url)}"]`);
          if (fresh) refreshCard(fresh, format, meta);
        } else {
          if (fig) { refreshCard(fig, format, meta); }
          else {
            const a = this._findAnchor(url);
            if (a) insertCard(a, url, format, meta);
          }
        }
      } else {
        const fig = this.root.querySelector(`.link-card[data-url="${CSS.escape(url)}"]`);
        if (fig) {
          const p = document.createElement("p");
          p.textContent = url;
          fig.replaceWith(p);
        }
      }

      this._cards[url] = { format, meta };
      this.onSave({ ...this._cards });
    }

    _setupClicks() {
      this.root.addEventListener("click", (e) => {
        /* Otwarcie URL z karty. */
        const a = e.target.closest("a[data-url]");
        if (a) {
          e.preventDefault();
          e.stopPropagation();
          void window.cribro?.system?.openExternal?.(a.dataset.url);
          return;
        }

        /* Przyciski formatu wewnątrz karty. */
        const btn = e.target.closest(".lc-btn[data-do]");
        if (btn) {
          e.preventDefault();
          e.stopPropagation();
          const fig = btn.closest(".link-card");
          if (fig) void this._setFormat(fig.dataset.url, btn.dataset.do, fig);
          return;
        }

        /* Klik w akapit z gołym URL — pokaż popover. */
        const bl = e.target.closest("p");
        if (bl && this.root.contains(bl)) {
          const txt = bl.textContent?.trim() ?? "";
          if (/^https?:\/\/[^\s]+$/.test(txt)) {
            showPopover(bl, this._cards[txt]?.format ?? "text",
              (fmt) => this._setFormat(txt, fmt, bl));
          }
        }
      });

      document.addEventListener("pointerdown", (e) => {
        if (popover && !popover.hidden && !popover.contains(e.target)) hidePopover(true);
      }, true);
    }
  }

  window.LinkCardManager = LinkCardManager;
})();
