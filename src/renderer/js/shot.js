/* Tekst z ekranu — okno z pytaniem i edytor graficzny Markup.
   Zaznaczenie obszaru już się stało, odczyt biegnie w tle. Tutaj zostaje
   decyzja: dokąd to trafi, w jakiej formie oraz opcjonalna edycja zrzutu
   (kadrowanie, kształty, zakreślacz, dymki, tekst). */

const api = window.cribro;
const $ = (selector) => document.querySelector(selector);

const choice = {
  target: "new",
  form: "text",
  noteId: null,
};

let reading = true;
let hasText = false;
let closing = false;
let currentImage = "";
let inMarkupMode = false;
let markup = null;

async function boot() {
  const settings = await api.settings.get();
  setLanguage(settings.uiLanguage ?? "pl");
  $("#text").spellcheck = settings.spellcheck?.enabled !== false;
  translateTree();

  const state = await api.shot.ready();
  if (!state) return; // okno bez zrzutu nie ma o czym rozmawiać

  currentImage = state.image ?? "";
  $("#shotImage").src = currentImage;
  choice.target = state.target ?? "new";
  choice.form = state.form ?? "text";

  await fillNotes();
  // Odczyt bywa szybszy niż otwarcie okna — wtedy tekst jest już w stanie
  // i nie ma na co czekać. Inaczej dopisze go shot:text.
  if (state.reading === false) applyText(state);
  paint();
  initMarkupUI();
}

/* Lista notatek do dopisania. Najświeższa na górze i wybrana z góry —
   „dopisz do notatki" prawie zawsze znaczy „do tej, przy której właśnie
   siedzę", a to jest ta ostatnio ruszana. */
async function fillNotes() {
  const notes = (await api.notes.get()) ?? [];
  const fresh = [...notes].sort(
    (a, b) => Date.parse(b.updatedAt ?? b.at ?? 0) - Date.parse(a.updatedAt ?? a.at ?? 0),
  );

  const select = $("#noteId");
  select.innerHTML = fresh
    .map((note) => `<option value="${note.id}">${escapeHtml(nameOf(note))}</option>`)
    .join("");

  choice.noteId = fresh[0]?.id ?? null;
  if (choice.noteId) select.value = choice.noteId;
  // Nie ma do czego dopisać — zostaje nowa notatka i schowek.
  if (!fresh.length) $('#target button[data-value="note"]').disabled = true;
}

/** Pierwsza linia notatki jest jej nazwą — tak samo jak w Notatniku. */
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

/* Odczyt skończony — albo tekstem, albo powodem, dla którego go nie ma.
   Brak klucza nie jest awarią: zrzut nadal da się wstawić jako obrazek,
   więc okno mówi o tym jednym zdaniem i przestawia formę, zamiast
   zamykać się z błędem. */
function applyText(state) {
  reading = false;
  const field = $("#text");
  field.dataset.state = "done";

  if (state.error) {
    show(t("Nie udało się odczytać tekstu: {powód}", { powód: state.error }), "warn");
  } else if (state.missingKey) {
    show(
      state.owner
        ? t("Brak klucza Gemini — zostaje sam obrazek. Klucz wpisuje się w Ustawieniach.")
        : t("Odczyt tekstu jest w tej chwili niedostępny — zostaje sam obrazek."),
      "warn",
    );
  }

  field.value = state.text ?? "";
  hasText = !!field.value.trim();

  // Bez tekstu jedyną sensowną formą jest obrazek — i tak też okno się ustawia,
  // zamiast zostawiać wybór, który nic by nie zapisał.
  if (!hasText) choice.form = "image";
  if (hasText && !inMarkupMode) field.focus();
}

function show(message, kind = "warn") {
  const note = $("#note");
  note.textContent = message;
  note.dataset.kind = kind;
  note.hidden = false;
}

