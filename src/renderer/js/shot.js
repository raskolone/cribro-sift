/* Tekst z ekranu — okno z jednym pytaniem.
   Zaznaczenie obszaru już się stało, odczyt biegnie w tle. Tutaj zostaje
   decyzja, której nie wolno zgadywać za człowieka: dokąd to trafi i czy
   ma być tekstem, obrazkiem, czy jednym i drugim.

   Okno otwiera się ZANIM odczyt się skończy — inaczej po zaznaczeniu
   ekranu przez dwie sekundy nie działoby się nic i wyglądałoby to na
   zgubiony zrzut. Podgląd stoi więc od razu, a tekst dopisuje się sam. */

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

async function boot() {
  const settings = await api.settings.get();
  setLanguage(settings.uiLanguage ?? "pl");
  $("#text").spellcheck = settings.spellcheck?.enabled !== false;
  translateTree();

  const state = await api.shot.ready();
  if (!state) return; // okno bez zrzutu nie ma o czym rozmawiać

  $("#shotImage").src = state.image ?? "";
  choice.target = state.target ?? "new";
  choice.form = state.form ?? "text";

  await fillNotes();
  // Odczyt bywa szybszy niż otwarcie okna — wtedy tekst jest już w stanie
  // i nie ma na co czekać. Inaczej dopisze go shot:text.
  if (state.reading === false) applyText(state);
  paint();
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
      t("Brak klucza OpenAI — zostaje sam obrazek. Klucz wpisuje się w Ustawieniach."),
      "warn",
    );
  }

  field.value = state.text ?? "";
  hasText = !!field.value.trim();

  // Bez tekstu jedyną sensowną formą jest obrazek — i tak też okno się ustawia,
  // zamiast zostawiać wybór, który nic by nie zapisał.
  if (!hasText) choice.form = "image";
  if (hasText && choice.target !== "cursor") field.focus();
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

  /* Pod kursor idzie sam tekst i nie ma w tym nic do wyboru: obrazka
     nie da się wkleić w cudze pole tekstowe, a udawanie, że się da,
     kończyłoby się pustym wklejeniem. */
  const cursor = choice.target === "cursor";
  if (cursor) choice.form = "text";
  if (!hasText && !reading) choice.form = "image";

  for (const button of document.querySelectorAll("#form button")) {
    const value = button.dataset.value;
    button.setAttribute("aria-pressed", String(value === choice.form));
    button.disabled =
      (cursor && value !== "text") || (!hasText && !reading && value !== "image");
  }

  $("#formNote").textContent = cursor
    ? t("pod kursor idzie sam tekst")
    : choice.form === "image"
      ? t("zrzut zostaje na dysku")
      : "";

  $("#save").disabled = reading && choice.form !== "image";
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
  if (closing) return;
  const text = $("#text").value;
  if (choice.form !== "image" && !text.trim()) return;

  closing = true;
  $("#save").disabled = true;

  const result = await api.shot.save({
    target: choice.target,
    noteId: choice.target === "note" ? choice.noteId : null,
    form: choice.form,
    text,
  });

  if (result?.error) {
    closing = false;
    $("#save").disabled = false;
    return show(result.error, "warn");
  }

  /* Potwierdzenie zamiast zniknięcia bez słowa. Okno zamyka proces
     główny — po tej jednej chwili, w której widać, dokąd rzecz poszła. */
  show(
    choice.target === "cursor"
      ? t("Wklejone pod kursor.")
      : choice.target === "note"
        ? t("Dopisane do notatki.")
        : t("Zapisane w nowej notatce."),
    "ok",
  );
}

$("#save").addEventListener("click", save);
$("#cancel").addEventListener("click", () => api.shot.cancel());
$("#close").addEventListener("click", () => api.shot.cancel());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") return api.shot.cancel();
  if (event.metaKey && event.key === "Enter") return save();
});

/* Odczyt przychodzi osobno, bo okno stanęło przed nim. */
api.shot.onText((state) => {
  applyText(state);
  paint();
});

boot();
