/* Ten sam interfejs działa w dwóch miejscach: w Electronie rozmawia
   z procesem głównym, a w zwykłej przeglądarce — z tą atrapą.
   Dzięki temu makieta do klikania i prawdziwa aplikacja to jeden plik. */

if (!window.cribro) {
  const listeners = {};
  const emit = (channel, payload) => (listeners[channel] ?? []).forEach((fn) => fn(payload));
  const on = (channel) => (handler) => {
    (listeners[channel] ??= []).push(handler);
    return () => (listeners[channel] = listeners[channel].filter((fn) => fn !== handler));
  };

  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

  const seed = [
    {
      id: "s1",
      at: minutesAgo(4),
      app: "Slack",
      mesh: "srednie",
      pinned: false,
      durationMs: 14200,
      timings: { transcribe: 640, sift: 910, total: 1550 },
      raw: "yyy dobra to znaczy chciałem powiedzieć że eee ta funkcja z sitem no wiesz ona powinna działać tak że użytkownik trzyma dwa klawisze i mówi i potem yyy to znaczy jak puści to się kończy nagranie i tekst leci do schowka automatycznie",
      text: "Funkcja z sitem powinna działać tak: użytkownik trzyma dwa klawisze i mówi. Gdy je puści, nagranie się kończy, a tekst automatycznie trafia do schowka.",
    },
    {
      id: "s2",
      at: minutesAgo(38),
      app: "Mail",
      mesh: "drobne",
      pinned: true,
      durationMs: 16800,
      timings: { transcribe: 700, sift: 1180, total: 1880 },
      raw: "hej Aniu eee chciałem zapytać czy dasz radę przesłać mi ten raport do piątku no to znaczy do czwartku bo w piątek mam już spotkanie z klientem i yyy potrzebuję to wcześniej przejrzeć dzięki wielkie",
      text: "Cześć Aniu,\n\nczy dasz radę przesłać mi raport do czwartku? W piątek mam spotkanie z klientem i chciałbym wcześniej wszystko przejrzeć.\n\nDzięki wielkie!",
    },
    {
      id: "s3",
      at: minutesAgo(112),
      app: "Notion",
      mesh: "drobne",
      pinned: false,
      durationMs: 19400,
      timings: { transcribe: 820, sift: 1240, total: 2060 },
      raw: "no dobra więc plan na jutro jest taki że yyy po pierwsze robimy przegląd zgłoszeń potem eee to znaczy najpierw kawa a potem przegląd zgłoszeń no i po drugie musimy się zdecydować co robimy z tym starym API bo ono nam yyy leży i kwiczy",
      text: "Plan na jutro:\n\n1. Kawa.\n2. Przegląd zgłoszeń.\n3. Decyzja w sprawie starego API — w obecnym stanie nie nadaje się do dalszego utrzymania.",
    },
    {
      id: "s4",
      at: minutesAgo(260),
      app: "Linear",
      mesh: "zgrubne",
      pinned: false,
      durationMs: 11100,
      timings: { transcribe: 520, sift: 640, total: 1160 },
      raw: "so um I was thinking that we could like ship the beta on Friday but uh only if the sieve latency stays under two seconds you know",
      text: "So I was thinking that we could ship the beta on Friday, but only if the sieve latency stays under two seconds.",
    },
  ];

  const words = (text) => (text ? text.trim().split(/\s+/).filter(Boolean).length : 0);
  const history = seed.map((entry) => ({
    ...entry,
    rawWords: words(entry.raw),
    siftedWords: words(entry.text),
    provider: "demo",
    model: "gemini-3.7-flash",
    pasted: true,
  }));

  const settings = {
    hotkey: {
      hold: ["Ctrl", "Alt"],
      toggleAccelerator: "Control+Alt+Space",
    },
    mesh: "srednie",
    language: { mode: "bilingual", primary: "pl", secondary: "en" },
    uiLanguage: "pl",
    autoPaste: true,
    playSound: true,
    launchAtLogin: false,
    keepRaw: true,
    stt: { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "" },
    sieve: { provider: "gemini", model: "gemini-3.7-flash", apiKey: "", customInstruction: "" },
    /* Tekst z ekranu. W przeglądarce nie ma czego zaznaczać, więc atrapa
       stoi na dostawcy „mock" — karta w Ustawieniach ma pokazywać kształt
       wyboru, a nie prosić o cudzy klucz. */
    shot: {
      hotkey: null,
      provider: "mock",
      model: "mock",
      apiKey: "",
      ask: true,
      target: "new",
      form: "text",
      copy: true,
    },
    grains: ["Cribro", "Wyrozumski", "kursant", "Hostinger", "n8n"],
    /* Polecenia w makiecie to ten sam zestaw startowy co w aplikacji —
       przepisany z main/commands.js, bo karta ma pokazywać to, co użytkownik
       naprawdę zastanie po pierwszym uruchomieniu. */
    commands: {
      enabled: true,
      bypass: ["cytuję", "słowo w słowo", "bez polecenia"],
      removedBuiltins: [],
      items: [
        {
          id: "c-checklist",
          name: "Checklista",
          enabled: true,
          builtin: true,
          where: "edge",
          triggers: [
            "zrób checklistę",
            "zrób z tego checklistę",
            "zrób z tego listę zadań",
            "make a checklist",
          ],
          rules: "Zapisz wypowiedź jako listę zadań: każdy punkt zaczyna się od „- [ ] \".\nJedno zadanie na punkt, w bezokoliczniku („Zadzwonić do Ani\"), bez kropki na końcu.\nZdanie, które nie jest zadaniem, zostaje zwykłym akapitem nad listą.\nPunktów ma być dokładnie tyle, ile zadań padło — żadnego nie dokładasz.",
          mesh: null,
          outlet: "cursor",
        },
        {
          id: "c-bullets",
          name: "Punkty",
          enabled: true,
          builtin: true,
          where: "edge",
          triggers: [
            "zrób punkty",
            "zrób z tego punkty",
            "zapisz to w punktach",
            "make bullet points",
          ],
          rules: "Zapisz wypowiedź jako listę punktów: każdy zaczyna się od „- \".\nJedna myśl na punkt, krótko, bez powtarzania tej samej rzeczy innymi słowami.\nZdanie wprowadzające zostaje akapitem nad listą.\nLiczba punktów wynika z tego, co padło — nie dokładasz swoich.",
          mesh: null,
          outlet: "cursor",
        },
        {
          id: "c-mail",
          name: "Mail",
          enabled: true,
          builtin: true,
          where: "edge",
          triggers: [
            "zrób z tego maila",
            "ułóż to jako wiadomość",
            "make this an email",
          ],
          rules: "Ułóż wypowiedź w wiadomość: zwrot powitalny, treść w akapitach, zwrot pożegnalny.\nAdresata i podpis bierzesz WYŁĄCZNIE z tego, co padło. Jeśli nie padło żadne imię,\npiszesz „Cześć,\" i nie podpisujesz się w niczyim imieniu.\nTon uprzejmy i rzeczowy. Żadnych ustaleń, terminów ani obietnic, których nie było.",
          mesh: "drobne",
          outlet: "cursor",
        },
      ],
    },
    widget: { enabled: false, mode: "compact", x: null, y: null, cards: {} },
    /* Przewodnik w makiecie jest już „pokazany": zrzuty ekranu robi się
       z gotowego okna, a nie z okna zasłoniętego slajdem. Przycisk na dole
       paska działa normalnie i tędy się go otwiera. */
    tutorial: { seen: true },
    spellcheck: { enabled: true, followDictation: true, languages: [] },
    cloud: { enabled: false, url: "", anonKey: "", autoSync: true },
  };

  const permissions = { accessibility: false, microphone: "granted" };

  const DEMO = {
    raw: "eee dobra to jeszcze jedna rzecz do zrobienia yyy trzeba dodać do landing page'a taką animację z konstelacją no wiesz gwiazdy które przesypują się przez sito i zostaje z nich tylko ten jeden kształt",
    text: "Jeszcze jedna rzecz do zrobienia: dodać do landing page'a animację z konstelacją — gwiazdy przesypują się przez sito i zostaje z nich jeden kształt.",
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  window.cribro = {
    isDesktop: false,
    isMock: true,
    platform: "darwin",

    /* Chmura w makiecie jest tylko widokiem: pokazuje kształt formularza,
       nie łączy się z niczym. */
    cloud: {
      state: async () => ({
        configured: false,
        signedIn: false,
        email: null,
        enabled: false,
        autoSync: true,
        lastSyncAt: null,
        syncing: false,
        provider: null,
        waitingFor: null,
      }),
      signUp: async () => ({ needsConfirmation: true }),
      signIn: async () => {
        throw new Error("Makieta nie łączy się z Supabase.");
      },
      signOut: async () => ({ signedIn: false }),
      resetPassword: async () => true,
      signInWith: async () => {
        throw new Error("Makieta nie łączy się z Supabase.");
      },
      cancelSignIn: async () => ({ waitingFor: null }),
      redirects: async () => [
        "http://127.0.0.1:53682/auth/callback",
        "http://127.0.0.1:53683/auth/callback",
        "http://127.0.0.1:53684/auth/callback",
      ],
      sync: async () => {
        throw new Error("Makieta nie łączy się z Supabase.");
      },
      onChange: on("cloud:changed"),
    },

    settings: {
      get: async () => structuredClone(settings),
      save: async (patch) => {
        deepMerge(settings, patch);
        emit("settings:changed", structuredClone(settings));
        return structuredClone(settings);
      },
      onChange: on("settings:changed"),
    },

    history: {
      get: async () => structuredClone(history),
      update: async (id, patch) => {
        const entry = history.find((item) => item.id === id);
        if (entry) Object.assign(entry, patch);
        return entry;
      },
      remove: async (id) => {
        const index = history.findIndex((item) => item.id === id);
        if (index > -1) history.splice(index, 1);
        return true;
      },
      clear: async () => {
        const kept = history.filter((entry) => entry.pinned);
        history.length = 0;
        history.push(...kept);
        return structuredClone(history);
      },
      stats: async () => {
        let raw = 0;
        let kept = 0;
        for (const entry of history) {
          raw += entry.rawWords;
          kept += entry.siftedWords;
        }
        return {
          sessions: history.length,
          wordsKept: kept,
          wordsSifted: Math.max(0, raw - kept),
          minutesSaved: Math.round((kept / 45 - kept / 150) * 10) / 10,
        };
      },
      resift: async (id, mesh) => {
        await wait(900);
        const entry = history.find((item) => item.id === id);
        if (entry) entry.mesh = mesh;
        return entry;
      },
      onNew: on("entry:new"),
    },

    notes: (() => {
      const notes = [
        {
          id: "n1",
          at: minutesAgo(22),
          updatedAt: minutesAgo(3),
          pinned: true,
          // Na wierzchu — makieta ma pokazywać widget, który coś trzyma,
          // a nie pusty znaczek z ekranem powitalnym.
          widget: true,
          text:
            "## Spotkanie z Anią\n\nRaport ma być gotowy **do czwartku**, nie do piątku. " +
            "W piątek jest spotkanie z klientem.\n\n- [x] przesłać zestawienie\n- [ ] ustalić, kto przejmuje stare API",
        },
        {
          id: "n2",
          at: minutesAgo(180),
          updatedAt: minutesAgo(140),
          pinned: false,
          text: "Pomysły na landing\n\nKonstelacja przesypująca się przez sito. Nagłówek, który sam się przesiewa.",
        },
        {
          id: "n3",
          at: minutesAgo(46),
          updatedAt: minutesAgo(46),
          pinned: false,
          kind: "quick",
          widget: true,
          text: "Zadzwonić do drukarni w sprawie nakładu.",
        },
        {
          id: "n4",
          at: minutesAgo(310),
          updatedAt: minutesAgo(300),
          pinned: false,
          kind: "quick",
          text: "Sprawdzić, czy limity Gemini odnawiają się o północy czasu lokalnego.",
        },
      ];
      return {
        get: async () => structuredClone(notes),
        create: async () => {
          const note = { id: `n${Date.now()}`, at: new Date().toISOString(), updatedAt: new Date().toISOString(), text: "", pinned: false };
          notes.unshift(note);
          return note;
        },
        update: async (id, patch) => {
          const note = notes.find((n) => n.id === id);
          if (note) Object.assign(note, patch, { updatedAt: new Date().toISOString() });
          return note;
        },
        remove: async (id) => {
          const i = notes.findIndex((n) => n.id === id);
          if (i > -1) notes.splice(i, 1);
          return true;
        },
        open: async () => true,
        openWindow: async () => true,
        closeWindow: () => {},
        quick: async () => true,
        closeQuick: () => {},
        dictate: async () => "listening",
        toAppleNotes: async () => ({ ok: true }),
        markdown: async (id) => {
          const note = notes.find((n) => n.id === id);
          const [first, ...rest] = (note?.text ?? "").split("\n");
          return first ? [`# ${first}`, ...rest].join("\n") : "";
        },
        export: async () => ({ canceled: false }),
        sift: async (id) => {
          const note = notes.find((n) => n.id === id);
          if (note) Object.assign(note, { previousText: note.text });
          return note;
        },
        undoSift: async (id) => {
          const note = notes.find((n) => n.id === id);
          if (note?.previousText) Object.assign(note, { text: note.previousText, previousText: null });
          return note;
        },
        onAppended: on("note:appended"),
        onChanged: on("note:changed"),
        onNew: on("note:new"),
      };
    })(),

    widget: {
      show: async () => true,
      settings: async () => ({ enabled: false, x: null, y: null }),
      passthrough: () => {},
      /* Pokrętła z tacy działają też w makiecie — bo to po nich widać,
         że kliknięcie w kółko przestawia ustawienie, a nie otwiera okna. */
      run: async (action) => {
        if (action !== "sieve") return true;
        const order = ["zgrubne", "srednie", "drobne"];
        settings.mesh = order[(order.indexOf(settings.mesh) + 1) % order.length] ?? order[0];
        emit("settings:changed", structuredClone(settings));
        return settings.mesh;
      },
      onLevel: on("widget:level"),
      // W przeglądarce nie ma okna do zmieniania rozmiaru, więc oddajemy
      // geometrię, jaką ustawiłby proces główny dla widgetu przy dolnej
      // krawędzi — tyle wystarczy, żeby układ i animacja miały się od czego
      // odbić w makiecie.
      layout: async (view) => ({
        view,
        dir: "up",
        ax: view === "panel" ? 150 : 52,
        ay: view === "panel" ? 386 : 52,
        badge: 60,
        tray: { dir: "down", side: "right", item: 34, step: 9, gap: 12 },
        panelW: 256,
        panelH: 320,
        panelX: 22,
        panelY: 22,
      }),
      move: () => {},
      drop: () => {},
      reset: async () => true,
      grabFocus: () => {},
      release: () => {},
    },

    /* Kartki na pulpicie. W przeglądarce nie ma osobnych okien, więc talia
       jest tu wyłącznie stanem — tyle, żeby znaczek w makiecie przełączał
       się tak samo jak w aplikacji. */
    deck: (() => {
      let open = false;
      const tell = (value) => (emit("deck:changed", { open: value }), value);
      return {
        toggle: async () => tell((open = !open)),
        show: async (next) => tell((open = !!next)),
        // Escape zdejmuje talię i mówi, czy było co zdejmować — po tej
        // odpowiedzi okno poznaje, czy Escape ma iść dalej.
        escape: async () => {
          if (!open) return false;
          tell((open = false));
          return true;
        },
        onChange: on("deck:changed"),
        state: async () => {
          const all = await window.cribro.notes.get();
          return { open, count: all.filter((note) => note.widget).length };
        },
        dismiss: async (id) => {
          await window.cribro.notes.update(id, { widget: false });
          emit("note:changed", { id });
          return true;
        },
        grabFocus: () => {},
        move: () => {},
        drop: () => {},
        resize: () => {},
        onFold: on("sticky:fold"),
        onScale: on("sticky:scale"),
        folded: () => {},
      };
    })(),

    /* HUD ma w Electronie własny kanał do procesu głównego. W przeglądarce
       nie ma mikrofonu, więc atrapa tylko pilnuje, żeby podgląd nie sypał
       się na braku metody. */
    hud: {
      onStart: on("rec:start"),
      onStop: on("rec:stop"),
      onCancel: on("rec:cancel"),
      sendAudio: () => {},
      sendLevel: (level) => emit("widget:level", level),
      sendError: () => {},
      // To samo, co robi nothingHeard w main/main.js: zdanie do okna
      // i smutna mina w HUD-zie.
      sendEmpty: () => {
        emit("pipeline:error", {
          stage: "nagranie",
          empty: true,
          message: "Nie mogę pomóc, bo nic nie usłyszałem",
        });
        emit("state", { state: "idle", empty: true });
      },
    },

    /* Zrzutu ekranu przeglądarka nie zrobi (to zgoda systemowa i narzędzie
       systemowe), więc atrapa mówi to wprost, zamiast udawać, że coś złapała. */
    shot: {
      grab: async () => false,
      ready: async () => null,
      save: async () => ({ error: "Makieta nie robi zrzutów ekranu." }),
      cancel: () => {},
      onText: on("shot:text"),
    },

    system: {
      copy: async (text) => {
        try {
          await navigator.clipboard.writeText(text ?? "");
        } catch {
          /* przeglądarka może odmówić bez gestu użytkownika */
        }
        return true;
      },
      status: async () => ({ backend: "uiohook", ...permissions }),
      checkHotkey: async (accelerator) => ({
        accelerator,
        conflicts: accelerator === "Control+Alt+Space" ? [{ source: "system", name: "Następne źródło wprowadzania" }] : [],
        blind: [],
      }),
      request: async (kind) => {
        if (kind === "accessibility") permissions.accessibility = true;
        return true;
      },
      // W przeglądarce nie ma mikrofonu ani procesu głównego — nagrywanie
      // sprowadza się do tego samego pokazu co przycisk demonstracyjny.
      capture: async () => window.cribro.system.demo(),
      openExternal: async () => true,
      /* Próba polecenia. Makieta nie ma procesu głównego, więc rozpoznanie
         jest tu odtworzone w skrócie — te same trzy reguły co w
         main/commands.js: krawędź wypowiedzi, granica zdania po frazie
         i materiał, który musi zostać. */
      probeCommand: async (text) => {
        const clean = String(text ?? "").trim();
        const GAP = "[\\s,.:;!?…—–'’-]+";
        const BREAK = "(?:[ \\t]*[,.:;!?…—–-]+|[ \\t]*\\r?\\n)\\s*";
        const shape = (phrase) =>
          (phrase.match(/[\p{L}\p{N}]+/gu) ?? []).join(GAP);

        const edges = (phrase) => {
          const body = shape(phrase);
          if (!body) return null;
          const head = new RegExp(`^[\\s„"'(]*${body}(?![\\p{L}\\p{N}])${BREAK}`, "iu").exec(clean);
          if (head) return clean.slice(head[0].length).trim();
          const tail = new RegExp(`${BREAK}${body}[\\s,.:;!?…—–]*$`, "iu").exec(clean);
          if (tail) return clean.slice(0, tail.index).trim();
          return null;
        };

        const config = settings.commands;
        for (const phrase of config.bypass) {
          const rest = edges(phrase);
          if (rest) return { id: null, name: null, trigger: null, body: rest, bypassed: true };
        }
        for (const command of config.items) {
          if (!command.enabled) continue;
          for (const trigger of command.triggers) {
            const rest = edges(trigger);
            if (rest) return { id: command.id, name: command.name, trigger, body: rest, bypassed: false };
          }
        }
        return { id: null, name: null, trigger: null, body: clean, bypassed: false };
      },
      // Kopia katalogu na potrzeby podglądu w przeglądarce. W Electronie
      // ta lista przychodzi z procesu głównego.
      providers: async () => ({
        stt: {
          mock: { label: "Atrapa (bez klucza)", needsKey: false, models: [["mock", "Przykładowe zdania"]] },
          gemini: {
            label: "Google Gemini", needsKey: true, keyHint: "AIza…",
            keyUrl: "https://aistudio.google.com/apikey",
            models: [["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite — domyślny, najluźniejsze limity"], ["gemini-3.7-flash", "Gemini 3.7 Flash — zatłoczony na darmowym poziomie"], ["gemini-3.1-pro", "Gemini 3.1 Pro — dokładniejszy"], ["gemini-2.5-flash", "Gemini 2.5 Flash — starszy"]],
          },
          openai: {
            label: "OpenAI", needsKey: true, keyHint: "sk-…",
            keyUrl: "https://platform.openai.com/api-keys",
            models: [["gpt-transcribe", "GPT Transcribe — najdokładniejszy"], ["gpt-4o-transcribe", "GPT-4o Transcribe"], ["gpt-4o-mini-transcribe", "GPT-4o mini Transcribe"], ["whisper-1", "Whisper v1"]],
          },
        },
        sieve: {
          gemini: {
            label: "Google Gemini", needsKey: true, keyHint: "AIza…",
            keyUrl: "https://aistudio.google.com/apikey",
            models: [["gemini-3.7-flash", "Gemini 3.7 Flash — szybki, domyślny"], ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite — najluźniejsze limity"], ["gemini-3.1-pro", "Gemini 3.1 Pro — najlepsza redakcja"], ["gemini-2.5-flash", "Gemini 2.5 Flash — starszy"]],
          },
          openai: {
            label: "OpenAI", needsKey: true, keyHint: "sk-…",
            keyUrl: "https://platform.openai.com/api-keys",
            models: [["gpt-5.6-terra", "GPT-5.6 Terra — rozsądny domyślny"], ["gpt-5.6-sol", "GPT-5.6 Sol — najmocniejszy"], ["gpt-5.6-luna", "GPT-5.6 Luna — najtańszy"]],
          },
          anthropic: {
            label: "Anthropic Claude", needsKey: true, keyHint: "sk-ant-…",
            keyUrl: "https://console.anthropic.com/settings/keys",
            models: [["claude-opus-5", "Claude Opus 5"], ["claude-sonnet-5", "Claude Sonnet 5"], ["claude-haiku-4-5", "Claude Haiku 4.5"]],
          },
        },
        shot: {
          openai: {
            label: "OpenAI", needsKey: true, keyHint: "sk-…",
            keyUrl: "https://platform.openai.com/api-keys",
            models: [["gpt-5.6-luna", "GPT-5.6 Luna — najtańszy, domyślny"], ["gpt-5.6-terra", "GPT-5.6 Terra — pewniejszy przy piśmie odręcznym"], ["gpt-4o-mini", "GPT-4o mini — starszy, tani klasyk"]],
          },
          mock: { label: "Atrapa (bez klucza)", needsKey: false, models: [["mock", "Przykładowy odczyt"]] },
        },
      }),
      testStt: async () => {
        await wait(600);
        return { ok: true, note: `${settings.stt.provider} / ${settings.stt.model} odpowiedział w 612 ms.` };
      },
      testSieve: async () => {
        await wait(900);
        return {
          ok: true,
          ms: 870,
          model: settings.sieve.model,
          text: "Chciałem powiedzieć, że to działa.",
        };
      },
      demo: async () => {
        emit("state", { state: "listening" });
        await wait(2400);
        emit("state", { state: "sifting" });
        await wait(1300);
        const entry = {
          id: `d${Date.now()}`,
          at: new Date().toISOString(),
          app: "Demo",
          mesh: settings.mesh,
          pinned: false,
          durationMs: 12400,
          timings: { transcribe: 610, sift: 880, total: 1490 },
          raw: DEMO.raw,
          text: DEMO.text,
          rawWords: words(DEMO.raw),
          siftedWords: words(DEMO.text),
          provider: "demo",
          model: settings.sieve.model,
          pasted: settings.autoPaste,
        };
        history.unshift(entry);
        emit("entry:new", entry);
        emit("state", { state: "done", entry });
        await wait(1500);
        emit("state", { state: "idle" });
        return true;
      },
      cancelCapture: async () => {
        emit("state", { state: "idle", cancelled: true });
        return true;
      },
      minimize: () => {},
      close: () => {},
    },

    onState: on("state"),
    onGoToView: on("view:go"),
    onError: on("pipeline:error"),
    onBackend: on("hotkey:backend"),
  };

  function deepMerge(base, patch) {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        deepMerge((base[key] ??= {}), value);
      } else {
        base[key] = value;
      }
    }
    return base;
  }
}
