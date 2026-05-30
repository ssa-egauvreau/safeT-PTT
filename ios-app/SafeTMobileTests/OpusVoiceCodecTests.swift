import XCTest
@testable import SafeTMobile

/// Pin the libopus encoder/decoder contract on the iOS side.
///
/// `OpusEncoder` / `OpusDecoder` were rewritten in the libopus-FEC PR to
/// call libopus directly through the bridging header instead of
/// `AVAudioConverter`. The contract this test fixture pins:
///
///  - The encoder is ready (libopus compiled in cleanly).
///  - A 20 ms 16 kHz mono PCM-16 frame encodes to a packet within the
///    expected size range for the 32 kbps + 10 % FEC voice profile.
///  - The wire framing (2-byte magic `0x4F 0x70` + opaque packet) matches
///    `VoiceCodec.opus.magic0` / `.magic1` — a drift here breaks every
///    cross-platform peer at once.
///  - Round-tripping a tone retains non-trivial energy (sanity check
///    against the encoder shipping silent packets).
///  - The FEC recovery path reconstructs a "lost" frame from the next
///    packet's LBRR data with PSNR comfortably above zero.
final class OpusVoiceCodecTests: XCTestCase {

    private let frameSamples = 320  // 20 ms @ 16 kHz

    /// Build a 20 ms 16 kHz mono PCM-16 LE Data containing a sine at
    /// `freqHz` with peak `amp`. Mirrors the test signal pattern used in
    /// the server-side opusServerCodec tests so cross-platform regressions
    /// surface with similar audio fingerprints.
    private func tone(freqHz: Double, amp: Int16 = 8000) -> Data {
        var data = Data(count: frameSamples * 2)
        data.withUnsafeMutableBytes { raw in
            guard let p = raw.bindMemory(to: Int16.self).baseAddress else { return }
            for i in 0..<frameSamples {
                let v = Int(Double(amp) * sin(2 * .pi * freqHz * Double(i) / 16000))
                p[i] = Int16(clamping: v)
            }
        }
        return data
    }

    /// RMS energy of a PCM-16 Data buffer. Used as a smoke check against
    /// the encoder shipping silent packets.
    private func rms(_ data: Data) -> Double {
        var sum: Double = 0
        var n = 0
        data.withUnsafeBytes { raw in
            guard let p = raw.bindMemory(to: Int16.self).baseAddress else { return }
            n = data.count / 2
            for i in 0..<n {
                let v = Double(p[i])
                sum += v * v
            }
        }
        return n > 0 ? sqrt(sum / Double(n)) : 0
    }

    /// RMS energy of an Int16 array — the decoder's output shape.
    private func rms(_ samples: [Int16]) -> Double {
        if samples.isEmpty { return 0 }
        var sum: Double = 0
        for v in samples { sum += Double(v) * Double(v) }
        return sqrt(sum / Double(samples.count))
    }

    /// PSNR (dB) of `recovered` vs `original` treating both as Int16 PCM.
    /// Saturates at +99 dB for identical signals to avoid log(0).
    private func psnrDb(original: [Int16], recovered: [Int16]) -> Double {
        let n = min(original.count, recovered.count)
        if n == 0 { return -99 }
        var mse = 0.0
        for i in 0..<n {
            let d = Double(recovered[i]) - Double(original[i])
            mse += d * d
        }
        mse /= Double(n)
        if mse < 1 { return 99 }
        return 10 * log10((32767.0 * 32767.0) / mse)
    }

    func test_encoder_isReady_afterInit() {
        let enc = OpusEncoder()
        XCTAssertTrue(enc.isReady, "Encoder should construct cleanly with libopus compiled in")
    }

    func test_decoder_isReady_afterInit() {
        let dec = OpusDecoder()
        XCTAssertTrue(dec.isReady, "Decoder should construct cleanly with libopus compiled in")
    }

    /// Encoded packet must:
    ///  - lead with the wire magic (0x4F 0x70)
    ///  - sit in the expected size range for 32 kbps + ~10 % FEC LBRR
    func test_encode_producesFramedPacketOfExpectedShape() {
        let enc = OpusEncoder()
        XCTAssertTrue(enc.isReady)

        let pcm = tone(freqHz: 440)
        guard let framed = enc.encodeFrame(pcm) else {
            XCTFail("encodeFrame returned nil for a valid 20 ms PCM frame")
            return
        }

        XCTAssertGreaterThanOrEqual(framed.count, 2 + 40,
                                    "Framed packet too small: \(framed.count) bytes")
        XCTAssertLessThanOrEqual(framed.count, 2 + 200,
                                 "Framed packet too large: \(framed.count) bytes")
        XCTAssertEqual(framed[framed.startIndex], VoiceCodec.opus.magic0)
        XCTAssertEqual(framed[framed.startIndex + 1], VoiceCodec.opus.magic1)
    }

