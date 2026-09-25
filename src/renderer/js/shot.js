/* Tekst z ekranu — OCR Modal, edycja tekstu i edytor graficzny Markup.
   Obsługuje pełny cykl życia OCR:
   idle -> capturing -> processing -> success / empty / error -> saving
*/

const api = window.cribro;
const $ = (selector) => document.querySelector(selector);

/** @typedef {'idle' | 'capturing' | 'processing' | 'success' | 'empty' | 'error' | 'saving'} OcrState */

/** @type {OcrState} */
let ocrState = "idle";

const choice = {
  target: "new",
  form: "text",
  noteId: null,
};

let reading = true;
let hasText = false;
let saving = false;
let currentImage = "";
let inMarkupMode = false;
let markup = null;

let initialContext = {
  activeNotebookId: null,
  activeLessonId: null,
  activeStudentId: null,
  noteId: null,
};
let contextConfirmed = false;

/**
 * Przełącza stan interfejsu OCR i zarządza widocznością elementów.
 * @param {OcrState} nextState
 * @param {object} [details]
 */
function setOcrState(nextState, details = {}) {
  ocrState = nextState;

  const processingView = $("#processingView");
  const emptyView = $("#emptyView");
  const contentSection = $("#contentSection");
  const saveBtn = $("#save");
  const saveSpinner = saveBtn?.querySelector(".btn-spinner");
  const saveText = saveBtn?.querySelector(".btn-text");

  if (processingView) processingView.hidden = ocrState !== "processing";
  if (emptyView) emptyView.hidden = ocrState !== "empty";
  if (contentSection) contentSection.hidden = ocrState === "processing" || ocrState === "empty";

  if (ocrState === "saving") {
    if (saveBtn) saveBtn.disabled = true;
    if (saveSpinner) saveSpinner.hidden = false;
    if (saveText) saveText.textContent = t("Zapisywanie…");
  } else {
    if (saveSpinner) saveSpinner.hidden = true;
    if (saveText) saveText.textContent = choice.target === "note" ? t("Dopisz") : t("Zapisz");
  }

  if (ocrState === "success") {
    const textEl = $("#text");
    if (textEl && !inMarkupMode) {
      setTimeout(() => textEl.focus(), 50);
    }
  }

  paint();
}

async function boot() {
  const settings = (await api?.settings?.get?.()) ?? {};
  setLanguage(settings.uiLanguage ?? "pl");

  // Synchronizacja motywu (light / dark)
  try {
    const currentTheme = (await api?.theme?.get?.())?.resolved ?? settings.theme ?? "dark";
    document.documentElement.setAttribute("data-theme", currentTheme === "light" ? "light" : "dark");
    api?.theme?.onChange?.((resolved) => {
      document.documentElement.setAttribute("data-theme", resolved === "light" ? "light" : "dark");
      paint();
    });
  } catch (_e) {
    // fallback do domyślnego
  }

  const textField = $("#text");
  if (textField) textField.spellcheck = settings.spellcheck?.enabled !== false;
  translateTree();

  setOcrState("processing");

  const state = await api?.shot?.ready?.();
  if (!state) {
    setOcrState("idle");
    return;
  }

  currentImage = state.image ?? "";
  const shotImg = $("#shotImage");
  if (shotImg) shotImg.src = currentImage;
  choice.target = state.target ?? "new";
  choice.form = state.form ?? "text";

  // Zapamiętujemy kontekst wyjściowy (lekcja / notebook / kursant)
  initialContext = {
    activeNotebookId: state.activeNotebookId ?? settings.activeNotebookId ?? null,
    activeLessonId: state.activeLessonId ?? settings.activeLessonId ?? null,
    activeStudentId: state.activeStudentId ?? settings.activeStudentId ?? null,
    noteId: state.noteId ?? null,
  };

  await fillNotes();

  // Jeśli odczyt zakończył się przed otwarciem okna
  if (state.reading === false) {
    applyText(state);
  } else {
    setOcrState("processing");
  }

  paint();
  initMarkupUI();
  setupFocusTrap();
}

/**
 * Lista notatek do dopisania. Najświeższa na górze i wybrana domyślnie.
 */
