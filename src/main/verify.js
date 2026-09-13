"use strict";

/**
 * Walidacja zapisu — szkic z biegu kontra przebieg z pliku.
 *
 * ══ PO CO TO ISTNIEJE ══
 *
 * Przepisywanie w biegu i przepisywanie z pliku to dwa różne zadania, choć
 * dotyczą tego samego dźwięku. Pierwsze leci odcinkami, pod presją czasu,
 * na najszybszym modelu i bez wiedzy o tym, co będzie dalej. Drugie ma cały
 * plik, tyle czasu, ile trzeba, i może puścić diaryzację.
 *
 * Drugie jest więc lepsze — ale „lepsze" to za mało, żeby po prostu wyrzucić
 * pierwsze i udawać, że go nie było. Człowiek, który przez godzinę patrzył
 * na zapis powstający na żywo, ma prawo wiedzieć, CO SIĘ ZMIENIŁO: czy to
 * była kosmetyka, czy właśnie zniknęło zdanie, które zapamiętał.
 *
 * Ten plik odpowiada na jedno pytanie: na ile te dwa zapisy mówią to samo,
 * i gdzie się rozjechały.
 *
 * ══ CZEGO TU CELOWO NIE MA ══
 *
 * Nie ma rozstrzygania, który zapis jest prawdziwy. Zapisem właściwym jest
 * ten z pliku i to jest decyzja podjęta wyżej (patrz verify w ustawieniach
 * spotkań). Tutaj liczy się wyłącznie RÓŻNICA — po to, żeby dało się na nią
 * spojrzeć, a nie po to, żeby ją rozsądzać.
 *
 * Plik nie zna Electrona ani sieci: wchodzą dwa zapisy, wychodzi liczba
 * i lista wierszy. Dlatego sprawdza go zwykły Node — scripts/verify-test.js.
 */

/* Ta sama normalizacja co w main/merge.js i z tego samego powodu: dwa
   przebiegi transkrypcji różnią się najczęściej interpunkcją i wielkością
   liter, a to nie jest różnica w tym, co padło. */
const words = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[.,;:!?…„”"'()\[\]—–-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

const said = (lines) => (lines ?? []).map((line) => line?.text ?? "").join(" ");

/**
 * Ile słów mają wspólnych dwa teksty, licząc jako NAJDŁUŻSZY WSPÓLNY PODCIĄG.
 *
 * Podciąg, a nie ciąg pod rząd — inaczej niż przy wykrywaniu przesłuchu
 * w main/merge.js, i jest to różnica zamierzona. Tam szukaliśmy echa, czyli
 * tego samego nagrania powtórzonego nieprzerwanie. Tutaj porównujemy dwa
 * OPISY tego samego dźwięku: zgadzają się w większości słów, ale z dziurami
 * w miejscach, gdzie jeden przebieg usłyszał coś, czego drugi nie.
 *
 * Rachunek jest ograniczony z góry, bo tabela rośnie iloczynem długości:
 * godzina rozmowy to jakieś dziewięć tysięcy słów, czyli osiemdziesiąt
 * milionów komórek. Porównujemy więc wiersz po wierszu (krótkie teksty),
 * a nie całość naraz.
 */
function commonWords(a, b) {
  const left = words(a);
  const right = words(b);
  if (!left.length || !right.length) return 0;

  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] =
        left[i - 1] === right[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[right.length];
}

/** Wiersze zapisu w oknie czasowym wokół podanej chwili. */
const near = (lines, at, span) =>
  (lines ?? []).filter((line) => Math.abs((line?.at ?? 0) - at) <= span);

/**
 * Na ile szkic zgadza się z zapisem właściwym.
 *
 * Zgodność liczymy SŁOWAMI, nie wierszami: podział na wypowiedzi zmienia się
 * między przebiegami z byle powodu (inne cięcie, inna diaryzacja), a pytanie
 * brzmi „czy padły te same słowa", nie „czy tak samo je pogrupowano".
 *
 * @param {Array<{at:number,text:string}>} draft       zapis z biegu
 * @param {Array<{at:number,text:string}>} verified    zapis z pliku
 * @param {object} [options]
 * @param {number} [options.span]  ile sekund w bok szukamy odpowiednika
 * @param {number} [options.drift] poniżej jakiej zgodności wiersz jest rozjechany
 * @returns {{agreement:number, draftWords:number, verifiedWords:number,
 *            drift:Array<{at:number,speaker:string,text:string,score:number}>,
 *            checkedAt:string}}
 */
function compare(draft, verified, { span = 45, drift = 0.5 } = {}) {
  const draftWords = words(said(draft)).length;
  const verifiedWords = words(said(verified)).length;

  /* Pusty szkic nie jest rozjazdem — to jest brak szkicu. Rozróżnienie ma
     znaczenie, bo „zgodność 0%" brzmi jak katastrofa, a „nie było czego
     porównać" jest zwykłą informacją. */
  if (!draftWords || !verifiedWords) {
    return {
      agreement: null,
      draftWords,
      verifiedWords,
      drift: [],
      checkedAt: new Date().toISOString(),
    };
  }

  /* Zgodność ogólna liczona na CAŁOŚCI, ale w oknach — pełna tabela na
     dziewięciu tysiącach słów byłaby osiemdziesięcioma milionami komórek
     na każde spotkanie. Okno idzie za zapisem właściwym, bo to on jest
     miarą; szkic jest tym, co się do niego porównuje. */
  let matched = 0;
  for (const line of verified ?? []) {
    const around = near(draft, line.at ?? 0, span).map((item) => item.text).join(" ");
    if (!around) continue;
    matched += commonWords(line.text, around);
  }
  const agreement = Math.min(1, matched / verifiedWords);

  /* Wiersze rozjechane — te, których w szkicu praktycznie nie było. To one
     są odpowiedzią na pytanie „co przepisywanie w biegu przegapiło": każdy
     taki wiersz to zdanie, które padło na zajęciach, a którego w zapisie
     na żywo nie widziałeś. */
  const drifted = [];
  for (const line of verified ?? []) {
    const mine = words(line.text).length;
    if (mine < 4) continue; // krótkie zdanie nie jest dowodem na nic
    const around = near(draft, line.at ?? 0, span).map((item) => item.text).join(" ");
    const score = around ? commonWords(line.text, around) / mine : 0;
    if (score < drift) {
      drifted.push({
        at: line.at ?? 0,
        speaker: line.speaker ?? "",
        text: line.text,
        score: Math.round(score * 100) / 100,
      });
    }
  }

  return {
    agreement: Math.round(agreement * 1000) / 1000,
    draftWords,
    verifiedWords,
    drift: drifted,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { compare, commonWords, words };
