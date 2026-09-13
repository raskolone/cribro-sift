"use strict";

/**
 * Most do Cribro Recall — bez sieci i bez Recall.
 *
 * Sprawdzane jest to, co da się zepsuć po tej stronie: czy adres jest
 * normalizowany, czy http jest odrzucane (token jedzie w nagłówku), co
 * wychodzi w ciele żądania, i czy odpowiedź inna niż oczekiwana zamienia
 * się w zdanie po polsku, a nie w wyjątek o składni JSON.
 *
 * `fetch` podstawiamy na czas testu — żadne żądanie nie wychodzi.
 */

const assert = require("assert");
const recall = require("../src/main/recall");

let failures = 0;
const check = (name, fn) => {
  try {
    const done = fn();
    if (done instanceof Promise) return done.then(
      () => console.log(`  ✓ ${name}`),
      (error) => {
        failures += 1;
        console.log(`  ✗ ${name}\n    ${error.message}`);
      },
    );
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
  return Promise.resolve();
};

const meeting = {
  id: "spotkanie-1789",
  at: "2026-09-13T09:30:00.000Z",
  title: "Lekcja z Alą",
  transcript: [
    { at: 0, speaker: "Ja", text: "How was your week?" },
    { at: 4, speaker: "Ona", text: "I was commuting a lot." },
  ],
};

const settings = {
  recall: { url: "https://us-central1-projekt.cloudfunctions.net/ingestTranscript", token: "sekret" },
};

/** Atrapa `fetch`: zapamiętuje żądanie i oddaje zadaną odpowiedź. */
function stubFetch(reply) {
  const seen = {};
  global.fetch = async (url, options) => {
    seen.url = url;
    seen.options = options;
    seen.body = JSON.parse(options.body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      async text() {
        return reply.text;
      },
    };
  };
  return seen;
}

const real = global.fetch;

(async () => {
  console.log("Most do Cribro Recall");

  await check("adres bez schematu i z ukośnikiem na końcu przechodzi", () => {
    assert.strictEqual(
      recall.endpoint(" projekt.cloudfunctions.net/ingestTranscript/ "),
      "https://projekt.cloudfunctions.net/ingestTranscript",
    );
  });

  await check("http jest odrzucane — token jedzie w nagłówku", () => {
    assert.throws(() => recall.endpoint("http://projekt.example/ingest"), /https/);
  });

  await check("brak adresu mówi, czego brakuje", () => {
    assert.throws(() => recall.endpoint(""), /Ustawieniach/);
  });

  await check("skonfigurowany dopiero z adresem i tokenem", () => {
    assert.strictEqual(recall.configured({}), false);
    assert.strictEqual(recall.configured({ recall: { url: "https://a.example" } }), false);
    assert.strictEqual(recall.configured(settings), true);
  });

  await check("data spotkania jest dniem lokalnym, nie znacznikiem UTC", () => {
    assert.match(recall.localDay(meeting.at), /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(recall.localDay("nie-data"), null);
  });

  await check("zapis rozmowy niesie mówiących i znaczniki czasu", () => {
    const text = recall.transcriptFor(meeting);
    assert.match(text, /Ja: How was your week\?/);
    assert.match(text, /Ona: I was commuting a lot\./);
  });

  await check("spotkanie bez zapisu nie jedzie nigdzie", () => {
    assert.throws(() => recall.transcriptFor({ id: "x", transcript: [] }), /nie ma jeszcze zapisu/);
  });

  await check("udana wysyłka: co wychodzi w żądaniu", async () => {
    const seen = stubFetch({
      status: 201,
      text: JSON.stringify({ ok: true, action: "created", lessonId: "sift-1789", studentUid: "ala" }),
    });

    const result = await recall.send({ settings, meeting, studentEmail: " Ala@Example.com " });

    assert.strictEqual(result.action, "created");
    assert.strictEqual(result.lessonId, "sift-1789");
    assert.strictEqual(seen.options.method, "POST");
    /* Token we własnym nagłówku — `Authorization` przechwytuje brama Cloud
       Run i żądanie nie dochodzi do funkcji (patrz main/recall.js). */
    assert.strictEqual(seen.options.headers["x-sift-token"], "sekret");
    assert.strictEqual(seen.options.headers.authorization, undefined);
    assert.strictEqual(seen.body.siftSessionId, "spotkanie-1789");
    assert.strictEqual(seen.body.studentEmail, "Ala@Example.com");
    assert.strictEqual(seen.body.topic, "Lekcja z Alą");
    // Nagranie nie wychodzi nigdy — w ciele nie ma po nim śladu.
    assert.strictEqual("audio" in seen.body, false);
    assert.strictEqual("tracks" in seen.body, false);
  });

  await check("brak adresu kursanta zatrzymuje wysyłkę przed siecią", async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      throw new Error("nie powinno dojść do żądania");
    };
    await assert.rejects(() => recall.send({ settings, meeting, studentEmail: "" }), /e-mail/);
    assert.strictEqual(called, false);
  });

  await check("odrzucony token mówi o tokenie, nie o kodzie HTTP", async () => {
    stubFetch({ status: 401, text: JSON.stringify({ ok: false, error: "Brak dostępu." }) });
    await assert.rejects(() => recall.send({ settings, meeting, studentEmail: "ala@example.com" }), /token/);
  });

  await check("nieznany kursant mówi, o kogo chodzi", async () => {
    stubFetch({ status: 404, text: JSON.stringify({ ok: false, error: "Nie ma kursanta" }) });
    await assert.rejects(
      () => recall.send({ settings, meeting, studentEmail: "nikt@example.com" }),
      /nikt@example\.com/,
    );
  });

  await check("strona błędu Google zamiast JSON-a nie wywraca wysyłki", async () => {
    stubFetch({ status: 500, text: "<html><body>Internal Server Error</body></html>" });
    await assert.rejects(
      () => recall.send({ settings, meeting, studentEmail: "ala@example.com" }),
      /Recall odmówił/,
    );
  });

  global.fetch = real;

  if (failures) {
    console.log(`\n✗ ${failures} nieudanych sprawdzeń`);
    process.exit(1);
  }
  console.log("\n✓ most do Recall działa tak, jak opisano");
})();
