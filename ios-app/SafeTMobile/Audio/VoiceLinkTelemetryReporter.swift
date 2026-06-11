import Foundation
import os

/// Per-window inbound voice-link counters reported every ~30 s.
///
/// Mirrors the Android / web reporters so all three clients post the same
/// payload schema to `POST /v1/telemetry/voice-link`. Counters only — no audio,
/// no transcript, no PCM. The admin dashboard reads aggregates back so
/// dispatch can answer "is this unit having voice quality problems?" with data
/// instead of trusting an end-user report.
///
/// Lifecycle:
///   - `start(baseURL:tokenProvider:)` arms a Timer that rolls the in-progress
///     window into a queued snapshot every 30 s and POSTs the head.
///   - `stop()` invalidates the timer. Counters carry across `stop()` /
///     `start()` into the next window — no data lost across an app pause.
///
/// Buffering:
///   - Up to `maxBufferedWindows` (~2 minutes) of unsent windows in memory.
///   - On a failed POST the head is left at the front of the queue; the next
///     30-second tick retries it. When the cap is exceeded the OLDEST queued
///     window is dropped, not the newest — operators care about recent data
///     first.
///   - Idle windows (zero counters) are sent too so the dashboard can tell
///     "this unit is alive but quiet" apart from "this unit fell off the air".
///
/// Thread safety: counters are mutated from `VoiceTransport.dispatchInboundVoice`
/// (the main actor) and `InboundJitterBuffer.playoutLoop` (a dedicated thread).
/// All accesses go through `lock`; the snapshot path closes the in-flight
/// window under the same lock.
final class VoiceLinkTelemetryReporter {

    static let shared = VoiceLinkTelemetryReporter()

    private static let telemetryIntervalSeconds: TimeInterval = 30
    private static let maxBufferedWindows = 4
    private static let clientType = "ios"

    private let lock = NSLock()
    // Use the explicit class name (not `Self`) here: Swift rejects covariant
    // `Self` in a stored-property default initializer because the initializer
    // expression is evaluated before the type is fully formed.
    private var window = WindowCounters(openedAtMs: VoiceLinkTelemetryReporter.nowMs())
    private var queued: [QueuedWindow] = []
    private var timer: Timer?
    private var inFlight = false

