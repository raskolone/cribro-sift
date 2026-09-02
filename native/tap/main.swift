// ════════════════════════════════════════════════════════════════════
//  cribro-tap — dźwięk spotkania w dwóch torach
//
//  Electron nie umie na macOS wziąć dźwięku systemu. Jego typy mówią to
//  wprost („loopback … currently only supported on Windows”), więc głos
//  rozmówców musi wejść drogą natywną i tylko po to jest ten program.
//
//  ── DWA TORY, DWIE NIEZALEŻNE DROGI CORE AUDIO ──
//
//  Bierze OBA tory przez Core Audio, ale KAŻDY WŁASNĄ DROGĄ:
//
//      system      Process Tap (CATapDescription) — cały dźwięk wychodzący
//                  z komputera, oprócz Cribro samego siebie. Nowe API,
//                  od macOS 14.4, zaprojektowane DOKŁADNIE pod ten
//                  przypadek: dźwięk systemu bez dotykania czegokolwiek
//                  związanego z ekranem.
//      mikrofon    zwykłe urządzenie wejściowe Core Audio — ta sama droga,
//                  którą każdy program na Macu czyta mikrofon, i tak samo
//                  prosta jak przed tą zmianą.
//
//  ── DLACZEGO NIE SCREENCAPTUREKIT (JUŻ NIE) ──
//
//  Wcześniej oba tory szły jednym strumieniem ScreenCaptureKit — bo to
//  jedyne API, które umiało złapać i dźwięk systemu, i mikrofon jednym
//  zegarem. Miało to jednak cenę: ScreenCaptureKit jest API DO NAGRYWANIA
//  EKRANU. Nawet zamówione z klatką 2×2 piksela raz na minutę — a to była
//  najtańsza rzecz, jaką dawało się zamówić — strumień i tak uruchamiał
//  całą maszynerię przechwytywania obrazu pod spodem (potwierdzone na
//  forum deweloperskim Apple: przy „tylko dźwięk” trzeba i tak przyjmować
//  klatki i je odrzucać). W trakcie spotkania, gdy i tak już GPU jest
//  zajęte samą rozmową wideo, to była druga warstwa tego samego rodzaju
//  obciążenia — i to ona dawała się we znaki jako spowolnienie całego
//  systemu.
//
//  Process Tap tej maszynerii w ogóle nie dotyka: żyje w warstwie Core
//  Audio HAL, tej samej, w której leży zwykły mikrofon — nie w warstwie
//  kompozytora ekranu. Stąd ta zmiana.
//
//  PRZY OKAZJI ZNIKA TEŻ INNE OGRANICZENIE. ScreenCaptureKit słyszał
//  wyłącznie aplikacje Z OKNEM — `say` i `afplay` nie wchodziły do toru
//  systemu wcale, bo filtr działał po oknach widocznych na ekranie.
//  Process Tap działa na poziomie routingu dźwięku, nie okien, więc łapie
//  WSZYSTKO, co gra — zmierzone na tej maszynie wprost: `say` wszedł do
//  toru czysto, bez okna, bez wyjątku w kodzie.
//
//  ── DWA NIEZALEŻNE ZEGARY, JEDEN WSPÓLNY PUNKT ZERO ──
//
//  Skoro tory idą dwiema osobnymi drogami, nie dzielą już jednego
//  strumienia — ale dzielą coś równie mocnego: Core Audio znaczy każdą
//  ramkę czasem hosta (`mach_absolute_time`), a to jest zegar SYSTEMOWY,
//  wspólny dla całej maszyny, nie strumienia. `Clock` niżej łapie jeden
//  wspólny punkt zerowy TUŻ PRZED uruchomieniem obu urządzeń — i to
//  wystarcza, żeby oba tory zgadzały się co do tego, kiedy jest zero,
//  bez potrzeby jednego wspólnego strumienia.
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
//  · ECHO NIE JEST KASOWANE — ani przez ScreenCaptureKit, ani przez
//    Process Tap: to właściwość mikrofonu i głośników, nie tego, którym
//    API się czyta dźwięk. Przy głośnikach głos drugiej strony wraca
//    mikrofonem na −27,6 dBFS, raptem 10 dB poniżej toru systemu.
//    Rozstrzyga to splot torów po stronie JavaScriptu, nie ten program.
// ════════════════════════════════════════════════════════════════════