/** Jeden przebieg po wszystkim, co zależy od wyboru — bez wyjątków. */
function paint() {
  for (const button of document.querySelectorAll("#target button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === choice.target));
  }
  $("#noteId").hidden = choice.target !== "note";

  const disk = choice.target === "disk";

  if (disk && choice.form === "text") choice.form = "image";
  if (!hasText && !reading) choice.form = "image";

  for (const button of document.querySelectorAll("#form button")) {
    const value = button.dataset.value;
    button.setAttribute("aria-pressed", String(value === choice.form));
    button.disabled = !hasText && !reading && value !== "image";
  }

  $("#formNote").textContent = disk
    ? t("zrzut zostanie zapisany jako plik PNG")
    : choice.form === "image"
      ? t("zrzut zostaje na dysku")
      : "";

  $("#save").disabled = reading && choice.form !== "image" && !disk;
  $("#readNote").textContent = reading ? t("czytam…") : t("poprawki wpisujesz tutaj");
}

for (const group of ["target", "form"]) {
  $(`#${group}`).addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    choice[group] = button.dataset.value;
    paint();
  });
}

$("#noteId").addEventListener("change", (event) => (choice.noteId = event.target.value));
$("#text").addEventListener("input", () => {
  hasText = !!$("#text").value.trim();
  paint();
});

async function save() {
  if (closing || inMarkupMode) return;
  const text = $("#text").value;
  if (choice.target !== "disk" && choice.form !== "image" && !text.trim()) return;

  closing = true;
  $("#save").disabled = true;

  const result = await api.shot.save({
    target: choice.target,
    noteId: choice.target === "note" ? choice.noteId : null,
    form: choice.form,
    text,
    image: currentImage,
  });

  if (result?.canceled) {
    closing = false;
    $("#save").disabled = false;
    return;
  }

  if (result?.error) {
    closing = false;
    $("#save").disabled = false;
    return show(result.error, "warn");
  }

  /* Potwierdzenie zamiast zniknięcia bez słowa. Okno zamyka proces
     główny — po tej jednej chwili, w której widać, dokąd rzecz poszła. */
  show(
    choice.target === "note"
      ? t("Dopisane do notatki.")
      : choice.target === "disk"
        ? t("Zapisano na dysku.")
        : t("Zapisane w nowej notatce."),
    "ok",
  );
}

$("#save").addEventListener("click", save);
$("#cancel").addEventListener("click", () => api.shot.cancel());
$("#close").addEventListener("click", () => api.shot.cancel());

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
  setTimeout(() => api.shot.cancel(), 650);
}

async function copyTextOnly() {
  const text = $("#text").value;
  if (!text.trim()) return show(t("Brak tekstu do skopiowania."), "warn");
  await api.shot.copyText(text.trim());
  notifyCopied("Tekst skopiowany do schowka!");
}

async function copyScreenshotOnly() {
  if (!currentImage) return show(t("Brak obrazu do skopiowania."), "warn");
  await api.shot.copyImage(currentImage);
  notifyCopied("Screenshot skopiowany do schowka!");
}

async function copyAllToClipboard() {
  const text = $("#text").value;
  await api.shot.copyAll({ text: text.trim(), image: currentImage });
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
  const text = $("#text").value;
  show(t("Wysyłam do Notatek Apple…"), "ok");
  const res = await api.shot.shareAppleNotes({ text: text.trim(), image: currentImage });
  if (res?.error) {
    show(res.error, "warn");
  } else {
    show(t("Dodano do Notatek Apple!"), "ok");
    setTimeout(() => api.shot.cancel(), 800);
  }
}

async function shareToNotion() {
  const text = $("#text").value;
  show(t("Otwieram w Notion…"), "ok");
  const res = await api.shot.shareNotion({ text: text.trim() });
  if (res?.error) {
    show(res.error, "warn");
  } else {
    show(t("Skopiowano i otwieram Notion!"), "ok");
    setTimeout(() => api.shot.cancel(), 800);
  }
}