async function fillNotes() {
  const notes = (await api?.notes?.get?.()) ?? [];
  const fresh = [...notes].sort(
    (a, b) => Date.parse(b.updatedAt ?? b.at ?? 0) - Date.parse(a.updatedAt ?? a.at ?? 0),
  );

  const select = $("#noteId");
  if (!select) return;

  select.innerHTML = fresh
    .map((note) => `<option value="${note.id}">${escapeHtml(nameOf(note))}</option>`)
    .join("");

  choice.noteId = initialContext.noteId ?? fresh[0]?.id ?? null;
  if (choice.noteId) select.value = choice.noteId;

  if (!fresh.length) {
    const noteBtn = $('#target button[data-value="note"]');
    if (noteBtn) noteBtn.disabled = true;
  }
}

/** Pierwsza linia notatki jest jej nazwą */
function nameOf(note) {
  const first = String(note.text ?? "")
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s*|^[-*]\s*(\[[ xX]\]\s*)?|^>\s*/, "").trim())
    .find(Boolean);
  const title = first || t("Bez tytułu");
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

const escapeHtml = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

/**
 * Zastosowanie wyniku OCR do okna edycji.
 * Obsługuje stany: error, empty, success.
 */
function applyText(state) {
  reading = false;
  const field = $("#text");
  if (!field) return;

  field.dataset.state = "done";

  if (state.error) {
    // Bezpieczny komunikat błędu bez surowego stack trace
    const cleanError = String(state.error).replace(/(\r\n|\n|\r).*/s, "").trim();
    show(t("Nie udało się odczytać tekstu: {powód}", { powód: cleanError || t("Błąd połączenia") }), "danger");
    setOcrState("error", { error: cleanError });
    return;
  }

  if (state.missingKey) {
    show(
      state.owner
        ? t("Brak klucza Gemini — zostaje sam obrazek. Klucz wpisuje się w Ustawieniach.")
        : t("Odczyt tekstu jest w tej chwili niedostępny — zostaje sam obrazek."),
      "warn",
    );
  }

  const rawText = state.text ?? "";
  field.value = rawText;
  hasText = !!rawText.trim();

  if (!hasText && !state.missingKey) {
    // Stan pusty - brak czytelnego tekstu
    setOcrState("empty");
    choice.form = "image";
  } else {
    // Sukces - znaleziono tekst
    setOcrState("success");
    if (!hasText) choice.form = "image";
  }
}

function show(message, kind = "warn") {
  const note = $("#note");
  if (!note) return;
  note.textContent = message;
  note.dataset.kind = kind;
  note.hidden = !message;
}

/**
 * Sprawdza, czy kontekst lekcji / kursanta nie zmienił się w trakcie OCR.
 */
async function verifyContext() {
  if (contextConfirmed) return true;

  try {
    const currentSettings = (await api?.settings?.get?.()) ?? {};
    const currLesson = currentSettings.activeLessonId ?? null;
    const currStudent = currentSettings.activeStudentId ?? null;
    const currNotebook = currentSettings.activeNotebookId ?? null;

    const changed =
      (initialContext.activeLessonId && currLesson && initialContext.activeLessonId !== currLesson) ||
      (initialContext.activeStudentId && currStudent && initialContext.activeStudentId !== currStudent) ||
      (initialContext.activeNotebookId && currNotebook && initialContext.activeNotebookId !== currNotebook);

    if (changed) {
      const warning = $("#contextWarning");
      if (warning) {
        warning.innerHTML = `
          <span>${escapeHtml(t("Kursant lub lekcja zmieniły się w trakcie odczytu OCR. Czy na pewno chcesz zapisać?"))}</span>
          <button type="button" id="confirmContextBtn">${escapeHtml(t("Zapisz mimo to"))}</button>
        `;
        warning.hidden = false;
        $("#confirmContextBtn")?.addEventListener("click", () => {
          contextConfirmed = true;
          warning.hidden = true;
          save();
        });
      }
      return false;
    }
  } catch (_e) {
    // Ignoruj błędy pobierania kontekstu
  }

  return true;
}