import AppKit
import AudioToolbox
import AVFoundation
import CoreAudio
import EventKit
import Foundation

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
/// Przeliczać trzeba, bo tory przychodzą w różnych formatach: dźwięk
/// systemu (z tapa) i mikrofon mają zwykle różne częstotliwości próbkowania
/// i liczbę kanałów, a żadnej z nich program nie zamawia — bierze to,
/// co Core Audio akurat oddaje.
///
/// CZAS PRZYCHODZI JUŻ GOTOWY. Skąd się bierze — patrz `Clock` niżej:
/// to jedno wspólne miejsce liczy milisekundy dla obu torów naraz, więc
/// tor nie musi wiedzieć nic o zegarze, tylko o dźwięku.
final class Track {
    let lane: Lane
    private let drain: Drain
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?

    private(set) var peak: Float = 0        // najgłośniejsza próbka, 0…1
    private(set) var sumOfSquares: Double = 0
    private(set) var samples = 0

    /// Znacznik PIERWSZEJ ramki i koniec OSTATNIEJ — w milisekundach od
    /// wspólnego zera (patrz `Clock`). Sonda potrzebuje ich, żeby odróżnić
    /// trzy rzeczy, które w samej długości nagrania wyglądają identycznie:
    /// późniejszy start toru, ciszę w środku i rozjazd zegara.
    private(set) var firstMillis: Double?
    private(set) var lastMillis: Double = 0

    init(lane: Lane, drain: Drain) {
        self.lane = lane
        self.drain = drain
    }

    func append(_ bufferList: UnsafePointer<AudioBufferList>, format incoming: AVAudioFormat, millis: Double) {
        // Format potrafi się zmienić w locie — przepięcie słuchawek
        // w trakcie rozmowy jest zdarzeniem normalnym, nie awarią.
        if sourceFormat == nil || sourceFormat! != incoming {
            sourceFormat = incoming
            converter = AVAudioConverter(from: incoming, to: TARGET)
            log("· \(lane.label): wejście \(Int(incoming.sampleRate)) Hz, kanałów \(incoming.channelCount)")
        }
        guard let converter else { return }

        guard let source = AVAudioPCMBuffer(pcmFormat: incoming, bufferListNoCopy: bufferList),
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

        if firstMillis == nil { firstMillis = millis }
        lastMillis = millis + Double(out.frameLength) / SAMPLE_RATE * 1000

        drain.take(Data(bytes: channel, count: Int(out.frameLength) * 2), at: millis)
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

// ── Zegar ───────────────────────────────────────────────────────────

/// Wspólny punkt zerowy dla obu torów.
///
/// Core Audio znaczy każdą ramkę czasem hosta (`AudioTimeStamp.mHostTime`)
/// — to `mach_absolute_time()`, zegar SYSTEMOWY, jeden na całą maszynę,
/// niezależny od tego, przez które urządzenie przyszła ramka. Tory idą
/// dziś dwiema OSOBNYMI drogami Core Audio (tap i mikrofon, każdy własnym
/// urządzeniem) — ale skoro obie znaczą czas tym samym zegarem, wystarczy
/// złapać JEDEN wspólny początek, tuż przed uruchomieniem obu urządzeń,
/// żeby oba tory liczyły milisekundy od tej samej chwili.
final class Clock {
    private let numerator: Double
    private let denominator: Double
    private let originTicks: UInt64

    init() {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        numerator = Double(info.numer)
        denominator = Double(info.denom)
        originTicks = mach_absolute_time()
    }

    func millis(since hostTime: UInt64) -> Double {
        let deltaTicks = hostTime >= originTicks ? hostTime - originTicks : 0
        let nanos = Double(deltaTicks) * numerator / denominator
        return nanos / 1_000_000
    }
}

// ── Core Audio: pomocnicze odczyty ─────────────────────────────────

extension AudioObjectID {
    static let unset = AudioObjectID(kAudioObjectUnknown)
    var isSet: Bool { self != AudioObjectID.unset }
}

func propertyAddress(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

/// Przełożenie PID-u procesu na obiekt Core Audio.
///
/// CATapDescription wyklucza procesy PO TYM OBIEKCIE, nie po PID-zie —
/// to dwa różne światy identyfikatorów i nie da się ich pomylić bez błędu
/// w środku dnia. Bez tego przełożenia wykluczenie własnego dźwięku
/// milczącą awarią wpuszczałoby Cribro do własnego nagrania.
func processAudioObject(pid: pid_t) -> AudioObjectID? {
    var address = propertyAddress(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var object = AudioObjectID.unset
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var mutablePid = pid
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address,
        UInt32(MemoryLayout<pid_t>.size), &mutablePid, &size, &object)
    guard status == noErr, object.isSet else { return nil }
    return object
}

/// UID domyślnego wyjścia dźwięku — poddzięcie zegarowe urządzenia
/// zbiorczego, w którym mieszka tap (patrz komentarz przy openCapture).
func defaultOutputDeviceUID() -> String? {
    var address = propertyAddress(kAudioHardwarePropertyDefaultSystemOutputDevice)
    var deviceID = AudioObjectID.unset
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    guard status == noErr, deviceID.isSet else { return nil }

    var uidAddress = propertyAddress(kAudioDevicePropertyDeviceUID)
    var uid: CFString = "" as CFString
    var uidSize = UInt32(MemoryLayout<CFString>.stride)
    status = withUnsafeMutablePointer(to: &uid) { ptr in
        AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, ptr)
    }
    guard status == noErr else { return nil }
    return uid as String
}

/// Domyślne urządzenie wejściowe — mikrofon. `nil`, gdy w systemie nie ma
/// żadnego: to nie jest awaria, po prostu tor mikrofonu zostaje pusty.
func defaultInputDevice() -> AudioObjectID? {
    var address = propertyAddress(kAudioHardwarePropertyDefaultInputDevice)
    var deviceID = AudioObjectID.unset
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    guard status == noErr, deviceID.isSet else { return nil }
    return deviceID
}

/// Format ramek, jakie oddaje tap — inny niż format urządzenia, bo tap
/// nie jest urządzeniem fizycznym.
func tapStreamFormat(_ tapID: AudioObjectID) -> AudioStreamBasicDescription? {
    var address = propertyAddress(kAudioTapPropertyFormat)
    var description = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.stride)
    let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &description)
    return status == noErr ? description : nil
}

