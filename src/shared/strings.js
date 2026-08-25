"use strict";

/**
 * Wersje językowe interfejsu.
 *
 * Kluczem jest polski oryginał, nie wymyślony identyfikator. Powód jest
 * praktyczny: dzięki temu kod dalej czyta się po polsku, a brak tłumaczenia
 * oznacza tekst po polsku zamiast gołego `settings.hotkey.label`. Angielski
 * jest tu jedynym słownikiem — polski to źródło.
 *
 * Wyszukiwanie normalizuje białe znaki, więc napis rozbity na kilka linii
 * w szablonie HTML trafia na ten sam klucz co jednolinijkowy.
 *
 * Zmienne zapisujemy jako `{nazwa}`: `t("{n} min temu", { n: 5 })`.
 *
 * Plik jest wspólny dla procesu głównego (pasek menu, okna dialogowe)
 * i dla renderera, dlatego eksportuje się na oba sposoby.
 */

const EN = {
  /* ── Nawigacja i nagłówki widoków ── */
  Start: "Start",
  Przesiane: "Sifted",
  Notatnik: "Notepad",
  Notatki: "Notes",
  "Lista po lewej, notatka po prawej. Podwójne kliknięcie otwiera ją w osobnym okienku.":
    "List on the left, note on the right. A double click opens it in its own window.",
  Sito: "Sieve",
  Ziarna: "Grains",
  Ustawienia: "Settings",
  "Tylko to, co chciałeś powiedzieć.": "Only what you meant to say.",
  "Cztery kroki do pierwszego dyktowania.": "Four steps to your first dictation.",
  "Jedno pokrętło: jak gęsto przesiewać.": "One dial: how finely to sift.",
  "Słowa, których sito nigdy nie tknie.": "Words the sieve never touches.",
  "Skróty, dostawcy, prywatność.": "Shortcuts, providers, privacy.",
  Skrót: "Shortcut",
  "trzymaj i mów": "hold and speak",
  "Zwiń pas boczny": "Collapse sidebar",
  "Rozwiń pas boczny": "Expand sidebar",

  /* ── Pasek górny i stany ── */
  Dyktuj: "Dictate",
  Gotowe: "Ready",
  "Słucham…": "Listening…",
  "Przesiewam…": "Sifting…",
  "Sito {mesh}": "{mesh} sieve",

  /* ── Zgody ── */
  "Cribro potrzebuje zgody „Dostępność\"": "Cribro needs Accessibility permission",
  "Bez niej nie usłyszy skrótu na klawiaturze ani nie wklei tekstu pod kursor. Sam schowek działa i tak.":
    "Without it the shortcut stays deaf and text will not be pasted at the cursor. The clipboard works either way.",
  "Do tego czasu działa przełącznik <b>⌃⌥Spacja</b>: raz włącza nagrywanie, drugi raz kończy.":
    "Until then the <b>⌃⌥Space</b> toggle works: press once to start, once more to finish.",
  "Jeśli Cribro jest już na liście, ale zgoda nie działa: usuń wpis przyciskiem „−\", wróć tutaj i kliknij ponownie.":
    "If Cribro is already listed but the permission does nothing: remove the entry with “−”, come back here and click again.",
  "Przyznaj dostęp": "Grant access",
  Przyznany: "Granted",
  Przyznana: "Granted",
  Brakuje: "Missing",
  Pominięta: "Skipped",
  "Uprawnienia systemowe": "System permissions",
  "Mikrofon: {mic} · Dostępność: {ax}": "Microphone: {mic} · Accessibility: {ax}",
  przyznana: "granted",
  brak: "none",
  "Otwórz Ustawienia systemowe": "Open System Settings",

  /* ── Ekran startowy ── */
  "Pierwsze dyktowanie": "Your first dictation",
  "Cztery kroki. Potem już tylko trzymasz dwa klawisze i mówisz.":
    "Four steps. After that you just hold two keys and speak.",
  Mikrofon: "Microphone",
  "macOS zapyta raz. Bez zgody nie usłyszymy nic.":
    "macOS asks once. Without it we hear nothing.",
  Poproś: "Ask",
  Dostępność: "Accessibility",
  "(opcjonalnie)": "(optional)",
  "Potrzebna do skrótu ⌃+⌥ i wklejania pod kursor. Bez niej nagrywasz przyciskiem, a tekst ląduje w schowku.":
    "Needed for the ⌃+⌥ shortcut and pasting at the cursor. Without it you record with the button and the text lands in the clipboard.",
  Otwórz: "Open",
  Silniki: "Engines",
  "Transkrypcja:": "Transcription:",
  "· sito:": "· sieve:",
  ". Klucze na miejscu.": ". Keys are in place.",
  ". Klucze wpiszesz w Ustawieniach.": ". You enter the keys in Settings.",
  "Sprawdź transkrypcję": "Test transcription",
  "Sprawdź sito": "Test the sieve",
  "Powiedz coś": "Say something",
  "Naciśnij, mów przez kilka sekund i naciśnij ponownie. Tekst wyląduje w schowku i pod kursorem.":
    "Press, speak for a few seconds, press again. The text lands in the clipboard and at the cursor.",
  "Naciśnij, mów przez kilka sekund i naciśnij ponownie. Tekst wyląduje w schowku.":
    "Press, speak for a few seconds, press again. The text lands in the clipboard.",
  "Nagraj teraz": "Record now",
  "Zatrzymaj i przesiej": "Stop and sift",
  "Ostatni wynik": "Latest result",
  "Jeszcze nic tu nie ma.": "Nothing here yet.",

  /* ── Historia ── */
  Zapis: "Record",
  "Szukaj w przesianych…": "Search sifted…",
  Wyczyść: "Clear",
  Kopiuj: "Copy",
  "Co odpadło": "What fell through",
  "Ukryj różnicę": "Hide the difference",
  "Przesiej ponownie": "Sift again",
  Przypnij: "Pin",
  Odepnij: "Unpin",
  Usuń: "Delete",
  Przypięte: "Pinned",
  przypięta: "pinned",
  zostało: "kept",
  odsiane: "sifted out",
  poprawione: "corrected",
  "−{n} słów": "−{n} words",
  "{n} słów na wejściu, {out} na wyjściu": "{n} words in, {out} out",
  Sesje: "Sessions",
  "przesianych dyktowań": "dictations sifted",
  "Słowa zachowane": "Words kept",
  "trafiły do schowka": "made it to the clipboard",
  "Szum odsiany": "Noise removed",
  "zniknęło po drodze": "disappeared along the way",
  "Czas oddany": "Time given back",
  "wobec pisania na klawiaturze": "compared with typing",
  "Nic tu jeszcze nie ma": "Nothing here yet",
  "Spróbuj innego słowa.": "Try another word.",
  Skopiowane: "Copied",
  Usunięte: "Deleted",
  "Wyczyszczone. Przypięte zostały.": "Cleared. Pinned entries stayed.",
  "Połączono.": "Connected.",

  /* ── Czas ── */
  "przed chwilą": "just now",
  "{n} min temu": "{n} min ago",
  "{n} godz. temu": "{n} h ago",
  teraz: "now",
  "{n} min": "{n} min",
  "{n} godz.": "{n} h",

  /* ── Sito ── */
  "Gęstość oczek": "Mesh density",
  "Im drobniejsze sito, tym mniej przechodzi. Zmienisz to też z paska menu.":
    "The finer the sieve, the less gets through. You can change it from the menu bar too.",
  Zgrubne: "Coarse",
  Średnie: "Medium",
  Drobne: "Fine",
  "Zostaje prawie wszystko. Znikają tylko zacięcia.":
    "Almost everything stays. Only stumbles disappear.",
  "Czysta wypowiedź, twój głos.": "A clean sentence, in your voice.",
  "Zwięźle i formalnie. Gotowe do wysłania.": "Concise and formal. Ready to send.",
  "Własna wytyczna": "Custom guideline",
  "Jedno zdanie, które sito dostaje przy każdym dyktowaniu. Zostaw puste, jeśli nie masz potrzeby.":
    "One sentence the sieve gets with every dictation. Leave it empty if you have no need.",
  "np. Pisz zawsze bezokolicznikami w listach zadań. Nie używaj wykrzykników.":
    "e.g. Always use infinitives in task lists. No exclamation marks.",

  /* ── Język dyktowania ── */
  Język: "Language",
  "Język dyktowania": "Dictation language",
  "Tryb rozpoznawania": "Recognition mode",
  "Dwujęzycznie — dwa języki naraz": "Bilingual — two languages at once",
  "Jeden język": "Single language",
  "Rozpoznaj automatycznie": "Detect automatically",
  "Pierwszy język": "First language",
  "Drugi język": "Second language",
  "Przy dwóch językach model wie, że przeplatanie jest zamierzone, i nie tłumaczy wtrąceń w żadną stronę.":
    "With two languages the model knows the mixing is deliberate and never translates the interjections either way.",
  "Ten język dostaje dostawca wprost — najmniej miejsca na pomyłkę.":
    "This code goes to the provider directly — the least room for error.",
  "Drugi język pary. Terminy w nim wypowiedziane zostają w nim, nawet w środku zdania.":
    "The other half of the pair. Terms spoken in it stay in it, even mid-sentence.",
  Polski: "Polish",
  English: "English",
  Deutsch: "German",
  Français: "French",
  Español: "Spanish",
  Italiano: "Italian",
  Українська: "Ukrainian",
  Čeština: "Czech",

  /* ── Ziarna ── */
  "Dodaj słowo i wciśnij Enter": "Add a word and press Enter",
  "Nazwiska, nazwy produktów, żargon. Sito przepuszcza je w niezmienionej formie — nawet jeśli transkrypcja usłyszała coś podobnego.":
    "Names, products, jargon. The sieve passes them through untouched — even when the transcript heard something similar.",

  /* ── Polecenia ── */
  Polecenia: "Commands",
  "Zdania, po których sito wie, co zrobić.": "Phrases that tell the sieve what to do.",
  "Wykrywanie poleceń": "Command detection",
  "Sito nigdy nie odpowiada na to, co usłyszało — „napisz maila do Ani\" zapisuje jako to zdanie. Polecenia są jedynym wyjątkiem i właśnie dlatego nie zgaduje ich żaden model: ruszają wyłącznie frazy zapisane tutaj, a fraza znika z tekstu, zamiast zostać w nim jako słowa.":
    "The sieve never answers what it heard — „write an email to Ann\" is written down as that sentence. Commands are the only exception, and that is exactly why no model guesses them: only the phrases saved here ever fire, and the phrase disappears from the text instead of staying in it as words.",
  "Wykrywaj polecenia": "Detect commands",
  "Wyłączone: każde zdanie jest zwykłym tekstem, tak jak przed dodaniem tej karty.":
    "When off, every sentence is plain text, just as before this tab existed.",
  Furtka: "Escape phrase",
  "Wypowiedź zaczynająca się od tej frazy nie uruchamia żadnego polecenia. Potrzebna wtedy, gdy chcesz podyktować „zrób checklistę\" jako tekst.":
    "An utterance starting with this phrase fires no command. Needed when you want to dictate „make a checklist\" as text.",
  "Dodaj frazę i wciśnij Enter": "Add a phrase and press Enter",
  "Twoje polecenia": "Your commands",
  "Polecenie zmienia FORMĘ tego, co powiedziałeś — nigdy nie dopisuje treści, której nie było. Musi też mieć na czym pracować: sama fraza „zrób checklistę\" bez niczego dalej zostaje zwykłym zdaniem.":
    "A command changes the FORM of what you said — it never adds content that was not there. It also needs something to work on: the phrase „make a checklist\" with nothing after it stays an ordinary sentence.",
  "Dodaj polecenie": "Add a command",
  "Zobaczysz ją w pigułce podczas przesiewania i w zapisie.":
    "You will see it in the pill while sifting and in the record.",
  Wywołania: "Triggers",
  "Frazy, po których polecenie rusza. Warto dodać kilka wariantów, także po angielsku.":
    "The phrases that fire the command. Worth adding a few variants, English included.",
  "Dodaj wywołanie i wciśnij Enter": "Add a trigger and press Enter",
  "Gdzie może stać": "Where it may stand",
  "Nigdy w środku zdania — inaczej „żeby zrobiła checklistę\" uruchamiałoby polecenie w relacji z rozmowy.":
    "Never mid-sentence — otherwise „to make a checklist\" would fire a command inside an account of a conversation.",
  "Na początku albo na końcu": "At the start or at the end",
  "Tylko na początku": "Only at the start",
  "Tylko na końcu": "Only at the end",
  "Co sito ma zrobić": "What the sieve should do",
  "Wytyczna na to jedno dyktowanie. Pisz o formie, nie o treści — dopisywanie faktów zostaje zakazane tak czy owak.":
    "The guidance for this one dictation. Write about form, not content — adding facts stays forbidden either way.",
  "Polecenie może przesiać drobniej, nie ruszając pokrętła w Sicie.":
    "A command may sift finer without touching the dial in Sieve.",
  "Jak w Sicie": "As set in Sieve",
  Ujście: "Outlet",
  "Pod kursor": "Under the cursor",
  "Tak jak zwykle: wklejenie w aktywnej aplikacji i schowek.":
    "As usual: pasted into the active app, and the clipboard.",
  "Do notatki": "Into a note",
  "Dopisuje do notatki, do której dyktujesz. Spod kursora — zakłada nową.":
    "Appends to the note you are dictating into. From the cursor — it starts a new one.",
  "Nowa notatka": "New note",
  "Zawsze zakłada osobną notatkę i tam odkłada tekst.":
    "Always starts a separate note and puts the text there.",
  "Tylko schowek": "Clipboard only",
  "Nic się nigdzie nie wkleja.": "Nothing is pasted anywhere.",
  "Ujście słucha wyłącznie frazy wypowiedzianej dokładnie tak, jak ją zapisałeś.":
    "The outlet obeys only a phrase spoken exactly as you saved it.",
  "Włącz albo wyłącz": "Turn on or off",
  "Polecenie potrzebuje nazwy, wywołania i wytycznej.":
    "A command needs a name, a trigger and guidance.",
  Próba: "Dry run",
  "Wpisz zdanie tak, jak byś je powiedział. Próba sprawdza samo rozpoznanie — sita nie woła, więc odpowiada od razu i nic nie kosztuje.":
    "Type a sentence the way you would say it. The dry run checks recognition alone — it never calls the sieve, so it answers at once and costs nothing.",
  "np. Zrób checklistę: mleko, chleb i masło": "e.g. Make a checklist: milk, bread and butter",
  "np. Zapisz wypowiedź jako listę zadań: każdy punkt zaczyna się od „- [ ] \".":
    "e.g. Write the utterance as a task list: every item starts with „- [ ] \".",
  "Żadne polecenie nie ruszy. Sito dostanie:": "No command will fire. The sieve will get:",
  "Nic nie rusza.": "Nothing fires.",
  "To zwykły tekst do przesiania.": "This is plain text to sift.",
  "Sito może jeszcze rozpoznać wariant frazy po swojej stronie — próba sprawdza dopasowanie dokładne.":
    "The sieve may still recognise a variant of the phrase on its side — the dry run checks the exact match.",
  "rusza po frazie": "fires on the phrase",
  "Sito dostanie:": "The sieve will get:",
  "Komendy formatujące": "Formatting commands",
  "Te działają zawsze, także w środku zdania, i nie mają nic wspólnego z powyższymi — sito zna je z urodzenia i nie da się ich zmienić.":
    "These always work, mid-sentence too, and have nothing to do with the above — the sieve knows them from birth and they cannot be changed.",
  "pusta linia": "an empty line",
  "złamanie wiersza": "a line break",
  "element listy": "a list item",
  "znak interpunkcyjny": "a punctuation mark",
  "Bez polecenia": "Without the command",
  "Przesiewam bez polecenia…": "Sifting without the command…",
  Polecenie: "Command",

  /* ── Ustawienia ── */
  "Jeden komplet klawiszy, dwa sposoby mówienia. Escape zawsze przerywa nagranie i je kasuje — nic nie idzie wtedy do transkrypcji.":
    "One set of keys, two ways of speaking. Escape always cancels the recording and deletes it — nothing goes to transcription.",
  Trzymanie: "Hold",
  "Przytrzymaj klawisze i mów. Puszczasz — sito pracuje. Do jednego zdania w biegu.":
    "Hold the keys and speak. Let go and the sieve works. For a sentence on the move.",
  "Bez trzymania (hands-off)": "Hands-off",
  "Stuknij te same klawisze dwa razy pod rząd — nagrywanie zostaje włączone, ręce wolne. Kolejne stuknięcie kończy i przesiewa. Działa zawsze, obok trzymania: nie ma czego włączać, bo o sposobie decyduje gest, a nie ustawienie.":
    "Tap the same keys twice — recording stays on, hands free. Another tap ends it and sifts. Always on, alongside holding: there is nothing to switch, because the gesture decides, not a setting.",
  "Szybka notatka": "Quick note",
  "Otwiera małe okno z jednym polem tekstowym. Z menu aplikacji: ⌘⇧N. Skrótu globalnego, działającego spoza Cribro, jeszcze nie ma.":
    "Opens a small window with a single text field. From the app menu: ⌘⇧N. A global shortcut, working from outside Cribro, is not there yet.",
  "nie ustawiono": "not set",
  Wypróbuj: "Try it",
  Konflikty: "Conflicts",
  "Sprawdza skrót w ustawieniach systemu i pyta system, czy pozwoli go zarejestrować. Aplikacji podsłuchujących klawiaturę — jak narzędzia do dyktowania — nie widzi żaden interfejs, więc ich nie wykryje.":
    "Checks the shortcut against system settings and asks the system whether it may be registered. Apps that listen to the keyboard — like dictation tools — are invisible to every interface, so they stay undetected.",
  "Sprawdź konflikty": "Check conflicts",
  "Sprawdzam…": "Checking…",
  "zajęty:": "taken by:",
  wolny: "free",
  "Silnik skrótu": "Shortcut engine",
  "uiohook — trzymanie i hands-off działają": "uiohook — hold and hands-off work",
  "globalShortcut — brak zgody „Dostępność”, działa tylko przełącznik":
    "globalShortcut — no Accessibility permission, only the toggle works",
  "brak — skrót nie działa, użyj przycisku Dyktuj":
    "none — the shortcut is dead, use the Dictate button",

  Dock: "Dock",
  "Jak aplikacja pokazuje się poza oknem: ikoną w Docku i przełącznikiem ⌘Tab.":
    "How the app shows up outside its window: a Dock icon and the ⌘Tab switcher.",
  "Ikona w Docku": "Dock icon",
  "Wyłączenie zostawia Cribro wyłącznie w pasku menu — znika też z ⌘Tab.":
    "Turning it off leaves Cribro in the menu bar only — it also disappears from ⌘Tab.",
  Położenie: "Position",
  Podgląd: "Preview",


  Zachowanie: "Behaviour",
  "Co dzieje się w chwili, gdy tekst jest gotowy.": "What happens the moment the text is ready.",
  "Wklejaj pod kursor": "Paste at the cursor",
  "Poza schowkiem symuluje ⌘V w aktywnej aplikacji.":
    "Beyond the clipboard it simulates ⌘V in the active app.",
  "Dźwięk potwierdzenia": "Confirmation sound",
  "Krótki sygnał, gdy tekst trafi do schowka.":
    "A short chime when the text reaches the clipboard.",
  "Uruchamiaj przy starcie": "Launch at login",
  "Cribro czeka w pasku menu.": "Cribro waits in the menu bar.",
  "Zachowuj surowy transkrypt": "Keep the raw transcript",
  "Bez tego nie zobaczysz, co sito odsiało.":
    "Without it you will not see what the sieve removed.",

  "Język interfejsu": "Interface language",
  "Zmienia napisy w oknach, w pasku menu i na widgecie. Język dyktowania ustawia się osobno, w zakładce Sito.":
    "Changes the labels in the windows, the menu bar and the widget. The dictation language is set separately, in the Sieve tab.",

  "Dwa osobne kroki. Najpierw ktoś zamienia głos na tekst, potem ktoś inny ten tekst czyści. Możesz dać oba jednemu dostawcy albo je rozdzielić.":
    "Two separate steps. First someone turns speech into text, then someone else cleans that text up. You can give both to one provider or split them.",
  "Krok 1 — transkrypcja": "Step 1 — transcription",
  "Krok 2 — sito": "Step 2 — the sieve",
  "Zamienia nagranie na wierny zapis, razem z wahaniami i zacięciami.":
    "Turns the recording into a faithful transcript, hesitations and stumbles included.",
  "Czyści zapis: usuwa szum mowy, rozstrzyga autopoprawki, stawia interpunkcję.":
    "Cleans the transcript: removes speech noise, resolves self-corrections, adds punctuation.",
  Dostawca: "Provider",
  Model: "Model",
  "Klucz API": "API key",
  "Skąd go wziąć": "Where to get one",
  "Oba kroki chodzą na tym samym dostawcy — klucz wystarczy wpisać raz, w dowolnym z nich.":
    "Both steps run on the same provider — enter the key once, in either of them.",
  "Sprawdź połączenie": "Test the connection",
  "Woła dostawcę naprawdę — od razu wiesz, czy klucz i model działają.":
    "Calls the provider for real — you know at once whether the key and model work.",
  Sprawdź: "Test",
  "Atrapa (bez klucza)": "Mock (no key)",
  "Google Gemini": "Google Gemini",
  OpenAI: "OpenAI",
  "Anthropic Claude": "Anthropic Claude",

  /* ── Widget ── */
  Widget: "Widget",
  "Znaczek pływający nad wszystkimi aplikacjami — po to, żeby dopisać zdanie do notatki bez opuszczania tego, przy czym się właśnie siedzi.":
    "A badge floating above every application — so you can add a sentence to a note without leaving whatever you are in the middle of.",
  Widok: "View",
  "Kompaktowy — lista": "Compact — a list",
  "Pulpit — wszystkie kartki": "Desktop — every card",
  "Kliknięcie w znaczek rozwija przy nim listę notatek z wierzchu, a wybrana wychodzi z niej kartką. Wszystko w jednym rogu ekranu i wszystko znika razem ze znaczkiem.":
    "Clicking the badge unfolds the list of notes on top right next to it, and the note you pick comes out of it as a card. All in one corner of the screen, and all of it goes away with the badge.",
  "Każda notatka z wierzchu dostaje własną kartkę na pulpicie — jak karteczki przyklejone do ekranu. Kartki leżą tam, gdzie je położysz, zmieniają rozmiar uchwytem w rogu i zostają nad wszystkimi oknami, także po przełączeniu pulpitu. Schodzą z wierzchu tylko na wyraźny gest: kliknięcie w znaczek albo Escape — wszystkie naraz.":
    "Every note on top gets its own card on the desktop — like sticky notes on the screen. The cards stay where you put them, resize by the grip in the corner and stay above every window, across desktops too. They come off the top only on a deliberate gesture: a click on the badge or Escape — all of them at once.",
  "Otwórz w Notatniku": "Open in the Notepad",
  "Zdejmij z wierzchu": "Take off the top",
  "Pokazuj widget": "Show the widget",
  "Pływa nad wszystkim i nie przejmuje fokusu, dopóki się w niego nie kliknie.":
    "Floats above everything and takes no focus until you click it.",
  "Które notatki": "Which notes",
  "Otwórz notatkę w Notatniku albo w zakładce Notatki i włącz przy niej „Widoczna w widgecie\". Wybór zostaje na tym komputerze — na drugim ta sama notatka może leżeć schowana.":
    "Open a note in the Notepad or the Notes tab and switch on “Visible in the widget”. The choice stays on this computer — on another one the same note may sit hidden.",
  "Otwórz Notatnik": "Open the Notepad",
  "Widget przeciąga się za znaczek w dowolne miejsce ekranu i tam zostaje. Jeśli przepadł razem z drugim monitorem — tędy wraca.":
    "Drag the widget by its badge anywhere on screen and there it stays. If it vanished with a second monitor — this brings it back.",
  "Przywróć na miejsce": "Put it back",
  "Widget wrócił na swoje miejsce": "The widget is back in its place",
  "Widoczna w widgecie": "Visible in the widget",
  "Notatka jest na wierzchu": "The note is on top",
  "Notatka zeszła z wierzchu": "The note left the top",
  "Na wierzchu": "On top",
  "Nic jeszcze nie leży na wierzchu. Otwórz notatkę w Notatniku i włącz przy niej <b>Widoczna w widgecie</b>.":
    "Nothing is on top yet. Open a note in the Notepad and switch on <b>Visible in the widget</b> there.",
  "Notatki na wierzchu": "Notes on top",
  "Kolor notatki": "Note colour",
  "Zmień rozmiar": "Resize",
  "Podwójne kliknięcie zmienia tytuł": "A double click changes the title",
  Granat: "Navy",
  Mech: "Moss",
  Bursztyn: "Amber",
  Fiolet: "Violet",
  "Róż": "Rose",
  "Błękit": "Sky",
  Grafit: "Graphite",
  "Wróć do listy": "Back to the list",
  "Dyktuj do tej notatki": "Dictate into this note",
  Zwiń: "Collapse",
  "Pisz albo naciśnij mikrofon.": "Write, or press the microphone.",
  "Piszę…": "Typing…",
  pusta: "empty",
  "1 słowo": "1 word",

  /* ── Pisownia ── */
  Pisownia: "Spelling",
  "Podkreślanie błędów w notatkach i w szybkiej notatce. Podpowiedzi siedzą pod prawym przyciskiem myszy — tam też jest „Naucz się tego słowa\" dla nazwisk i nazw własnych.":
    "Underlining mistakes in notes and in the quick note. Suggestions live under the right mouse button — so does “Learn this word” for names and proper nouns.",
  "Sprawdzaj pisownię": "Check spelling",
  "Czerwona fala pod słowem, którego słownik nie zna. Nie zmienia niczego sama z siebie.":
    "A red squiggle under a word the dictionary does not know. It changes nothing on its own.",
  "Językiem zajmuje się macOS: rozpoznaje go sam z pisanego tekstu i korzysta ze słownika wspólnego dla wszystkich aplikacji. Listę języków ustawia się w Ustawieniach systemowych → Klawiatura → Tekst.":
    "macOS handles the language: it works it out from what you type and uses the dictionary shared by every app. The list of languages lives in System Settings → Keyboard → Text.",
  "Języki jak przy dyktowaniu": "Same languages as dictation",
  "Ten sam człowiek pisze w tych samych językach, w których mówi. Wyłącz, żeby wybrać osobno.":
    "The same person writes in the same languages they speak. Turn this off to pick them separately.",
  "Języki sprawdzania": "Spellcheck languages",
  "Bez zaznaczenia żadnego słownik wraca do angielskiego.":
    "With none selected the dictionary falls back to English.",
  "Naucz się tego słowa": "Learn this word",
  "Brak podpowiedzi": "No suggestions",

  /* ── Konto i chmura ── */
  "Konto i notatki w chmurze": "Account and notes in the cloud",

  /* ── Logowanie przez cudze konto ── */
  "Konto Google": "Google account",
  "Logowanie otwiera się w przeglądarce, nie tutaj — dzięki temu hasła do Google nie wpisujesz w oknie, które narysowała ta aplikacja.":
    "Signing in opens in your browser, not here — so you never type your Google password into a window this app drew itself.",
  "Zaloguj przez Google": "Sign in with Google",
  "Albo adresem i hasłem — konto jest to samo, jeśli adres w Google jest ten sam.":
    "Or with an address and password — it is the same account if the address in Google is the same.",
  "Czekam na przeglądarkę": "Waiting for the browser",
  "Dokończ logowanie w oknie, które się właśnie otworzyło. Wrócisz tu sam — ta karta zmieni się w chwili, gdy konto się potwierdzi.":
    "Finish signing in in the window that just opened. You will come back on your own — this card changes the moment the account is confirmed.",
  Przerwij: "Cancel",
  "Adresy powrotne dla logowania przez Google": "Return addresses for signing in with Google",
  "Panel Supabase → Authentication → URL Configuration → Redirect URLs. Dopisz wszystkie trzy — aplikacja bierze pierwszy wolny port. Ostatnia linijka zastępuje tamte trzy, jeśli wolisz jedną.":
    "Supabase dashboard → Authentication → URL Configuration → Redirect URLs. Add all three — the app takes the first free port. The last line replaces those three if you prefer just one.",
  "Do schowka": "To the clipboard",
  "Wklej do panelu jeden pod drugim.": "Paste them into the dashboard one under another.",
  "Kopiuj adresy": "Copy the addresses",
  "Adresy w schowku.": "The addresses are in the clipboard.",
  "Logowanie przerwane.": "Signing in cancelled.",
  "Minęło pięć minut bez odpowiedzi z przeglądarki.":
    "Five minutes went by with no answer from the browser.",
  "Kopia notatek na własnym projekcie Supabase — po to, żeby ta sama notatka była na dwóch komputerach. Wyłączone znaczy wyłączone: nic nie wychodzi z tego dysku. Historia dyktowania nie jedzie tam nigdy.":
    "A copy of your notes on your own Supabase project — so the same note is on two computers. Off means off: nothing leaves this disk. Dictation history never goes there.",
  "Włącz kopię w chmurze": "Turn on the cloud copy",
  "Bez tego reszta karty nic nie robi, a notatki zostają wyłącznie tutaj.":
    "Without this the rest of the card does nothing and notes stay here only.",
  "Adres projektu": "Project URL",
  "Panel Supabase → Project Settings → API → Project URL.":
    "Supabase dashboard → Project Settings → API → Project URL.",
  "Klucz publiczny (anon)": "Public key (anon)",
  "Ten sam ekran, pole „anon public\". Klucz service_role nie ma tu czego szukać — omija reguły dostępu i otwiera wszystkie konta naraz.":
    "Same screen, the “anon public” field. The service_role key has no business here — it bypasses the access rules and opens every account at once.",
  "Tabele zakłada się raz: wklej plik supabase/schema.sql z katalogu projektu do SQL Editora w panelu i naciśnij Run.":
    "The tables are created once: paste supabase/schema.sql from the project folder into the dashboard SQL Editor and press Run.",
  "Adres e-mail": "Email address",
  Hasło: "Password",
  "Co najmniej 6 znaków. Nie jest nigdzie zapisywane — zostaje token sesji.":
    "At least 6 characters. It is never stored — only a session token is.",
  Konto: "Account",
  "Notatki z tego komputera trafią do konta, na które się zalogujesz — razem z tymi, które powstały, zanim konto istniało.":
    "Notes from this computer go to the account you sign in to — including the ones written before the account existed.",
  Zaloguj: "Sign in",
  "Załóż konto": "Create account",
  "Nie pamiętam hasła": "Forgot the password",
  "Wyślemy link na podany adres.": "We will send a link to that address.",
  "Wyślij link": "Send the link",
  Zalogowany: "Signed in",
  Wyloguj: "Sign out",
  "Synchronizuj w tle": "Sync in the background",
  "Po każdej zmianie i co pięć minut. Wyłączone — tylko przyciskiem obok.":
    "After every change and every five minutes. Off — only with the button next to it.",
  "Ostatnia synchronizacja": "Last sync",
  "Trwa…": "Running…",
  "jeszcze nie było": "not yet",
  "Synchronizuj teraz": "Sync now",
  "Zmień projekt": "Change project",
  "Podaj adres e-mail i hasło.": "Enter an email address and a password.",
  "Podaj adres, na który wysłać link.": "Enter the address to send the link to.",
  "Zalogowano.": "Signed in.",
  "Konto założone. Kliknij link z poczty, potem zaloguj się tutaj.":
    "Account created. Click the link in your inbox, then sign in here.",
  "Konto założone i zalogowane.": "Account created and signed in.",
  "Wylogowano. Notatki zostają na tym dysku.": "Signed out. The notes stay on this disk.",
  "Link poszedł na podany adres.": "The link is on its way to that address.",
  "Przyjęte: {taken}, wysłane: {pushed}.": "Taken: {taken}, sent: {pushed}.",

  Prywatność: "Privacy",
  "Nagranie ginie zaraz po transkrypcji — na dysku zostaje tylko tekst. Historia leży w twoim katalogu użytkownika i nigdy nie opuszcza tego komputera.":
    "The recording dies right after transcription — only text stays on disk. History lives in your user folder and never leaves this computer.",
  "Nagranie ginie zaraz po transkrypcji — na dysku zostaje tylko tekst. Historia dyktowania leży w twoim katalogu użytkownika i nie opuszcza tego komputera: nie ma jej w chmurze i nie ma dokąd jej wysłać. Notatki jadą na serwer wyłącznie wtedy, gdy sam włączysz konto powyżej.":
    "The recording dies right after transcription — only text stays on disk. Dictation history lives in your user folder and does not leave this computer: it is not in the cloud and there is nowhere to send it. Notes go to a server only if you turn the account on above.",
  "Zostaje na tym dysku.": "Stays on this disk.",

  /* ── Notatnik ── */
  Nowa: "New",
  "1 notatka": "1 note",
  "{n} notatki": "{n} notes",
  "{n} notatek": "{n} notes",
  "brak notatek": "no notes",
  "{n} z {all}": "{n} of {all}",
  "Nowa notatka": "New note",
  "Szukaj w notatkach…": "Search notes…",
  "Dyktuj prosto do tej notatki": "Dictate straight into this note",
  "Wstaw godzinę (⌘T)": "Insert the time (⌘T)",
  Formatowanie: "Formatting",
  Nagłówek: "Heading",
  Pogrubienie: "Bold",
  Kursywa: "Italic",
  Lista: "List",
  "Lista zadań": "Task list",
  Cytat: "Quote",
  "Przesiej całą notatkę": "Sift the whole note",
  Udostępnij: "Share",
  "Wyślij do Notatek Apple": "Send to Apple Notes",
  "Kopiuj tekst": "Copy text",
  "Kopiuj jako Markdown": "Copy as Markdown",
  "Zapisz jako plik .md…": "Save as .md file…",
  "Usuń notatkę": "Delete note",
  "Otwórz w osobnym okienku": "Open in its own window",
  "Zwiń listę notatek": "Collapse the note list",
  "Szybkie notatki": "Quick notes",
  "Rozwiń listę notatek": "Expand the note list",
  "Podwójne kliknięcie otwiera notatkę w osobnym okienku":
    "A double click opens the note in its own window",
  "Podwójne kliknięcie zmienia tytuł": "A double click changes the title",
  "Zwiń przegródkę": "Collapse the section",
  "Rozwiń przegródkę": "Expand the section",
  "Pogrubienie (⌘B)": "Bold (⌘B)",
  "Kursywa (⌘I)": "Italic (⌘I)",
  "Nagłówek (⌘⇧H)": "Heading (⌘⇧H)",
  "Lista (⌘⇧8)": "List (⌘⇧8)",
  "Lista zadań (⌘⇧9)": "Task list (⌘⇧9)",
  "Cytat (⌘⇧')": "Quote (⌘⇧')",
  "Nic nie pasuje.": "Nothing matches.",

  /* ── Formatowanie: nagłówki, kreska, składanie, wyrównanie ── */
  "Nagłówki i bloki": "Headings and blocks",
  "Nagłówek 1": "Heading 1",
  "Nagłówek 2": "Heading 2",
  "Nagłówek 3": "Heading 3",
  "Nagłówek składany": "Toggle heading",
  "Linia rozdzielająca": "Divider",
  "Wyrównanie tekstu": "Text alignment",
  "Do lewej": "Left",
  Wyśrodkowany: "Centred",
  "Do prawej": "Right",
  Wyjustowany: "Justified",

  /* ── Szuflady i etykiety ── */
  Wszystkie: "All",
  "Bez szuflady": "No folder",
  "Szuflada notatki": "Note folder",
  "Nowa szuflada…": "New folder…",
  "+ etykieta": "+ tag",
  "Zdejmij etykietę": "Remove tag",
  "Pokaż notatki z tą etykietą": "Show notes with this tag",

  /* ── Wyprowadzanie na zewnątrz ── */
  "Zapisz jako PDF…": "Save as PDF…",
  "Wyślij do Notion": "Send to Notion",
  "Zapisane jako PDF": "Saved as PDF",
  "Wysyłam do Notion…": "Sending to Notion…",
  "Wysłane do Notion": "Sent to Notion",
  "Zaktualizowane w Notion": "Updated in Notion",
  "Notatka ze spotkania zaczyna się od jednego zdania. Reszta dopisze się sama — także głosem.":
    "A meeting note starts with a single sentence. The rest writes itself — by voice too.",
  "Pisz albo naciśnij Dyktuj i mów.\nNotatka zapisuje się sama.":
    "Type, or press Dictate and speak.\nThe note saves itself.",
  "Dopisane z dyktowania": "Added from dictation",
  "Przesiane — cofnij": "Sifted — undo",
  "Pisz albo naciśnij Dyktuj i mów.\n\nNotatka zapisuje się sama.":
    "Type, or press Dictate and speak.\n\nThe note saves itself.",
  Zapisane: "Saved",
  "Zapisywanie…": "Saving…",
  "{n} słów": "{n} words",
  "{n} sł.": "{n} w.",
  "Notatnik jest pusty": "The notepad is empty",
  "Szybka notatka ze spotkania": "A quick note from the meeting",
  "Zacznij pisać albo po prostu mów — tekst wpada tutaj przesiany.":
    "Start typing, or just speak — the text lands here sifted.",
  Cofnij: "Undo",
  "Przesiane. Można cofnąć.": "Sifted. You can undo.",
  "Wysłane do Notatek.": "Sent to Notes.",
  "Skopiowane.": "Copied.",
  "Zapisane na dysku.": "Saved to disk.",

  /* ── Ustawienia → Notion ── */
  "Notatka jako strona w Notion — z nagłówkami, listami zadań i składanymi sekcjami. Wysłana drugi raz odświeża tę samą stronę, zamiast robić drugą obok. W jedną stronę: z Notion nic tu nie wraca.":
    "A note as a Notion page — headings, task lists and toggle sections included. Sent a second time it refreshes the same page instead of making another one beside it. One way: nothing comes back from Notion.",
  "Token integracji": "Integration token",
  "notion.so/my-integrations → „New integration\" → „Internal Integration Secret\". To nie jest hasło do konta i samo z siebie nie daje dostępu do niczego.":
    "notion.so/my-integrations → “New integration” → “Internal Integration Secret”. This is not your account password and grants nothing on its own.",
  "Strona, pod którą wpadają notatki": "The page notes land under",
  "Wklej jej adres z przeglądarki — sam identyfikator też przejdzie.":
    "Paste its address from the browser — a bare identifier works too.",
  "⚠︎ Krok, który wszyscy pomijają: otwórz tę stronę w Notion, kliknij „•••\" w prawym górnym rogu → „Connections\" → i dodaj swoją integrację. Bez tego Notion odpowie, że strony nie ma — choć widzisz ją na ekranie.":
    "⚠︎ The step everybody skips: open that page in Notion, click “•••” in the top right → “Connections” → and add your integration. Without it Notion will answer that the page does not exist — while you are looking straight at it.",
  Sprawdzenie: "Check",
  "Czy token działa i czy integracja naprawdę widzi tę stronę.":
    "Whether the token works and the integration really sees that page.",
  "Sprawdź połączenie": "Check the connection",
  "Pytam Notion…": "Asking Notion…",
  "Działa — Notion widzi tę stronę.": "Works — Notion sees that page.",

  /* ── Szybka notatka (małe okno) ── */
  "Zapisz i zamknij": "Save and close",
  "Powiedz albo napisz jedno zdanie.": "Say or type a single sentence.",
  "⌘⏎ zapisuje · Esc zamyka": "⌘⏎ saves · Esc closes",
  "Zapisano w Notatniku.": "Saved to Notes.",

  /* ── Taca widgetu ── */
  "Dyktuj — ⌃⌥": "Dictate — ⌃⌥",
  "Gęstość sita": "Sieve density",
  "Zmień rozmiar kartki": "Resize the card",
  "Język dyktowania: {label}": "Dictation language: {label}",

  /* ── HUD ── */
  Słucham: "Listening",
  Przesiewam: "Sifting",
  "W schowku": "In the clipboard",
  schowek: "clipboard",
  "puść klawisze, żeby przesiać": "let go to sift",
  "stuknij ⌃⌥, żeby zakończyć · esc anuluje": "tap ⌃⌥ to finish · esc cancels",
  "naciśnij skrót ponownie, żeby zakończyć": "press the shortcut again to finish",
  "naciśnij Zatrzymaj · esc anuluje": "press Stop · esc cancels",
  "Nie mogę pomóc, bo nic nie usłyszałem": "I can't help — I didn't hear a thing",
  "Mów bliżej mikrofonu albo trzymaj klawisze dłużej niż sekundę.":
    "Speak closer to the microphone, or hold the keys for longer than a second.",

  /* ── Komunikaty ── */
  "Skopiowane do schowka": "Copied to the clipboard",
  "Przesiewam ponownie — sito {mesh}…": "Sifting again — {mesh} sieve…",
  "Bez tytułu": "Untitled",
  "Zapisuję…": "Saving…",
  "Przesiewam notatkę…": "Sifting the note…",
  "Wysyłam do Notatek Apple…": "Sending to Apple Notes…",
  "Wysłane do Notatek Apple": "Sent to Apple Notes",
  "Tekst skopiowany": "Text copied",
  "Markdown skopiowany": "Markdown copied",
  "Zapisane do pliku": "Saved to file",

  /* ── Szybka notatka (okno) ── */
  Zamknij: "Close",

  /* ── Tekst z ekranu (okno i ustawienia) ── */
  "Tekst z ekranu": "Text from the screen",
  Odczyt: "Reading",
  "poprawki wpisujesz tutaj": "corrections go here",
  "czytam…": "reading…",
  Dokąd: "Where to",
  "Do notatki": "To a note",
  "Pod kursor": "At the cursor",
  Forma: "Form",
  Tekst: "Text",
  Obrazek: "Image",
  Oba: "Both",
  "pod kursor idzie sam tekst": "only text goes to the cursor",
  "zrzut zostaje na dysku": "the capture stays on disk",
  "Zaznaczony fragment ekranu": "The selected part of the screen",
  Anuluj: "Cancel",
  Zapisz: "Save",
  "⌘⏎ zapisuje · Esc zamyka": "⌘⏎ saves · Esc closes",
  "Wklejone pod kursor.": "Pasted at the cursor.",
  "Dopisane do notatki.": "Appended to the note.",
  "Zapisane w nowej notatce.": "Saved as a new note.",
  "Brak klucza OpenAI — zostaje sam obrazek. Klucz wpisuje się w Ustawieniach.":
    "No OpenAI key — the image alone remains. The key goes in Settings.",
  "Nie udało się odczytać tekstu: {powód}": "The text could not be read: {powód}",
  "Nie udało się zapisać zrzutu": "The capture could not be saved",
  "Nie ma czego zapisać.": "There is nothing to save.",
  "Brak zgody „Nagrywanie ekranu” — włącz ją w Ustawieniach systemowych.":
    "No “Screen Recording” permission — turn it on in System Settings.",
  "Zaznaczasz kawałek ekranu, a to, co na nim widać, staje się notatką. Cudzy PDF, slajd z prezentacji, zrzut z rozmowy. Model tutaj wyłącznie czyta: nie poprawia literówek i nie odpowiada na to, co przeczytał.":
    "You select a piece of the screen and whatever is on it becomes a note. Someone else’s PDF, a slide, a screenshot of a conversation. Here the model only reads: it fixes no typos and answers nothing it has read.",
  "Naciśnij klawisze razem z modyfikatorem. Escape przerywa.":
    "Press the keys together with a modifier. Escape stops.",
  "Działa spoza Cribro — po to jest, bo zaznacza się cudze okno. macOS trzyma już ⌘⇧3, ⌘⇧4 i ⌘⇧5.":
    "Works from outside Cribro — that is the point, since you select someone else’s window. macOS already holds ⌘⇧3, ⌘⇧4 and ⌘⇧5.",
  "Ustaw klawisze": "Set keys",
  "Czekam na klawisze…": "Waiting for keys…",
  Zmień: "Change",
  Skasuj: "Clear",
  "Przechwyć teraz": "Capture now",
  "To samo, co robi skrót: krzyżyk na ekranie, spacja łapie całe okno, Escape przerywa.":
    "The same thing the shortcut does: crosshairs on the screen, space grabs a whole window, Escape stops.",
  "Zaznacz obszar": "Select an area",
  "Pytaj, dokąd trafia": "Ask where it goes",
  "Okienko z wyborem: nowa notatka, dopisanie do istniejącej albo pod kursor — i w jakiej formie. Bez pytania odczyt idzie tam, gdzie ostatnim razem.":
    "A small window with the choice: a new note, appending to an existing one, or the cursor — and in which form. Without asking, the reading goes where it went last time.",
  "Kopiuj odczyt do schowka": "Copy the reading to the clipboard",
  "Tak samo jak przesiane dyktowanie — najczęstsze, co się robi z tekstem wyjętym z cudzego okna, to wklejenie go gdzie indziej.":
    "Just like sifted dictation — the most common thing to do with text taken out of someone else’s window is to paste it elsewhere.",
  "Czyta tekst z obrazka. Zadanie odtwórcze, więc domyślnie najtańszy model — różnicę widać na rachunku, nie w wyniku.":
    "Reads the text off the image. A copying task, so the cheapest model by default — the difference shows on the bill, not in the result.",
  "Skrót skasowany — zostaje menu.": "Shortcut cleared — the menu remains.",
  "Skrót globalny potrzebuje ⌘, ⌃, ⌥ albo ⇧.": "A global shortcut needs ⌘, ⌃, ⌥ or ⇧.",
  "{skrót} jest zajęty: {kto}": "{skrót} is taken: {kto}",
  "{skrót} ustawiony.": "{skrót} set.",

  /* ── Menu aplikacji ── */
  "O programie": "About",
  Usługi: "Services",
  Ukryj: "Hide",
  "Ukryj pozostałe": "Hide Others",
  "Pokaż wszystko": "Show All",
  Plik: "File",
  Edycja: "Edit",
  Widok: "View",
  Okno: "Window",
  "Zamknij okno": "Close Window",
  Ponów: "Redo",
  Wytnij: "Cut",
  Wklej: "Paste",
  "Wklej jako zwykły tekst": "Paste and Match Style",
  "Zaznacz wszystko": "Select All",
  "Pełny ekran": "Full Screen",
  Zminimalizuj: "Minimise",
  Powiększ: "Zoom",
  "Ustaw wszystko na wierzchu": "Bring All to Front",

  /* ── Pasek menu ── */
  "Otwórz Cribro Sift": "Open Cribro Sift",
  "Wklejaj automatycznie": "Paste automatically",
  Zakończ: "Quit",
  "Cribro Sift — trzymaj ⌃⌥ i mów": "Cribro Sift — hold ⌃⌥ and speak",
  "Gotowe — tekst w schowku": "Ready — text in the clipboard",
};

const DICTS = { en: EN };

/** Zwraca funkcję t() dla wybranego języka. Nieznany napis wraca bez zmian. */
function translator(lang) {
  const dict = DICTS[lang] ?? null;

  return function t(text, vars) {
    const source = String(text ?? "");
    let out = source;

    if (dict) {
      // Szablony HTML łamią napisy na kilka linii; klucz jest jeden.
      const key = source.trim().replace(/\s+/g, " ");
      out = dict[key] ?? dict[source] ?? source;
    }

    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        out = out.split(`{${name}}`).join(String(value));
      }
    }
    return out;
  };
}

const LANG_NAMES = { pl: "Polski", en: "English" };

if (typeof module !== "undefined" && module.exports) {
  module.exports = { translator, DICTS, LANG_NAMES };
}
if (typeof window !== "undefined") {
  window.CribroStrings = { translator, DICTS, LANG_NAMES };
}