/** Aktualizacja stanu elementów interfejsu */
function paint() {
  for (const button of document.querySelectorAll("#target button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === choice.target));
  }
  const noteSelect = $("#noteId");
  if (noteSelect) noteSelect.hidden = choice.target !== "note";

  const disk = choice.target === "disk";

  if (disk && choice.form === "text") choice.form = "image";
  if (!hasText && !reading && ocrState === "empty") choice.form = "image";

  for (const button of document.querySelectorAll("#form button")) {
    const value = button.dataset.value;
    button.setAttribute("aria-pressed", String(value === choice.form));
    button.disabled = !hasText && !reading && value !== "image" && ocrState === "empty";
  }

  const formNote = $("#formNote");
  if (formNote) {
    formNote.textContent = disk
      ? t("zrzut zostanie zapisany jako plik PNG")
      : choice.form === "image"
        ? t("zrzut zostaje na dysku")
        : "";
  }

  const saveBtn = $("#save");
  if (saveBtn) {
    const isSaveDisabled =
      ocrState === "saving" ||
      ocrState === "processing" ||
      (choice.target !== "disk" && choice.form !== "image" && !hasText);
    saveBtn.disabled = isSaveDisabled;
  }

  const readNote = $("#readNote");
  if (readNote) {
    readNote.textContent = reading ? t("czytam…") : t("poprawki wpisujesz tutaj");
  }
}

for (const group of ["target", "form"]) {
  $(`#${group}`)?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    choice[group] = button.dataset.value;
    paint();
  });
}

$("#noteId")?.addEventListener("change", (event) => (choice.noteId = event.target.value));

$("#text")?.addEventListener("input", () => {
  const currentText = $("#text")?.value ?? "";
  hasText = !!currentText.trim();
  paint();
});

// Przełączenie na zapis jako obrazek w stanie pustym
$("#switchToImageBtn")?.addEventListener("click", () => {
  choice.form = "image";
  setOcrState("success");
  paint();
});

/**
 * Zapis zmodyfikowanej zawartości OCR.
 */
async function save() {
  if (saving || inMarkupMode || ocrState === "saving" || ocrState === "processing") return;

  const text = $("#text")?.value ?? "";
  const trimmed = text.trim();

  if (choice.target !== "disk" && choice.form !== "image" && !trimmed) {
    return show(t("Nie ma czego zapisać."), "warn");
  }

  const contextOk = await verifyContext();
  if (!contextOk) return;

  saving = true;
  setOcrState("saving");

  try {
    const result = await api?.shot?.save?.({
      target: choice.target,
      noteId: choice.target === "note" ? choice.noteId : null,
      form: choice.form,
      text, // Zapisujemy zmodyfikowany tekst, nie pierwotny wynik OCR
      image: currentImage,
      context: initialContext,
    });

    if (result?.canceled) {
      saving = false;
      setOcrState("success");
      return;
    }

    if (result?.error) {
      saving = false;
      setOcrState("success");
      return show(result.error, "danger");
    }

    // Potwierdzenie zapisu przed zamknięciem okna
    show(
      choice.target === "note"
        ? t("Dopisane do notatki.")
        : choice.target === "disk"
          ? t("Zapisano na dysku.")
          : t("Zapisane w nowej notatce."),
      "ok",
    );

    setTimeout(() => {
      api?.shot?.cancel?.();
    }, 450);
  } catch (error) {
    saving = false;
    setOcrState("success");
    show(error?.message || t("Nie udało się zapisać zrzutu"), "danger");
  }
}

$("#save")?.addEventListener("click", save);
$("#cancel")?.addEventListener("click", () => api?.shot?.cancel?.());
$("#close")?.addEventListener("click", () => api?.shot?.cancel?.());

/* ─────────────────────────────────────────────────────────────
   AKCJE SCHOWKA (DO SCHOWKA)
   ───────────────────────────────────────────────────────────── */
function notifyCopied(msg = "Skopiowano do schowka!") {
  show(t(msg), "ok");
  const feedback = $("#copyFeedback");
  if (feedback) {
    feedback.textContent = `✓ ${t("Skopiowano") || "Skopiowano"}`;
    feedback.hidden = false;
  }
  setTimeout(() => api?.shot?.cancel?.(), 650);
}

async function copyTextOnly() {
  const text = $("#text")?.value ?? "";
  if (!text.trim()) return show(t("Brak tekstu do skopiowania."), "warn");
  await api?.shot?.copyText?.(text.trim());
  notifyCopied("Tekst skopiowany do schowka!");
}

async function copyScreenshotOnly() {
  if (!currentImage) return show(t("Brak obrazu do skopiowania."), "warn");
  await api?.shot?.copyImage?.(currentImage);
  notifyCopied("Screenshot skopiowany do schowka!");
}

