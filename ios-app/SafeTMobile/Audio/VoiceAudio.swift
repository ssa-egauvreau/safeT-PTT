import AVFoundation
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Single AVAudioEngine that captures the mic into 320-byte PCM16 frames
/// (20 ms at 16 kHz mono — the protocol the server's voice relay broadcasts)
/// and plays incoming PCM16 frames back through the speaker.
///
/// The engine is started once when the radio comes online and runs for the
/// lifetime of the session. Mic capture is gated by `startCapture()` /
/// `stopCapture()`, called when PTT is pressed/released.
final class VoiceAudio {
    /// 320 bytes = 160 samples × 2 bytes/sample = 20 ms at 16 kHz mono.
    static let frameBytes = 320
    static let sampleRate: Double = 16_000

    /// Called with each fully assembled 320-byte capture frame plus the capture
    /// session id that produced it. Configure before calling `startCapture()`.
    var onCapturedFrame: ((Data, UInt64) -> Void)?

    /// Called when incoming PCM16 frames are enqueued for playback.
    var onEnqueuedIncoming: ((Data) -> Void)?

    /// Gain applied to the AVAudioPlayerNode for incoming voice audio (0.0–1.0).
    var playbackVolume: Float {
        get { player.volume }
        set { player.volume = newValue }
    }


    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// Separate node for replay so a complete clip plays once, straight to the
    /// speaker, WITHOUT going through the jitter buffer (whose PLC would re-emit
    /// the whole clip faded a few times — heard as the replay "looping").
    private let replayPlayer = AVAudioPlayerNode()

    // MARK: - scan priority / hold (mirrors Android InboundVoicePlayer)

    /// Guards the scan-arbitration state below. The enqueue path now runs off the
    /// main actor on per-channel decode queues (see InboundVoiceDecoder), so the
    /// home queue and each scan queue can call enqueue* concurrently.
    private let holdLock = NSLock()
    /// While the home channel is active, scan audio is suppressed until this time.
    private var mainHoldUntil: TimeInterval = 0
    /// The one scan channel currently allowed through, and until when.
    private var activeScanChannel: String?
    private var scanHoldUntil: TimeInterval = 0
    private let mainHoldSeconds: TimeInterval = 0.4
    private let scanHoldSeconds: TimeInterval = 0.4

