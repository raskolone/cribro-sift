"use strict";

const { asNote } = require("./digest");

/**
 * Notatka ze spotkania — zakładana i odświeżana SAMA.
 *
 * ══ DLACZEGO SAMA ══
 *
 * Wcześniej trzeba było o nią poprosić: przycisk „Zapisz jako notatkę"
 * w zakładce Spotkania. Kto nie kliknął, ten po tygodniu miał wpis w spisie
 * rozmów i nic w Notatniku — czyli rozmowę w miejscu, do którego się nie
 * zagląda, zamiast w tym, w którym szuka się wszystkiego innego. A klikało
 * się wtedy, gdy człowiek właśnie wstawał od biurka.
 *
 * Teraz każda rozmowa, po której zostało cokolwiek do przeczytania, dostaje
 * notatkę: podsumowanie, zadania i CAŁY ZAPIS ROZMOWY na końcu. To ostatnie
 * jest tu najważniejsze, bo dopiero ono pozwala skasować nagranie bez
 * straty — a nagranie ginie po transkrypcji domyślnie i tak.
 *
 * ══ TRZY GRANICE ══
 *
 *   1. Notatka SKASOWANA ręką nie wraca. Nagrobek po niej mówi „tej notatki
 *      nie ma" i to jest odpowiedź, nie usterka.
 *   2. Notatka ZMIENIONA ręką nie jest nadpisywana. Poznajemy to po tym, że
 *      treść przestała być tą, którą sami zapisaliśmy (`autoText`) — czyjeś
 *      dopiski są jedyną rzeczą w tej notatce, której nie da się odtworzyć
 *      z niczego. Zapis rozmowy da się złożyć jeszcze raz, podsumowanie
 *      napisać od nowa; dwa zdania dopisane w środku — nie.
 *   3. Notatka nie powstaje z niczego. Rozmowa bez zapisu i bez podsumowania
 *      nie ma czym wypełnić kartki, a pusta kartka w Notatniku jest gorsza
 *      niż jej brak.
 *
 * `autoText` leży wyłącznie na tym dysku i nie jedzie na serwer (patrz
 * kolumny w main/sync.js). Notatka przyniesiona synchronizacją z innego
 * komputera nie ma go wcale — i wtedy, z samej konstrukcji, nie zostanie
 * nadpisana. To jest właściwa strona ostrożności.
 *
 * Plik nie zna Electrona: dostaje sklep i oddaje rozstrzygnięcie. Dlatego
 * sprawdza go osobny test (scripts/meetnote-live-test.js) na prawdziwym
 * sklepie w katalogu tymczasowym, a nie na atrapie.
 */

/**
 * @param {object} store  main/store.js
 * @param {string} id     identyfikator spotkania
 * @param {object} [options]
 * @param {string} [options.me]      imię właściciela konta — do nazwy notatki
 * @returns {{note: object|null, action: "created"|"updated"|"kept"|"none"}}
 *          `kept` znaczy „notatka jest i została nietknięta"; `none` —
 *          „nie ma z czego jej zrobić albo skasowano ją ręką".
 */
function keepNote(store, id, { me = "" } = {}) {
  const meeting = store.getMeetings().find((item) => item.id === id);
  if (!meeting) return { note: null, action: "none" };
  if (!meeting.summary && !meeting.transcript?.length) return { note: null, action: "none" };

  const text = asNote(meeting, { transcript: true, me });
  const known = meeting.noteId
    ? store.rawNotes().find((note) => note.id === meeting.noteId)
    : null;

  // Skasowana ręką nie wraca.
  if (known?.deletedAt) return { note: null, action: "none" };

  if (known) {
    // Zmieniona ręką zostaje taka, jaka jest.
    if (known.text !== known.autoText) return { note: known, action: "kept" };
    if (known.text === text) return { note: known, action: "kept" };
    return { note: store.updateNote(known.id, { text, autoText: text }), action: "updated" };
  }

  const note = store.createNote({ text, autoText: text, kind: "meeting" });
  store.updateMeeting(id, { noteId: note.id });
  return { note, action: "created" };
}

module.exports = { keepNote };
