import Foundation
import os

/// Off-main inbound voice decode pipeline.
///
/// Codec decode (IMBE / Codec2 / Opus / AMBE) plus the post-decode shaping chain
/// is CPU work that used to run on the `@MainActor` inside the transports. When
/// the app is backgrounded (screen off) iOS throttles the main thread and
/// coalesces timers, so that main-actor decode arrived late and bunched — the
/// inbound jitter buffer ran dry and its PLC produced the "robotic" re-emit and
/// then silence. Moving decode onto a dedicated serial queue keeps frame
/// delivery off the throttled main run loop.
///
/// Each instance owns its own decoders and a single serial queue, so the native
/// vocoder state is accessed from exactly one thread (the queue) and never races
/// — including across scan channels, which previously shared one decoder.
/// `@unchecked Sendable`: every piece of mutable state is confined to the
/// private serial `queue`, and the immutable references (`audio`, `onPlayed`,
/// the decoders) are themselves thread-safe, so the type is safe to hand across
/// threads (the transports read it from the background URLSession completion).
final class InboundVoiceDecoder: @unchecked Sendable {

    /// Home channel applies the agency post-decode chain; scan channels play the
    /// plain upsample/passthrough the scan path always used. `channelLabel` is
    /// set for scan so playback can route through `VoiceAudio.enqueueScan`
    /// arbitration; nil for the home channel.
    private let channelLabel: String?
    private let audio: VoiceAudio
    private let listenPcmMagic: [UInt8]
    private let logger: Logger

    /// Fired on the main actor after a frame was actually played out (home:
    /// every frame; scan: only when the frame won the scan arbitration slot).
    /// Home uses it to drive the "receiving" indicator; scan to flash its banner.
    /// Queue-confined; assigned via `setOnPlayed` once before traffic flows.
    private var onPlayed: (@MainActor () -> Void)?

    /// Serial, high-priority queue — single-threaded vocoder access + steady
    /// delivery cadence independent of the (throttled) main run loop.
    private let queue: DispatchQueue

    /// Decoders, keyed by codec, accessed only on `queue`.
    private let decoders: VoiceCodecRegistry

    // MARK: queue-confined render state

    private var postDecodeProcessor: PostDecodeChain.Processor?
    private var widebandEnabled = false
    private var opusVoiceProcessor: PostDecodeChain.Processor?
    private var lastInboundVoiceAt: TimeInterval = 0
    private let talkSpurtGapSeconds: TimeInterval = VoiceTiming.talkSpurtGapSeconds

    init(channelLabel: String?, audio: VoiceAudio, listenPcmMagic: [UInt8], logger: Logger) {
        self.channelLabel = channelLabel
        self.audio = audio
        self.listenPcmMagic = listenPcmMagic
        self.logger = logger
        let label = channelLabel.map { "voice-decode.scan.\($0)" } ?? "voice-decode.home"
        self.queue = DispatchQueue(label: label, qos: .userInteractive)
        let registry = VoiceCodecRegistry()
        registry.registerDecoder(ImbeDecoder())
        registry.registerDecoder(Codec2Decoder())
        registry.registerDecoder(OpusDecoder())
        registry.registerDecoder(AmbeDecoder())
        self.decoders = registry
    }

    /// Wire ids of every codec this decoder can decode — advertised in the scan
    /// join `caps` so the relay's logging reflects what the client can hear.
    func decodableCaps() -> [String] {
        decoders.decodableCodecs().map { $0.wireId }
    }

    /// Set the play-out callback (once, before traffic). Assigned on `queue` so
    /// it is read race-free by `play`.
    func setOnPlayed(_ callback: @escaping @MainActor () -> Void) {
        queue.async { self.onPlayed = callback }
    }

    /// Push the agency RX shaping built on the main actor. The processor is only
    /// ever *used* on `queue`, so handing the freshly built object across once is
    /// safe (no concurrent access). Home channel only; scan never shapes.
    func updateConfig(processor: PostDecodeChain.Processor?, wideband: Bool) {
        queue.async {
            self.postDecodeProcessor = processor
            self.widebandEnabled = wideband
            self.lastInboundVoiceAt = 0
        }
    }

    /// Hand a raw inbound WebSocket binary frame to the decode pipeline. Returns
    /// immediately; decode + playout happen on `queue`.
    func submit(_ payload: Data) {
        queue.async { self.decodeAndPlay(payload) }
    }

    // MARK: - private (all on `queue`)

