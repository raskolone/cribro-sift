// ════════════════════════════════════════════════════════════════════
//  cribro-tap — dźwięk spotkania w dwóch torach
//
//  Electron nie umie na macOS wziąć dźwięku systemu. Jego typy mówią to
//  wprost („loopback … currently only supported on Windows”), więc głos
//  rozmówców musi wejść drogą natywną i tylko po to jest ten program.
//
//  Bierze OBA tory z JEDNEGO strumienia ScreenCaptureKit:
//
//      SCStreamOutputTypeAudio       → to mówią oni  (wyjście systemu)
//      SCStreamOutputTypeMicrophone  → to mówisz ty  (mikrofon)
//
//  Jeden strumień, nie dwa, i to jest cała sztuczka: oba tory dostają
//  wtedy ten sam zegar (zmierzone: 0,003 s rozjazdu). Gdyby mikrofon szedł
//  osobno, przez getUserMedia w oknie Electrona, trzeba by je zestrajać —
//  a rozjazd dwóch zegarów widać w transkrypcji jako przeplot zdań, które
//  padły w odwrotnej kolejności.
//
//  Podział na osoby wynika stąd za darmo: nie zgaduje go model, tylko
//  okablowanie. Twój głos wchodzi mikrofonem, ich głos wychodzi
//  z głośników. To są fizycznie osobne strumienie.
//
//  ── DWA TRYBY ──
//
//  --stream  (praca)   Ramki PCM na standardowe wyjście. Proces główny
//                      Electrona rozplata je na dwa tory, zapisuje i tnie
//                      na odcinki do transkrypcji. Patrz src/main/tap.js.
//
//  --probe   (pomiar)  Nagrywa zadaną liczbę sekund do dwóch plików WAV
//                      i mówi, co w nich siedzi — szczyt i głośność
//                      skuteczna toru po torze. Tym rozstrzygnięto etap E0
//                      i tym sprawdza się sprzęt, gdy coś nie gra.
//
//  --agenda  (kalendarz) Nadchodzące spotkania z kalendarza systemowego,
//                      jedną linią JSON. Nie ma tu nic wspólnego z dźwiękiem
//                      i siedzi w tym samym programie z jednego powodu:
//                      drugi program natywny to drugi podpis, drugie
//                      uprawnienia i druga rzecz do wysłania w paczce.
//
//  ── DLACZEGO EVENTKIT, A NIE GOOGLE CALENDAR API ──
//
//  EventKit czyta WSZYSTKIE kalendarze, które ktoś dodał w macOS — Google,
//  iCloud, Exchange — bez klucza API, bez okna logowania i bez projektu
//  w cudzej konsoli. Google Calendar podpięty w Ustawieniach systemowych
//  jest tu widoczny tak samo jak każdy inny. Bezpośrednie API Google
//  wymagałoby własnego identyfikatora klienta, ekranu zgody i weryfikacji
//  aplikacji — czyli rzeczy, których nie da się zrobić za użytkownika.
//
//  ── CZEGO SIĘ DOWIEDZIELIŚMY SONDĄ (E0) ──
//
//  · ScreenCaptureKit NIE KASUJE ECHA. Przy głośnikach głos drugiej strony
//    wraca mikrofonem na −27,6 dBFS, raptem 10 dB poniżej toru systemu.
//    Rozstrzyga to splot torów po stronie JavaScriptu, nie ten program.
//
//  · SCK NIE ŁAPIE PROCESÓW BEZ OKNA. `say` i `afplay` nie wchodzą do toru
//    systemu wcale; ta sama mowa puszczona z okna aplikacji wchodzi
//    natychmiast. Filtr działa po aplikacjach widocznych na ekranie — i tą
//    samą drogą da się z nagrania wyciąć muzykę z tła.
// ════════════════════════════════════════════════════════════════════

import AVFoundation
import CoreMedia
import EventKit
import Foundation
import ScreenCaptureKit

