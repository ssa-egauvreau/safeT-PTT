import Foundation

/// Per-codec uplink encoder. Implementations take a uniform 20 ms frame of
/// capture-rate PCM (16 kHz mono PCM-16 little-endian = 640 bytes) and return
/// the WebSocket payload for that frame — codec magic bytes followed by the
/// codec's own packet — ready to ship.
protocol VoiceEncoder: AnyObject {
    var codec: VoiceCodec { get }

    /// True when the underlying codec library is loaded and usable. A codec
    /// whose native lib failed to load reports false so the registry can
    /// fall back to IMBE on TX without throwing.
    var isReady: Bool { get }

    /// Encode one 20 ms frame of 16 kHz mono PCM-16 LE (640 bytes / 320 samples).
    /// Returns the framed WebSocket payload (magic bytes prepended), or nil if
    /// the encoder is not ready or the input is malformed.
    func encodeFrame(_ pcm16kLe640: Data) -> Data?

    /// Reset internal state at the start of a new talk-spurt.
    func resetForTalkSpurt()
}

extension VoiceEncoder {
    func resetForTalkSpurt() {}
}

/// Per-codec downlink decoder. Implementations take an inbound WebSocket
/// payload (the codec's magic bytes followed by its packet) and return
/// decoded samples at the codec's native sample rate; the transport layer
/// then upsamples / post-processes to the playback rate.
protocol VoiceDecoder: AnyObject {
    var codec: VoiceCodec { get }
    var isReady: Bool { get }

    /// Sample rate of `decodeFrame`'s output. IMBE / Codec2 = 8000, Opus = 16000.
    var nativeSampleRate: Int { get }

    /// Decode one framed inbound voice payload. Returns native-rate mono
    /// samples, or nil if the frame is malformed or the codec is not ready.
    func decodeFrame(_ framedBytes: Data) -> [Int16]?

    /// Reset decoder state at an inbound talk-spurt boundary.
    func resetForTalkSpurt()
}

extension VoiceDecoder {
    func resetForTalkSpurt() {}
}
