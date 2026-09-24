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
  const URL_RE = /^https?:\/\/[^\s]+$/i;

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
    if (!fig.nextElementSibling) {
      const after = document.createElement("p");
      after.appendChild(document.createElement("br"));
      fig.after(after);
    }
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
    popover.style.display = "flex";

    const box = anchor.getBoundingClientRect();
    const pw  = 240;
    const ph  = 38;

    let left = box.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;

    let top = box.top - ph - 6;
    if (top < 8) {
      top = box.bottom + 6;
    }

    popover.style.left = `${Math.round(left + window.scrollX)}px`;
    popover.style.top = `${Math.round(top + window.scrollY)}px`;

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
      this._setupPaste();
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

    getCards() { return { ...this._cards }; }

    _setupPaste() {
      this.root.addEventListener("paste", (e) => {
        const text = (e.clipboardData?.getData("text/plain") ?? "").trim();
        if (URL_RE.test(text)) {
          e.preventDefault();
          e.stopPropagation();
          this.handleUrlPaste(text);
        }
      }, true);
    }

    handleUrlPaste(url) {
      const sel = window.getSelection();
      let anchor = null;

      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const a = document.createElement("a");
        a.className = "prose-link";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.dataset.url = url;
        a.textContent = url;
        range.insertNode(a);

        const after = document.createRange();
        after.setStartAfter(a);
        after.setEndAfter(a);
        sel.removeAllRanges();
        sel.addRange(after);
        anchor = a;
      } else {
        const p = document.createElement("p");
        const a = document.createElement("a");
        a.className = "prose-link";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.dataset.url = url;
        a.textContent = url;
        p.appendChild(a);
        this.root.appendChild(p);
        anchor = a;
      }

      this.root.dispatchEvent(new Event("input", { bubbles: true }));
      const current = this._cards[url]?.format ?? "text";
      showPopover(anchor, current, (fmt) => this._setFormat(url, fmt, anchor));
    }

    async handlePaste(text) {
      const clean = String(text ?? "").trim();
      if (URL_RE.test(clean)) {
        this.handleUrlPaste(clean);
      }
    }

    _findAnchor(url) {
      const fig = this.root.querySelector(`.link-card[data-url="${CSS.escape(url)}"]`);
      if (fig) return fig;
      const a = this.root.querySelector(`a[data-url="${CSS.escape(url)}"], a[href="${CSS.escape(url)}"]`);
      if (a) return a;
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
          const a = document.createElement("a");
          a.className = "prose-link";
          a.href = fig.dataset.url;
          a.target = "_blank";
          a.rel = "noopener";
          a.dataset.url = fig.dataset.url;
          a.textContent = fig.dataset.url;
          p.appendChild(a);
          fig.replaceWith(p);
        }
      }

      /* Podmień zapisane karty. */
      for (const [url, card] of Object.entries(this._cards)) {
        if (!card || card.format === "text") continue;
        const existingFig = this.root.querySelector(`.link-card[data-url="${CSS.escape(url)}"]`);
        if (existingFig) {
          refreshCard(existingFig, card.format, card.meta ?? null);
          continue;
        }
        const anchor = this._findAnchor(url);
        if (anchor) {
          const target = (anchor.tagName === "A" && anchor.parentElement && anchor.parentElement.childNodes.length === 1 && anchor.parentElement.tagName === "P")
            ? anchor.parentElement
            : anchor;
          insertCard(target, url, card.format, card.meta ?? null);
        }
      }
    }

    async _setFormat(url, format, anchorEl) {
      const existing = this._cards[url] ?? {};
      let meta = existing.meta ?? null;

      if (format !== "text") {
        let fig = anchorEl?.classList?.contains("link-card") ? anchorEl : null;
        if (!fig) {
          fig = document.createElement("figure");
          fig.className = `link-card link-card--${format}`;
          fig.dataset.url = url;
          fig.dataset.format = format;
          fig.setAttribute("contenteditable", "false");

          if (meta) {
            fig.innerHTML = buildCardInner(url, format, meta);
          } else {
            fig.innerHTML = skeletonInner();
          }

          const target = (anchorEl?.tagName === "A" && anchorEl.parentElement && anchorEl.parentElement.childNodes.length === 1 && anchorEl.parentElement.tagName === "P")
            ? anchorEl.parentElement
            : (anchorEl ?? this._findAnchor(url));

          if (target && target.parentNode) {
            target.replaceWith(fig);
          } else {
            this.root.appendChild(fig);
          }

          if (!fig.nextElementSibling) {
            const after = document.createElement("p");
            after.appendChild(document.createElement("br"));
            fig.after(after);
          }
        } else {
          fig.className = `link-card link-card--${format}`;
          fig.dataset.format = format;
          if (meta) {
            fig.innerHTML = buildCardInner(url, format, meta);
          } else {
            fig.innerHTML = skeletonInner();
          }
        }

        if (!meta && window.cribro?.links?.fetchPreview) {
          try {
            meta = await window.cribro.links.fetchPreview(url);
          } catch {
            meta = null;
          }
          const fresh = this.root.querySelector(`.link-card[data-url="${CSS.escape(url)}"]`);
          if (fresh) {
            refreshCard(fresh, format, meta);
          }
        }
      } else {
        const fig = this.root.querySelector(`.link-card[data-url="${CSS.escape(url)}"]`);
        if (fig) {
          const p = document.createElement("p");
          const a = document.createElement("a");
          a.className = "prose-link";
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener";
          a.dataset.url = url;
          a.textContent = url;
          p.appendChild(a);
          fig.replaceWith(p);
        }
      }

      this._cards[url] = { format, meta };
      this.root.dispatchEvent(new Event("input", { bubbles: true }));
      this.onSave({ ...this._cards });
    }

    _setupClicks() {
      this.root.addEventListener("click", (e) => {
        /* Otwarcie URL z karty. */
        const cardLink = e.target.closest("a[data-url]");
        if (cardLink && cardLink.closest(".link-card")) {
          e.preventDefault();
          e.stopPropagation();
          const url = cardLink.dataset.url || cardLink.href;
          if (url) void window.cribro?.system?.openExternal?.(url);
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

        /* Klik w link tekstowy <a>. */
        const link = e.target.closest("a.prose-link, a[href]");
        if (link && this.root.contains(link)) {
          e.preventDefault();
          e.stopPropagation();
          const url = link.dataset.url || link.getAttribute("href") || link.textContent.trim();
          if (url) {
            void window.cribro?.system?.openExternal?.(url);
            showPopover(link, this._cards[url]?.format ?? "text",
              (fmt) => this._setFormat(url, fmt, link));
          }
          return;
        }

        /* Klik w zwykły akapit zawierający goły URL — pokaż popover. */
        const bl = e.target.closest("p, li");
        if (bl && this.root.contains(bl)) {
          const txt = bl.textContent?.trim() ?? "";
          if (URL_RE.test(txt)) {
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