// ── Wspólny format ──────────────────────────────────────────────────
//
// 16 kHz mono, próbka szesnastobitowa. Ten sam format, który wychodzi
// dziś z HUD-a (renderer/js/hud.js) i jedyny, który przyjmują wszyscy
// dostawcy transkrypcji bez konwersji. Mowa nie ma nic powyżej 8 kHz,
// więc wyżej płaci się za samo powietrze.

let SAMPLE_RATE = 16_000.0

let TARGET = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    interleaved: true
)!

/// Numer toru w ramce. Mikrofon jest zerem, bo to on jest torem „ja”.
enum Lane: UInt8 {
    case microphone = 0
    case system = 1

    var label: String {
        self == .microphone ? "tor A (mikrofon)" : "tor B (system)"
    }
}

/// Wypisanie na stderr. Standardowe wyjście należy do ramek PCM i nie
/// wolno w nie wejść ani jednym znakiem — jedna linia logu rozjechałaby
/// cały strumień po stronie odbiorcy.
func log(_ text: String) {
    FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
}

func die(_ text: String) -> Never {
    log("BŁĄD: " + text)
    exit(1)
}

// ── Ujścia ──────────────────────────────────────────────────────────

/// Dokąd trafia przeliczony dźwięk. Dwie drogi, ta sama ścieżka nad nimi.
protocol Drain {
    func take(_ pcm: Data, at millis: Double)
    func close()
}

/// Ramka na standardowym wyjściu — 20 bajtów nagłówka i próbki za nim.
///
///     magia   4B  "CRIB"
///     tor     1B  0 = mikrofon, 1 = system
///     zapas   3B
///     próbek  4B  uint32 little-endian
///     czas    8B  double little-endian, milisekundy od startu strumienia
///
/// Magia nie jest ozdobą: gdyby cokolwiek dopisało się do standardowego
/// wyjścia (a robi to każda biblioteka, która uzna, że ma coś do
/// powiedzenia), odbiorca musi umieć znaleźć początek następnej ramki
/// zamiast przyjąć śmieci za dźwięk.
final class PipeDrain: Drain {
    private let lane: Lane
    private static let gate = NSLock()

    init(lane: Lane) { self.lane = lane }

    func take(_ pcm: Data, at millis: Double) {
        var frame = Data(capacity: 20 + pcm.count)
        frame.append(contentsOf: Array("CRIB".utf8))
        frame.append(lane.rawValue)
        frame.append(contentsOf: [0, 0, 0])
        withUnsafeBytes(of: UInt32(pcm.count / 2).littleEndian) { frame.append(contentsOf: $0) }
        withUnsafeBytes(of: millis.bitPattern.littleEndian) { frame.append(contentsOf: $0) }
        frame.append(pcm)

        // Oba tory piszą w to samo wyjście. Bez zamka ramka jednego toru
        // potrafiłaby wejść w środek ramki drugiego.
        Self.gate.lock()
        FileHandle.standardOutput.write(frame)
        Self.gate.unlock()
    }

    func close() {}
}

/// Plik WAV. Nagłówek pisze się na końcu, bo dopiero wtedy znana jest
/// długość — stąd 44 bajty miejsca na starcie i powrót na początek.
final class WavDrain: Drain {
    private let handle: FileHandle
    private var payload = 0

    init(url: URL) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
        handle.write(Data(count: 44))
    }

    func take(_ pcm: Data, at _: Double) {
        guard !pcm.isEmpty else { return }
        handle.write(pcm)
        payload += pcm.count
    }

    var seconds: Double { Double(payload) / 2.0 / SAMPLE_RATE }

    func close() {
        var header = Data()
        func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }

        header.append(contentsOf: Array("RIFF".utf8))
        u32(UInt32(36 + payload))
        header.append(contentsOf: Array("WAVEfmt ".utf8))
        u32(16)                          // długość bloku fmt
        u16(1)                           // PCM bez kompresji
        u16(1)                           // mono
        u32(UInt32(SAMPLE_RATE))
        u32(UInt32(SAMPLE_RATE) * 2)     // bajtów na sekundę
        u16(2)                           // bajtów na ramkę
        u16(16)                          // bitów na próbkę
        header.append(contentsOf: Array("data".utf8))
        u32(UInt32(payload))

        try? handle.seek(toOffset: 0)
        handle.write(header)
        try? handle.close()
    }
}