/// Natywny format WEJŚCIA urządzenia — tego samego rodzaju pytanie, co
/// przy tapie, tylko o inny obiekt i inny zakres własności.
func deviceInputFormat(_ deviceID: AudioObjectID) -> AudioStreamBasicDescription? {
    var address = propertyAddress(kAudioDevicePropertyStreamFormat, scope: kAudioObjectPropertyScopeInput)
    var description = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.stride)
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &description)
    return status == noErr ? description : nil
}

// ── Przechwytywanie ─────────────────────────────────────────────────

/// Wszystko, co trzeba zamknąć po skończonym nagraniu. Trzymane w jednym
/// miejscu, żeby `stop()` nie mogło zapomnieć o którymś z czterech
/// obiektów Core Audio, które ta funkcja zakłada.
final class Capture {
    fileprivate var tapID = AudioObjectID.unset
    fileprivate var aggregateDeviceID = AudioObjectID.unset
    fileprivate var aggregateProcID: AudioDeviceIOProcID?
    fileprivate var inputDeviceID: AudioObjectID?
    fileprivate var inputProcID: AudioDeviceIOProcID?

    /// Kolejność jest odwrotna do zakładania: najpierw to, co czyta
    /// dźwięk (żeby żaden IOProc nie odpalił się nad już skasowanym
    /// urządzeniem), potem samo urządzenie zbiorcze, na końcu tap.
    func stop() {
        if let inputDeviceID, let inputProcID {
            AudioDeviceStop(inputDeviceID, inputProcID)
            AudioDeviceDestroyIOProcID(inputDeviceID, inputProcID)
        }
        if aggregateDeviceID.isSet {
            AudioDeviceStop(aggregateDeviceID, aggregateProcID)
            if let aggregateProcID {
                AudioDeviceDestroyIOProcID(aggregateDeviceID, aggregateProcID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
        }
        if tapID.isSet {
            AudioHardwareDestroyProcessTap(tapID)
        }
    }
}

/// Uruchomienie obu torów.
///
/// TOR SYSTEMU idzie przez Process Tap, opakowany w PRYWATNE urządzenie
/// zbiorcze — samego tapa nie da się czytać wprost, Core Audio oddaje
/// dźwięk tylko z urządzeń, więc tap dostaje jedno na własność, z realnym
/// wyjściem systemu jako podrzędnikiem (potrzebnym urządzeniu zbiorczemu
/// do własnego zegara, nie do dźwięku — dźwięk w callbacku to wyłącznie
/// to, co złapał tap).
///
/// TOR MIKROFONU idzie wprost do urządzenia wejściowego — bez zbiorczego
/// opakowania, bo realne urządzenie go nie potrzebuje.
///
/// KOGO WYKLUCZAMY Z TORU SYSTEMU: siebie zawsze (ten proces, cribro-tap,
/// i tak nic nie gra — ale wykluczenie własnego PID-u jest tanie i pewne),
/// APLIKACJĘ CRIBRO PO NAZWIE (bo to ONA, nie ten program, odtwarza
/// potwierdzenia po dyktowaniu i odsłuch fragmentów zapisu — bez tego
/// własny dźwięk aplikacji wchodziłby do nagrania cudzej rozmowy) i to,
/// co skonfigurowano z zewnątrz (`--exclude`).
func openCapture(system: Track, microphone: Track, clock: Clock, excluding names: [String]) throws -> Capture {
    let capture = Capture()

    var excludedObjects: [AudioObjectID] = []
    if let mine = processAudioObject(pid: ProcessInfo.processInfo.processIdentifier) {
        excludedObjects.append(mine)
    }
    let mine = ["com.cribro.sift", "Cribro Sift", "Cribro"]
    let wanted = names + mine
    let running = NSWorkspace.shared.runningApplications
    let unwanted = running.filter { app in
        wanted.contains { name in
            (app.bundleIdentifier?.localizedCaseInsensitiveContains(name) ?? false)
                || (app.localizedName?.localizedCaseInsensitiveContains(name) ?? false)
        }
    }
    if !unwanted.isEmpty {
        log("· pomijam: " + unwanted.map { $0.localizedName ?? "?" }.joined(separator: ", "))
    }
    for app in unwanted {
        if let object = processAudioObject(pid: app.processIdentifier) {
            excludedObjects.append(object)
        }
    }

    let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: excludedObjects)
    tapDescription.uuid = UUID()
    tapDescription.name = "cribro-tap"
    tapDescription.muteBehavior = .unmuted

    var tapID = AudioObjectID.unset
    var status = AudioHardwareCreateProcessTap(tapDescription, &tapID)
    guard status == noErr else {
        die("""
        brak zgody „Nagrywanie dźwięku innych aplikacji” albo Core Audio odmówił (\(status)).
                Ustawienia systemowe → Prywatność i ochrona → Nagrywanie dźwięku innych aplikacji.
        """)
    }
    capture.tapID = tapID

    guard let outputUID = defaultOutputDeviceUID() else {
        die("system nie zgłosił domyślnego wyjścia dźwięku.")
    }

    let aggregateDescription: [String: Any] = [
        kAudioAggregateDeviceNameKey: "cribro-tap-system",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceMainSubDeviceKey: outputUID,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceIsStackedKey: false,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
        kAudioAggregateDeviceTapListKey: [[
            kAudioSubTapDriftCompensationKey: true,
            kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
        ]],
    ]
    var aggregateDeviceID = AudioObjectID.unset
    status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateDeviceID)
    guard status == noErr else {
        die("nie udało się złożyć urządzenia zbiorczego dla tap-a (\(status)).")
    }
    capture.aggregateDeviceID = aggregateDeviceID

