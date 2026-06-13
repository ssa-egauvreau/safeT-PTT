import AVFoundation
import Foundation

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

    // MARK: - playback source arbitration (scan "takes turns")
    //
    // The home channel and every scan listener push decoded PCM into the SAME
    // jitter buffer / player. When two channels key at once their frames
    // interleave into one queue and play as garbled overlap. Arbitrate so only
    // one source feeds the player at a time: the first source to produce audio
    // holds the player until it goes quiet for `sourceHoldSeconds`; a
    // higher-priority source (the tuned/home channel) preempts a scan channel.
    /// Source key currently allowed to feed the player (nil = free).
    private var activeAudioSource: String?
    /// Priority of the holding source — home (2) outranks scan (1).
    private var activeAudioPriority: Int = 0
    /// Monotonic timestamp (systemUptime) of the holding source's last frame.
    private var lastSourceFrameAt: TimeInterval = 0
    /// How long a source keeps the player after its last frame, so brief
    /// inter-word gaps don't hand the channel to a competing talker mid-spurt.
    private let sourceHoldSeconds: TimeInterval = 0.8
    /// Priority constant for the tuned/home channel (always wins over scan).
    static let homeAudioPriority = 2
    /// Priority constant for scan-listener channels.
    static let scanAudioPriority = 1

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
    }

    deinit {
        jitterBuffer.release()
    }

    /// Activates the audio session (media-volume playback) and starts the engine
    /// for RX. Must be called after `requestRecordPermission()` returns true.
    /// The mic is NOT wired here — we run playback-only so the volume buttons
    /// show the speaker icon; `startCapture()` rebuilds the engine with input
    /// when PTT is pressed.
    func start() throws {
        try AudioSessionManager.configureForPlayback()
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        if !player.isPlaying {
            player.play()
        }
    }

    /// (Re)start the engine in its playback-only shape. Idempotent. Best-effort
    /// (used on the revert path), unlike `start()` which surfaces failures.
    private func startEngineForPlayback() {
        if !engine.isRunning {
            engine.prepare()
            try? engine.start()
        }
        if !player.isPlaying {
            player.play()
        }
    }

    /// Drop the mic, return to the media-volume playback session, and resume RX.
    /// Used on PTT release and on any capture-setup failure.
    private func revertToPlayback() {
        if engine.isRunning { engine.stop() }
        try? AudioSessionManager.configureForPlayback()
        startEngineForPlayback()
    }

    func stop() {
        stopCapture()
        jitterBuffer.stop()
        if player.isPlaying { player.stop() }
        if engine.isRunning { engine.stop() }
        AudioSessionManager.deactivate()
    }

    // MARK: - capture (mic → callback)

    @discardableResult
    func startCapture() -> UInt64? {
        guard !capturing else { return captureSessionId }

        // Acquire the mic: switch to the record session and rebuild the engine so
        // its input node wires up. We listen on a playback-only session (for the
        // speaker-icon / media volume), so the input isn't configured until now.
        // Stopping the engine before touching the input avoids the 0-channel /
        // 0 Hz `outputFormat` that crashes installTap on a playback-only engine.
        do {
            try AudioSessionManager.configureForTransmit()
        } catch {
            revertToPlayback()
            return nil
        }
        if engine.isRunning { engine.stop() }

        let inputNode = engine.inputNode
        let nativeFormat = inputNode.outputFormat(forBus: 0)
        // Defensive guard: if record permission is missing or the input route is
        // mid-change, `outputFormat` can still report a 0-channel / 0 Hz format.
        // Installing a tap with that crashes AVAudioEngine — bail to playback so
        // PTT just no-ops instead of taking the app down.
        guard nativeFormat.channelCount > 0, nativeFormat.sampleRate > 0 else {
            revertToPlayback()
            return nil
        }

        let pcm16Mono16k = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.sampleRate,
            channels: 1,
            interleaved: true
        )!
        guard let converter = AVAudioConverter(from: nativeFormat, to: pcm16Mono16k) else {
            revertToPlayback()
            return nil
        }
        captureConverter = converter
        captureBuffer.removeAll(keepingCapacity: true)
        captureSessionId &+= 1
        let sessionId = captureSessionId

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: nativeFormat) { [weak self] buffer, _ in
            self?.handle(captureBuffer: buffer, target: pcm16Mono16k, sessionId: sessionId)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            captureConverter = nil
            revertToPlayback()
            return nil
        }
        if !player.isPlaying { player.play() }
        // Mark capturing AFTER a successful tap install + engine start so a
        // failure path doesn't leave stopCapture() removing a tap that's gone.
        capturing = true
        return sessionId
    }

    func stopCapture() {
        guard capturing else { return }
        capturing = false
        engine.inputNode.removeTap(onBus: 0)
        captureBuffer.removeAll(keepingCapacity: false)
        captureConverter = nil
        // Drop the mic and return to the media-volume playback session so RX is
        // loud and the volume buttons show the speaker icon again.
        revertToPlayback()
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
    ///
    /// `source` identifies the originating channel and `priority` ranks it
    /// (home > scan). Frames from a source that doesn't currently hold the
    /// player are dropped, so two channels keying at once play one-at-a-time
    /// ("scan takes turns") instead of garbling together.
    func enqueueIncoming(_ pcm16: Data, source: String = "home", priority: Int = VoiceAudio.homeAudioPriority) {
        guard !pcm16.isEmpty, pcm16.count % 2 == 0 else { return }
        guard claimPlayback(source: source, priority: priority) else { return }
        onEnqueuedIncoming?(pcm16)
        jitterBuffer.enqueue(pcm16)
    }

    /// Decides whether `source` may feed the player right now. Grants the claim
    /// when the player is free (no holder, or the holder went quiet past the
    /// hold window), when `source` already holds it, or when `source` outranks
    /// the current holder. Refreshes the hold timestamp on every granted frame.
    private func claimPlayback(source: String, priority: Int) -> Bool {
        let now = ProcessInfo.processInfo.systemUptime
        let free = activeAudioSource == nil || (now - lastSourceFrameAt) > sourceHoldSeconds
        guard free || source == activeAudioSource || priority > activeAudioPriority else {
            return false
        }
        activeAudioSource = source
        activeAudioPriority = priority
        lastSourceFrameAt = now
        return true
    }

    /// Plays back a PCM16 buffer without triggering `onEnqueuedIncoming`.
    /// Use for replay so the replayed audio is not re-appended to the last-received buffer.
    func replayAudio(_ pcm16: Data) {
        guard !pcm16.isEmpty, pcm16.count % 2 == 0 else { return }
        jitterBuffer.enqueue(pcm16)
    }
}
