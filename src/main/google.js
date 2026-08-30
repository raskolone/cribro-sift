"use strict";

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const { signInWithProvider } = require("./oauth");

/**
 * Konto Google — wyłącznie po to, żeby przeczytać pocztę do porannego
 * podsumowania.
 *
 * TRZY DECYZJE, KTÓRE WARTO ZNAĆ, ZANIM SIĘ TO CZYTA:
 *
 *   1. TYLKO ODCZYT I TYLKO POCZTA. Zakres to `gmail.readonly` i nic poza
 *      tym. Kalendarz idzie zupełnie inną drogą — przez systemowy EventKit
 *      (patrz main/agenda.js) — bo Google Calendar podpięty w Ustawieniach
 *      macOS jest tam widoczny za darmo, bez klucza i bez okna logowania.
 *      Prosić Google o kalendarz, mając go już na biurku, byłoby proszeniem
 *      o więcej, niż potrzeba.
 *
 *   2. KLIENT JEST TWÓJ, NIE NASZ. Identyfikator klienta OAuth zakłada
 *      użytkownik u siebie w Google Cloud i wkleja w Ustawieniach. To nie
 *      jest przerzucanie roboty: klient zostawiony w trybie „Testing"
 *      z jednym adresem na liście testerów sprawia, że TYLKO TO KONTO może
 *      się tą drogą zalogować. Klucz zaszyty w aplikacji dawałby dostęp
 *      każdemu, kto ją odpakuje.
 *
 *   3. LOGOWANIE JEDZIE TĄ SAMĄ DROGĄ CO KONTO CRIBRO — pętla zwrotna
 *      i PKCE z main/oauth.js. Ten sam serwerek, te same porty, ta sama
 *      strona powrotna. Google i Supabase różnią się tylko dwoma adresami,
 *      więc dostają dwa opisy, a nie dwie machiny.
 *
 * Sesja leży na dysku zaszyfrowana i WCZYTUJE SIĘ DOPIERO NA ŻĄDANIE.
 * Powód jest ten sam, co przy koncie Cribro (patrz main/supabase.js):
 * odszyfrowanie jest wywołaniem synchronicznym, które macOS potrafi
 * zatrzymać na pytaniu o dostęp do pęku kluczy, a zrobione przy starcie
 * zatrzymuje całe uruchamianie aplikacji.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Czego prosimy i niczego więcej. */
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"];

/** Nagłówki, które naprawdę czytamy. Reszty maila nie ściągamy wcale. */
const HEADERS = ["From", "To", "Cc", "Subject", "Date", "List-Unsubscribe", "In-Reply-To"];

/** Ile maili najwyżej bierzemy pod uwagę. Reguły i tak wybiorą kilkanaście. */
const MAX_MAILS = 80;
/** Ile zapytań o pojedyncze maile trzymamy w powietrzu naraz. */
const LANES = 6;
/** Token odświeżamy minutę przed czasem — zegary bywają rozjechane. */
const EARLY = 60_000;

/** Odpowiedź Google na błąd, po ludzku. */
async function complain(response, what) {
  let detail = "";
  try {
    const data = await response.json();
    detail = data.error_description ?? data.error?.message ?? data.error ?? "";
  } catch {
    /* odpowiedź bez JSON-a — zostaje sam kod */
  }
  return new Error(`${what}: ${response.status}${detail ? ` — ${detail}` : ""}`);
}

class Google {
  constructor({ dir } = {}) {
    this.clientId = "";
    this.clientSecret = "";
    this.session = null;
    this.restored = false;
    this.path = path.join(dir ?? app.getPath("userData"), "google-account.bin");
  }

  configure({ clientId, clientSecret } = {}) {
    const nextId = String(clientId ?? "").trim();
    // Zmiana klienta unieważnia sesję: token wydany dla jednego klienta
    // nie znaczy nic dla drugiego, a zostawiony wygląda na zalogowanie.
    if (this.clientId && nextId !== this.clientId) this.forget();
    this.clientId = nextId;
    this.clientSecret = String(clientSecret ?? "").trim();
    return this.configured;
  }

