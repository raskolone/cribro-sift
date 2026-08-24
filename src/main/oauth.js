"use strict";

const http = require("http");
const crypto = require("crypto");

/**
 * Logowanie przez cudze konto — Google dziś, Apple, gdy będzie na to
 * program deweloperski.
 *
 * Aplikacja desktopowa nie może zrobić tego tak, jak robi to strona WWW.
 * Nie ma paska adresu, w który człowiek mógłby spojrzeć, i nie ma jak
 * bezpiecznie przechować tajemnicy klienta — cokolwiek zaszyjemy w bundlu,
 * da się z niego wyjąć. Stąd dwie decyzje, obie wynikające z RFC 8252
 * („OAuth 2.0 for Native Apps"):
 *
 *   1. LOGOWANIE IDZIE W SYSTEMOWEJ PRZEGLĄDARCE, nie w oknie aplikacji.
 *      Okno wbudowane widziałoby hasło do Google w polu, które samo
 *      narysowało — i człowiek nie miałby jak sprawdzić, czy to naprawdę
 *      Google. W przeglądarce widzi kłódkę i adres, a przy okazji jest już
 *      tam zalogowany.
 *
 *   2. PKCE ZAMIAST TAJEMNICY KLIENTA. Aplikacja losuje sekret na jedno
 *      logowanie (`verifier`), wysyła jego skrót (`challenge`), a przy
 *      odbiorze kodu pokazuje oryginał. Kod przechwycony po drodze jest
 *      wtedy bezużyteczny, bo przechwytujący nie zna oryginału.
 *
 * Kod wraca na PĘTLĘ ZWROTNĄ — serwerek HTTP na 127.0.0.1, żywy przez
 * jedno logowanie. Druga droga, własny schemat adresu (`cribro://`),
 * wymaga wpisu w Info.plist i rejestracji w LaunchServices, a przy
 * uruchomieniu z `npm run dev` schemat przejmuje binarka Electrona
 * z node_modules. Pętla zwrotna działa tak samo w obu przypadkach i nie
 * wymaga od użytkownika niczego poza dopisaniem jednego adresu w panelu.
 *
 * Portów jest kilka do wyboru, bo jeden zajęty nie może znaczyć „nie da
 * się zalogować". Wszystkie trzy trzeba dopisać do listy dozwolonych
 * adresów w Supabase (albo jedną gwiazdką objąć wszystkie).
 */

const PORTS = [53682, 53683, 53684];
const CALLBACK = "/auth/callback";
/** Po tylu minutach przestajemy czekać — okno przeglądarki bywa zamykane. */
const TIMEOUT_MS = 5 * 60 * 1000;

/** Sekret na jedno logowanie i jego skrót. base64url, bo tak każe RFC 7636. */
function pkce() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Strona, którą widzi człowiek po powrocie z Google.
 *
 * Wygląda jak aplikacja i mówi jedno zdanie, bo tylko jedno zdanie jest tu
 * do powiedzenia. Gołe „OK" w przeglądarce po zalogowaniu wygląda jak
 * awaria — a to jest ostatni ekran całej operacji i to on zostaje w głowie.
 */
function page({ ok, message }) {
  const title = ok ? "Zalogowano" : "Nie udało się";
  const body = ok
    ? "Możesz zamknąć tę kartę i wrócić do Cribro Sift."
    : message || "Spróbuj jeszcze raz w oknie aplikacji.";
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8" />
<title>${title} — Cribro Sift</title><style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#09101c;color:#eae8e3;
       font:400 16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       background-image:radial-gradient(circle at 50% -20%,#172a46 0%,#09101c 70%)}
  main{max-width:30rem;padding:2.5rem;text-align:center}
  .mark{width:56px;height:56px;margin:0 auto 1.5rem;border-radius:50%;
        border:1px solid ${ok ? "rgba(114,240,180,.3)" : "rgba(240,114,111,.3)"};
        display:grid;place-items:center;color:${ok ? "#72f0b4" : "#f0726f"};font-size:26px}
  h1{margin:0 0 .5rem;font-size:1.35rem;font-weight:700;color:#fff}
  p{margin:0;color:#9aa9bd}
</style></head><body><main>
  <div class="mark">${ok ? "✓" : "!"}</div>
  <h1>${title}</h1><p>${body}</p>
</main></body></html>`;
}

/** Pierwszy wolny port z listy. Zajęty port to nie awaria, tylko następny. */
function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    let index = 0;

    const attempt = () => {
      if (index >= PORTS.length) {
        return reject(
          new Error(
            `Wszystkie porty (${PORTS.join(", ")}) są zajęte. Zamknij to, co je trzyma, i spróbuj jeszcze raz.`,
          ),
        );
      }
      server.listen(PORTS[index++], "127.0.0.1");
    };

    server.on("error", (error) => (error.code === "EADDRINUSE" ? attempt() : reject(error)));
    server.once("listening", () => resolve({ server, port: server.address().port }));
    attempt();
  });
}

/**
 * Całe logowanie: od otwarcia przeglądarki do gotowej sesji.
 *
 * @param {object}   options
 * @param {object}   options.client       instancja Supabase (main/supabase.js)
 * @param {string}   options.provider     "google" | "apple" | …
 * @param {Function} options.openExternal otwarcie adresu w przeglądarce
 * @param {Function} [options.onWaiting]  wołane z adresem, gdy już czekamy
 * @returns {{ result: Promise<object>, cancel: Function }}
 */
function signInWithProvider({ client, provider, openExternal, onWaiting }) {
  const { verifier, challenge } = pkce();

  let settle = null;
  let closed = false;

  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  let handle = null;
  const shut = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    handle?.server.close();
  };

  const fail = (error) => {
    shut();
    settle.reject(error instanceof Error ? error : new Error(String(error)));
  };

  const timer = setTimeout(
    () => fail(new Error("Minęło pięć minut bez odpowiedzi z przeglądarki.")),
    TIMEOUT_MS,
  );

  const respond = (response, ok, message) => {
    response.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page({ ok, message }));
  };

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    // Przeglądarki proszą o /favicon.ico przy każdej stronie. Bez tego
    // pierwsze prawdziwe wejście bywało już po zamknięciu serwera.
    if (url.pathname !== CALLBACK) {
      response.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (error) {
      respond(response, false, error);
      fail(new Error(error));
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      respond(response, false, "Adres powrotny przyszedł bez kodu.");
      fail(new Error("Adres powrotny przyszedł bez kodu."));
      return;
    }

    try {
      const session = await client.exchangeCode(code, verifier);
      respond(response, true);
      shut();
      settle.resolve(session);
    } catch (problem) {
      respond(response, false, problem.message);
      fail(problem);
    }
  };

  (async () => {
    try {
      handle = await listen(handler);
      const target = `http://127.0.0.1:${handle.port}${CALLBACK}`;
      const authorize = client.authorizeUrl({ provider, redirectTo: target, challenge });
      onWaiting?.({ url: authorize, redirect: target });
      await openExternal(authorize);
    } catch (problem) {
      fail(problem);
    }
  })();

  return {
    result,
    /** Rezygnacja z okna aplikacji — serwer ma zniknąć razem z czekaniem. */
    cancel: () => fail(new Error("Logowanie przerwane.")),
  };
}

module.exports = { signInWithProvider, PORTS, CALLBACK };
