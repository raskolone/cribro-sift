"use strict";

const assert = require("assert");
const { SttStream } = require("../src/main/stt-stream");

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  console.log("✓", label);
  passed += 1;
}

console.log("Rozpoczynam testy modułu SttStream...");

const stream = new SttStream();
check("Instancja SttStream tworzy się poprawnie", stream !== null && stream.active === false);

// 1. Bez klucza lub z innym dostawcą nie otwiera sesji
const noKey = stream.startSession({ stt: { provider: "openai" } });
check("Inny dostawca (OpenAI) nie uruchamia strumienia WebSocket Deepgram", noKey === false && stream.active === false);

const noKeyDeepgram = stream.startSession({ stt: { provider: "deepgram", apiKey: "" } });
check("Brak klucza Deepgram nie uruchamia sesji", noKeyDeepgram === false);

// 2. Wyłączone strumieniowanie w ustawieniach
const disabled = stream.startSession({
  stt: { provider: "deepgram", apiKey: "dummy-key", streaming: false },
});
check("Wyłączona flaga stt.streaming uniemożliwia start sesji", disabled === false);

// 3. finishSession na nieaktywnym strumieniu natychmiast zwraca null
stream.finishSession().then((res) => {
  check("finishSession na nieaktywnym strumieniu zwraca null", res === null);

  // 4. Kolejkowanie chunków przy sztucznej sesji
  stream.active = true;
  stream.ws = {
    readyState: 0, // CONNECTING
    send: () => {},
    close: () => {},
  };
  stream.sendChunk(Buffer.from([1, 2, 3]));
  check("Próbki audio są kolejkowane, gdy gniazdo jeszcze się łączy", stream.queue.length === 1);

  // 5. abortSession czyści kolejkę i stan
  stream.abortSession();
  check("abortSession czyści stan i kolejkę", stream.active === false && stream.queue.length === 0);

  console.log(`\nSttStream: wszystkie ${passed} sprawdzeń przeszło pomyślnie!\n`);
});