async function copyAllToClipboard() {
  const text = $("#text")?.value ?? "";
  await api?.shot?.copyAll?.({ text: text.trim(), image: currentImage });
  notifyCopied("Wszystko skopiowane do schowka!");
}

$("#copyImageBtn")?.addEventListener("click", copyScreenshotOnly);
$("#copyTextBtn")?.addEventListener("click", copyTextOnly);
$("#copyShotImgBtn")?.addEventListener("click", copyScreenshotOnly);
$("#copyAllBtn")?.addEventListener("click", copyAllToClipboard);

/* ─────────────────────────────────────────────────────────────
   AKCJE UDOSTĘPNIANIA
   ───────────────────────────────────────────────────────────── */
async function shareToAppleNotes() {
  const text = $("#text")?.value ?? "";
  show(t("Wysyłam do Notatek Apple…"), "ok");
  const res = await api?.shot?.shareAppleNotes?.({ text: text.trim(), image: currentImage });
  if (res?.error) {
    show(res.error, "danger");
  } else {
    show(t("Dodano do Notatek Apple!"), "ok");
    setTimeout(() => api?.shot?.cancel?.(), 800);
  }
}

async function shareToNotion() {
  const text = $("#text")?.value ?? "";
  show(t("Otwieram w Notion…"), "ok");
  const res = await api?.shot?.shareNotion?.({ text: text.trim() });
  if (res?.error) {
    show(res.error, "danger");
  } else {
    show(t("Skopiowano i otwieram Notion!"), "ok");
    setTimeout(() => api?.shot?.cancel?.(), 800);
  }
}

async function shareToSpark() {
  const text = $("#text")?.value ?? "";
  show(t("Otwieram w Spark Mail…"), "ok");
  const res = await api?.shot?.shareSpark?.({ text: text.trim() });
  if (res?.error) {
    show(res.error, "danger");
  } else {
    show(t("Wiadomość utworzona w Spark!"), "ok");
    setTimeout(() => api?.shot?.cancel?.(), 800);
  }
}

async function shareToWhatsApp() {
  const text = $("#text")?.value ?? "";
  show(t("Otwieram WhatsApp…"), "ok");
  const res = await api?.shot?.shareWhatsApp?.({ text: text.trim() });
  if (res?.error) {
    show(res.error, "danger");
  } else {
    show(t("Przekazano do WhatsApp!"), "ok");
    setTimeout(() => api?.shot?.cancel?.(), 800);
  }
}

$("#shareAppleNotesBtn")?.addEventListener("click", shareToAppleNotes);
$("#shareNotionBtn")?.addEventListener("click", shareToNotion);
$("#shareSparkBtn")?.addEventListener("click", shareToSpark);
$("#shareWhatsAppBtn")?.addEventListener("click", shareToWhatsApp);

/* ─────────────────────────────────────────────────────────────
   OBSŁUGA TRYBU EDYCJI GRAFICZNEJ (MARKUP / CANVAS)
   ───────────────────────────────────────────────────────────── */