    private func decodeAndPlay(_ payload: Data) {
        // Clear-PCM sideband echo (server-only recording path) — never playback.
        if payload.count >= 2,
           payload[payload.startIndex] == listenPcmMagic[0],
           payload[payload.startIndex + 1] == listenPcmMagic[1] {
            return
        }
        guard payload.count >= 2,
              let decoder = decoders.decoder(forMagic: payload[payload.startIndex], payload[payload.startIndex + 1]) else {
            // Unknown magic — legacy clear PCM (soundboard tone-out, etc.).
            VoiceLinkTelemetryReporter.shared.recordFrameReceived(codec: "raw_pcm", bytes: payload.count)
            play(payload)
            return
        }

        let now = ProcessInfo.processInfo.systemUptime
        let newSpurt = lastInboundVoiceAt == 0 || (now - lastInboundVoiceAt) > talkSpurtGapSeconds
        lastInboundVoiceAt = now
        let telemetryCodec = decoder.codec.wireId
        VoiceLinkTelemetryReporter.shared.recordFrameReceived(codec: telemetryCodec, bytes: payload.count)
        if newSpurt {
            decoder.resetForTalkSpurt()
            // Both 8 kHz and Opus wideband paths share biquad/compressor state;
            // reset on every talk-spurt boundary so a prior talker's filter ring
            // can't bleed into the next talker's first frame.
            postDecodeProcessor?.reset()
            opusVoiceProcessor?.reset()
            VoiceLinkTelemetryReporter.shared.recordTalkSpurtStart()
        }
        // Lazy-load IMBE/AMBE native libs on first frame so peers stay audible.
        if decoder.codec == .imbe, !P25ImbeNative.isAvailable, !P25ImbeNative.initialize() {
            VoiceLinkTelemetryReporter.shared.recordDecodeFailure()
            logger.warning("IMBE frame discarded — vocoder not loaded")
            return
        }
        if decoder.codec == .ambe_2450, !P25AmbeNative.isAvailable, !P25AmbeNative.initialize() {
            VoiceLinkTelemetryReporter.shared.recordDecodeFailure()
            logger.warning("AMBE frame discarded — vocoder not loaded")
            return
        }
        guard decoder.isReady else {
            VoiceLinkTelemetryReporter.shared.recordDecodeFailure()
            logger.warning("Inbound \(decoder.codec.wireId, privacy: .public) frame dropped — decoder native lib not loaded")
            return
        }
        guard let samples = decoder.decodeFrame(payload) else {
            VoiceLinkTelemetryReporter.shared.recordDecodeFailure()
            return
        }
        VoiceLinkTelemetryReporter.shared.recordFrameDecoded(codec: telemetryCodec)
        play(render(samples, nativeRate: decoder.nativeSampleRate))
    }

    /// Native-rate samples → 16 kHz PCM16 LE for the player.
    private func render(_ samples: [Int16], nativeRate: Int) -> Data {
        // Scan path: never shaped — plain upsample (8 kHz) or passthrough (16 kHz),
        // matching the scan path's historical behaviour.
        if channelLabel != nil {
            if nativeRate == 8000 {
                return P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: samples)
            }
            return Self.shortLeMonoBytes(samples)
        }
        // Home path: agency post-decode chain.
        if nativeRate == 8000 {
            guard let processor = postDecodeProcessor else {
                return P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: samples)
            }
            return processor.process(pcm8k160: samples)
        }
        // Opus (16 kHz): agency wideband chain when enabled, else fixed warm
        // "radio voice" Opus shaping so Opus sounds full rather than thin.
        if let processor = postDecodeProcessor, widebandEnabled {
            return processor.processWideband(pcm16k: samples)
        }
        let proc: PostDecodeChain.Processor
        if let existing = opusVoiceProcessor {
            proc = existing
        } else {
            proc = PostDecodeChain.Processor(config: .opusVoiceShaping)
            opusVoiceProcessor = proc
        }
        return proc.processWideband(pcm16k: samples)
    }

    /// Enqueue for playout and, if it was actually played, fire `onPlayed` on
    /// the main actor.
    private func play(_ pcm16: Data) {
        if let channel = channelLabel {
            guard audio.enqueueScan(channel: channel, pcm16) else { return }
        } else {
            audio.enqueueIncoming(pcm16)
        }
        if let onPlayed {
            Task { @MainActor in onPlayed() }
        }
    }

    private static func shortLeMonoBytes(_ samples: [Int16]) -> Data {
        var out = Data(count: samples.count * 2)
        out.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            let bytes = base.assumingMemoryBound(to: UInt8.self)
            for (i, s) in samples.enumerated() {
                let le = UInt16(bitPattern: s)
                bytes[i * 2] = UInt8(le & 0xff)
                bytes[i * 2 + 1] = UInt8((le >> 8) & 0xff)
            }
        }
        return out
    }
}
