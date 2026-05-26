import XCTest
@testable import SafeTMobile

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