function initMarkupUI() {
  const canvas = $("#markupCanvas");
  if (!canvas || typeof window.MarkupEngine !== "function") return;

  markup = new window.MarkupEngine({
    canvas,
    onStateChange: (state) => {
      for (const btn of document.querySelectorAll(".tool-btn[data-tool]")) {
        btn.classList.toggle("active", btn.dataset.tool === state.tool);
      }
      for (const btn of document.querySelectorAll(".color-dot")) {
        btn.classList.toggle("active", btn.dataset.color.toLowerCase() === state.color.toLowerCase());
      }
      for (const btn of document.querySelectorAll(".stroke-btn[data-width]")) {
        btn.classList.toggle("active", Number(btn.dataset.width) === state.lineWidth);
      }
      for (const btn of document.querySelectorAll(".stroke-btn[data-size]")) {
        btn.classList.toggle("active", Number(btn.dataset.size) === state.fontSize);
      }

      const fontSeg = $("#fontSeg");
      if (fontSeg) {
        fontSeg.style.display =
          ["text", "bubble"].includes(state.tool) || ["text", "bubble"].includes(state.selectedType)
            ? "flex"
            : "none";
      }

      const undoBtn = $("#markupUndo");
      if (undoBtn) undoBtn.disabled = !state.canUndo;
      const redoBtn = $("#markupRedo");
      if (redoBtn) redoBtn.disabled = !state.canRedo;
      const delBtn = $("#markupDelete");
      if (delBtn) delBtn.disabled = !state.hasSelection;
    },
  });

  document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => markup.setTool(btn.dataset.tool));
  });

  document.querySelectorAll(".color-dot").forEach((dot) => {
    dot.addEventListener("click", () => markup.setColor(dot.dataset.color));
  });

  document.querySelectorAll(".stroke-btn[data-width]").forEach((btn) => {
    btn.addEventListener("click", () => markup.setLineWidth(Number(btn.dataset.width)));
  });

  document.querySelectorAll(".stroke-btn[data-size]").forEach((btn) => {
    btn.addEventListener("click", () => markup.setFontSize(Number(btn.dataset.size)));
  });

  $("#markupUndo")?.addEventListener("click", () => markup.undo());
  $("#markupRedo")?.addEventListener("click", () => markup.redo());
  $("#markupDelete")?.addEventListener("click", () => markup.deleteSelected());

  $("#markupDone")?.addEventListener("click", () => closeMarkup({ apply: true }));
  $("#markupCancel")?.addEventListener("click", () => closeMarkup({ apply: false }));

  $("#preview")?.addEventListener("click", openMarkup);
  $("#preview")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMarkup();
    }
  });
  $("#openMarkupBtn")?.addEventListener("click", openMarkup);

  window.addEventListener("resize", () => {
    if (inMarkupMode && markup) markup.resize();
  });
}

async function openMarkup() {
  if (inMarkupMode || !currentImage) return;
  inMarkupMode = true;

  const mainView = $("#mainView");
  const mainFooter = $("#mainFooter");
  const markupView = $("#markupView");

  if (mainView) mainView.hidden = true;
  if (mainFooter) mainFooter.hidden = true;
  if (markupView) markupView.hidden = false;

  await api?.shot?.setWindowSize?.({ width: 920, height: 720 });
  await markup?.loadImage?.(currentImage);
  markup?.setTool?.("select");
}

async function closeMarkup({ apply = false } = {}) {
  if (!inMarkupMode) return;

  if (apply && markup) {
    const exported = markup.exportImage();
    if (exported?.dataUrl) {
      currentImage = exported.dataUrl;
      const shotImg = $("#shotImage");
      if (shotImg) shotImg.src = currentImage;
      await api?.shot?.updateImage?.(currentImage);
    }
  }

  inMarkupMode = false;
  const markupView = $("#markupView");
  const mainView = $("#mainView");
  const mainFooter = $("#mainFooter");

  if (markupView) markupView.hidden = true;
  if (mainView) mainView.hidden = false;
  if (mainFooter) mainFooter.hidden = false;

  await api?.shot?.setWindowSize?.({ width: 640, height: 760 });
}

/* ─────────────────────────────────────────────────────────────
   FOCUS TRAP & DOSTĘPNOŚĆ KLAWIATURY (A11Y)
   ───────────────────────────────────────────────────────────── */
function setupFocusTrap() {
  const shell = $("#shell");
  if (!shell) return;

  document.addEventListener("keydown", (event) => {
    if (inMarkupMode) {
      if (event.key === "Escape") {
        event.preventDefault();
        return closeMarkup({ apply: false });
      }
      if (event.metaKey && event.key === "Enter") {
        event.preventDefault();
        return closeMarkup({ apply: true });
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      return api?.shot?.cancel?.();
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      return save();
    }

    // Obsługa Focus Trap przy wciskaniu klawisza Tab
    if (event.key === "Tab") {
      const focusable = Array.from(
        shell.querySelectorAll(
          'button:not([disabled]):not([hidden]), [href], input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])',
        ),
      ).filter((el) => el.offsetParent !== null);

      if (focusable.length === 0) return;

      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement.focus();
          event.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          event.preventDefault();
        }
      }
    }
  });
}

/* Nasłuchiwanie wyniku OCR z procesu głównego */
api?.shot?.onText?.((state) => {
  applyText(state);
  paint();
});

boot();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    choice,
    applyText,
    setOcrState,
    verifyContext,
    save,
  };
}
