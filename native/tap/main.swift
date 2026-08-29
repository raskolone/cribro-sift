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
//  wtedy ten sam zegar. Gdyby mikrofon szedł osobno (przez getUserMedia
//  w oknie Electrona), trzeba by je potem zestrajać po znacznikach czasu
//  — a rozjazd dwóch zegarów widać w transkrypcji jako przeplot zdań,
//  które padły w odwrotnej kolejności.
//
//  Podział na osoby wynika stąd za darmo: nie zgaduje go model, tylko
//  okablowanie. Twój głos wchodzi mikrofonem, ich głos wychodzi
//  z głośników. To są fizycznie osobne strumienie.
//
//  ── TRYB SONDY (--probe) ──
//
//  Etap E0 planu. Nagrywa zadaną liczbę sekund do dwóch plików WAV
//  i mówi, co w nich siedzi: szczyt i głośność skuteczna toru po torze.
//  Jest to jedyny sposób, żeby odpowiedzieć na pytanie, którego nie da
//  się rozstrzygnąć zza biurka:
//
//      ILE CUDZEGO GŁOSU WCHODZI W TOR MIKROFONU?
//
//  ScreenCaptureKit nie kasuje echa. Przy słuchawkach to nie ma
//  znaczenia. Przy głośnikach ich głos wraca twoim mikrofonem i zostaje
//  powiedziany drugi raz — a wtedy transkrypcja rozmowy jest podwójna.
//  Sonda mierzy to zamiast zgadywać: puszcza się ją raz przy głośnikach
//  i raz przy słuchawkach, i porównuje głośność toru A w chwilach, gdy
//  mówi wyłącznie druga strona.
// ════════════════════════════════════════════════════════════════════

import AVFoundation
import CoreMedia
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

/// Wypisanie na stderr — stdout zostaje dla danych, gdy program przejdzie
/// z sondy do pracy w potoku z procesem głównym Electrona.
func log(_ text: String) {
    FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
}

func die(_ text: String) -> Never {
    log("BŁĄD: " + text)
    exit(1)
}

// ── Zapis WAV ───────────────────────────────────────────────────────

/// Nagłówek pisze się na końcu, bo dopiero wtedy znana jest długość.
/// Stąd 44 bajty miejsca na starcie i powrót na początek przy zamknięciu.
final class WavWriter {
    private let handle: FileHandle
    private let url: URL
    private var payload = 0

    init(url: URL) throws {
        self.url = url
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
        handle.write(Data(count: 44))
    }

    func write(_ data: Data) {
        guard !data.isEmpty else { return }
        handle.write(data)
        payload += data.count
    }

    /// Sekundy dźwięku, które faktycznie wylądowały w pliku.
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
    let name: String
    private let writer: WavWriter
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?

    private(set) var peak: Float = 0        // najgłośniejsza próbka, 0…1
    private(set) var sumOfSquares: Double = 0
    private(set) var samples = 0

    init(name: String, url: URL) throws {
        self.name = name
        writer = try WavWriter(url: url)
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
            log("· \(name): wejście \(Int(incoming.sampleRate)) Hz, kanałów \(incoming.channelCount)")
        }
        guard let converter else { return }

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
                log("· \(name): przeliczenie odmówiło — \(problem.localizedDescription)")
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

            writer.write(Data(bytes: channel, count: Int(out.frameLength) * 2))
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
    var seconds: Double { writer.seconds }

    func close() { writer.close() }
}

