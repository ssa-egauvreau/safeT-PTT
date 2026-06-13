import AVFoundation
import Foundation
import os

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

    /// Called (on the audio thread) with the peak mic level (0–1) of each
    /// captured buffer — drives the XMIT-box audio visualizer. Hop to the main
    /// actor before touching UI state.
    var onTxLevel: ((Float) -> Void)?

    /// Called when incoming PCM16 frames are enqueued for playback.
    var onEnqueuedIncoming: ((Data) -> Void)?

    /// Operator volume (0.0–1.0 from the settings slider). Drives a SOFTWARE
    /// output gain on the decoded PCM rather than the player node's 0–1 volume,
    /// so RX can be amplified ABOVE unity. The `.voiceChat` session pins playback
    /// to the quieter call-volume bus; a software boost is the safe way to make
    /// RX louder without touching the playback session/engine (which regressed RX
    /// when changed). The player node stays at unity gain.
    var playbackVolume: Float {
        get { outputVolume01 }
        set { outputVolume01 = max(0, min(1, newValue)) }
    }
    /// Slider position, 0–1.
    private var outputVolume01: Float = 1.0
    /// Linear gain applied to samples. Slider 1.0 → `maxOutputGain`×; the slider
    /// midpoint (~0.4) lands on unity.
    private var outputGain: Float { outputVolume01 * Self.maxOutputGain }
    /// Headroom above unity at full slider. With the media-volume `.playback`
    /// session RX is already loud, so a light 1.5× boost is plenty (tanh soft-clip
    /// keeps peaks clean). If the media-volume switch is ever reverted, bump this
    /// back up (the call-volume bus is much quieter).
    static let maxOutputGain: Float = 1.5


    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "voiceaudio")

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

    /// Activates the media-volume playback session and starts the engine for RX.
    /// Must be called after `requestRecordPermission()` returns true. The mic is
    /// wired only during a PTT hold (`startCapture`), so listening runs on the
    /// loud media-volume bus (speaker icon).
    func start() throws {
        try AudioSessionManager.configureForPlayback()
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        if !player.isPlaying {
            player.play()
        }
        logger.log("voice started: playback engine running=\(self.engine.isRunning) player=\(self.player.isPlaying)")
    }

    /// (Re)start the engine in playback shape. Best-effort (revert path).
    private func startEngineForPlayback() {
        if !engine.isRunning {
            engine.prepare()
            try? engine.start()
        }
        if !player.isPlaying { player.play() }
    }

    /// Drop the mic, return to the media-volume playback session, resume RX.
    private func revertToPlayback() {
        if engine.isRunning { engine.stop() }
        try? AudioSessionManager.configureForPlayback()
        startEngineForPlayback()
        logger.log("reverted to playback: engine running=\(self.engine.isRunning) player=\(self.player.isPlaying)")
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

        // Switch to the record session so the mic route comes up. We listen on a
        // playback-only session (for the speaker icon / media volume), so the
        // input isn't configured until now.
        do {
            try AudioSessionManager.configureForTransmit()
        } catch {
            revertToPlayback()
            return nil
        }
        // Stop the playback engine, then re-query the input. If the format is
        // still 0 (input not yet wired), start the engine to wire it and re-query
        // — both paths logged so a silent-RX regression is diagnosable.
        if engine.isRunning { engine.stop() }
        let inputNode = engine.inputNode
        var nativeFormat = inputNode.outputFormat(forBus: 0)
        if nativeFormat.channelCount == 0 || nativeFormat.sampleRate == 0 {
            engine.prepare()
            try? engine.start()
            nativeFormat = inputNode.outputFormat(forBus: 0)
        }
        logger.log("startCapture input format: \(nativeFormat.sampleRate, privacy: .public)Hz ch=\(nativeFormat.channelCount, privacy: .public)")
        guard nativeFormat.channelCount > 0, nativeFormat.sampleRate > 0 else {
            logger.error("startCapture: input format invalid — reverting to playback")
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
        captureBuffer = Data()
        captureSessionId &+= 1
        let sessionId = captureSessionId

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: nativeFormat) { [weak self] buffer, _ in
            self?.handle(captureBuffer: buffer, target: pcm16Mono16k, sessionId: sessionId)
        }
        if !engine.isRunning {
            engine.prepare()
            do {
                try engine.start()
            } catch {
                logger.error("startCapture: engine start failed: \(error.localizedDescription, privacy: .public)")
                inputNode.removeTap(onBus: 0)
                captureConverter = nil
                revertToPlayback()
                return nil
            }
        }
        if !player.isPlaying { player.play() }
        capturing = true
        return sessionId
    }

    func stopCapture() {
        guard capturing else { return }
        capturing = false
        engine.inputNode.removeTap(onBus: 0)
        // Drop the mic and return to the media-volume playback session so RX is
        // loud (speaker icon) again.
        revertToPlayback()
        captureBuffer = Data()
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
        // Peak level for the XMIT visualizer.
        if let onTxLevel {
            var peak: Float = 0
            let samples = int16[0]
            for i in 0..<frameCount {
                let v = abs(Float(samples[i]))
                if v > peak { peak = v }
            }
            onTxLevel(min(1, peak / 32_767))
        }
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
        onEnqueuedIncoming?(pcm16)   // store the original (pre-gain) for replay
        scheduleForPlayback(pcm16)
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
        scheduleForPlayback(pcm16)
    }

    /// Applies the software output gain (with soft limiting) and hands the frame
    /// to the jitter buffer. Single choke point so live RX and replay match.
    private func scheduleForPlayback(_ pcm16: Data) {
        jitterBuffer.enqueue(amplified(pcm16, gain: outputGain))
    }

    /// Multiplies each Int16 sample by `gain` with a soft knee + hard clamp, so a
    /// boost above unity gets louder without integer wrap-around or harsh peak
    /// clipping. Returns a fresh, zero-based `Data` (never an aliasing slice).
    /// Pure sample math — no audio-session/engine state is touched, so it can't
    /// regress the RX pipeline.
    private func amplified(_ pcm16: Data, gain: Float) -> Data {
        guard gain != 1.0 else { return pcm16 }
        var out = Data(pcm16)   // fresh contiguous copy
        out.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            let bytes = base.assumingMemoryBound(to: UInt8.self)
            let limit: Float = 32_767
            let count = raw.count / 2
            for i in 0..<count {
                let off = i * 2
                let lo = UInt16(bytes[off])
                let hi = UInt16(bytes[off + 1])
                let s = Float(Int16(bitPattern: lo | (hi << 8))) * gain
                // Smooth tanh soft-clip: roughly linear (full boost) for quiet
                // audio, saturating gently toward ±full-scale for loud audio
                // instead of hard-clipping. Hard clipping adds harsh harmonics
                // that sound "robotic"; tanh keeps it loud but clean.
                let shaped = limit * tanhf(s / limit)
                let clamped = min(max(shaped, -32_768), 32_767)
                let le = UInt16(bitPattern: Int16(clamped))
                bytes[off] = UInt8(le & 0xff)
                bytes[off + 1] = UInt8((le >> 8) & 0xff)
            }
        }
        return out
    }
}