    private var baseURL: URL?
    private var tokenProvider: () -> String = { "" }
    private var radioKeyProvider: () -> String = { "" }
    private var unitId: String?
    private var channel: String?

    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "voiceLinkTelemetry")
    private let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15
        cfg.timeoutIntervalForResource = 15
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    /// Sets the POST destination + auth providers. Safe to call repeatedly;
    /// only the latest values are used on the next POST.
    func configure(baseURL: URL, tokenProvider: @escaping () -> String, radioKeyProvider: @escaping () -> String) {
        lock.lock()
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.radioKeyProvider = radioKeyProvider
        lock.unlock()
    }

    /// Sets which (unit, channel) future reports are billed to. Calling with a
    /// new identity closes the in-progress window under the previous identity
    /// so counters accumulated on the prior channel are not credited to the
    /// new one.
    func setIdentity(unitId: String?, channel: String?) {
        lock.lock()
        let identityChanged = self.unitId != unitId || self.channel != channel
        if identityChanged, self.unitId != nil {
            closeAndQueueWindowLocked()
        }
        self.unitId = unitId
        self.channel = channel
        lock.unlock()
    }

    /// Arms the 30-second POST loop. Idempotent — a second `start` while
    /// already running is a no-op.
    func start() {
        lock.lock()
        if timer != nil {
            lock.unlock()
            return
        }
        // Timer must be created on a run loop. Use the main run loop because
        // VoiceTransport is `@MainActor` and most callers will already be on
        // the main thread when they call start().
        let t = Timer(timeInterval: Self.telemetryIntervalSeconds, repeats: true) { [weak self] _ in
            self?.tick()
        }
        timer = t
        lock.unlock()
        DispatchQueue.main.async {
            RunLoop.main.add(t, forMode: .common)
        }
    }

    func stop() {
        lock.lock()
        let t = timer
        timer = nil
        lock.unlock()
        // Timer.invalidate must run on the run loop the timer was added to;
        // we hop to main to match the add path above, otherwise the call
        // becomes a no-op and the timer fires once more before the loop
        // notices it's invalid.
        if let t {
            DispatchQueue.main.async {
                t.invalidate()
            }
        }
    }

    // MARK: - counter recording

    func recordFrameReceived(codec: String, bytes: Int) {
        lock.lock()
        window.framesReceived += 1
        window.bytesReceived += max(0, bytes)
        var entry = window.codecBreakdown[codec] ?? CodecCounters()
        entry.framesReceived += 1
        window.codecBreakdown[codec] = entry
        lock.unlock()
    }

    /// Uplink accounting — every app-level byte this handset puts on the voice
    /// socket (vocoded frames, clear PCM, recorder sideband) so the admin
    /// data-usage column reflects both directions.
    func recordBytesSent(_ bytes: Int) {
        lock.lock()
        window.bytesSent += max(0, bytes)
        lock.unlock()
    }

    func recordFrameDecoded(codec: String) {
        lock.lock()
        window.framesDecoded += 1
        var entry = window.codecBreakdown[codec] ?? CodecCounters()
        entry.framesDecoded += 1
        window.codecBreakdown[codec] = entry
        lock.unlock()
    }

    func recordDecodeFailure() {
        lock.lock()
        window.decodeFailures += 1
        lock.unlock()
    }

    func recordPlcSynthesized() {
        lock.lock()
        window.plcFramesSynthesized += 1
        lock.unlock()
    }

    func recordBufferUnderrun() {
        lock.lock()
        window.bufferUnderruns += 1
        lock.unlock()
    }

    func recordBufferDepth(_ frames: Int) {
        lock.lock()
        if frames > window.maxBufferDepthFrames {
            window.maxBufferDepthFrames = frames
        }
        lock.unlock()
    }

    func recordTalkSpurtStart() {
        lock.lock()
        window.talkSpurtsStarted += 1
        lock.unlock()
    }

    func recordTalkSpurtEnd() {
        lock.lock()
        window.talkSpurtsEnded += 1
        lock.unlock()
    }

    // MARK: - private

    private func tick() {
        lock.lock()
        guard unitId != nil else {
            // No identity yet — rotate the window so accumulated counters
            // don't backfill onto the first identity that arrives.
            window = WindowCounters(openedAtMs: Self.nowMs())
            lock.unlock()
            return
        }
        closeAndQueueWindowLocked()
        lock.unlock()
        flush()
    }

    private func closeAndQueueWindowLocked() {
        guard let u = unitId else { return }
        let closedAt = Self.nowMs()
        queued.append(QueuedWindow(unitId: u, channel: channel, counters: window, closedAtMs: closedAt))
        window = WindowCounters(openedAtMs: closedAt)
        // Drop the OLDEST queued window when the cap is exceeded — operators
        // care about recent data first; an hour-old summary is less
        // actionable than the current one.
        while queued.count > Self.maxBufferedWindows {
            queued.removeFirst()
        }
    }

    private func flush() {
        lock.lock()
        if inFlight {
            lock.unlock()
            return
        }
        inFlight = true
        lock.unlock()
        defer {
            lock.lock()
            inFlight = false
            lock.unlock()
        }
        while true {
            lock.lock()
            guard let head = queued.first, let url = baseURL else {
                lock.unlock()
                return
            }
            let token = tokenProvider().trimmingCharacters(in: .whitespacesAndNewlines)
            let radioKey = radioKeyProvider().trimmingCharacters(in: .whitespacesAndNewlines)
            lock.unlock()
            let ok = postSync(url: url, window: head, token: token, radioKey: radioKey)
            if !ok { return }
            lock.lock()
            if let first = queued.first, first.closedAtMs == head.closedAtMs && first.unitId == head.unitId {
                queued.removeFirst()
            }
            lock.unlock()
        }
    }

    private func postSync(url: URL, window: QueuedWindow, token: String, radioKey: String) -> Bool {
        var request = URLRequest(url: url.appendingPathComponent("/v1/telemetry/voice-link"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        } else if !radioKey.isEmpty {
            request.setValue(radioKey, forHTTPHeaderField: "X-Radio-Key")
        }
        guard let body = Self.buildReportBody(window) else { return true /* drop bad body */ }
        request.httpBody = body
        let sem = DispatchSemaphore(value: 0)
        var success = false
        var permanent = false
        let task = session.dataTask(with: request) { _, response, _ in
            defer { sem.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            // 2xx + 202 (DB-less soft-accept) drain the head; 5xx / network
            // errors retain it for retry; non-429 4xx is permanently broken
            // (bad payload, wrong auth) so drain to avoid burning retries.
            if (200..<300).contains(http.statusCode) {
                success = true
            } else if http.statusCode == 429 {
                success = false
            } else if (400..<500).contains(http.statusCode) {
                permanent = true
            }
        }
        task.resume()
        // Bounded wait — Timer fires every 30 s, so a stuck request can stall
        // at most one tick before we give up and let the next one try again.
        _ = sem.wait(timeout: .now() + .seconds(20))
        return success || permanent
    }

    // MARK: - shape (visible for tests)

    struct CodecCounters: Equatable {
        var framesReceived: Int = 0
        var framesDecoded: Int = 0
    }

    struct WindowCounters {
        let openedAtMs: Int64
        var framesReceived: Int = 0
        var framesDecoded: Int = 0
        var decodeFailures: Int = 0
        var plcFramesSynthesized: Int = 0
        var bufferUnderruns: Int = 0
        var maxBufferDepthFrames: Int = 0
        var talkSpurtsStarted: Int = 0
        var talkSpurtsEnded: Int = 0
        var bytesReceived: Int = 0
        /// Uplink bytes — voice frames + recorder sideband sent on the socket.
        var bytesSent: Int = 0
        var codecBreakdown: [String: CodecCounters] = [:]
    }

    struct QueuedWindow {
        let unitId: String
        let channel: String?
        let counters: WindowCounters
        let closedAtMs: Int64
    }

    /// Builds the JSON wire body. Pure function — exposed for tests.
    static func buildReportBody(_ w: QueuedWindow) -> Data? {
        var obj: [String: Any] = [
            "unitId": w.unitId,
            "clientType": Self.clientType,
            "counters": [
                "framesReceived": w.counters.framesReceived,
                "framesDecoded": w.counters.framesDecoded,
                "decodeFailures": w.counters.decodeFailures,
                "plcFramesSynthesized": w.counters.plcFramesSynthesized,
                "bufferUnderruns": w.counters.bufferUnderruns,
                "maxBufferDepthFrames": w.counters.maxBufferDepthFrames,
                "talkSpurtsStarted": w.counters.talkSpurtsStarted,
                "talkSpurtsEnded": w.counters.talkSpurtsEnded,
                "bytesReceived": w.counters.bytesReceived,
            "bytesSent": w.counters.bytesSent,
                "wallMsObservation": max(0, Int(w.closedAtMs - w.counters.openedAtMs)),
            ] as [String: Any],
            "clientTs": Self.isoFormat(ms: w.closedAtMs),
        ]
        if let channel = w.channel {
            obj["channel"] = channel
        }
        var codecBreakdown: [String: [String: Int]] = [:]
        for (codec, c) in w.counters.codecBreakdown {
            codecBreakdown[codec] = [
                "framesReceived": c.framesReceived,
                "framesDecoded": c.framesDecoded,
            ]
        }
        obj["codecBreakdown"] = codecBreakdown
        return try? JSONSerialization.data(withJSONObject: obj, options: [])
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000.0)
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func isoFormat(ms: Int64) -> String {
        Self.isoFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(ms) / 1000.0))
    }

    // Visible for tests
    func snapshotForTest() -> (queuedCount: Int, framesReceived: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (queued.count, window.framesReceived)
    }

    func resetForTest() {
        lock.lock()
        queued.removeAll()
        window = WindowCounters(openedAtMs: Self.nowMs())
        unitId = nil
        channel = nil
        lock.unlock()
    }
}
