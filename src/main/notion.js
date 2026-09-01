"use strict";

/**
 * Notatka → strona w Notion.
 *
 * Bez SDK, na samym `fetch` — tak samo jak Supabase (patrz main/supabase.js).
 * Powód jest ten sam: całe API, którego tu potrzeba, to trzy adresy, a każda
 * dołożona zależność to kolejna rzecz, która potrafi się zepsuć przy
 * podpisywaniu aplikacji.
 *
 * ══ CO TRZEBA MIEĆ PO STRONIE NOTION ══
 *
 *   1. Integrację (notion.so/my-integrations) — z niej bierze się token
 *      „ntn_…". To NIE jest hasło do konta i nie daje dostępu do niczego
 *      samo z siebie.
 *   2. Stronę-rodzica, UDOSTĘPNIONĄ tej integracji (w Notion: „•••" →
 *      „Connections" → nazwa integracji). Bez tego kroku każde żądanie
 *      wraca błędem „Could not find page" — i to jest najczęstszy powód,
 *      dla którego pierwsza próba nie działa.
 *
 * ══ CO ZNACZY „WYŚLIJ PONOWNIE" ══
 *
 * Znaczy „ta sama strona ma mieć nową treść", a nie „zrób drugą stronę
 * obok". Notatka pamięta więc, jaką stronę dostała (w ustawieniach, patrz
 * `notion.pages` — to zakładka tego komputera, nie treść notatki), a przy
 * kolejnym wysłaniu jej dzieci są kasowane i wstawiane od nowa.
 *
 * Kasowanie, a nie nadpisywanie: Notion nie ma „zamień całą zawartość".
 * Blok zmienia się tylko po jednym, a ich liczba i rodzaje między jedną
 * wersją notatki a drugą i tak się nie zgadzają.
 */

const API = "https://api.notion.com/v1";
/* Wersja API jedzie w nagłówku i jest przyklejona do kodu. Notion zmienia
   kształt odpowiedzi między wersjami, więc „najnowsza" znaczyłoby „ta,
   która zepsuje eksport w dniu, w którym wyjdzie". */
const VERSION = "2022-06-28";

/* Notion przyjmuje najwyżej setkę bloków na jedno żądanie. */
const CHUNK = 100;
/* I najwyżej dwa tysiące znaków w jednym kawałku tekstu. */
const TEXT_LIMIT = 2000;

/* ── Rozbiór Markdownu ─────────────────────────────────────────
   Te same wyrażenia, co w shared/richtext.js — celowo powtórzone, a nie
   wyciągnięte do wspólnego pliku. Tamten plik tłumaczy na HTML dla
   PRZEGLĄDARKI i ma prawo się zmieniać razem z edytorem; ten tłumaczy na
   cudzy format i musi się zmieniać razem z NIM. Sklejone w jedno, obie
   strony blokowałyby się nawzajem przy pierwszej zmianie. */