    guard var systemDescription = tapStreamFormat(tapID),
          let systemFormat = AVAudioFormat(streamDescription: &systemDescription)
    else {
        die("tap nie oddał formatu dźwięku systemu.")
    }

    let queue = DispatchQueue(label: "com.cribro.tap.audio")

    var aggregateProcID: AudioDeviceIOProcID?
    status = AudioDeviceCreateIOProcIDWithBlock(&aggregateProcID, aggregateDeviceID, queue) {
        _, inInputData, inInputTime, _, _ in
        system.append(inInputData, format: systemFormat, millis: clock.millis(since: inInputTime.pointee.mHostTime))
    }
    guard status == noErr else { die("nie udało się podpiąć odbioru toru systemu (\(status)).") }
    capture.aggregateProcID = aggregateProcID

    status = AudioDeviceStart(aggregateDeviceID, aggregateProcID)
    guard status == noErr else { die("nie udało się uruchomić toru systemu (\(status)).") }

    /* Mikrofon jest drugorzędny wobec toru systemu: bez niego zapis
       rozmowy ma tylko połowę torów, ale bez systemu nie ma NIC. Brak
       mikrofonu (albo jego awaria) zostaje więc ostrzeżeniem, nie
       przerwaniem — dokładnie tak samo, jak dawny kod traktował brak
       macOS 15 przy mikrofonie w jednym strumieniu. */
    if let inputDeviceID = defaultInputDevice(),
       var micDescription = deviceInputFormat(inputDeviceID),
       let micFormat = AVAudioFormat(streamDescription: &micDescription)
    {
        var inputProcID: AudioDeviceIOProcID?
        let micStatus = AudioDeviceCreateIOProcIDWithBlock(&inputProcID, inputDeviceID, queue) {
            _, inInputData, inInputTime, _, _ in
            microphone.append(
                inInputData, format: micFormat, millis: clock.millis(since: inInputTime.pointee.mHostTime))
        }
        if micStatus == noErr, let inputProcID, AudioDeviceStart(inputDeviceID, inputProcID) == noErr {
            capture.inputDeviceID = inputDeviceID
            capture.inputProcID = inputProcID
        } else {
            log("UWAGA: mikrofon nie ruszył (\(micStatus)) — zostaje tylko tor systemu.")
        }
    } else {
        log("UWAGA: brak mikrofonu albo jego formatu — zostaje tylko tor systemu.")
    }