    func test_encode_rejectsWrongFrameSize() {
        let enc = OpusEncoder()
        XCTAssertNil(enc.encodeFrame(Data()), "empty PCM rejected")
        XCTAssertNil(enc.encodeFrame(Data(count: 100)), "short PCM rejected")
        XCTAssertNil(enc.encodeFrame(Data(count: 1024)), "oversized PCM rejected")
    }

    /// End-to-end round-trip a tone. Verify the decoded waveform has
    /// non-trivial energy — guards against a regression where the encoder
    /// ships silent packets.
    func test_encodeDecode_roundTrip_retainsEnergy() {
        let enc = OpusEncoder()
        let dec = OpusDecoder()
        XCTAssertTrue(enc.isReady && dec.isReady)

        let pcm = tone(freqHz: 1000, amp: 8000)
        let inEnergy = rms(pcm)
        XCTAssertGreaterThan(inEnergy, 100, "input tone has non-trivial energy")

        guard let framed = enc.encodeFrame(pcm),
              let decoded = dec.decodeFrame(framed)
        else {
            XCTFail("encode→decode round-trip failed")
            return
        }
        XCTAssertEqual(decoded.count, frameSamples)
        let outEnergy = rms(decoded)
        XCTAssertGreaterThan(outEnergy, inEnergy * 0.25,
                             "decoded energy too low: \(outEnergy) vs input \(inEnergy)")
    }

    func test_decode_rejectsWrongMagic() {
        let dec = OpusDecoder()
        XCTAssertTrue(dec.isReady)
        var bad = Data([0x00, 0x00])
        bad.append(contentsOf: [UInt8](repeating: 0, count: 80))
        XCTAssertNil(dec.decodeFrame(bad))
    }

    /// The headline FEC test: encode 5 frames, "lose" frame 3, recover it
    /// from frame 4's LBRR. The decoder's internal state must be walked
    /// past frames 0-2 first so opus_decode(decode_fec=1) reconstructs
    /// the actual frame 3 LBRR rather than a stale one.
    func test_fecRecovery_reconstructsLostFrame() {
        let enc = OpusEncoder()
        let dec = OpusDecoder()
        XCTAssertTrue(enc.isReady && dec.isReady)

        var originals: [Data] = []
        var packets: [Data] = []
        for i in 0..<5 {
            let pcm = tone(freqHz: 500 + Double(i) * 50, amp: 8000)
            originals.append(pcm)
            guard let packet = enc.encodeFrame(pcm) else {
                XCTFail("frame \(i) encode failed"); return
            }
            packets.append(packet)
        }

        // Decode frames 0..<3 normally to walk the decoder state up to
        // exactly where frame 3 would be the next expected packet.
        for i in 0..<3 {
            XCTAssertNotNil(dec.decodeFrame(packets[i]), "frame \(i) regular decode failed")
        }

        // Now "lose" frame 3: instead of decoding packets[3], call the
        // FEC path with packets[4] which carries frame 3's LBRR.
        guard let recovered = dec.decodeLostFrameFromNext(packets[4]) else {
            XCTFail("FEC recovery returned nil")
            return
        }
        XCTAssertEqual(recovered.count, frameSamples)

        let recoveredEnergy = rms(recovered)
        XCTAssertGreaterThan(recoveredEnergy, 200,
                             "FEC-recovered energy too low: \(recoveredEnergy)")

        // PSNR vs the original frame 3 — LBRR is lower-quality than the
        // original by design (10 % bitrate budget), so the floor is
        // permissive. 8 dB clears comfortably for tone signals while a
        // silent-output or random-output regression would fail.
        let original3 = originals[3].withUnsafeBytes { raw -> [Int16] in
            guard let p = raw.bindMemory(to: Int16.self).baseAddress else { return [] }
            return Array(UnsafeBufferPointer(start: p, count: frameSamples))
        }
        let psnr = psnrDb(original: original3, recovered: recovered)
        XCTAssertGreaterThanOrEqual(psnr, 8,
                                    "FEC PSNR too low: \(psnr) dB")
    }
}
