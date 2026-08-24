"use strict";
/**
 * Logowanie przez cudze konto — cały taniec bez Google i bez Supabase.
 *
 * Sprawdzamy to, co da się sprawdzić na sucho, a co przy prawdziwym
 * logowaniu jest najdroższe do wyłapania: czy adres autoryzacji ma
 * wszystkie cztery parametry, czy pętla zwrotna oddaje kod z powrotem,
 * czy sekret PKCE dojeżdża w całości i czy błąd z przeglądarki kończy
 * czekanie, zamiast wisieć pięć minut.
 *
 *   node scripts/oauth-test.js
 */
const assert = require("assert");
const crypto = require("crypto");

const { signInWithProvider, CALLBACK } = require("../src/main/oauth");

/** Atrapa klienta Supabase — tyle z niego, ile widzi oauth.js. */
function fakeClient({ exchange } = {}) {
  const seen = { authorize: null, code: null, verifier: null };
  return {
    seen,
    authorizeUrl({ provider, redirectTo, challenge }) {
      const query = new URLSearchParams({
        provider,
        redirect_to: redirectTo,
        code_challenge: challenge,
        code_challenge_method: "s256",
      });
      seen.authorize = `https://demo.supabase.co/auth/v1/authorize?${query}`;
      return seen.authorize;
    },
    async exchangeCode(code, verifier) {
      seen.code = code;
      seen.verifier = verifier;
      if (exchange) return exchange(code, verifier);
      return { signedIn: true, email: "ktos@example.com", provider: "google" };
    },
  };
}

/** Przeglądarka: zamiast otwierać okno, oddaje adres, pod który poszłaby. */
function browser() {
  let resolve;
  const opened = new Promise((r) => (resolve = r));
  return { opened, openExternal: async (url) => resolve(url) };
}

const get = async (url) => {
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, body: await response.text() };
};

(async () => {
  /* 1. Adres autoryzacji: dostawca, powrót, skrót i metoda skrótu */
  {
    const client = fakeClient();
    const web = browser();
    const attempt = signInWithProvider({
      client,
      provider: "google",
      openExternal: web.openExternal,
    });

    const url = new URL(await web.opened);
    assert.equal(url.searchParams.get("provider"), "google");
    assert.equal(url.searchParams.get("code_challenge_method"), "s256");

    const challenge = url.searchParams.get("code_challenge");
    assert.ok(challenge && challenge.length >= 43, "skrót PKCE za krótki albo go nie ma");
    assert.ok(!/[+/=]/.test(challenge), "skrót ma być base64url, bez +, / i =");

    const redirect = new URL(url.searchParams.get("redirect_to"));
    assert.equal(redirect.hostname, "127.0.0.1", "powrót ma iść na pętlę zwrotną");
    assert.equal(redirect.pathname, CALLBACK);

    /* 2. Kod z pętli zwrotnej idzie do wymiany razem z sekretem, którego
          skrótem był `challenge` — to jest cała istota PKCE. */
    const page = await get(`${redirect.origin}${CALLBACK}?code=kod-z-google`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("Zalogowano"), "strona powrotna nie mówi, że się udało");

    const session = await attempt.result;
    assert.equal(session.email, "ktos@example.com");
    assert.equal(client.seen.code, "kod-z-google");
    assert.equal(
      crypto.createHash("sha256").update(client.seen.verifier).digest("base64url"),
      challenge,
      "sekret nie pasuje do wysłanego skrótu",
    );
    console.log("✓ Adres autoryzacji, pętla zwrotna i wymiana kodu na sesję");

    // Serwer ma zniknąć po zalogowaniu — inaczej zostaje otwarty port.
    await assert.rejects(() => get(`${redirect.origin}${CALLBACK}`), "port został otwarty");
    console.log("✓ Port zamyka się po zalogowaniu");
  }

  /* 3. Odmowa w przeglądarce kończy czekanie, a nie wisi */
  {
    const client = fakeClient();
    const web = browser();
    const attempt = signInWithProvider({ client, provider: "google", openExternal: web.openExternal });
    const redirect = new URL(new URL(await web.opened).searchParams.get("redirect_to"));

    // Obietnicę przechwytujemy PRZED wywołaniem błędu: inaczej Node zdąży
    // uznać odrzucenie za nieobsłużone i przerwać proces.
    const rejected = assert.rejects(attempt.result, /Nie zgodzono/);
    const page = await get(`${redirect.origin}${CALLBACK}?error=access_denied&error_description=Nie+zgodzono+si%C4%99`);
    assert.equal(page.status, 400);
    assert.ok(page.body.includes("Nie udało się"));
    await rejected;
    console.log("✓ Odmowa w przeglądarce wraca jako błąd, nie jako cisza");
  }

  /* 4. Rezygnacja z okna aplikacji zamyka port i odrzuca obietnicę */
  {
    const client = fakeClient();
    const web = browser();
    const attempt = signInWithProvider({ client, provider: "google", openExternal: web.openExternal });
    const redirect = new URL(new URL(await web.opened).searchParams.get("redirect_to"));

    const rejected = assert.rejects(attempt.result, /przerwane/);
    attempt.cancel();
    await rejected;
    await assert.rejects(() => get(`${redirect.origin}${CALLBACK}`), "port został otwarty po rezygnacji");
    console.log("✓ Rezygnacja zamyka port i kończy czekanie");
  }

  /* 5. Zapytanie o cokolwiek innego niż adres powrotny nie kończy logowania.
        Przeglądarki proszą o /favicon.ico przy każdej stronie — pierwsza
        wersja brała to za powrót i zamykała serwer przed czasem. */
  {
    const client = fakeClient();
    const web = browser();
    const attempt = signInWithProvider({ client, provider: "google", openExternal: web.openExternal });
    const redirect = new URL(new URL(await web.opened).searchParams.get("redirect_to"));

    const stray = await get(`${redirect.origin}/favicon.ico`);
    assert.equal(stray.status, 404);

    const page = await get(`${redirect.origin}${CALLBACK}?code=drugi-kod`);
    assert.equal(page.status, 200);
    await attempt.result;
    assert.equal(client.seen.code, "drugi-kod");
    console.log("✓ Zabłąkane zapytanie nie przerywa logowania");
  }

  /* 6. Dwie próby pod rząd nie wchodzą sobie na port */
  {
    const first = signInWithProvider({ client: fakeClient(), provider: "google", openExternal: async () => {} });
    const second = signInWithProvider({ client: fakeClient(), provider: "google", openExternal: async () => {} });
    // Same obietnice adresów: obie muszą dostać własny, wolny port.
    const both = Promise.all([assert.rejects(first.result), assert.rejects(second.result)]);
    await new Promise((r) => setTimeout(r, 80));
    first.cancel();
    second.cancel();
    await both;
    console.log("✓ Druga próba bierze następny port zamiast padać");
  }

  console.log("\nLogowanie przez cudze konto: wszystko zgodne.");
})().catch((error) => {
  console.error("\n✗", error.message);
  process.exit(1);
});