// ── Tor ─────────────────────────────────────────────────────────────

/// Jeden tor dźwięku: przelicza to, co przyszło, na wspólny format
/// i po drodze mierzy głośność.
///
/// Przeliczać trzeba, bo tory przychodzą w różnych formatach i tylko
/// jeden z nich da się zamówić. Dźwięk systemu bierze `sampleRate`
/// i `channelCount` z konfiguracji strumienia, ale MIKROFON przychodzi
/// „in the selected microphone capture device's native format” — czyli
/// zwykle 48 kHz, zmiennoprzecinkowo, i nikt nas o zdanie nie pyta.
final class Track {
    let lane: Lane
    private let drain: Drain
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var origin: Double?

    private(set) var peak: Float = 0        // najgłośniejsza próbka, 0…1
    private(set) var sumOfSquares: Double = 0
    private(set) var samples = 0

    init(lane: Lane, drain: Drain) {
        self.lane = lane
        self.drain = drain
    }

    func append(_ sampleBuffer: CMSampleBuffer) {
        guard let description = sampleBuffer.formatDescription,
              let asbd = description.audioStreamBasicDescription
        else { return }

        var layout = asbd
        guard let incoming = AVAudioFormat(streamDescription: &layout) else { return }

        // Format potrafi się zmienić w locie — przepięcie słuchawek
        // w trakcie rozmowy jest zdarzeniem normalnym, nie awarią.
        if sourceFormat == nil || sourceFormat! != incoming {
            sourceFormat = incoming
            converter = AVAudioConverter(from: incoming, to: TARGET)
            log("· \(lane.label): wejście \(Int(incoming.sampleRate)) Hz, kanałów \(incoming.channelCount)")
        }
        guard let converter else { return }

        /* Czas liczony od PIERWSZEJ ramki strumienia, nie od zera zegara
           systemowego. Oba tory czytają go z tego samego źródła, więc to
           on jest tym wspólnym zegarem, na którym stoi splot torów. */
        let stamp = sampleBuffer.presentationTimeStamp.seconds
        if origin == nil { origin = stamp }
        let millis = (stamp - (origin ?? stamp)) * 1000

        try? sampleBuffer.withAudioBufferList { list, _ in
            guard let source = AVAudioPCMBuffer(pcmFormat: incoming, bufferListNoCopy: list.unsafePointer),
                  source.frameLength > 0
            else { return }

            let ratio = TARGET.sampleRate / incoming.sampleRate
            let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1024
            guard let out = AVAudioPCMBuffer(pcmFormat: TARGET, frameCapacity: capacity) else { return }

            var handed = false
            var problem: NSError?
            converter.convert(to: out, error: &problem) { _, status in
                if handed {
                    status.pointee = .noDataNow
                    return nil
                }
                handed = true
                status.pointee = .haveData
                return source
            }
            if let problem {
                log("· \(lane.label): przeliczenie odmówiło — \(problem.localizedDescription)")
                return
            }
            guard out.frameLength > 0, let channel = out.int16ChannelData?[0] else { return }

            for index in 0..<Int(out.frameLength) {
                let value = Float(channel[index]) / 32768.0
                let magnitude = abs(value)
                if magnitude > peak { peak = magnitude }
                sumOfSquares += Double(value * value)
            }
            samples += Int(out.frameLength)

            drain.take(Data(bytes: channel, count: Int(out.frameLength) * 2), at: millis)
        }
    }

    /// Głośność skuteczna w decybelach względem pełnej skali.
    /// Cisza to około −90 dBFS, mowa w rozmowie zwykle −30…−20 dBFS.
    var rmsDb: Double {
        guard samples > 0 else { return -120 }
        let rms = (sumOfSquares / Double(samples)).squareRoot()
        return rms > 0 ? 20 * log10(rms) : -120
    }

