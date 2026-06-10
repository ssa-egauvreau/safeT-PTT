import Foundation

/// On-wire voice codec identity, mirrored from `server/src/voiceCodecs.ts`
/// and `android-app/.../VoiceCodec.kt` so all three ends agree byte-for-byte.
/// Every voice frame the relay forwards starts with the codec's two-byte
/// magic prefix, which is how receivers route the frame to the right decoder
/// when channels can use different codecs.
///
/// IMBE keeps its existing 0xF5 0xAB so older clients that predate this
/// enum stay on-wire compatible without any change.
enum VoiceCodec: String, CaseIterable {
    case imbe = "imbe"
    case codec2_3200 = "codec2_3200"
    case opus = "opus"
    case ambe_2450 = "ambe_2450"

    /// Fallback for any control message that omits or mangles the codec.
    static let `default`: VoiceCodec = .imbe

    var magic0: UInt8 {
        switch self {
        case .imbe: return 0xF5
        case .codec2_3200: return 0xC2
        case .opus: return 0x4F
        case .ambe_2450: return 0xA2
        }
    }

    var magic1: UInt8 {
        switch self {
        case .imbe: return 0xAB
        case .codec2_3200: return 0x01
        case .opus: return 0x70
        case .ambe_2450: return 0x45
        }
    }

    /// Server-side identifier used in REST + WebSocket control messages.
    var wireId: String { rawValue }

    /// Resolve a codec from the `codec` / `caps` strings the server sends.
    static func fromWireId(_ value: String?) -> VoiceCodec? {
        guard let value, !value.isEmpty else { return nil }
        return VoiceCodec(rawValue: value)
    }

    /// Resolve a codec from the first two bytes of an inbound voice frame.
    static func fromMagic(_ b0: UInt8, _ b1: UInt8) -> VoiceCodec? {
        return VoiceCodec.allCases.first { $0.magic0 == b0 && $0.magic1 == b1 }
    }
}