const LIST_LINE = /^(\s*)([-*]|\d+\.)[ \t]+(?:\[([ xX])\][ \t]+)?(.*)$/;
/* Linia będąca SAMYM obrazkiem — tak wstawia zrzut main/shot.js. Obrazek
   w środku zdania zostaje tekstem; osobna linia ma dokąd pójść. */
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/;
const QUOTE_LINE = /^\s*>[ \t]?/;
const HEADING_LINE = /^(#{1,6})[ \t]+(.*)$/;
const DIVIDER_LINE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TOGGLE_MARK = /^([▸▾])[ \t]*/;

/**
 * Znaczniki wewnątrz linii → `rich_text` Notion.
 *
 * Notion nie zna zagnieżdżonych znaczników jako drzewa: każdy kawałek
 * tekstu niesie własny komplet cech. Idziemy więc po linii raz i dla
 * każdego kawałka mówimy, co jest w tym miejscu włączone.
 */
function richText(line) {
  const parts = [];
  const pattern = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|((?:^|(?<=[\s(„"']))[*_][^*_\n]+[*_](?=$|[\s.,;:!?)”"']))/g;
  let at = 0;

  const push = (text, annotations) => {
    if (!text) return;
    // Kawałek dłuższy niż limit Notion dzielimy — inaczej całe żądanie
    // wraca błędem walidacji i nie idzie NIC, także reszta notatki.
    for (let i = 0; i < text.length; i += TEXT_LIMIT) {
      parts.push({
        type: "text",
        text: { content: text.slice(i, i + TEXT_LIMIT) },
        ...(annotations ? { annotations } : {}),
      });
    }
  };

  for (const match of String(line ?? "").matchAll(pattern)) {
    push(line.slice(at, match.index), null);
    const token = match[0];
    if (match[1]) push(token.slice(2, -2), { bold: true });
    else if (match[2]) push(token.slice(1, -1), { code: true });
    else {
      // Kursywa łapie się razem ze znakiem przed nią (patrz wyrażenie),
      // więc ten znak trzeba oddać z powrotem jako zwykły tekst.
      const lead = /^[*_]/.test(token) ? "" : token[0];
      push(lead, null);
      push(token.slice(lead.length + 1, -1), { italic: true });
    }
    at = match.index + token.length;
  }
  push(line.slice(at), null);

  return parts.length ? parts : [{ type: "text", text: { content: "" } }];
}

const block = (type, body) => ({ object: "block", type, [type]: body });

/**
 * Notatka w Markdownie → lista bloków Notion.
 *
 * Nagłówek składany Cribro jest w Notion nagłówkiem składanym naprawdę
 * (`is_toggleable`) — to jedno z niewielu miejsc, gdzie oba programy mają
 * dokładnie to samo pojęcie i szkoda byłoby je zgubić po drodze.
 */
function toBlocks(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (DIVIDER_LINE.test(line)) {
      out.push(block("divider", {}));
      i += 1;
      continue;
    }

    /* ZRZUT EKRANU.
       Notion umie pokazać obrazek, ale tylko taki, po który sam sięgnie —
       czyli spod adresu http(s). Zrzuty Cribro leżą na tym dysku, pod
       `file://`, i Notion nie ma jak ich zobaczyć.

       Wcześniej taka linia wpadała tu jako zwykły akapit i lądowała
       w cudzej stronie jako surowy Markdown, w całości, razem z zakodowanymi
       spacjami w ścieżce. To nie było „obrazka nie ma" — to był śmieć
       w miejscu, w którym miał być obrazek.

       Teraz obrazek spod adresu jedzie jako prawdziwy blok, a ten z dysku
       zostawia po sobie jedno zdanie: że był i gdzie został. Zdanie da się
       przeczytać, ścieżki z procentami — nie. */
    const picture = IMAGE_LINE.exec(line);
    if (picture) {
      const [, alt, src] = picture;
      if (/^https?:\/\//i.test(src)) {
        out.push(block("image", { type: "external", external: { url: src } }));
      } else {
        out.push(
          block("paragraph", {
            rich_text: [
              {
                type: "text",
                text: { content: `[${alt || "obrazek"} — został na komputerze, z którego wyszła notatka]` },
                annotations: { italic: true },
              },
            ],
          }),
        );
      }
      i += 1;
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      const toggle = TOGGLE_MARK.exec(heading[2]);
      const body = toggle ? heading[2].slice(toggle[0].length) : heading[2];
      out.push(
        block(`heading_${level}`, {
          rich_text: richText(body),
          is_toggleable: !!toggle,
        }),
      );
      i += 1;
      continue;
    }

    if (QUOTE_LINE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE_LINE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE_LINE, ""));
        i += 1;
      }
      out.push(block("quote", { rich_text: richText(body.join("\n")) }));
      continue;
    }

    const item = LIST_LINE.exec(line);
    if (item) {
      const done = item[3] === undefined ? null : item[3].toLowerCase() === "x";
      const ordered = /\d/.test(item[2]);
      const type =
        done !== null ? "to_do" : ordered ? "numbered_list_item" : "bulleted_list_item";
      out.push(
        block(type, {
          rich_text: richText(item[4]),
          ...(done !== null ? { checked: done } : {}),
        }),
      );
      i += 1;
      continue;
    }

    // Akapit: kolejne zwykłe linie to jeden akapit z twardymi łamaniami —
    // dokładnie tak, jak czyta je edytor (patrz markdownToHtml).
    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING_LINE.test(lines[i]) &&
      !QUOTE_LINE.test(lines[i]) &&
      !DIVIDER_LINE.test(lines[i]) &&
      !LIST_LINE.test(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    out.push(block("paragraph", { rich_text: richText(paragraph.join("\n")) }));
  }

  return out;
}

/* ── Rozmowa z Notion ──────────────────────────────────────────── */

/**
 * Identyfikator strony z tego, co człowiek wkleił.
 *
 * Wkleja się adres („notion.so/Plan-2f1a…"), a nie identyfikator — więc
 * bierzemy z niego trzydzieści dwa znaki szesnastkowe i rozstawiamy myślniki
 * tam, gdzie Notion je stawia. Sam identyfikator też przejdzie.
 */
function pageId(raw) {
  const hex = String(raw ?? "")
    .split("?")[0]
    .replace(/[^0-9a-fA-F]/g, "");
  const id = hex.slice(-32);
  if (id.length !== 32) return null;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

class NotionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "NotionError";
    this.status = status;
  }
}

/** Komunikaty Notion mówią do programisty. Te trzy zdarzają się naprawdę. */
function humanize(message, status) {
  const text = String(message ?? "");
  if (status === 401) {
    return "Notion nie przyjął tokenu. Sprawdź go w Ustawieniach → Notion.";
  }
  if (/could not find (page|block|database)/i.test(text) || status === 404) {
    return "Notion nie widzi tej strony. Otwórz ją, kliknij „•••” → „Connections” i dodaj swoją integrację.";
  }
  if (status === 429) return "Notion prosi o chwilę przerwy — spróbuj za moment.";
  return `Notion odmówił: ${text.slice(0, 200)}`;
}

async function call(token, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": VERSION,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) throw new NotionError(humanize(data?.message ?? text, response.status), response.status);
  return data;
}

/** Wszystkie dzieci strony — do skasowania przed wstawieniem nowych. */
async function childrenOf(token, id) {
  const ids = [];
  let cursor = null;
  do {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : "?page_size=100";
    const data = await call(token, `/blocks/${id}/children${query}`);
    for (const child of data?.results ?? []) ids.push(child.id);
    cursor = data?.has_more ? data.next_cursor : null;
  } while (cursor);
  return ids;
}

/** Bloki dokładane setkami — tyle bierze Notion na jedno żądanie. */
async function appendBlocks(token, id, blocks) {
  for (let i = 0; i < blocks.length; i += CHUNK) {
    await call(token, `/blocks/${id}/children`, {
      method: "PATCH",
      body: { children: blocks.slice(i, i + CHUNK) },
    });
  }
}

/**
 * Notatka na stronę Notion.
 *
 * @param {object} options
 * @param {string} options.token   token integracji („ntn_…")
 * @param {string} options.parent  strona-rodzic: adres albo identyfikator
 * @param {string} options.title   tytuł strony (pierwsza linia notatki)
 * @param {string} options.text    treść notatki w Markdownie
 * @param {string|null} options.page  strona z poprzedniego wysłania
 * @returns {Promise<{ id: string, url: string, updated: boolean }>}
 */
async function sendNote({ token, parent, title, text, page = null }) {
  if (!String(token ?? "").trim()) {
    throw new NotionError("Nie ma tokenu Notion. Ustawienia → Notion.", 0);
  }
  const parentId = pageId(parent);
  if (!parentId) {
    throw new NotionError("Nie ma strony-rodzica w Notion. Ustawienia → Notion.", 0);
  }

  const blocks = toBlocks(text);
  const known = page ? pageId(page) : null;

  // Ta sama notatka wysłana drugi raz ma odświeżyć swoją stronę, a nie
  // założyć drugą. Gdy strony już nie ma (skasowana w Notion), robimy nową.
  if (known) {
    try {
      const old = await childrenOf(token, known);
      for (const id of old) await call(token, `/blocks/${id}`, { method: "DELETE" });
      await appendBlocks(token, known, blocks);
      await call(token, `/pages/${known}`, {
        method: "PATCH",
        body: { properties: { title: { title: richText(title) } } },
      });
      return { id: known, url: `https://www.notion.so/${known.replace(/-/g, "")}`, updated: true };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  const created = await call(token, "/pages", {
    method: "POST",
    body: {
      parent: { page_id: parentId },
      properties: { title: { title: richText(title) } },
      children: blocks.slice(0, CHUNK),
    },
  });
  if (blocks.length > CHUNK) await appendBlocks(token, created.id, blocks.slice(CHUNK));

  return {
    id: created.id,
    url: created.url ?? `https://www.notion.so/${String(created.id).replace(/-/g, "")}`,
    updated: false,
  };
}

/** Czy token i strona w ogóle działają — do przycisku „Sprawdź". */
async function check({ token, parent }) {
  const parentId = pageId(parent);
  if (!parentId) throw new NotionError("To nie wygląda na adres strony Notion.", 0);
  const data = await call(token, `/pages/${parentId}`);
  return { ok: true, id: data?.id ?? parentId };
}

module.exports = { sendNote, check, toBlocks, richText, pageId, NotionError };
