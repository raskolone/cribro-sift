"use strict";

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

/**
 * Klient Supabase — konta i baza notatek.
 *
 * Napisany ręcznie, na samym `fetch`, zamiast na @supabase/supabase-js.
 * Powód jest ten sam co przy dostawcach transkrypcji: cała rozmowa
 * z serwerem to sześć adresów i dwa nagłówki, a biblioteka dokłada do tego
 * własny magazyn sesji, własny WebSocket i własne pojęcie „przeglądarki",
 * którego w procesie głównym Electrona nie ma.
 *
 * Dwa klucze, dwie różne role — i tylko jeden z nich ma prawo tu być:
 *
 *   anon         klucz publiczny. Jedzie w każdym żądaniu, wolno mu leżeć
 *                w pliku ustawień i wolno go pokazać. Sam z siebie nie
 *                daje dostępu do niczego: o tym, co widać, decyduje RLS
 *                w bazie (patrz supabase/schema.sql) na podstawie tego,
 *                KTO jest zalogowany.
 *
 *   service_role klucz omijający RLS. Nigdy w aplikacji desktopowej.
 *                Kto go ma, ma wszystkie notatki wszystkich ludzi.
 *
 * Sesja (a w niej token odświeżający — długowieczny) leży osobno od
 * ustawień i jest szyfrowana pękiem kluczy systemu przez safeStorage.
 */

class SupabaseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}

/**
 * Komunikaty GoTrue są po angielsku i mówią do programisty, nie do
 * człowieka, który właśnie próbuje się zalogować. Te kilka, które zdarzają
 * się naprawdę, tłumaczymy na zdanie mówiące, co zrobić.
 */
const HUMAN = {
  "invalid login credentials": "Nie ten adres albo nie to hasło.",
  "email not confirmed": "Adres nie jest jeszcze potwierdzony — sprawdź skrzynkę.",
  "user already registered": "Takie konto już istnieje. Zaloguj się zamiast zakładać nowe.",
  "password should be at least 6 characters.": "Hasło musi mieć co najmniej 6 znaków.",
  "signups not allowed for this instance":
    "Rejestracja jest wyłączona w panelu Supabase (Authentication → Providers → Email).",
  "email rate limit exceeded": "Za dużo prób pod rząd. Spróbuj za kilka minut.",
};

function humanize(message) {
  return HUMAN[String(message).trim().toLowerCase()] ?? message;
}

/** Adres projektu wpisuje człowiek, więc trafi tu i ukośnik na końcu, i spacja. */
function normalizeUrl(url) {
  const clean = String(url ?? "").trim().replace(/\/+$/, "");
  if (!clean) return "";
  return /^https?:\/\//.test(clean) ? clean : `https://${clean}`;
}

class Supabase {
  constructor({ dir } = {}) {
    this.url = "";
    this.anonKey = "";
    this.session = null;
    this.sessionPath = path.join(dir ?? app.getPath("userData"), "supabase-session.bin");
    this.#load();
  }

  /* ── Konfiguracja ───────────────────────────────────────────── */

  configure({ url, anonKey } = {}) {
    const nextUrl = normalizeUrl(url);
    const nextKey = String(anonKey ?? "").trim();
    // Zmiana projektu unieważnia sesję: token z jednego projektu nie znaczy
    // nic w drugim, a zostawiony wygląda jak zalogowanie i myli.
    if (this.url && (nextUrl !== this.url || nextKey !== this.anonKey)) this.#forget();
    this.url = nextUrl;
    this.anonKey = nextKey;
    return this.configured;
  }

  get configured() {
    return !!(this.url && this.anonKey);
  }

  get user() {
    return this.session?.user ?? null;
  }

  get signedIn() {
    return !!this.session?.refresh_token;
  }

  /** Wszystko, co interfejs musi wiedzieć o stanie konta. */
  snapshot() {
    return {
      configured: this.configured,
      signedIn: this.signedIn,
      email: this.user?.email ?? null,
      userId: this.user?.id ?? null,
      confirmed: !!(this.user?.email_confirmed_at ?? this.user?.confirmed_at),
      /* Czym się zalogowano. Nie ozdoba: przy koncie z Google nie ma sensu
         pokazywać „nie pamiętam hasła", bo hasła u nas nigdy nie było. */
      provider: this.user?.app_metadata?.provider ?? (this.signedIn ? "email" : null),
    };
  }

  /* ── Sesja na dysku ─────────────────────────────────────────── */