    var peakDb: Double { peak > 0 ? Double(20 * log10(peak)) : -120 }
    var seconds: Double { Double(samples) / SAMPLE_RATE }

    func close() { drain.close() }
}

// ── Odbiór ze strumienia ────────────────────────────────────────────

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate {
    let system: Track
    let microphone: Track

    init(system: Track, microphone: Track) {
        self.system = system
        self.microphone = microphone
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard buffer.isValid else { return }
        if type == .audio {
            system.append(buffer)
            return
        }
        // .microphone istnieje dopiero od macOS 15, więc nie da się wypisać
        // go w `case` bez sprawdzenia dostępności. Ekran i tak nie dochodzi
        // — nie zamówiliśmy jego wyjścia.
        if #available(macOS 15.0, *), type == .microphone {
            microphone.append(buffer)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("· strumień się zatrzymał: \(error.localizedDescription)")
    }
}

// ── Strumień ────────────────────────────────────────────────────────

/// Wspólne uruchomienie dla obu trybów.
func openStream(sink: Sink, excluding names: [String]) async throws -> SCStream {
    // Zapytanie o treść do udostępnienia jest jednocześnie pytaniem
    // o zgodę „Nagrywanie ekranu”. Jeśli jej nie ma, to jest miejsce,
    // w którym macOS pokaże okno — albo w którym program odmówi.
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        die("""
        brak zgody „Nagrywanie ekranu” albo ScreenCaptureKit odmówił.
                \(error.localizedDescription)

                Ustawienia systemowe → Prywatność i ochrona → Nagrywanie ekranu.
        """)
    }

    guard let display = content.displays.first else { die("system nie zgłosił żadnego ekranu.") }

    /* Wykluczenia. Dźwięk systemu to dźwięk wszystkich aplikacji z oknami,
       więc muzyka z tła weszłaby do transkrypcji jako czyjaś wypowiedź.
       Filtr działa po aplikacjach — i to jest tańsze wyjście niż schodzenie
       do CoreAudio po dźwięk pojedynczego procesu. */
    let unwanted = content.applications.filter { app in
        names.contains { app.bundleIdentifier.localizedCaseInsensitiveContains($0)
            || app.applicationName.localizedCaseInsensitiveContains($0) }
    }
    if !unwanted.isEmpty {
        log("· pomijam: " + unwanted.map(\.applicationName).joined(separator: ", "))
    }

    let filter = SCContentFilter(display: display, excludingApplications: unwanted, exceptingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = Int(SAMPLE_RATE)
    config.channelCount = 1

    // Obrazu nie zamawiamy, ale strumień jest strumieniem ekranu i klatki
    // i tak powstają. Dwa piksele raz na minutę to najtańsza forma
    // „nie interesuje mnie obraz”, jaką da się wyrazić w tej konfiguracji.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 60, timescale: 1)
    config.queueDepth = 5

    var micWanted = false
    if #available(macOS 15.0, *) {
        config.captureMicrophone = true
        micWanted = true
    } else {
        log("UWAGA: mikrofon w tym strumieniu wymaga macOS 15. Będzie tylko tor systemu.")
    }

    let stream = SCStream(filter: filter, configuration: config, delegate: sink)
    let queue = DispatchQueue(label: "com.cribro.tap.audio")

    try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: queue)
    if #available(macOS 15.0, *), micWanted {
        try stream.addStreamOutput(sink, type: .microphone, sampleHandlerQueue: queue)
    }

    try await stream.startCapture()
    return stream
}

// ── Tryb pracy ──────────────────────────────────────────────────────