async function shareToSpark() {
  const text = $("#text").value;
  show(t("Otwieram w Spark Mail…"), "ok");
  const res = await api.shot.shareSpark({ text: text.trim() });
  if (res?.error) {
    show(res.error, "warn");
  } else {
    show(t("Wiadomość utworzona w Spark!"), "ok");
    setTimeout(() => api.shot.cancel(), 800);
  }
}

async function shareToWhatsApp() {
  const text = $("#text").value;
  show(t("Otwieram WhatsApp…"), "ok");
  const res = await api.shot.shareWhatsApp({ text: text.trim() });
  if (res?.error) {
    show(res.error, "warn");
  } else {
    show(t("Przekazano do WhatsApp!"), "ok");
    setTimeout(() => api.shot.cancel(), 800);
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
  markup = new MarkupEngine({
    canvas,
    onStateChange: (state) => {
      // Aktualizacja paska narzędzi
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

      $("#fontSeg").style.display = ["text", "bubble"].includes(state.tool) || ["text", "bubble"].includes(state.selectedType) ? "flex" : "none";
      $("#markupUndo").disabled = !state.canUndo;
      $("#markupRedo").disabled = !state.canRedo;
      $("#markupDelete").disabled = !state.hasSelection;
    },
  });

  // Narzędzia
  document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => markup.setTool(btn.dataset.tool));
  });

  // Paleta kolorów
  document.querySelectorAll(".color-dot").forEach((dot) => {
    dot.addEventListener("click", () => markup.setColor(dot.dataset.color));
  });

  // Grubość linii
  document.querySelectorAll(".stroke-btn[data-width]").forEach((btn) => {
    btn.addEventListener("click", () => markup.setLineWidth(Number(btn.dataset.width)));
  });

  // Rozmiar czcionki
  document.querySelectorAll(".stroke-btn[data-size]").forEach((btn) => {
    btn.addEventListener("click", () => markup.setFontSize(Number(btn.dataset.size)));
  });

  // Undo / Redo / Delete
  $("#markupUndo").addEventListener("click", () => markup.undo());
  $("#markupRedo").addEventListener("click", () => markup.redo());
  $("#markupDelete").addEventListener("click", () => markup.deleteSelected());

  // Zakończenie edycji
  $("#markupDone").addEventListener("click", () => closeMarkup({ apply: true }));
  $("#markupCancel").addEventListener("click", () => closeMarkup({ apply: false }));

  // Wejście do edycji
  $("#preview").addEventListener("click", openMarkup);
  $("#openMarkupBtn").addEventListener("click", openMarkup);

  window.addEventListener("resize", () => {
    if (inMarkupMode && markup) markup.resize();
  });
}

async function openMarkup() {
  if (inMarkupMode || !currentImage) return;
  inMarkupMode = true;

  $("#mainView").hidden = true;
  $("#mainFooter").hidden = true;
  $("#markupView").hidden = false;

  // Powiększenie okna do wygodnych wymiarów edycji graficznej
  await api.shot.setWindowSize({ width: 880, height: 680 });

  await markup.loadImage(currentImage);
  markup.setTool("select");
}

async function closeMarkup({ apply = false } = {}) {
  if (!inMarkupMode) return;

  if (apply && markup) {
    const exported = markup.exportImage();
    if (exported?.dataUrl) {
      currentImage = exported.dataUrl;
      $("#shotImage").src = currentImage;
      await api.shot.updateImage(currentImage);
    }
  }

  inMarkupMode = false;
  $("#markupView").hidden = true;
  $("#mainView").hidden = false;
  $("#mainFooter").hidden = false;

  // Powrót do standardowych wymiarów modala
  await api.shot.setWindowSize({ width: 460, height: 640 });
}

/* ─────────────────────────────────────────────────────────────
   SKRÓTY KLAWIISZOWE
   ───────────────────────────────────────────────────────────── */
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

  if (event.key === "Escape") return api.shot.cancel();
  if (event.metaKey && event.key === "Enter") return save();
});

/* Odczyt przychodzi osobno, bo okno stanęło przed nim. */
api.shot.onText((state) => {
  applyText(state);
  paint();
});

boot();
