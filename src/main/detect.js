"use strict";

/**
 * Wykrywanie spotkania — po tym, co stoi na ekranie.
 *
 * Pytanie „czy trwa spotkanie" ma wiele odpowiedzi kiepskich i jedną
 * znośną. Kiepskie to: czy Zoom jest uruchomiony (jest zawsze, siedzi
 * w pasku), czy mikrofon pracuje (pracuje przy dyktowaniu), czy w kalendarzu
 * coś stoi (stoi, ale nikt na to nie przyszedł). Znośna jest jedna:
 * CZY NA EKRANIE STOI OKNO ROZMOWY. Okno rozmowy istnieje dokładnie wtedy,
 * gdy rozmowa trwa, i znika, gdy się kończy.
 *
 * Rozpoznajemy je po tytule, bo tylko tytuł odróżnia okno rozmowy od okna
 * tego samego programu stojącego bezczynnie: „Zoom Meeting" to rozmowa,
 * „Zoom Workplace" to program czekający na nią. To jest zgadywanie po
 * napisach i tak trzeba je traktować — stąd tablica POKOJE osobno, żeby
 * dało się ją poprawić bez ruszania reszty, i osobny test bez Electrona.
 *
 * PRECYZJA PRZED ZASIĘGIEM. Pomyłka w jedną stronę to niewykryte spotkanie,
 * czyli tyle, co jest dzisiaj. Pomyłka w drugą to znaczek dopominający się
 * o notatki w trakcie oglądania czegoś na YouTubie — a przy ustawieniu
 * „sam z siebie" nagranie cudzych słów bez powodu. Dlatego wzorce są wąskie
 * i wolą przepuścić spotkanie, niż wymyślić je z niczego.
 *
 * CZEGO TU NIE MA: kończenia nagrania, gdy okno rozmowy zniknie. Kusi, ale
 * tytuł okna potrafi zmienić się w środku rozmowy (przeładowana karta,
 * pokój poboczny), a nagranie ucięte w połowie to jedyna strata w tej
 * aplikacji, której nie da się cofnąć. Kończy człowiek.
 *
 * Plik nie zna Electrona: spisu okien nie bierze sam, tylko dostaje go
 * funkcją. Dlatego sprawdza go zwykły Node — patrz scripts/detect-test.js.
 */

/**
 * Okna, po których poznajemy rozmowę.
 *
 * `when` musi trafić w tytuł OKNA ROZMOWY i chybić tytuł okna programu
 * bezczynnego. Pierwsza grupa wzorca — o ile jest — to nazwa spotkania.
 */
const ROOMS = [
  {
    kind: "meet",
    where: "Google Meet",
    /* W rozmowie karta nazywa się „Meet – jrx-kfoz-hys" albo „Meet –
       Przegląd tygodnia". Strona startowa to „Google Meet”, bez myślnika
       i bez niczego po nim — i o nią właśnie NIE chodzi. */
    when: /^Meet\s*[–—-]\s*(.+?)(?:\s+[-–—]\s+(?:Google Chrome|Safari|Brave|Arc|Firefox|Vivaldi))?$/,
  },
  {
    kind: "zoom",
    where: "Zoom",
    // „Zoom Meeting" to rozmowa. Samo „Zoom" i „Zoom Workplace" to program.
    when: /^Zoom (?:Meeting|Webinar)(?:\s*[–—-]\s*(.+))?$/,
  },
  {
    kind: "teams",
    where: "Microsoft Teams",
    // Okno rozmowy: „Meeting in Ustalenia | Microsoft Teams".
    when: /^(?:Meeting|Spotkanie)(?:\s+(?:in|w)\s+([^|]*?))?\s*\|\s*Microsoft Teams/,
  },
  {
    kind: "webex",
    where: "Webex",
    when: /^(?:Cisco Webex Meetings?|Webex Meeting)(?:\s*[–—-]\s*(.+))?$/,
  },
];

/** Kod pokoju Google Meet — nazwą spotkania nie jest, choć nią udaje. */
const ROOM_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * Czy któreś z tych okien to rozmowa.
 *
 * @param {Array<string|{name: string}>} windows  tytuły okien na ekranie
 * @returns {{kind: string, where: string, title: string|null}|null}
 */
function spot(windows) {
  for (const item of windows ?? []) {
    const title = String(typeof item === "string" ? item : (item?.name ?? "")).trim();
    if (!title) continue;

    for (const room of ROOMS) {
      const hit = room.when.exec(title);
      if (!hit) continue;
      const name = (hit[1] ?? "").trim();
      return {
        kind: room.kind,
        where: room.where,
        // Kod pokoju to nie nazwa spotkania — „jrx-kfoz-hys" w nagłówku
        // notatki nie mówi nikomu nic.
        title: name && !ROOM_CODE.test(name) ? name : null,
      };
    }
  }
  return null;
}

/** Czy to wciąż to samo spotkanie, czy już następne. */
const same = (a, b) => !!a && !!b && a.kind === b.kind && a.title === b.title;

/**
 * Pilnowanie ekranu.
 *
 * Spis okien bierze wstrzyknięta funkcja `list` — tutaj nie ma Electrona
 * i to jest cel: ten sam obieg da się przepuścić w teście przez tablicę
 * napisów, zamiast otwierać prawdziwego Zooma.
 *
 * ZNIKNIĘCIE MELDUJEMY DOPIERO ZA DRUGIM RAZEM. Spis okien bywa przez
 * chwilę niepełny — okno w trakcie przeładowania, ekran przechodzący
 * w wygaszacz — a znaczek gasnący i zapalający się co osiem sekund byłby
 * gorszy niż brak wykrywania.
 */
class Watcher {
  /**
   * @param {object} options
   * @param {() => Promise<Array>} options.list  spis okien na ekranie
   * @param {(meeting: object|null) => void} options.onChange
   * @param {number} [options.every]  co ile milisekund pytamy
   * @param {(problem: Error) => void} [options.onError]
   */
  constructor({ list, onChange, every = 8000, onError } = {}) {
    this.list = list;
    this.onChange = onChange ?? (() => {});
    this.onError = onError ?? (() => {});
    this.every = every;
    this.timer = null;
    this.seen = null;
    this.misses = 0;
    this.busy = false;
  }

  get running() {
    return !!this.timer;
  }

  start() {
    if (this.timer) return;
    // Pierwsze spojrzenie od razu: spotkanie mogło trwać, zanim ktokolwiek
    // włączył tę opcję.
    this.timer = setInterval(() => this.look(), this.every);
    this.look();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    // Stan czyścimy razem z pilnowaniem: po ponownym włączeniu spotkanie,
    // które nadal trwa, ma być zgłoszone jeszcze raz.
    if (this.seen) {
      this.seen = null;
      this.onChange(null);
    }
    this.misses = 0;
  }

  /** Jedno spojrzenie na ekran. */
  async look() {
    if (this.busy) return; // spis okien bywa wolniejszy niż odstęp między pytaniami
    this.busy = true;
    try {
      const found = spot(await this.list());
      if (found) {
        this.misses = 0;
        if (!same(found, this.seen)) {
          this.seen = found;
          this.onChange(found);
        }
        return;
      }
      if (!this.seen) return;
      this.misses += 1;
      if (this.misses < 2) return;
      this.seen = null;
      this.onChange(null);
    } catch (problem) {
      this.onError(problem);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { spot, Watcher, ROOMS };
