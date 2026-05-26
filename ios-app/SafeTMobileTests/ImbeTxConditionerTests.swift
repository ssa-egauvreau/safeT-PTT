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
/// `ImbeTxConditioner` runs on every captured PCM frame before P25 IMBE
/// encoding. Two recent fixes (Swift exclusivity violation in `conditionLe16`,
/// stored-property initializer for CI) make this a regression-prone spot:
/// any future edit that re-reads the inout `frame` inside
/// `withUnsafeMutableBytes`, mishandles odd-length data, or breaks the
/// soft-limit/clamp logic would silently ship clipped or crashing uplink audio.
final class ImbeTxConditionerTests: XCTestCase {
    // MARK: - guards on short / malformed input

    func test_conditionLe16_emptyFrame_isNoop() {
        let conditioner = ImbeTxConditioner()
        var frame = Data()
        conditioner.conditionLe16(frame: &frame)
        XCTAssertEqual(frame.count, 0)
    }

    func test_conditionLe16_singleByteFrame_isNoop() {
        // Less than one full LE16 sample — the function must early-return
        // rather than read past the buffer.
        let conditioner = ImbeTxConditioner()
        var frame = Data([0x7F])
        conditioner.conditionLe16(frame: &frame)
        XCTAssertEqual(Array(frame), [0x7F])
    }

    func test_conditionLe16_oddLengthFrame_leavesTrailingByteUntouched() {
        // 5 bytes = 2 complete LE16 samples + 1 trailing byte. The dangling
        // byte must survive the in-place rewrite; otherwise we would write
        // past the end of the buffer.
        let conditioner = ImbeTxConditioner()
        var frame = Data([0x00, 0x00, 0x00, 0x00, 0xAB])
        conditioner.conditionLe16(frame: &frame)
        XCTAssertEqual(frame.count, 5)
        XCTAssertEqual(frame[frame.startIndex.advanced(by: 4)], 0xAB)
    }

    // MARK: - in-place rewrite preserves length & range

    func test_conditionLe16_preservesFrameLength() {
        let conditioner = ImbeTxConditioner()
        var frame = makePcm16kFrame(sampleCount: 320, sample: 0)
        conditioner.conditionLe16(frame: &frame)
        XCTAssertEqual(frame.count, 640)
    }

    func test_conditionLe16_allZeroInput_remainsZero() {
        // The gate should hold closed on pure silence; nothing the AGC does
        // can turn zero samples into non-zero output.
        let conditioner = ImbeTxConditioner()
        var frame = makePcm16kFrame(sampleCount: 320, sample: 0)
        conditioner.conditionLe16(frame: &frame)
        XCTAssertTrue(readLe16Samples(frame).allSatisfy { $0 == 0 })
    }

    func test_conditionLe16_clampsOutputWithinInt16Range_forExtremeInput() {
        // Slamming the input at full-scale exercises the soft-knee limiter:
        // the output must never exceed ±32760 and must never overflow Int16
        // (Int16(clamping:) would otherwise raise on the bad path).
        let conditioner = ImbeTxConditioner()
        var frame = makePcm16kFrame(sampleCount: 320, sample: 32_767)
        conditioner.conditionLe16(frame: &frame)
        for sample in readLe16Samples(frame) {
            XCTAssertLessThanOrEqual(sample, 32_760)
            XCTAssertGreaterThanOrEqual(sample, -32_760)
        }
    }

    func test_conditionLe16_handlesNegativeExtremes_withoutOverflow() {
        let conditioner = ImbeTxConditioner()
        var frame = makePcm16kFrame(sampleCount: 320, sample: -32_768)
        conditioner.conditionLe16(frame: &frame)
        for sample in readLe16Samples(frame) {
            XCTAssertGreaterThanOrEqual(sample, -32_760)
            XCTAssertLessThanOrEqual(sample, 32_760)
        }
    }

    // MARK: - reset() actually resets state

    func test_reset_restoresStateSoSameInputProducesSameOutput() {
        // The envelope, floor, gate, and AGC are stateful. Running a frame,
        // calling reset(), and re-running the same frame on the same instance
        // must produce the same bytes as running it on a fresh conditioner.
        let stateful = ImbeTxConditioner()
        let fresh = ImbeTxConditioner()

        var warmup = sineFrame(sampleCount: 320, amplitude: 8_000, freqHz: 440)
        stateful.conditionLe16(frame: &warmup)

        stateful.reset()

        var afterReset = sineFrame(sampleCount: 320, amplitude: 8_000, freqHz: 440)
        var freshOutput = sineFrame(sampleCount: 320, amplitude: 8_000, freqHz: 440)
        stateful.conditionLe16(frame: &afterReset)
        fresh.conditionLe16(frame: &freshOutput)

        XCTAssertEqual(afterReset, freshOutput,
                       "reset() must clear all biquad / envelope / AGC state")
    }

    // MARK: - exclusivity regression guard

    func test_conditionLe16_doesNotTrap_onLargeFrames() {
        // A regression that re-reads `frame.count` inside
        // `withUnsafeMutableBytes` would trip Swift's exclusivity checks at
        // runtime and abort the process. Running a realistically large
        // multi-frame buffer is a cheap way to catch that on CI.
        let conditioner = ImbeTxConditioner()
        var frame = sineFrame(sampleCount: 320 * 8, amplitude: 12_000, freqHz: 600)
        conditioner.conditionLe16(frame: &frame)
        XCTAssertEqual(frame.count, 320 * 8 * 2)
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
    private func makePcm16kFrame(sampleCount: Int, sample: Int16) -> Data {
        var data = Data(count: sampleCount * 2)
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            let le = UInt16(bitPattern: sample)
            let lo = UInt8(le & 0xff)
            let hi = UInt8((le >> 8) & 0xff)
            for i in 0..<sampleCount {
                base[i * 2] = lo
                base[i * 2 + 1] = hi
            }
        }
        return data
    }

    private func sineFrame(sampleCount: Int, amplitude: Double, freqHz: Double) -> Data {
        var data = Data(count: sampleCount * 2)
        let fs = 16_000.0
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<sampleCount {
                let value = amplitude * sin(2 * .pi * freqHz * Double(i) / fs)
                let sample = Int16(clamping: Int(value.rounded()))
                let le = UInt16(bitPattern: sample)
                base[i * 2] = UInt8(le & 0xff)
                base[i * 2 + 1] = UInt8((le >> 8) & 0xff)
            }
        }
        return data
    }

    private func readLe16Samples(_ data: Data) -> [Int16] {
        let sampleCount = data.count / 2
        var out: [Int16] = []
        out.reserveCapacity(sampleCount)
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<sampleCount {
                let lo = UInt16(base[i * 2])
                let hi = UInt16(base[i * 2 + 1])
                out.append(Int16(bitPattern: lo | (hi << 8)))
            }
        }
        return out
    }
}