  #load() {
    try {
      const raw = fs.readFileSync(this.sessionPath);
      const json =
        raw[0] === 0x7b /* '{' */
          ? raw.toString("utf8")
          : safeStorage.decryptString(raw);
      this.session = JSON.parse(json);
    } catch {
      this.session = null;
    }
  }

  #save() {
    if (!this.session) return this.#forget();
    const json = JSON.stringify(this.session);
    fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
    // Pęk kluczy bywa niedostępny (świeży system, sesja bez okna logowania).
    // Wtedy zapis jawny jest lepszy niż wylogowanie po każdym starcie —
    // plik i tak leży w katalogu aplikacji, chronionym prawami użytkownika.
    const blob = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, "utf8");
    fs.writeFileSync(this.sessionPath, blob, { mode: 0o600 });
  }

  #forget() {
    this.session = null;
    try {
      fs.unlinkSync(this.sessionPath);
    } catch {
      /* nie było czego kasować */
    }
  }

  /** Zapisujemy własny termin ważności — `expires_in` jest względne. */
  #adopt(payload) {
    if (!payload?.access_token) return null;
    this.session = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
      user: payload.user ?? this.session?.user ?? null,
    };
    this.#save();
    return this.session;
  }

  /* ── Warstwa HTTP ───────────────────────────────────────────── */

  async #call(pathname, { method = "GET", body, headers = {}, token } = {}) {
    if (!this.configured) throw new SupabaseError("Nie ustawiono adresu projektu i klucza anon.", 0);

    const response = await fetch(`${this.url}${pathname}`, {
      method,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${token ?? this.anonKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
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

    if (!response.ok) {
      const message =
        data?.error_description ?? data?.msg ?? data?.message ?? data?.error ?? text ?? "błąd";
      throw new SupabaseError(humanize(message), response.status);
    }
    return { data, headers: response.headers };
  }

  /* ── Konta ──────────────────────────────────────────────────── */

  /**
   * Rejestracja. Gdy w projekcie włączone jest potwierdzanie adresu
   * (domyślnie jest), Supabase nie oddaje tokenów — oddaje samego
   * użytkownika, a token przyjdzie dopiero po kliknięciu w link.
   */
  async signUp(email, password) {
    const { data } = await this.#call("/auth/v1/signup", {
      method: "POST",
      body: { email: String(email).trim(), password },
    });
    const session = this.#adopt(data);
    return { needsConfirmation: !session, email: data?.user?.email ?? email };
  }

  async signIn(email, password) {
    const { data } = await this.#call("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email: String(email).trim(), password },
    });
    if (!this.#adopt(data)) throw new SupabaseError("Serwer nie oddał tokenu.", 500);
    return this.snapshot();
  }

  /** Wylogowanie ma się udać także wtedy, gdy nie ma sieci. */
  async signOut() {
    const token = this.session?.access_token;
    this.#forget();
    if (!token) return true;
    try {
      await this.#call("/auth/v1/logout", { method: "POST", body: {}, token });
    } catch {
      /* token i tak już u nas nie leży */
    }
    return true;
  }

  /* ── Logowanie przez cudze konto ─────────────────────────────
     Sam taniec (przeglądarka, pętla zwrotna, PKCE) siedzi w main/oauth.js.
     Tutaj są dwie rzeczy, które musi wiedzieć klient Supabase: jak zbudować
     adres, pod który wysyłamy człowieka, i co zrobić z kodem, który wraca. */

  /**
   * Adres, pod którym GoTrue przekieruje na Google (albo Apple), a potem
   * z powrotem na `redirectTo` z kodem w zapytaniu.
   *
   * `code_challenge` jest skrótem sekretu, który zostaje po naszej stronie.
   * Bez niego GoTrue oddałby token w kotwicy adresu (`#access_token=…`),
   * a kotwica nigdy nie dochodzi do serwera — pętla zwrotna nie miałaby
   * czego odebrać. To nie jest więc tylko zabezpieczenie: to jedyny wariant,
   * który w aplikacji desktopowej w ogóle działa.
   */
  authorizeUrl({ provider, redirectTo, challenge, scopes }) {
    if (!this.configured) throw new SupabaseError("Nie ustawiono adresu projektu i klucza anon.", 0);
    const query = new URLSearchParams({
      provider,
      redirect_to: redirectTo,
      code_challenge: challenge,
      code_challenge_method: "s256",
    });
    if (scopes) query.set("scopes", scopes);
    return `${this.url}/auth/v1/authorize?${query}`;
  }

  /** Kod z adresu powrotnego na sesję. Sekret pokazujemy dopiero tutaj. */
  async exchangeCode(code, verifier) {
    const { data } = await this.#call("/auth/v1/token?grant_type=pkce", {
      method: "POST",
      body: { auth_code: code, code_verifier: verifier },
    });
    if (!this.#adopt(data)) throw new SupabaseError("Serwer nie oddał tokenu.", 500);
    return this.snapshot();
  }

  async resetPassword(email) {
    await this.#call("/auth/v1/recover", {
      method: "POST",
      body: { email: String(email).trim() },
    });
    return true;
  }

  /**
   * Ważny token dostępu — odświeżany, gdy zostało mu mniej niż minuta.
   * Zapas jest po to, żeby token nie wygasł w locie, między sprawdzeniem
   * a dojściem żądania do serwera.
   */
  async token() {
    if (!this.session) throw new SupabaseError("Nie jesteś zalogowany.", 401);
    if (this.session.expires_at - Date.now() > 60_000) return this.session.access_token;

    try {
      const { data } = await this.#call("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: this.session.refresh_token },
      });
      if (!this.#adopt(data)) throw new SupabaseError("Odświeżenie sesji nic nie zwróciło.", 401);
      return this.session.access_token;
    } catch (error) {
      // Token odświeżający też ma swój koniec. Gdy serwer go odrzucił,
      // sesja jest martwa i trzymanie jej dalej udaje zalogowanie.
      if (error.status === 400 || error.status === 401) this.#forget();
      throw error;
    }
  }

  /* ── Baza (PostgREST) ───────────────────────────────────────── */

  /**
   * Żądanie do bazy w imieniu zalogowanego użytkownika.
   *
   * Zalogowanego, nie anonimowego — i to jest cała ochrona danych: RLS
   * czyta `auth.uid()` z tego tokenu i nie pokaże ani wiersza cudzego.
   */
  async rest(pathname, options = {}) {
    const token = await this.token();
    try {
      return await this.#call(`/rest/v1${pathname}`, { ...options, token });
    } catch (error) {
      // Token mógł zostać unieważniony po drugiej stronie (zmiana hasła,
      // wylogowanie wszystkich urządzeń). Jedna próba z nowym.
      if (error.status !== 401) throw error;
      if (!this.session) throw error;
      this.session.expires_at = 0;
      return this.#call(`/rest/v1${pathname}`, { ...options, token: await this.token() });
    }
  }
}

module.exports = { Supabase, SupabaseError, normalizeUrl };