    /// Format used everywhere downstream of the mic tap and upstream of the
    /// player: float32 mono 16 kHz, non-interleaved (the player's native shape).
    // Reference the concrete class name rather than `Self` — Swift forbids
    // `Self` in stored property initializers (even on a `final` class), so
    // `Self.sampleRate` fails to compile under Xcode 16.
    private let processingFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: VoiceAudio.sampleRate,
        channels: 1,
        interleaved: false
    )!

    private var captureConverter: AVAudioConverter?
    private var captureBuffer = Data()
    private var capturing = false
    private var captureSessionId: UInt64 = 0

    /// Software jitter buffer + PLC between decoded PCM and the player. The
    /// relay forwards frames the instant they arrive over WebSocket (no
    /// smoothing on either side) — without this buffer, network jitter
    /// drains the player and produces hard cutouts. See InboundJitterBuffer
    /// for the algorithm.
    private lazy var jitterBuffer: InboundJitterBuffer =
        InboundJitterBuffer(player: player, playerFormat: processingFormat)

    init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: processingFormat)
        engine.attach(replayPlayer)
        engine.connect(replayPlayer, to: engine.mainMixerNode, format: processingFormat)
        observeAppLifecycle()
    }

    deinit {
        #if canImport(UIKit)
        for token in lifecycleObservers { NotificationCenter.default.removeObserver(token) }
        #endif
        jitterBuffer.release()
    }

    /// Deepen the inbound jitter buffer while the app is backgrounded (screen
    /// off): iOS throttles the main-actor decode path then, so frames arrive
    /// late and bunched — a deeper cushion absorbs that instead of underrunning
    /// into PLC (robotic) and silence (cutout).
    #if canImport(UIKit)
    private var lifecycleObservers: [NSObjectProtocol] = []
    private func observeAppLifecycle() {
        let center = NotificationCenter.default
        lifecycleObservers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            self?.jitterBuffer.setBackgrounded(true)
        })
        lifecycleObservers.append(center.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
        ) { [weak self] _ in
            self?.jitterBuffer.setBackgrounded(false)
        })
    }
    #else
    private func observeAppLifecycle() {}
    #endif

    /// Activates the audio session and starts the engine. Must be called after
    /// `AudioSessionManager.requestRecordPermission()` returns true.
    func start() throws {
        try AudioSessionManager.configureForVoice()
        // Touch the input node BEFORE starting the engine so the engine wires
        // the mic route up front. Without this, the first access happens lazily
        // inside startCapture() — and on a running playback-only engine, the
        // input node's `outputFormat(forBus: 0)` can return a 0-channel /
        // 0-sample-rate format. Installing a tap with that format crashes
        // AVAudioEngine with `IsFormatSampleRateAndChannelCountValid(format)`.
        _ = engine.inputNode
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        if !player.isPlaying {
            player.play()
        }
        if !replayPlayer.isPlaying {
            replayPlayer.play()
        }
    }

    func stop() {
        stopCapture()
        jitterBuffer.stop()
        if player.isPlaying { player.stop() }
        if replayPlayer.isPlaying { replayPlayer.stop() }
        if engine.isRunning { engine.stop() }
        AudioSessionManager.deactivate()
    }

    // MARK: - capture (mic → callback)

    @discardableResult
    func startCapture() -> UInt64? {
        guard !capturing else { return captureSessionId }

        let inputNode = engine.inputNode
        let nativeFormat = inputNode.outputFormat(forBus: 0)
        // Defensive guard: if the audio session lost record permission, the input
        // route changed mid-flight, or the engine started before the input was
        // wired, `outputFormat` can return a 0-channel / 0 Hz format. Installing
        // a tap with that crashes AVAudioEngine. Bail cleanly so PTT just no-ops
        // instead of taking the app down.
        guard nativeFormat.channelCount > 0, nativeFormat.sampleRate > 0 else { return nil }

        let pcm16Mono16k = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.sampleRate,
            channels: 1,
            interleaved: true
        )!
        guard let converter = AVAudioConverter(from: nativeFormat, to: pcm16Mono16k) else { return nil }
        captureConverter = converter
        captureBuffer.removeAll(keepingCapacity: true)
        captureSessionId &+= 1
        let sessionId = captureSessionId

        // Install the tap inside a do/catch via @objc exception bridging would be
        // nicer, but Swift can't catch ObjC exceptions. The format guards above
        // cover the known-bad cases; if AVAudioEngine still throws here, the bug
        // is in the engine state and we want the crash report.
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: nativeFormat) { [weak self] buffer, _ in
            self?.handle(captureBuffer: buffer, target: pcm16Mono16k, sessionId: sessionId)
        }
        // Mark capturing AFTER a successful tap install so a failure path doesn't
        // leave stopCapture() trying to remove a tap that was never added.
        capturing = true
        return sessionId
    }

    func stopCapture() {
        guard capturing else { return }
        capturing = false
        engine.inputNode.removeTap(onBus: 0)
        captureBuffer.removeAll(keepingCapacity: false)
        captureConverter = nil
    }

    private func handle(captureBuffer source: AVAudioPCMBuffer, target: AVAudioFormat, sessionId: UInt64) {
        guard let converter = captureConverter else { return }
        // Convert at the input/output sample-rate ratio plus a small headroom.
        let ratio = target.sampleRate / source.format.sampleRate
        let frameCapacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1024
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: frameCapacity) else { return }

        var supplied = false
        var error: NSError?
        let status = converter.convert(to: converted, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return source
        }
        guard status != .error, let int16 = converted.int16ChannelData, converted.frameLength > 0 else { return }

        let frameCount = Int(converted.frameLength)
        let byteCount = frameCount * MemoryLayout<Int16>.size
        int16[0].withMemoryRebound(to: UInt8.self, capacity: byteCount) { bytes in
            captureBuffer.append(bytes, count: byteCount)
        }
        flushFramesIfReady(sessionId: sessionId)
    }

    private func flushFramesIfReady(sessionId: UInt64) {
        while captureBuffer.count >= Self.frameBytes {
            let frame = captureBuffer.prefix(Self.frameBytes)
            captureBuffer.removeFirst(Self.frameBytes)
            onCapturedFrame?(Data(frame), sessionId)
        }
    }

    // MARK: - playback (incoming PCM → speaker)

    /// Schedules a PCM16 (mono, 16 kHz, little-endian) buffer for playback.
    /// Hands off to the software jitter buffer + PLC rather than scheduling
    /// directly to AVAudioPlayerNode, so bursty inbound arrival (the relay
    /// forwards frames the instant they arrive over WebSocket, with no
    /// smoothing) is paced out at a steady cadence and isolated network
    /// stalls produce a short fade-to-silence via PLC instead of a hard cutout.
    func enqueueIncoming(_ pcm16: Data) {
        guard !pcm16.isEmpty, pcm16.count % 2 == 0 else { return }
        // The home channel takes priority: while it's actively receiving, hold
        // off scan audio for a short window so scan traffic can't fight it.
        holdLock.lock()
        mainHoldUntil = ProcessInfo.processInfo.systemUptime + mainHoldSeconds
        holdLock.unlock()
        notifyEnqueued(pcm16)
        jitterBuffer.enqueue(pcm16)
    }

    /// Marshal the replay-capture callback to the main actor — it mutates
    /// view-model state and the enqueue path now runs off-main.
    private func notifyEnqueued(_ pcm16: Data) {
        guard let onEnqueuedIncoming else { return }
        if Thread.isMainThread {
            onEnqueuedIncoming(pcm16)
        } else {
            DispatchQueue.main.async { onEnqueuedIncoming(pcm16) }
        }
    }

    /// Enqueues a scan-channel PCM16 frame, arbitrating so that only ONE scan
    /// channel plays at a time (mirrors Android's InboundVoicePlayer). Returns
    /// `false` when the frame was suppressed — the caller should then NOT update
    /// the "currently scanning" banner, which is what stops the UI from flapping
    /// between channels when several scan channels key up at once.
    ///
    /// Priority: the home channel wins (frames dropped while it holds); otherwise
    /// the first scan channel to key up locks the slot until it goes quiet for
    /// `scanHoldSeconds`, after which another scan channel may take over.
    @discardableResult
    func enqueueScan(channel: String, _ pcm16: Data) -> Bool {
        guard !pcm16.isEmpty, pcm16.count % 2 == 0 else { return false }
        let now = ProcessInfo.processInfo.systemUptime
        holdLock.lock()
        // Home channel has the floor.
        if now < mainHoldUntil { holdLock.unlock(); return false }
        // A different scan channel still holds the slot — suppress this one.
        if let active = activeScanChannel,
           active.caseInsensitiveCompare(channel) != .orderedSame,
           now < scanHoldUntil {
            holdLock.unlock()
            return false
        }
        activeScanChannel = channel
        scanHoldUntil = now + scanHoldSeconds
        holdLock.unlock()
        notifyEnqueued(pcm16)
        jitterBuffer.enqueue(pcm16)
        return true
    }

    /// Plays back a complete PCM16 clip exactly once, scheduled straight onto a
    /// dedicated replay node — bypassing the jitter buffer + PLC entirely. The
    /// jitter buffer is built for a steady stream of 20 ms frames; handing it one
    /// giant clip made its PLC re-emit the tail repeatedly, which is what the user
    /// heard as the replay "looping". A direct one-shot schedule plays it once.
    func replayAudio(_ pcm16: Data) {
        guard !pcm16.isEmpty, pcm16.count % 2 == 0 else { return }
        guard let buffer = makeBuffer(from: pcm16) else { return }
        replayPlayer.scheduleBuffer(buffer, at: nil, options: [.interrupts], completionHandler: nil)
        if !replayPlayer.isPlaying { replayPlayer.play() }
    }

    /// Plays a complete end-of-TX cue (roger beep / squelch tail) exactly once on
    /// the dedicated replay node, bypassing the jitter buffer + PLC entirely.
    /// Routed here rather than through `enqueueIncoming` because the cue is a
    /// short fixed clip whose tail, fed into the PLC jitter buffer, gets re-emitted
    /// a few times as a faded copy — the "echo" the operator hears after a tone-out
    /// or transmission. Unlike `replayAudio` this does NOT interrupt, so it layers
    /// onto the very tail of the transmission instead of cutting it off.
    func playCue(_ pcm16: Data) {
        guard !pcm16.isEmpty, pcm16.count % 2 == 0 else { return }
        guard let buffer = makeBuffer(from: pcm16) else { return }
        replayPlayer.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        if !replayPlayer.isPlaying { replayPlayer.play() }
    }

    /// Converts a little-endian PCM16 mono/16 kHz blob into a float32
    /// `AVAudioPCMBuffer` in the player's processing format.
    private func makeBuffer(from pcm16: Data) -> AVAudioPCMBuffer? {
        let sampleCount = pcm16.count / 2
        guard sampleCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: processingFormat,
                                            frameCapacity: AVAudioFrameCount(sampleCount)),
              let channel = buffer.floatChannelData else { return nil }
        buffer.frameLength = AVAudioFrameCount(sampleCount)
        pcm16.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let samples = raw.bindMemory(to: Int16.self)
            let out = channel[0]
            for i in 0..<sampleCount {
                out[i] = Float(Int16(littleEndian: samples[i])) / 32_768.0
            }
        }
        return buffer
    }
}