    return capture
}

// ── Tryb pracy ──────────────────────────────────────────────────────

func stream(excluding names: [String]) async throws {
    let clock = Clock()
    let system = Track(lane: .system, drain: PipeDrain(lane: .system))
    let microphone = Track(lane: .microphone, drain: PipeDrain(lane: .microphone))

    let capture = try openCapture(system: system, microphone: microphone, clock: clock, excluding: names)
    log("· gotowe")

    /* Koniec nagrywania to zamknięcie standardowego WEJŚCIA przez proces
       główny. Sygnałów nie używamy: kill kończy program w połowie ramki,
       a wtedy ostatni odcinek dźwięku ginie razem z tym, co w nim padło. */
    await withCheckedContinuation { (waiting: CheckedContinuation<Void, Never>) in
        // Czytanie wejścia jest blokujące, więc idzie na własny wątek.
        // Semafor w funkcji asynchronicznej zająłby wątek z puli zadań
        // i zatkał tę samą pulę, z której korzysta Core Audio.
        DispatchQueue.global().async {
            while let line = readLine(strippingNewline: true) {
                if line == "stop" { break }
            }
            waiting.resume()
        }
    }

    capture.stop()
    system.close()
    microphone.close()
    log("· koniec")
}

// ── Tryb pomiaru ────────────────────────────────────────────────────

