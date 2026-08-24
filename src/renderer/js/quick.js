/* Szybka notatka — najkrótsza droga od myśli do zapisanego zdania.
   Notatka powstaje od razu przy otwarciu okna, bo dyktowanie musi mieć
   dokąd dopisywać. Zamknięcie pustego okna kasuje ją z powrotem —
   inaczej po tygodniu Notatnik byłby pełen pustych wpisów. */

const api = window.cribro;

const $ = (selector) => document.querySelector(selector);
let note = null;
let saveTimer = null;
let runtime = "idle";

async function boot() {
  const settings = await api.settings.get();
  setLanguage(settings.uiLanguage ?? "pl");
  $("#text").spellcheck = settings.spellcheck?.enabled !== false;
  translateTree();

  // Szybka notatka trafia do własnej przegródki w Notatniku. To ta sama
  // szuflada co reszta, tylko z etykietą: myśl rzucona w biegu ma inny
  // ciężar niż notatka ze spotkania i nie powinny się mieszać na liście.
  note = await api.notes.create({ kind: "quick" });
  $("#text").focus();
}

function scheduleSave() {
  if (!note) return;
  note.text = $("#text").value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.notes.update(note.id, { text: note.text }), 400);
}

async function saveAndClose() {
  clearTimeout(saveTimer);
  const text = $("#text").value.trim();

  if (note) {
    if (text) await api.notes.update(note.id, { text: $("#text").value });
    else await api.notes.remove(note.id); // puste okno nie zostawia śladu
  }
  api.notes.closeQuick();
}

$("#text").addEventListener("input", scheduleSave);

$("#close").addEventListener("click", saveAndClose);
$("#save").addEventListener("click", saveAndClose);

$("#dictate").addEventListener("click", () => {
  if (note) api.notes.dictate(note.id);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // W trakcie nagrywania Escape znaczy „skasuj nagranie", nie „zamknij
    // okno". Inaczej jeden klawisz robiłby dwie rzeczy naraz i zabierałby
    // notatkę razem z nagraniem.
    if (runtime === "listening") return api.system.cancelCapture?.();
    return saveAndClose();
  }
  if (event.metaKey && event.key === "Enter") return saveAndClose();
});

/* Przycisk jest jedynym wskaźnikiem stanu — okno jest za małe na drugi. */
api.onState(({ state }) => {
  runtime = state;
  const button = $("#dictate");
  button.dataset.state = state;
  const label =
    state === "listening" ? t("Słucham…") : state === "sifting" ? t("Przesiewam…") : t("Dyktuj");
  button.querySelector("span").textContent = label;
});

/* Przesiany tekst dopisuje proces główny — my tylko pokazujemy wynik. */
api.notes.onAppended(async ({ id }) => {
  if (!note || id !== note.id) return;
  const fresh = (await api.notes.get()).find((item) => item.id === note.id);
  if (!fresh) return;
  note = fresh;
  $("#text").value = fresh.text;
  $("#text").focus();
  $("#text").setSelectionRange(fresh.text.length, fresh.text.length);
});

boot();