func stream(excluding names: [String]) async throws {
    let system = Track(lane: .system, drain: PipeDrain(lane: .system))
    let microphone = Track(lane: .microphone, drain: PipeDrain(lane: .microphone))
    let sink = Sink(system: system, microphone: microphone)

    let live = try await openStream(sink: sink, excluding: names)
    log("· gotowe")

    /* Koniec nagrywania to zamknięcie standardowego WEJŚCIA przez proces
       główny. Sygnałów nie używamy: kill kończy program w połowie ramki,
       a wtedy ostatni odcinek dźwięku ginie razem z tym, co w nim padło. */
    await withCheckedContinuation { (waiting: CheckedContinuation<Void, Never>) in
        // Czytanie wejścia jest blokujące, więc idzie na własny wątek.
        // Semafor w funkcji asynchronicznej zająłby wątek z puli zadań
        // i zatkał tę samą pulę, z której korzysta ScreenCaptureKit.
        DispatchQueue.global().async {
            while let line = readLine(strippingNewline: true) {
                if line == "stop" { break }
            }
            waiting.resume()
        }
    }

    try? await live.stopCapture()
    system.close()
    microphone.close()
    log("· koniec")
}

// ── Tryb pomiaru ────────────────────────────────────────────────────

func probe(seconds: Double, directory: URL, excluding names: [String]) async throws {
    log("Cribro tap — sonda")
    log("")

    let systemDrain = try WavDrain(url: directory.appendingPathComponent("tor-b-system.wav"))
    let micDrain = try WavDrain(url: directory.appendingPathComponent("tor-a-mikrofon.wav"))
    let system = Track(lane: .system, drain: systemDrain)
    let microphone = Track(lane: .microphone, drain: micDrain)
    let sink = Sink(system: system, microphone: microphone)

    let live = try await openStream(sink: sink, excluding: names)
    log("Nagrywam \(Int(seconds)) s. Mów i puść dźwięk z drugiej strony.")
    log("")

    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    try? await live.stopCapture()
    system.close()
    microphone.close()

    log("")
    log("── co przyszło ──")
    for track in [microphone, system] {
        log(String(
            format: "%@  %6.2f s   szczyt %7.1f dBFS   głośność %7.1f dBFS",
            track.lane.label.padding(toLength: 18, withPad: " ", startingAt: 0),
            track.seconds, track.peakDb, track.rmsDb
        ))
    }
    log("")
    let drift = abs(microphone.seconds - system.seconds)
    log(String(format: "rozjazd torów: %.3f s", drift))
    log(drift > 0.5
        ? "  ↑ powyżej pół sekundy — tory NIE mają wspólnego zegara"
        : "  ↑ poniżej pół sekundy — wspólny zegar trzyma")
    log("")
    log("Pliki: \(directory.path)")
}

// ── Wejście ─────────────────────────────────────────────────────────

var mode = "probe"
var seconds = 20.0
var outDir = FileManager.default.temporaryDirectory.appendingPathComponent("cribro-tap")
var excluded: [String] = []
/// Jak daleko w przód patrzymy w kalendarzu, w godzinach.
var hours = 12.0

// ── Kalendarz ───────────────────────────────────────────────────────

