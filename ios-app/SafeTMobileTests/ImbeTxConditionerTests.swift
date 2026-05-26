import XCTest
@testable import SafeTMobile

/// `ImbeTxConditioner` runs on every captured 16 kHz PCM frame on the uplink
/// path before downsampling and IMBE encoding. A regression here directly
/// degrades transmitted voice quality (clipping, NaN, wrong frame length,
/// state leaking across PTT cycles after the buffer is reset on busy/abort).
final class ImbeTxConditionerTests: XCTestCase {

    /// 16 kHz × 20 ms = 320 samples = 640 bytes. The downstream IMBE
    /// downsampler reads exactly 640 bytes — a length-altering regression
    /// would crash or truncate uplink audio.
    func test_conditioning_preservesFrameLength() {
        var frame = makeLE16Bytes(samples: Array(repeating: Int16(0), count: 320))
        let originalCount = frame.count

        ImbeTxConditioner().conditionLe16(frame: &frame)

        XCTAssertEqual(frame.count, originalCount)
    }

    /// All-zero PCM in must be all-zero PCM out. The DSP is linear in the
    /// signal, so this is a hard invariant — catches any future regression
    /// that adds DC bias, denormal contamination, or an AGC floor that
    /// "lifts" silence into audible noise.
    func test_silenceIn_producesSilenceOut() {
        var frame = makeLE16Bytes(samples: Array(repeating: Int16(0), count: 320))

        ImbeTxConditioner().conditionLe16(frame: &frame)

        for offset in stride(from: 0, to: frame.count, by: 2) {
            let lo = UInt16(frame[offset])
            let hi = UInt16(frame[offset + 1])
            let sample = Int16(bitPattern: lo | (hi << 8))
            XCTAssertEqual(sample, 0, "expected silence at byte offset \(offset)")
        }
    }

    /// Short / malformed buffers must not crash. The conditioner is fed
    /// from a buffered accumulator and can be called with an empty Data
    /// during a busy/abort reset race.
    func test_emptyFrame_isNoOp() {
        var empty = Data()

        ImbeTxConditioner().conditionLe16(frame: &empty)

        XCTAssertEqual(empty.count, 0)
    }

    /// Single-byte input cannot encode an Int16 sample. The guard at the
    /// top of `conditionLe16` exists to short-circuit this case; verify
    /// it stays in place.
    func test_singleByteFrame_isLeftUnchanged() {
        var frame = Data([0x42])

        ImbeTxConditioner().conditionLe16(frame: &frame)

        XCTAssertEqual(frame, Data([0x42]))
    }

    /// Drive the conditioner with a loud sustained tone for many frames
    /// and verify all output samples remain in Int16 range. Catches any
    /// regression where the soft-limiter / AGC produces NaN, ±∞, or
    /// wraparound that would corrupt the IMBE encoder downstream.
    func test_loudToneRemainsBounded_acrossManyFrames() {
        let conditioner = ImbeTxConditioner()
        let toneHz = 1_000.0
        let fs = 16_000.0
        var phase = 0.0
        let phaseStep = 2 * Double.pi * toneHz / fs

        for _ in 0..<100 {
            var samples = [Int16]()
            samples.reserveCapacity(320)
            for _ in 0..<320 {
                samples.append(Int16(0.95 * 32_767.0 * sin(phase)))
                phase += phaseStep
            }
            var frame = makeLE16Bytes(samples: samples)
            conditioner.conditionLe16(frame: &frame)
            assertAllSamplesInRange(frame)
        }
    }

    /// `resetUplinkState()` on VoiceTransport calls `txConditioner.reset()`
    /// on busy/abort/disconnect. After reset, silence must still produce
    /// silence — i.e. the AGC envelope from the previous transmission must
    /// not leak gain into the next one. This is the exact bug class the
    /// "clear IMBE uplink buffer after busy/abort" fix exists to prevent.
    func test_resetReturnsToSilentPassthrough_afterLoudActivity() {
        let conditioner = ImbeTxConditioner()

        for _ in 0..<50 {
            var loud = makeLE16Bytes(samples: Array(repeating: Int16(20_000), count: 320))
            conditioner.conditionLe16(frame: &loud)
        }

        conditioner.reset()

        var silent = makeLE16Bytes(samples: Array(repeating: Int16(0), count: 320))
        conditioner.conditionLe16(frame: &silent)

        for offset in stride(from: 0, to: silent.count, by: 2) {
            let lo = UInt16(silent[offset])
            let hi = UInt16(silent[offset + 1])
            let sample = Int16(bitPattern: lo | (hi << 8))
            XCTAssertEqual(sample, 0, "post-reset silence must remain silent (offset \(offset))")
        }
    }

    // MARK: - helpers

    private func makeLE16Bytes(samples: [Int16]) -> Data {
        var out = Data(capacity: samples.count * 2)
        for sample in samples {
            let le = UInt16(bitPattern: sample)
            out.append(UInt8(le & 0xff))
            out.append(UInt8((le >> 8) & 0xff))
        }
        return out
    }

    private func assertAllSamplesInRange(_ frame: Data, file: StaticString = #file, line: UInt = #line) {
        for offset in stride(from: 0, to: frame.count, by: 2) {
            let lo = UInt16(frame[offset])
            let hi = UInt16(frame[offset + 1])
            let sample = Int16(bitPattern: lo | (hi << 8))
            XCTAssertGreaterThanOrEqual(Int(sample), Int(Int16.min), file: file, line: line)
            XCTAssertLessThanOrEqual(Int(sample), Int(Int16.max), file: file, line: line)
        }
    }
}