func probe(seconds: Double, directory: URL, excluding names: [String]) async throws {
    log("Cribro tap — sonda")
    log("")

    let clock = Clock()
    /* Ta sama chwila co zero zegara — `Clock` bierze swój punkt odniesienia
       we własnym `init`, linijkę wyżej. Różnica między jednym a drugim to
       mikrosekundy, a potrzebna jest, żeby dało się porównać znaczniki
       ramek z czasem, który naprawdę upłynął. */
    let startedAt = Date()
    let systemDrain = try WavDrain(url: directory.appendingPathComponent("tor-b-system.wav"))
    let micDrain = try WavDrain(url: directory.appendingPathComponent("tor-a-mikrofon.wav"))
    let system = Track(lane: .system, drain: systemDrain)
    let microphone = Track(lane: .microphone, drain: micDrain)

    let capture = try openCapture(system: system, microphone: microphone, clock: clock, excluding: names)
    log("Nagrywam \(Int(seconds)) s. Mów i puść dźwięk z drugiej strony.")
    log("")

    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    capture.stop()
    let elapsed = Date().timeIntervalSince(startedAt)
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
    /* ══ ZEGAR ══

       Poprzednia wersja rozstrzygała to porównaniem DŁUGOŚCI obu torów
       (`abs(microphone.seconds - system.seconds)`) i przy różnicy powyżej
       pół sekundy ogłaszała, że tory nie mają wspólnego zegara. Ogłaszała
       to niemal zawsze — i niemal zawsze niesłusznie, bo długości muszą
       się różnić z dwóch całkiem zdrowych powodów:

         · PROCESS TAP NIE WYSYŁA NIC, KIEDY NIC NIE GRA. Cisza w torze
           systemu to zero ramek, a nie ramki wypełnione zerami. Zmierzone
           wprost: piętnaście sekund przy niegrającym komputerze to
           dokładnie zero ramek toru systemu — czyli piętnaście sekund
           różnicy w długości i ani milisekunda rozjazdu.
         · TOR SYSTEMU WSTAJE WOLNIEJ niż mikrofon, bo urządzenie zbiorcze
           trzeba najpierw złożyć. Zmierzone tutaj: mikrofon w ~170 ms,
           tor systemu w ~970 ms.

       Zegar sprawdza się więc inaczej, po znacznikach ramek, nie po
       długości. Cisza potrafi tor tylko SKRÓCIĆ — nigdy wydłużyć — więc
       nadmiar dźwięku ponad okno własnych znaczników toru jest jedyną
       rzeczą, której cisza wytłumaczyć nie umie i jest prawdziwym
       rozjazdem. Do tego żaden tor nie ma prawa mieć ramek z przyszłości,
       czyli za czasem ściennym całego nagrania.

       CZEGO TA SONDA NIE ROZSTRZYGNIE: stałego przesunięcia między torami.
       Gdyby któryś tor liczył od własnego zera, a nie od wspólnego, jego
       okno znaczników byłoby TAKIE SAMO, tylko przesunięte — a stałego
       przesunięcia nie da się od środka odróżnić od zwykłego opóźnienia
       startu. Rozstrzygnąłby to dopiero znany dźwięk puszczony naraz
       w oba tory. Tu poprzestajemy na tym, co da się zmierzyć uczciwie. */
    log("")
    log("── zegar ──")
    log(String(format: "nagranie trwało %.2f s (czas ścienny)", elapsed))

    var clockIsSound = true
    for track in [microphone, system] {
        guard let first = track.firstMillis else {
            log("\(track.lane.label): ani jednej ramki — nie ma czego sprawdzać")
            continue
        }
        let window = (track.lastMillis - first) / 1000   // okno własnych znaczników
        let audio = track.seconds                        // ile dźwięku naprawdę przyszło
        let silence = max(0, window - audio)             // dziury: cisza, nie awaria
        let drift = max(0, audio - window)               // nadmiar: tego cisza nie tłumaczy
        log(String(
            format: "%@  ramki %5.2f → %6.2f s   dźwięku %6.2f s   ciszy %5.2f s   rozjazd %+.3f s",
            track.lane.label.padding(toLength: 18, withPad: " ", startingAt: 0),
            first / 1000, track.lastMillis / 1000, audio, silence, drift
        ))
        if drift > 0.25 { clockIsSound = false }
        if track.lastMillis / 1000 > elapsed + 0.25 { clockIsSound = false }
    }

    if clockIsSound {
        log("  ↑ nic nie wyprzedza czasu ściennego i nic nie nadrabia ponad własne")
        log("    okno znaczników — wspólny zegar trzyma")
    } else {
        log("  ↑ tor nadrabia dźwięk ponad własne okno znaczników albo ma ramki")
        log("    z przyszłości — TO jest rozjazd zegara, nie cisza")
    }

    /* Różnica pierwszych ramek to osobna rzecz i nie jest usterką. Nie
       nazywamy jej jednak „opóźnieniem startu", bo z tego miejsca NIE DA
       SIĘ powiedzieć, czy urządzenie wstawało dłużej, czy po prostu przez
       pierwsze sekundy nic nie grało — Process Tap milczy w obu wypadkach
       tak samo. Mikrofon takiej dwuznaczności nie ma: szumi zawsze, więc
       jego pierwsza ramka to naprawdę moment startu urządzenia.

       Cokolwiek z tych dwóch, splot torów po stronie JavaScriptu dopisuje
       tę różnicę ciszą, zanim realne próbki pójdą dalej (GAP_TOLERANCE_MS
       w src/main/tap.js) — i to ona odpowiada za większość różnicy
       w długościach plików WAV. */
    if let micFirst = microphone.firstMillis, let sysFirst = system.firstMillis {
        /* Znak ma znaczenie i bywa ujemny: urządzenie zbiorcze raz wstaje
           wolniej od mikrofonu, a raz jest już rozgrzane z poprzedniego
           nagrania i rusza pierwsze. Zmierzone tu oba przypadki — 0,97 s
           po mikrofonie na zimno, 0,06 s przed nim na ciepło. */
        let gap = (sysFirst - micFirst) / 1000
        if abs(gap) < 0.05 {
            log("  · oba tory ruszyły w tej samej chwili")
        } else {
            log(String(
                format: "  · pierwsza ramka toru systemu o %.2f s %@ niż mikrofonu —",
                abs(gap), gap > 0 ? "PÓŹNIEJ" : "WCZEŚNIEJ"
            ))
            log("    albo urządzenie wstawało inaczej, albo tyle trwała cisza na początku;")
            log("    tak czy tak splot torów łata to ciszą (src/main/tap.js)")
        }
    }

    /* Pliki WAV zostają BEZ tej łaty — WavDrain zapisuje same próbki, bez
       znaczników (patrz `take` tam wyżej). Dwa pliki z sondy wolno więc
       porównywać co do treści, ale nie co do momentu: od tego jest tor
       produkcyjny, który znaczniki niesie. */
    log("")
    log("Pliki: \(directory.path)")
    log("  (bez łaty ciszą — pliki sondy są surowe, patrz WavDrain)")
}