  get configured() {
    return !!this.clientId;
  }

  get signedIn() {
    return !!this.session?.refresh_token;
  }

  snapshot() {
    return {
      configured: this.configured,
      signedIn: this.signedIn,
      email: this.session?.email ?? null,
    };
  }

  /** Sesja z dysku — wołane raz, już po wstaniu okien. Patrz nagłówek. */
  restore() {
    if (this.restored) return false;
    this.restored = true;
    if (this.session) return false;
    try {
      const raw = fs.readFileSync(this.path);
      const json = raw[0] === 0x7b ? raw.toString("utf8") : safeStorage.decryptString(raw);
      this.session = JSON.parse(json);
    } catch {
      this.session = null;
    }
    return !!this.session;
  }

  #save() {
    if (!this.session) return this.forget();
    const json = JSON.stringify(this.session);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const blob = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, "utf8");
    fs.writeFileSync(this.path, blob, { mode: 0o600 });
  }

  forget() {
    this.session = null;
    this.restored = true;
    try {
      fs.unlinkSync(this.path);
    } catch {
      /* nie było czego kasować */
    }
  }

  /* ── Logowanie ──────────────────────────────────────────────── */

  /**
   * Opis Google w kształcie, którego oczekuje main/oauth.js.
   *
   * `prompt=consent` i `access_type=offline` są tu po to, żeby Google
   * NAPRAWDĘ oddał token odświeżający. Bez nich oddaje go tylko przy
   * pierwszej w życiu zgodzie — a to znaczy, że druga próba logowania
   * (po skasowaniu sesji, po zmianie komputera) kończy się kontem, które
   * działa godzinę i milknie.
   *
   * `login_hint` podpowiada właściwe konto, gdy w przeglądarce zalogowanych
   * jest kilka. To wygoda, nie zabezpieczenie — tym, co naprawdę zawęża
   * dostęp do jednego konta, jest lista testerów przy kliencie OAuth.
   */
  #client(hint) {
    return {
      authorizeUrl: ({ redirectTo, challenge }) => {
        const query = new URLSearchParams({
          client_id: this.clientId,
          redirect_uri: redirectTo,
          response_type: "code",
          scope: SCOPES.join(" "),
          code_challenge: challenge,
          code_challenge_method: "S256",
          access_type: "offline",
          prompt: "consent",
        });
        if (hint) query.set("login_hint", hint);
        return `${AUTH_URL}?${query}`;
      },

      exchangeCode: async (code, verifier) => {
        const body = new URLSearchParams({
          code,
          client_id: this.clientId,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: this.redirect,
        });
        // Klient typu „Desktop app" dostaje od Google sekret, który sekretem
        // nie jest (leży w każdej kopii aplikacji) — ale bywa wymagany przy
        // wymianie kodu. Wysyłamy go, jeśli jest.
        if (this.clientSecret) body.set("client_secret", this.clientSecret);

        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!response.ok) throw await complain(response, "Google odmówił wymiany kodu");
        const data = await response.json();

        this.session = {
          access_token: data.access_token,
          refresh_token: data.refresh_token ?? this.session?.refresh_token ?? null,
          expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
          email: null,
        };
        this.session.email = await this.#whoami();
        this.#save();
        return this.snapshot();
      },
    };
  }

  /**
   * Logowanie w systemowej przeglądarce.
   *
   * @param {object}   options
   * @param {Function} options.openExternal otwarcie adresu w przeglądarce
   * @param {string}   [options.hint]       podpowiedź, które konto
   */
  signIn({ openExternal, hint } = {}) {
    if (!this.configured) {
      throw new Error(
        "Brak identyfikatora klienta OAuth. Załóż go w Google Cloud i wklej w Ustawieniach.",
      );
    }
    const client = this.#client(hint);
    // Adres powrotny znamy dopiero, gdy serwerek wybierze port — a wymiana
    // kodu musi podać dokładnie ten sam. Stąd zapamiętanie po drodze.
    return signInWithProvider({
      client,
      provider: "google",
      openExternal,
      onWaiting: ({ redirect }) => (this.redirect = redirect),
    });
  }

  /* ── Token ──────────────────────────────────────────────────── */

  async #whoami() {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${this.session.access_token}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.email ?? null;
  }

  /** Świeży token dostępu — odświeżany, gdy trzeba, i nie częściej. */
  async #token() {
    this.restore();
    if (!this.session?.refresh_token) throw new Error("Konto Google nie jest podłączone.");
    if (this.session.access_token && Date.now() < (this.session.expires_at ?? 0) - EARLY) {
      return this.session.access_token;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.session.refresh_token,
      grant_type: "refresh_token",
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      /* Odmowa przy odświeżaniu jest inna niż zwykły błąd sieci: token
         odświeżający bywa unieważniony (cofnięta zgoda, zmiana hasła)
         i wtedy nie ma czego ponawiać — trzeba zalogować się jeszcze raz. */
      if (response.status === 400 || response.status === 401) {
        this.forget();
        throw new Error("Google unieważnił dostęp — zaloguj się jeszcze raz.");
      }
      throw await complain(response, "Nie udało się odświeżyć dostępu do Google");
    }

    const data = await response.json();
    this.session.access_token = data.access_token;
    this.session.expires_at = Date.now() + (data.expires_in ?? 3600) * 1000;
    this.#save();
    return this.session.access_token;
  }

  async #get(url) {
    const token = await this.#token();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw await complain(response, "Gmail odmówił odpowiedzi");
    return response.json();
  }

  /* ── Poczta ─────────────────────────────────────────────────── */

  /**
   * Maile z ostatnich dni, w postaci, o którą pyta main/briefing.js.
   *
   * Ściągamy SAME NAGŁÓWKI I FRAGMENT (`format: metadata`), nigdy treści.
   * Do wyboru „co wymaga uwagi" treść nie jest potrzebna, a mail w całości
   * to jest cudza korespondencja leżąca w pamięci procesu bez powodu.
   */
  async mail({ days = 7, max = MAX_MAILS } = {}) {
    const query = encodeURIComponent(`in:inbox is:unread newer_than:${days}d -in:chats`);
    const list = await this.#get(
      `${GMAIL}/messages?q=${query}&maxResults=${Math.min(max, 100)}`,
    );
    const ids = (list.messages ?? []).map((row) => row.id);
    if (!ids.length) return [];

    const heads = HEADERS.map((name) => `metadataHeaders=${name}`).join("&");
    const out = [];
    /* Po kilka naraz, a nie wszystkie: Gmail liczy jednostki na sekundę
       i osiemdziesiąt równoległych zapytań kończy się odmową dla całej
       partii, czyli porankiem bez poczty. */
    for (let start = 0; start < ids.length; start += LANES) {
      const batch = ids.slice(start, start + LANES);
      const rows = await Promise.all(
        batch.map((id) =>
          this.#get(`${GMAIL}/messages/${id}?format=metadata&${heads}`).catch(() => null),
        ),
      );
      for (const row of rows) if (row) out.push(shape(row));
    }
    return out;
  }
}

/** Odpowiedź Gmaila na kształt, którym posługuje się main/briefing.js. */
function shape(message) {
  const headers = new Map(
    (message.payload?.headers ?? []).map((h) => [String(h.name).toLowerCase(), h.value]),
  );
  const labels = message.labelIds ?? [];
  const split = (text) =>
    String(text ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

  return {
    id: message.id,
    threadId: message.threadId,
    from: headers.get("from") ?? "",
    to: split(headers.get("to")),
    cc: split(headers.get("cc")),
    subject: headers.get("subject") ?? "",
    snippet: message.snippet ?? "",
    at: Number(message.internalDate) || Date.parse(headers.get("date")) || null,
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    important: labels.includes("IMPORTANT"),
    listUnsubscribe: headers.get("list-unsubscribe") ?? null,
    isReply: !!headers.get("in-reply-to"),
  };
}

module.exports = { Google, shape, SCOPES, MAX_MAILS };
