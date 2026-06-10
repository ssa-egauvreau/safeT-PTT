import Foundation

/// Swift wrapper around the bundled dvmvocoder's AMBE+2 half-rate mode — the
/// P25 Phase 2 / DMR vocoder rate: 49 voice bits @ 2450 bps in a 9-byte
/// DMR-interleaved codeword per 20 ms frame. Shares the native bridge with
/// `P25ImbeNative` (see Native/p25_vocoder_bridge.cpp); the 16 kHz ↔ 8 kHz
/// framing helpers live in `P25ImbeNative.Frames`.
enum P25AmbeNative {
    private static let lock = NSLock()
    private static var ready = false

    static var isAvailable: Bool {
        lock.lock()
        defer { lock.unlock() }
        return ready
    }

    @discardableResult
    static func initialize() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if ready { return true }
        ready = p25_ambe_init()
        return ready
    }

    static func encodeFrame(samples8k160: [Int16]) -> Data? {
        guard samples8k160.count == 160 else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if !ready { return nil }
        var codeword = [UInt8](repeating: 0, count: 9)
        let ok = samples8k160.withUnsafeBufferPointer { samplesPtr in
            codeword.withUnsafeMutableBufferPointer { outPtr in
                guard let s = samplesPtr.baseAddress, let o = outPtr.baseAddress else { return false }
                return p25_ambe_encode(s, o)
            }
        }
        return ok ? Data(codeword) : nil
    }

    static func decodeCodeword9(_ codeword: Data) -> [Int16]? {
        guard codeword.count == 9 else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if !ready { return nil }
        var samples = [Int16](repeating: 0, count: 160)
        let ok = codeword.withUnsafeBytes { raw in
            samples.withUnsafeMutableBufferPointer { outPtr in
                guard let c = raw.baseAddress?.assumingMemoryBound(to: UInt8.self),
                      let o = outPtr.baseAddress else { return false }
                return p25_ambe_decode(c, o)
            }
        }
        return ok ? samples : nil
    }
}