// ── Wejście ─────────────────────────────────────────────────────────

var mode = "probe"
var seconds = 20.0
var outDir = FileManager.default.temporaryDirectory.appendingPathComponent("cribro-tap")
var excluded: [String] = []
/// Jak daleko w przód patrzymy w kalendarzu, w godzinach.
var hours = 12.0
var back = 1.0

// ── Kalendarz ───────────────────────────────────────────────────────

/// Nadchodzące spotkania — jedną linią JSON na standardowe wyjście.
///
/// Wypisujemy TYLKO to, co potrzebne do rozstrzygnięcia „czy to spotkanie
/// i czy już się zaczyna": identyfikator, tytuł, godziny, liczbę zaproszonych
/// i adres rozmowy, jeśli jest. Reszty kalendarza — notatek, załączników,
/// nazwisk — nie czytamy i nie wynosimy z tego programu.
func agenda(hours: Double, back: Double) async {
    let store = EKEventStore()

    /* ══ „NIE PYTANO" TO CO INNEGO NIŻ „ODMÓWIONO" ══

       Wcześniej ten program mówił tylko „granted" albo „denied" — i przez
       to okno aplikacji pokazywało jedno zdanie na dwie zupełnie różne
       sytuacje. „Odmówiono" znaczy: idź do Ustawień systemowych i przestaw
       przełącznik. „Nie pytano" znaczy: kliknij, a system zapyta. Kto
       dostawał tę pierwszą radę na tę drugą sytuację, szukał w Ustawieniach
       przełącznika, którego tam jeszcze nie było — bo wpis powstaje dopiero
       po pierwszym pytaniu.

       Stan czytamy PRZED prośbą i oddajemy go osobno. Prosimy wyłącznie
       wtedy, gdy jest o co prosić: wołanie requestFullAccessToEvents przy
       stanie „denied" nie pokazuje niczego i wraca fałszem, czyli robi
       hałas bez skutku. */
    let status = EKEventStore.authorizationStatus(for: .event)

    var granted: Bool
    if #available(macOS 14.0, *) {
        granted = status == .fullAccess
    } else {
        granted = status == .authorized
    }

    var state: String
    switch status {
    case .restricted: state = "restricted"   // zabroniona przez zasady urządzenia
    case .denied: state = "denied"
    default: state = granted ? "granted" : "notDetermined"
    }
    if #available(macOS 14.0, *), status == .writeOnly {
        // Zgoda „tylko do zapisu" nie pozwala CZYTAĆ wpisów — dla nas to
        // jest brak zgody, tylko o innej nazwie i z innym przełącznikiem.
        state = "writeOnly"
    }

    if !granted && state == "notDetermined" {
        if #available(macOS 14.0, *) {
            granted = (try? await store.requestFullAccessToEvents()) ?? false
        } else {
            granted = await withCheckedContinuation { go in
                store.requestAccess(to: .event) { ok, _ in go.resume(returning: ok) }
            }
        }
        /* Po pytaniu stan jest już rozstrzygnięty — ale jeśli system
           odpowiedział odmową BEZ pokazania okna (tak dzieje się, gdy
           program nie niesie opisu zgody, patrz build/tap-info.plist),
           zostaje „notDetermined" i aplikacja powie o tym wprost, zamiast
           odsyłać do przełącznika, którego nie ma. */
        let after = EKEventStore.authorizationStatus(for: .event)
        if granted {
            state = "granted"
        } else if after == .denied {
            state = "denied"
        }
    }

    guard granted else {
        // Brak zgody nie jest awarią: aplikacja ma wtedy po prostu nie
        // pokazywać kalendarza. Mówimy to danymi, a nie kodem wyjścia.
        print("{\"access\":\"" + state + "\",\"events\":[]}")
        return
    }

    let now = Date()
    let until = now.addingTimeInterval(hours * 3600)
    /// Zaczynamy godzinę wstecz, bo spotkanie, które właśnie trwa, jest
    /// najważniejsze ze wszystkich — a zaczęło się przed „teraz".
    ///
    /// Poranne podsumowanie sięga dalej (--back), bo pyta o CAŁY DZIEŃ:
    /// przy pierwszym zalogowaniu o czternastej poranek bez porannych
    /// wpisów opisywałby dzień, którego już nie ma.
    let from = now.addingTimeInterval(-max(1, back) * 3600)
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
        /* Imiona zaproszonych. Wychodzą z tego programu po to, żeby zapis
           rozmowy mówił „Ania", a nie „Rozmówcy" — i nie idą nigdzie dalej
           niż do polecenia dla modelu, który i tak dostaje całą rozmowę. */
        var names = (event.attendees ?? [])
            .compactMap { $0.name }
            .filter { !$0.isEmpty && !$0.contains("@") }
        if let mine = event.organizer?.name, !names.contains(mine) { names.insert(mine, at: 0) }
        row.append("\"people\":[" + names.map(quoted).joined(separator: ",") + "]")

        /* Adresy zaproszonych — OSOBNO OD IMION i do jednej jedynej rzeczy:
           poranne podsumowanie porównuje po nich nadawcę maila z listą osób,
           z którymi mam się dziś widzieć („Magdalena pisze, a o czternastej
           jest z nią spotkanie"). Po imieniu tego zrobić się nie da: nazwa
           nadawcy w Gmailu i nazwa uczestnika w kalendarzu to prawie nigdy
           nie jest ten sam napis.

           Porównanie dzieje się w całości na tym komputerze (patrz
           needsAttention w main/briefing.js) i te adresy NIE IDĄ do modelu
           ani nigdzie indziej — w odróżnieniu od imion, które jadą do
           polecenia po to, żeby nazwać mówiących. */
        let mails: [String] = (event.attendees ?? []).compactMap { person in
            let text = person.url.absoluteString
            guard text.lowercased().hasPrefix("mailto:") else { return nil }
            let address = String(text.dropFirst("mailto:".count)).lowercased()
            return address.isEmpty ? nil : address
        }
        row.append("\"emails\":[" + mails.map(quoted).joined(separator: ",") + "]")
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
    case "--back":
        guard let value = args.first.flatMap(Double.init) else { die("--back chce liczby.") }
        back = value
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
            await agenda(hours: hours, back: back)
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