/// Nadchodzące spotkania — jedną linią JSON na standardowe wyjście.
///
/// Wypisujemy TYLKO to, co potrzebne do rozstrzygnięcia „czy to spotkanie
/// i czy już się zaczyna": identyfikator, tytuł, godziny, liczbę zaproszonych
/// i adres rozmowy, jeśli jest. Reszty kalendarza — notatek, załączników,
/// nazwisk — nie czytamy i nie wynosimy z tego programu.
func agenda(hours: Double) async {
    let store = EKEventStore()

    /// macOS 14 wprowadził dostęp „tylko do odczytu"; starsze chcą pełnego.
    let granted: Bool
    if #available(macOS 14.0, *) {
        granted = (try? await store.requestFullAccessToEvents()) ?? false
    } else {
        granted = await withCheckedContinuation { go in
            store.requestAccess(to: .event) { ok, _ in go.resume(returning: ok) }
        }
    }
    guard granted else {
        // Brak zgody nie jest awarią: aplikacja ma wtedy po prostu nie
        // pokazywać kalendarza. Mówimy to danymi, a nie kodem wyjścia.
        print("{\"access\":\"denied\",\"events\":[]}")
        return
    }

    let now = Date()
    let until = now.addingTimeInterval(hours * 3600)
    /// Zaczynamy godzinę wstecz, bo spotkanie, które właśnie trwa, jest
    /// najważniejsze ze wszystkich — a zaczęło się przed „teraz".
    let from = now.addingTimeInterval(-3600)
    let query = store.predicateForEvents(withStart: from, end: until, calendars: nil)

    let iso = ISO8601DateFormatter()
    var rows: [String] = []
    for event in store.events(matching: query) {
        if event.isAllDay { continue }
        if event.status == .canceled { continue }
        let link = [event.url?.absoluteString, event.location, event.notes]
            .compactMap { $0 }
            .compactMap(meetingLink)
            .first
        var row: [String] = []
        row.append("\"id\":\(quoted(event.eventIdentifier ?? UUID().uuidString))")
        row.append("\"title\":\(quoted(event.title ?? ""))")
        row.append("\"from\":\(quoted(iso.string(from: event.startDate)))")
        row.append("\"to\":\(quoted(iso.string(from: event.endDate)))")
        row.append("\"guests\":\(event.attendees?.count ?? 0)")
        row.append("\"link\":\(quoted(link ?? ""))")
        rows.append("{" + row.joined(separator: ",") + "}")
    }
    print("{\"access\":\"granted\",\"events\":[" + rows.joined(separator: ",") + "]}")
}

/// Adres rozmowy wyłuskany z pola, w którym bywa schowany.
///
/// Kalendarze wpisują go gdzie popadnie: Google w „location" albo w opisie,
/// Outlook w treści. Szukamy więc w kilku miejscach i bierzemy pierwszy
/// adres, który wygląda na pokój rozmowy, a nie na dowolny odsyłacz.
func meetingLink(_ text: String) -> String? {
    let rooms = ["meet.google.com", "zoom.us/j/", "teams.microsoft.com/l/meetup", "webex.com/meet"]
    for line in text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "<" || $0 == ">" }) {
        let candidate = String(line).trimmingCharacters(in: CharacterSet(charactersIn: "\"'()[],"))
        if rooms.contains(where: { candidate.contains($0) }) { return candidate }
    }
    return nil
}

/// Napis w cudzysłowie, z ucieczkami — bez sięgania po JSONSerialization
/// dla czterech pól.
func quoted(_ text: String) -> String {
    var out = "\""
    for character in text.unicodeScalars {
        switch character {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if character.value < 0x20 {
                out += String(format: "\\u%04x", character.value)
            } else {
                out.unicodeScalars.append(character)
            }
        }
    }
    return out + "\""
}

var args = Array(CommandLine.arguments.dropFirst())
while let flag = args.first {
    args.removeFirst()
    switch flag {
    case "--probe":
        mode = "probe"
    case "--stream":
        mode = "stream"
    case "--agenda":
        mode = "agenda"
    case "--hours":
        guard let value = args.first.flatMap(Double.init) else { die("--hours chce liczby.") }
        hours = value
        args.removeFirst()
    case "--seconds":
        guard let value = args.first.flatMap(Double.init) else { die("--seconds chce liczby.") }
        seconds = value
        args.removeFirst()
    case "--out":
        guard let value = args.first else { die("--out chce katalogu.") }
        outDir = URL(fileURLWithPath: value)
        args.removeFirst()
    case "--exclude":
        guard let value = args.first else { die("--exclude chce listy nazw po przecinku.") }
        excluded = value.split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
        args.removeFirst()
    default:
        die("nieznany argument: \(flag)")
    }
}

let finished = DispatchSemaphore(value: 0)
Task {
    do {
        if mode == "agenda" {
            await agenda(hours: hours)
        } else if mode == "stream" {
            try await stream(excluding: excluded)
        } else {
            try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
            try await probe(seconds: seconds, directory: outDir, excluding: excluded)
        }
    } catch {
        log("BŁĄD: \(error.localizedDescription)")
        finished.signal()
        exit(1)
    }
    finished.signal()
}
finished.wait()
