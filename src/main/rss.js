"use strict";

/**
 * Kanały — nagłówki z RSS i Atoma.
 *
 * DLACZEGO BEZ BIBLIOTEKI. Do porannego podsumowania potrzeba z kanału
 * czterech rzeczy: tytułu, adresu, daty i nazwy źródła. Tyle wyjmuje się
 * z XML-a kilkoma wyrażeniami, a każda biblioteka do RSS-a ciągnie za sobą
 * parser XML — czyli kilkanaście tysięcy linijek cudzego kodu wpuszczonego
 * do procesu głównego po to, żeby przeczytać nagłówki wiadomości.
 *
 * Nie jest to parser XML-a i nie udaje nim być: kanały łamiące składnię
 * po prostu wypadną z listy, a nie wywrócą poranka. Dlatego każdy kanał
 * jedzie osobno i każdy ma prawo zawieść sam.
 *
 * Rozstrzygnięcia są czyste — wchodzi tekst kanału, wychodzi lista wpisów.
 * Sprawdza je zwykły Node (scripts/briefing-test.js).
 */

/** Ile najdłużej czekamy na jeden kanał. Poranek nie może stać na cudzym serwerze. */
const PATIENCE = 8000;
/** Ile wpisów bierzemy z jednego kanału. */
const PER_FEED = 5;
/** Ile wpisów wchodzi do podsumowania łącznie. */
const TOTAL = 12;

const strip = (text) =>
  String(text ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (all, code) => {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (named[code.toLowerCase()]) return named[code.toLowerCase()];
      if (code[0] === "#") {
        const num = code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(num) ? String.fromCodePoint(num) : all;
      }
      return all;
    })
    .replace(/\s+/g, " ")
    .trim();

/** Zawartość pierwszego znacznika o tej nazwie. */
function tag(block, name) {
  const found = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return found ? strip(found[1]) : "";
}

/** Adres wpisu — RSS trzyma go w treści, Atom w atrybucie. */
function linkOf(block) {
  const plain = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (plain && strip(plain[1])) return strip(plain[1]);
  const atom = block.match(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/i);
  return atom ? atom[1] : "";
}

/**
 * Kanał na listę wpisów.
 *
 * @param {string} xml    treść kanału
 * @param {string} source nazwa źródła; gdy pusta, bierzemy tytuł kanału
 */
function parse(xml, source = "") {
  const text = String(xml ?? "");
  // Tytuł kanału to PIERWSZY tytuł w dokumencie — ten sprzed wpisów.
  const head = text.split(/<(?:item|entry)\b/i)[0];
  const name = source || tag(head, "title") || "kanał";

  const blocks = [...text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  return blocks
    .map(([, , block]) => ({
      source: name,
      title: tag(block, "title"),
      link: linkOf(block),
      at:
        Date.parse(tag(block, "pubDate")) ||
        Date.parse(tag(block, "updated")) ||
        Date.parse(tag(block, "published")) ||
        null,
    }))
    .filter((entry) => entry.title)
    .slice(0, PER_FEED);
}

/**
 * Świeże nagłówki ze wszystkich kanałów.
 *
 * Każdy kanał osobno i każdy z własnym limitem czasu — jeden serwer, który
 * milczy, nie ma prawa zatrzymać poranka. Kanał, który zawiódł, po prostu
 * nie wnosi nic; nie mówimy o tym w oknie, bo to nie jest wiadomość
 * dla człowieka, tylko cudza awaria.
 */
async function headlines(feeds, { hours = 24, now = Date.now(), get = fetch } = {}) {
  const rows = await Promise.all(
    (feeds ?? [])
      .map((feed) => (typeof feed === "string" ? { url: feed, name: "" } : feed))
      .filter((feed) => feed?.url)
      .map(async (feed) => {
        try {
          const stop = AbortSignal.timeout(PATIENCE);
          const response = await get(feed.url, { signal: stop, redirect: "follow" });
          if (!response.ok) return [];
          return parse(await response.text(), feed.name);
        } catch {
          return [];
        }
      }),
  );

  const since = now - hours * 3600_000;
  return rows
    .flat()
    /* Wpis bez daty zostaje: część kanałów jej nie podaje, a wyrzucanie
       ich w całości znaczyłoby „ten kanał nie działa", co nie jest prawdą. */
    .filter((entry) => !entry.at || entry.at >= since)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, TOTAL);
}

module.exports = { headlines, parse, strip, PER_FEED, TOTAL };
