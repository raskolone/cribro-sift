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
      /* Tak samo jak w store.js: miejsce jest, klawiszy nie ma.
         `null` znaczy „nieprzypisany", nie „domyślny". */
      quickNote: null,
    },
    mesh: "srednie",
    language: { mode: "bilingual", primary: "pl", secondary: "en" },
    uiLanguage: "pl",
    /* Makieta pokazuje to, co widzi ZWYKŁY użytkownik — a ten nie widzi
       kroku „Silniki" wcale (patrz main/owner.js). Do obejrzenia go
       w przeglądarce wystarczy dopisać ?owner do adresu makiety. */
    owner: new URLSearchParams(location.search).has("owner"),
    /* Wszystko widoczne. Makieta pokazuje aplikację, a nie stan wdrożenia —
       a przełączniki funkcji są po to, żeby część okna CHOWAĆ (patrz
       main/admin.js). Zrzuty mają pokazywać całość. */
    features: { meetings: true, briefing: true, cloud: true },
    enginesReady: true,
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
    /* Te same domyślne, co w main/store.js. Bez nich karta ustawień
       spotkań w makiecie rysuje się z niczym zaznaczonym — i wygląda jak
       zepsuta, choć zepsuty jest tylko podgląd. */
    meetings: {
      enabled: false,
      detect: "ask",
      keepAudio: false,
      minSeconds: 90,
      folder: "Spotkania",
      exclude: ["Spotify", "Music"],
      summarize: true,
      template: "generic",
      instructions: "",
      rename: true,
      stopWithMeeting: true,
      calendar: true,
      armed: ["cal-2"],
    },
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
          text: "Sprawdzić, czy limity odnawiają się o północy czasu lokalnego.",
        },
        /* Notatka ze spotkania — jedyna, której nikt nie pisał. Powstaje
           sama po każdej nagranej rozmowie i ma w Notatniku własną
           przegródkę (patrz groupNotes w js/notes-core.js). Makieta musi ją
           mieć, bo bez niej nie widać, po co ta przegródka istnieje. */
        {
          id: "n5",
          at: minutesAgo(96),
          updatedAt: minutesAgo(94),
          pinned: false,
          kind: "meeting",
          folder: "Spotkania",
          text:
            "# Przegląd tygodnia · Ania Kowalska\n\n30 sierpnia 2026, 09:00 · Google Meet\n\n" +
            "**Kto był:** Maciej Wyrozumski, Ania Kowalska\n\n" +
            "**O czym było**\n\nPrzegląd zgłoszeń i decyzja o starym API.\n\n" +
            "**Ustalenia**\n\n- Raport idzie w czwartek.\n- Stare API zostaje do końca kwartału.\n\n" +
            "## Zadania\n\n- [ ] Ania: przysłać dane, wtorek\n- [ ] Napisać notkę o wyłączeniu API\n\n" +
            "## Zapis rozmowy\n\n**Ty** · 0:00\n\nZdążymy z raportem przed poniedziałkiem?\n\n" +
            "**Ania Kowalska** · 0:14\n\nDam radę, ale potrzebuję danych z wtorku.",
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
        /* W przeglądarce nie ma gdzie zapisać pliku ani czym go wydrukować —
           atrapa mówi, ile notatek BY poszło, żeby komunikat po kliknięciu
           był prawdziwy co do liczby. */
        exportFolder: async (folder) => ({
          canceled: false,
          notes: notes.filter(
            (note) => String(note.folder ?? "").trim() === String(folder ?? "").trim(),
          ).length,
        }),
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

    /* Spotkania. W makiecie nie ma czego nagrywać, ale JEST co pokazać:
       przykładowy spis, przełącznik i zakładki. Bez tego zakładka Meeting
       Notes w podglądzie byłaby pustą stroną, a to jedyne miejsce, w którym
       da się obejrzeć jej wygląd bez budowania aplikacji. */
    meetings: (() => {
      const rows = [
        {
          id: "m-demo-1",
          at: new Date(Date.now() - 3 * 3600e3).toISOString(),
          endedAt: new Date(Date.now() - 2.2 * 3600e3).toISOString(),
          seconds: 2880,
          title: "Przegląd tygodnia",
          state: "done",
          tracks: { mic: "", system: "" },
          transcript: [
            { speaker: "Rozmówcy", lane: "system", at: 0, text: "Czy zdążymy z raportem przed poniedziałkiem?" },
            { speaker: "Ty", lane: "mic", at: 14, text: "Dam radę, ale potrzebuję danych z wtorku — bez nich to zgadywanie." },
            { speaker: "Rozmówcy", lane: "system", at: 41, text: "Wyślę je dziś wieczorem, najpóźniej do dwudziestej." },
          ],
          notes: "Ania przysyła dane z wtorku do czwartku.",
        },
        {
          id: "m-demo-2",
          at: new Date(Date.now() - 26 * 3600e3).toISOString(),
          endedAt: new Date(Date.now() - 25.4 * 3600e3).toISOString(),
          seconds: 2160,
          title: null,
          state: "done",
          tracks: { mic: "", system: "" },
        },
      ];
      let live = false;
      let id = null;
      /* Rozmowa „wykryta na ekranie". W makiecie nie ma czego wykrywać,
         więc stoi tu wpisana — bez niej nie da się obejrzeć ani pytania
         znaczka, ani tego, co jest po powiedzeniu „Notuj". */
      let spotted = null;
      const hour = 3600e3;
      const plan = {
        access: "granted",
        armed: ["cal-2"],
        events: [
          { id: "cal-1", title: "Przegląd tygodnia", from: Date.now() + 0.4 * hour, to: Date.now() + 1.4 * hour, guests: 4, link: "https://meet.google.com/abc-defg-hij" },
          { id: "cal-2", title: "Rozmowa z klientem", from: Date.now() + 3 * hour, to: Date.now() + 3.75 * hour, guests: 2, link: null },
        ],
      };
      const tell = () =>
        emit("meeting:changed", { recording: live, id, seconds: 0, spotted, agenda: plan });
      return {
        toggle: async () => {
          live = !live;
          if (live) {
            id = `m-live-${Date.now().toString(36)}`;
            rows.unshift({
              id,
              at: new Date().toISOString(),
              endedAt: null,
              seconds: 0,
              title: spotted?.title ?? null,
              where: spotted?.where ?? null,
              state: "recording",
              transcript: [],
              notes: "",
            });
          } else {
            const row = rows.find((item) => item.id === id);
            if (row) Object.assign(row, { state: "done", seconds: 143 });
            id = null;
          }
          spotted = null;
          tell();
          return true;
        },
        /* Kalendarz w makiecie jest wpisany: w przeglądarce nie ma EventKit,
           a bez dwóch wpisów nie da się obejrzeć ani układu, ani tego, jak
           wygląda zgoda wyrażona przed czasem. */
        state: async () => ({ recording: live, id, seconds: 0, spotted, agenda: plan }),
        answer: async (yes) => {
          if (yes) return window.cribro.meetings.toggle();
          spotted = null;
          tell();
          return false;
        },
        note: async (which, text) => {
          const row = rows.find((item) => item.id === which);
          if (row) row.notes = text;
          return true;
        },
        /* Podsumowanie w makiecie nie woła modelu — pokazuje, jak wygląda
           czekanie i jak wygląda wynik. To jedyne, co da się obejrzeć
           w przeglądarce, a jedno i drugie ma swój układ. */
        summarize: async (which) => {
          const row = rows.find((item) => item.id === which);
          if (!row) return null;
          row.summarizing = true;
          tell();
          await new Promise((r) => setTimeout(r, 1400));
          row.summarizing = false;
          /* Układ jest ten sam, co w gotowym szablonie (patrz TEMPLATES
             w main/digest.js): najważniejsze na górze, reszta punktami,
             zadania polami do odhaczenia, „Otwarte" zwinięte. Makieta ma
             pokazywać to, co naprawdę wychodzi z modelu — razem
             z nagłówkiem składanym, bo to jego widać najbardziej. */
          row.summary = [
            "## Najważniejsze",
            "",
            "- Raport zamyka się w niedzielę, nie w poniedziałek — dane przyszły wcześniej.",
            "",
            "## O czym było",
            "",
            "- Termin raportu i dane potrzebne do jego zamknięcia.",
            "- Kolejność: najpierw dane z wtorku, potem zamknięcie.",
            "",
            "## Ustalenia",
            "",
            "- Raport ma być gotowy przed poniedziałkiem.",
            "- Dane z wtorku przychodzą dziś wieczorem.",
            "",
            "## Zadania",
            "",
            "- [ ] Ania: wysłać dane z wtorku, dziś wieczorem",
            "- [ ] Ty: zamknąć raport do niedzieli",
            "",
            "## \u25B8 Otwarte",
            "",
            "- Kto przejmuje stare API — bez rozstrzygnięcia.",
            "",
            "> Zdążę, ale potrzebuję danych z wtorku.",
          ].join("\n");
          if (!row.titleByHand) row.title = "Raport przed poniedziałkiem";
          tell();
          return { summary: row.summary };
        },
        /* Zwinięcie nagłówka w podsumowaniu — w atrapie tak samo jak
           naprawdę: strzałka jest treścią, więc zmienia treść. */
        fold: async (which, index, open) => {
          const row = rows.find((item) => item.id === which);
          if (!row?.summary) return false;
          const lines = row.summary.split("\n");
          const mark = /^(\s{0,3}#{1,6}[ \t]+)([\u25B8\u25BE])([ \t]*)/;
          let seen = -1;
          for (let at = 0; at < lines.length; at += 1) {
            if (!mark.test(lines[at])) continue;
            seen += 1;
            if (seen !== index) continue;
            lines[at] = lines[at].replace(mark, `$1${open ? "\u25BE" : "\u25B8"}$3`);
            break;
          }
          row.summary = lines.join("\n");
          return true;
        },
        /* Zgoda na kalendarz. W przeglądarce nie ma czego pytać, więc
           atrapa oddaje ten sam plan, co dotąd — makieta ma pokazywać
           kalendarz, a nie okno z odmową. */
        calendar: async () => plan,
        arm: async (which, on) => {
          const armed = new Set(plan.armed);
          if (on) armed.add(which);
          else armed.delete(which);
          plan.armed = [...armed];
          tell();
          return plan.armed;
        },
        toNote: async (which) => {
          const row = rows.find((item) => item.id === which);
          if (!row) return null;
          return window.cribro.notes.create({
            text: `# ${row.title ?? "Spotkanie"}\n\n${row.summary ?? ""}`,
          });
        },
        copy: async () => true,
        polish: async (which) => {
          const row = rows.find((item) => item.id === which);
          if (!row) return false;
          row.sifting = true;
          tell();
          await new Promise((r) => setTimeout(r, 1300));
          row.sifting = false;
          row.talk = [
            { speaker: "Rozmówcy", at: 0, text: "Zdążymy z raportem przed poniedziałkiem?" },
            { speaker: "Ty", at: 14, text: "Dam radę, ale potrzebuję danych z wtorku." },
            { speaker: "Rozmówcy", at: 41, text: "Wyślę je dziś wieczorem, najpóźniej do dwudziestej." },
          ];
          tell();
          return true;
        },
        retranscribe: async (which) => {
          const row = rows.find((item) => item.id === which);
          if (!row) return false;
          row.transcribing = true;
          tell();
          await new Promise((r) => setTimeout(r, 1200));
          row.transcribing = false;
          row.transcript = row.transcript?.length
            ? row.transcript
            : [{ speaker: "Ty", lane: "mic", at: 0, text: "Przepisane jeszcze raz, z pliku." }];
          tell();
          return true;
        },
        rename: async (which, title) => {
          const row = rows.find((item) => item.id === which);
          if (row) Object.assign(row, { title: title || null, titleByHand: !!title });
          tell();
          return true;
        },
        /* Wyłącznie dla makiety: udaje wykrycie rozmowy, żeby dało się
           obejrzeć pytanie znaczka bez otwierania Zooma. */
        pretend: (meeting) => {
          spotted = meeting ?? { kind: "meet", where: "Google Meet", title: "Przegląd tygodnia" };
          tell();
        },
        list: async () => rows,
        remove: async (which) => {
          const at = rows.findIndex((row) => row.id === which);
          if (at !== -1) rows.splice(at, 1);
          return true;
        },
        onChange: on("meeting:changed"),
        onDone: on("meeting:done"),
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
      /* Przeciąganie znaczka w makiecie nie ma czego przesuwać — okna
         w przeglądarce nie ma. Odpowiadamy „nic się nie ruszyło", żeby
         kliknięcie w znaczek zadziałało tak jak zwykle. */
      dragStart: async () => true,
      dragEnd: async () => ({ moved: false, spot: null }),
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
        // W przeglądarce nie ma okna do zwinięcia — sama kartka i tak
        // schowa treść, bo to robi jej własny arkusz.
        roll: async () => true,
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

    /* Panel admina. W makiecie nie ma bazy, więc konta stoją tu wpisane —
       inaczej zakładki nie dałoby się ani obejrzeć, ani zrzucić. Adresy są
       zmyślone i mają takie zostać. */
    admin: {
      state: async () => ({
        me: "ty@example.com",
        users: [
          {
            id: "u-1",
            email: "ty@example.com",
            display_name: "Ty",
            plan: "pro",
            created_at: "2026-06-01T09:00:00Z",
            last_sign_in: "2026-08-31T07:20:00Z",
            confirmed: true,
            features: ["meetings"],
          },
          {
            id: "u-2",
            email: "ania@example.com",
            display_name: "Ania",
            plan: "free",
            created_at: "2026-07-14T18:30:00Z",
            last_sign_in: "2026-08-30T16:05:00Z",
            confirmed: true,
            features: [],
          },
          {
            id: "u-3",
            email: "kuba@example.com",
            display_name: "Kuba",
            plan: "free",
            created_at: "2026-08-22T11:10:00Z",
            last_sign_in: null,
            confirmed: false,
            features: ["meetings"],
          },
        ],
        features: [
          {
            code: "meetings",
            label: "Notatki ze spotkań",
            note: "Nagrywanie rozmowy, transkrypcja i podsumowanie.",
            state: "invited",
            known: true,
          },
          {
            code: "briefing",
            label: "Poranek",
            note: "Podsumowanie dnia z kalendarza i poczty.",
            state: "on",
            known: true,
          },
          {
            code: "cloud",
            label: "Notatki w chmurze",
            note: "Synchronizacja notatek między komputerami.",
            state: "on",
            known: true,
          },
        ],
      }),
      setFeature: async (code, state) => ({ code, state }),
      grant: async (code, userId, on) => ({ code, userId, on }),
    },

    /* Poranek. W makiecie nie ma ani konta Google, ani kalendarza, więc
       treść stoi tu wpisana — bez niej okna poranka nie da się obejrzeć
       ani w przeglądarce, ani zrzutem z ukrytego okna. */
    briefing: {
      state: async () => ({
        enabled: true,
        owner: "ty@example.com",
        feeds: [{ url: "https://serwis.example/feed", name: "" }],
        lastAt: null,
        account: { configured: true, signedIn: true, email: "ty@example.com" },
        mismatch: false,
      }),
      show: async () => true,
      connect: async () => ({ account: { signedIn: true, email: "ty@example.com" } }),
      disconnect: async () => ({ account: { signedIn: false, email: null } }),
      onData: (handler) => {
        const hour = 3600e3;
        const at = new Date();
        const o = (h, m = 0) => new Date(at.getFullYear(), at.getMonth(), at.getDate(), h, m).getTime();
        setTimeout(
          () =>
            handler({
              at: at.toISOString(),
              plan: {
                all: [
                  { id: "1", title: "Stand-up zespołu", from: o(9), to: o(9, 15), guests: 5 },
                  { id: "2", title: "Kursant 4 — pierwsze zajęcia", from: o(11, 30), to: o(12, 15), guests: 2 },
                  { id: "3", title: "Przegląd tygodnia z Magdaleną", from: o(14), to: o(15), guests: 4 },
                ],
                done: [{ id: "1" }],
                ahead: [{ id: "2" }, { id: "3" }],
                next: { id: "2", from: o(11, 30) },
                minutesToNext: 35,
              },
              picks: [
                {
                  id: "a", threadId: "t1", from: "Magdalena Nowak", address: "magda@example.com",
                  subject: "Grafik zajęć — potwierdzenie",
                  why: ["jest dziś na Twoim spotkaniu", "jest w nim pytanie", "wisi 2 dni"],
                  link: "https://mail.google.com/mail/u/0/#inbox/t1",
                },
                {
                  id: "b", threadId: "t2", from: "Tomasz Kaczmarek", address: "tomasz@example.com",
                  subject: "Link do Meet",
                  why: ["napisane wprost do Ciebie", "jest w nim pytanie"],
                  link: "https://mail.google.com/mail/u/0/#inbox/t2",
                },
                {
                  id: "c", threadId: "t3", from: "Biuro rachunkowe", address: "biuro@example.com",
                  subject: "Faktura za sierpień",
                  why: ["wisi 4 dni"],
                  link: "https://mail.google.com/mail/u/0/#inbox/t3",
                },
              ],
              feeds: [
                { source: "Serwis", title: "Nowa wersja Electrona zmienia zasady podpisywania", link: "https://x", at: Date.now() - hour },
                { source: "Serwis", title: "Apple domyka lukę w EventKit", link: "https://y", at: Date.now() - 3 * hour },
              ],
              words: {
                headline: "Trzy spotkania, dzień zbity po południu — poranek masz wolny.",
                mail: [
                  "Magdalena Nowak — czeka na potwierdzenie grafiku, pyta wprost i wisi od wtorku.",
                  "Tomasz Kaczmarek — prosi o link do zajęć, które zaczynają się dziś.",
                  "Biuro rachunkowe — faktura za sierpień, nic pilnego poza terminem.",
                ],
                day: [
                  "9:00 Stand-up zespołu",
                  "11:30 Kursant 4 — pierwsze zajęcia, Tomasz czeka na link.",
                  "14:00 Przegląd tygodnia z Magdaleną — to tam wróci temat grafiku.",
                ],
                world: ["Zmiany w podpisywaniu aplikacji na macOS."],
              },
              problems: [],
            }),
          400,
        );
        return () => {};
      },
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
      /* W przeglądarce nie ma okna wyboru pliku ani procesu głównego —
         przycisk ma pokazać, że istnieje, a nie udawać, że czyta dysk. */
      readShotFile: async () => false,
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