// ── Odbiór ze strumienia ────────────────────────────────────────────

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate {
    let system: Track      // tor B — to mówią oni
    let microphone: Track  // tor A — to mówisz ty
    private var failure: Error?

    init(system: Track, microphone: Track) {
        self.system = system
        self.microphone = microphone
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard buffer.isValid else { return }
        switch type {
        case .audio:
            system.append(buffer)
        default:
            // .microphone istnieje dopiero od macOS 15, więc nie da się
            // wypisać go w `case` bez dostępności. Ekran i tak nie
            // dochodzi — nie zamówiliśmy jego wyjścia.
            if #available(macOS 15.0, *), type == .microphone {
                microphone.append(buffer)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        failure = error
        log("· strumień się zatrzymał: \(error.localizedDescription)")
    }
}

// ── Sonda ───────────────────────────────────────────────────────────

func probe(seconds: Double, directory: URL) async throws {
    log("Cribro tap — sonda E0")
    log("")

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
                Uruchomiony z terminala program prosi o zgodę DLA TERMINALA,
                nie dla Cribro Sift — to jest właśnie ta różnica, którą E0 ma
                pokazać przed etapem E1.
        """)
    }

    guard let display = content.displays.first else { die("system nie zgłosił żadnego ekranu.") }

    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    // Wycina z nagrania sam program. Nie wycina Spotify — dźwięk systemu
    // to CAŁY dźwięk systemu i o tym trzeba pamiętać przy transkrypcji.
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

    let system = try Track(name: "tor B (system)", url: directory.appendingPathComponent("tor-b-system.wav"))
    let microphone = try Track(name: "tor A (mikrofon)", url: directory.appendingPathComponent("tor-a-mikrofon.wav"))
    let sink = Sink(system: system, microphone: microphone)

    let stream = SCStream(filter: filter, configuration: config, delegate: sink)
    let queue = DispatchQueue(label: "com.cribro.tap.audio")

    try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: queue)
    if #available(macOS 15.0, *), micWanted {
        try stream.addStreamOutput(sink, type: .microphone, sampleHandlerQueue: queue)
    }

    try await stream.startCapture()
    log("Nagrywam \(Int(seconds)) s. Mów i puść dźwięk z drugiej strony.")
    log("")

    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    try await stream.stopCapture()

    system.close()
    microphone.close()

    // ── Raport ──
    //
    // To jest właściwy wynik E0. Nie pliki — liczby.
    log("")
    log("── co przyszło ──")
    for track in [microphone, system] {
        let line = String(
            format: "%@  %6.2f s   szczyt %7.1f dBFS   głośność %7.1f dBFS",
            track.name.padding(toLength: 18, withPad: " ", startingAt: 0),
            track.seconds, track.peakDb, track.rmsDb
        )
        log(line)
    }
    log("")
    let drift = abs(microphone.seconds - system.seconds)
    log(String(format: "rozjazd torów: %.3f s", drift))
    if drift > 0.5 {
        log("  ↑ powyżej pół sekundy — tory NIE mają wspólnego zegara, przemyśl E2")
    } else {
        log("  ↑ poniżej pół sekundy — wspólny zegar trzyma")
    }
    log("")
    log("Pliki: \(directory.path)")
    log("")
    log("CO Z TYM ZROBIĆ: puść sondę dwa razy — raz przy głośnikach,")
    log("raz przy słuchawkach — mówiąc w obu przebiegach WYŁĄCZNIE drugą")
    log("stroną (film, druga osoba, cokolwiek). Tor A ma wtedy milczeć.")
    log("Jeśli przy głośnikach jego głośność podskakuje do poziomu toru B,")
    log("to jest przesłuch i mikrofon trzeba brać z getUserMedia, nie stąd.")
}

// ── Wejście ─────────────────────────────────────────────────────────

var seconds = 20.0
var outDir = FileManager.default.temporaryDirectory.appendingPathComponent("cribro-tap")

var args = Array(CommandLine.arguments.dropFirst())
while let flag = args.first {
    args.removeFirst()
    switch flag {
    case "--probe":
        break
    case "--seconds":
        guard let value = args.first.flatMap(Double.init) else { die("--seconds chce liczby.") }
        seconds = value
        args.removeFirst()
    case "--out":
        guard let value = args.first else { die("--out chce katalogu.") }
        outDir = URL(fileURLWithPath: value)
        args.removeFirst()
    default:
        die("nieznany argument: \(flag)")
    }
}

try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let finished = DispatchSemaphore(value: 0)
Task {
    do {
        try await probe(seconds: seconds, directory: outDir)
    } catch {
        log("BŁĄD: \(error.localizedDescription)")
        finished.signal()
        exit(1)
    }
    finished.signal()
}
finished.wait()
