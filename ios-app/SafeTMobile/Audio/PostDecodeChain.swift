import Foundation

/// Live RX post-decode chain — what the handset applies to every IMBE-decoded
/// frame before handing the PCM bytes to `VoiceAudio.enqueueIncoming`. Mirrors
/// the Audio Lab's `processClip` shaping
/// (`server/web-console/src/pages/admin/audioLab/pipeline.ts`), the web voice
/// client's `postDecodeChain.ts`, and the Android `PostDecodeChain.kt`, so one
/// tuned admin preset sounds the same across all three clients.
///
/// Note: the iOS playback path is fixed at `VoiceAudio.sampleRate` = 16 000 Hz.
/// The Audio Lab's `polyphase24` upsample mode (24 kHz output) is treated
/// identically to `polyphase` (16 kHz output) here so the biquads still run
/// at the player's native rate. The audible difference is small — the
/// 24 → 48 vs 16 → 48 device resample on the listener's hardware. Matches
/// the Android handling, intentionally.
enum PostDecodeChain {

    enum UpsampleMode: String {
        case duplicate
        case linear
        case polyphase
        case polyphase24

        init(_ raw: String?) {
            switch raw?.lowercased() ?? "" {
            case "linear":      self = .linear
            case "polyphase":   self = .polyphase
            case "polyphase24": self = .polyphase24
            default:            self = .duplicate
            }
        }
    }

    /// Subset of `AudioLabConfig.postDecode` the live RX path consumes.
    /// Optional fields fall back to safe "feature off" defaults so an older
    /// server (no post-decode wired) produces a no-op processor.
    struct Config {
        let upsampleMode: UpsampleMode
        let hpfEnabled: Bool
        let hpfHz: Double
        let lpfEnabled: Bool
        let lpfHz: Double
        let lowShelfEnabled: Bool
        let lowShelfHz: Double
        let lowShelfDb: Double
        let highShelfEnabled: Bool
        let highShelfHz: Double
        let highShelfDb: Double
        let presenceEnabled: Bool
        let presenceHz: Double
        let presenceDb: Double
        let presenceQ: Double
        let saturationAmount: Double
        /// Run the chain on the Opus (16 kHz) path via `Processor.processWideband`.
        /// Shapes nothing on its own — only routes Opus through the tail.
        let wideband: Bool
        /// Feed-forward compressor — after the biquads, before saturation.
        /// Defaults mirror the web reference (postDecodeChain.ts).
        let compressorEnabled: Bool
        let compressorThresholdDb: Double
        let compressorRatio: Double
        let compressorAttackMs: Double
        let compressorReleaseMs: Double
        let compressorMakeupDb: Double
        /// End-of-transmission cue synthesized by `endOfTxCue` on `air_released`.
        let rogerBeepEnabled: Bool
        let rogerBeepHz: Double
        let rogerBeepMs: Double
        let squelchTailEnabled: Bool
        let squelchTailMs: Double
        let squelchTailLevel: Double

        /// Mirrors the server's `derivePostDecodeBlock` short-circuit — when no
        /// biquad / compressor / saturation is engaged and the upsample is the
        /// legacy default, the caller should skip building a `Processor`. The
        /// cue flags and `wideband` are intentionally excluded: the cue is
        /// synthesized separately by the transport from the raw config, and
        /// `wideband` shapes nothing on its own.
        var isNoOp: Bool {
            return upsampleMode == .duplicate
                && !hpfEnabled
                && !lpfEnabled
                && !lowShelfEnabled
                && !highShelfEnabled
                && !presenceEnabled
                && !compressorEnabled
                && saturationAmount <= 0
        }

        /// Fixed "warm radio voice" shaping for the Opus (16 kHz wideband) path
        /// ONLY. Makes Opus sound full and clear — bass/body, crisp consonants,
        /// easy to understand — instead of thin/static-y. NOT the narrow
        /// AMBE+2/DMR voicing: Opus is real wideband, so keep the band wide and
        /// add musical EQ + gentle glue. Applied independently in the Opus play
        /// path; does NOT touch the 8 kHz vocoder path (IMBE/Codec2 stay raw)
        /// and is independent of any agency Audio Lab config. Mirror EXACTLY in
        /// postDecodeChain.ts / PostDecodeChain.kt.
        static let opusVoiceShaping = Config(
            upsampleMode: .duplicate,
            hpfEnabled: true,
            hpfHz: 90,
            lpfEnabled: true,
            lpfHz: 7500,
            lowShelfEnabled: true,
            lowShelfHz: 200,
            lowShelfDb: 3,
            highShelfEnabled: true,
            highShelfHz: 6000,
            highShelfDb: 1,
            presenceEnabled: true,
            presenceHz: 2600,
            presenceDb: 3.5,
            presenceQ: 0.8,
            saturationAmount: 0.1,
            wideband: true,
            compressorEnabled: true,
            compressorThresholdDb: -24,
            compressorRatio: 2.5,
            compressorAttackMs: 8,
            compressorReleaseMs: 150,
            compressorMakeupDb: 2,
            rogerBeepEnabled: false,
            rogerBeepHz: 1200,
            rogerBeepMs: 120,
            squelchTailEnabled: false,
            squelchTailMs: 90,
            squelchTailLevel: 0.05
        )
    }

    /// Per-channel processor. Biquad state persists across the 20 ms IMBE
    /// frames within a single talk-spurt so filters don't "open" each hop.
    /// Call `reset()` at talk-spurt boundaries so a previous talker's filter
    /// ring can't bleed into the next talker's first frame.
    final class Processor {
        private let upsampleMode: UpsampleMode
        private let saturationAmount: Double
        // Biquads are always built at 16 kHz (the player rate), so the same
        // stage list + compressor serve both the 8 kHz vocoder path (process,
        // which upsamples first) and the Opus wideband path (processWideband,
        // which skips the upsample). One codec per talk-spurt + reset() at spurt
        // boundaries means the shared state never crosses.
        private var stages: [Biquad] = []
        private var compressor: Compressor?
        /// One-sample carryover so linear upsample stays seamless across
        /// frame boundaries within a talk-spurt.
        private var linearPrev: Double = 0

        init(config cfg: Config) {
            self.upsampleMode = cfg.upsampleMode
            self.saturationAmount = max(0, min(1, cfg.saturationAmount))
            let fs = 16_000.0
            // Stages run at the output rate (16 kHz), AFTER upsampling — same
            // ordering as the Audio Lab preview so coefficients match.
            if cfg.hpfEnabled {
                stages.append(.highpass(fc: cfg.hpfHz, q: 0.707, fs: fs))
            }
            if cfg.lpfEnabled {
                stages.append(.lowpass(fc: cfg.lpfHz, q: 0.707, fs: fs))
            }
            if cfg.lowShelfEnabled {
                stages.append(.lowShelf(fc: cfg.lowShelfHz, gainDb: cfg.lowShelfDb, fs: fs))
            }
            if cfg.highShelfEnabled {
                stages.append(.highShelf(fc: cfg.highShelfHz, gainDb: cfg.highShelfDb, fs: fs))
            }
            if cfg.presenceEnabled {
                stages.append(.peak(fc: cfg.presenceHz, gainDb: cfg.presenceDb,
                                    q: max(0.1, cfg.presenceQ), fs: fs))
            }
            if cfg.compressorEnabled {
                compressor = Compressor(
                    thresholdDb: cfg.compressorThresholdDb,
                    ratio: cfg.compressorRatio,
                    attackMs: cfg.compressorAttackMs,
                    releaseMs: cfg.compressorReleaseMs,
                    makeupDb: cfg.compressorMakeupDb,
                    fs: fs
                )
            }
        }

        func reset() {
            for i in 0..<stages.count { stages[i].reset() }
            compressor?.reset()
            linearPrev = 0
        }

        /// 160 8-kHz `Int16` samples in → 320 16-kHz LE PCM bytes out.
        /// Wire-compatible with `P25ImbeNative.Frames.upsampleDup8kToLe16Mono`
        /// so the downstream `VoiceAudio.enqueueIncoming` is happy.
        func process(pcm8k160: [Int16]) -> Data {
            var pcm16k = upsampleTo16k(pcm8k160)
            for i in 0..<stages.count {
                stages[i].processInPlace(&pcm16k)
            }
            compressor?.processInPlace(&pcm16k)
            if saturationAmount > 0 {
                Self.applySoftSaturation(&pcm16k, amount: saturationAmount)
            }
            return Self.shortLeBytes(pcm16k)
        }

        /// Opus wideband entry point: the input is ALREADY 16 kHz, so this
        /// skips the 8→16 upsample and runs the SAME biquad → compressor →
        /// saturation tail (the stages are at 16 kHz). Length-agnostic — Opus
        /// frames are not 160 samples, and nothing here assumes the *2 upsample
        /// length. Returns LE PCM-16 bytes for the player.
        func processWideband(pcm16k input: [Int16]) -> Data {
            var pcm16k = input
            for i in 0..<stages.count {
                stages[i].processInPlace(&pcm16k)
            }
            compressor?.processInPlace(&pcm16k)
            if saturationAmount > 0 {
                Self.applySoftSaturation(&pcm16k, amount: saturationAmount)
            }
            return Self.shortLeBytes(pcm16k)
        }

        /// Pack `Int16` samples to little-endian PCM-16 bytes for the player.
        private static func shortLeBytes(_ pcm16k: [Int16]) -> Data {
            var out = Data(count: pcm16k.count * 2)
            out.withUnsafeMutableBytes { raw in
                let dst = raw.bindMemory(to: Int16.self)
                for i in 0..<pcm16k.count {
                    dst[i] = pcm16k[i].littleEndian
                }
            }
            return out
        }

        private func upsampleTo16k(_ pcm8k: [Int16]) -> [Int16] {
            switch upsampleMode {
            case .duplicate:
                return Self.upsampleDup(pcm8k)
            case .linear:
                let (out, newPrev) = Self.upsampleLinear(pcm8k, prev: linearPrev)
                linearPrev = newPrev
                return out
            case .polyphase, .polyphase24:
                // POLYPHASE24 in the lab is a 24 kHz output; the iOS player
                // is hard-locked to 16 kHz so we use the 16 kHz polyphase
                // path. See the file-level note.
                return Self.upsamplePolyphase(pcm8k)
            }
        }

        // --- upsamplers (static — they hold no per-instance state) -------

        private static func upsampleDup(_ pcm8k: [Int16]) -> [Int16] {
            var out = [Int16](repeating: 0, count: pcm8k.count * 2)
            for i in 0..<pcm8k.count {
                out[i * 2] = pcm8k[i]
                out[i * 2 + 1] = pcm8k[i]
            }
            return out
        }

        private static func upsampleLinear(_ pcm8k: [Int16], prev: Double) -> ([Int16], Double) {
            var out = [Int16](repeating: 0, count: pcm8k.count * 2)
            var p = prev
            for i in 0..<pcm8k.count {
                let curr = Double(pcm8k[i])
                out[i * 2] = Int16(PostDecodeChain.clamp16((p + curr) / 2.0))
                out[i * 2 + 1] = pcm8k[i]
                p = curr
            }
            return (out, p)
        }

        /// 33-tap Hann-windowed sinc, fc = Fs/4. Same kernel shape as the
        /// web and Android polyphase upsamplers so the response matches.
        private static let polyphase16Kernel: [Float] = buildPolyphase16Kernel()

        private static func buildPolyphase16Kernel() -> [Float] {
            let n = 33
            let half = (n - 1) / 2
            let fc = 0.25
            var k = [Float](repeating: 0, count: n)
            var norm: Float = 0
            for i in 0..<n {
                let x = Double(i - half)
                let h: Double
                if x == 0 {
                    h = 2 * fc
                } else {
                    h = sin(2 * .pi * fc * x) / (.pi * x)
                }
                let w = 0.5 * (1 - cos(2 * .pi * Double(i) / Double(n - 1)))
                k[i] = Float(h * w)
                norm += k[i]
            }
            if norm != 0 {
                for i in 0..<n { k[i] = k[i] / norm }
            }
            return k
        }

        private static func upsamplePolyphase(_ pcm8k: [Int16]) -> [Int16] {
            let kernel = polyphase16Kernel
            let half = (kernel.count - 1) / 2
            var out = [Int16](repeating: 0, count: pcm8k.count * 2)
            for n in 0..<out.count {
                let phase = n & 1
                let centreIn = n >> 1
                if phase == 0 {
                    out[n] = (centreIn >= 0 && centreIn < pcm8k.count) ? pcm8k[centreIn] : 0
                } else {
                    var acc: Double = 0
                    for k in -half...half {
                        let inIdx = centreIn + k
                        let sample = (inIdx >= 0 && inIdx < pcm8k.count)
                            ? Double(pcm8k[inIdx]) : 0
                        acc += sample * Double(kernel[k + half])
                    }
                    out[n] = Int16(PostDecodeChain.clamp16(acc))
                }
            }
            return out
        }

        private static func applySoftSaturation(_ pcm: inout [Int16], amount: Double) {
            let clamped = max(0, min(1, amount))
            if clamped == 0 { return }
            let drive = 1 + clamped * 2
            let norm = 1 / tanh(drive)
            for i in 0..<pcm.count {
                let x = Double(pcm[i]) / 32768.0
                let y = tanh(x * drive) * norm * 32768.0
                pcm[i] = Int16(PostDecodeChain.clamp16(y))
            }
        }
    }

    // ----- helpers -------------------------------------------------------

    /// Round + clamp a `Double` into the `Int16` range.
    ///
    /// Uses `floor(x + 0.5)` (round half toward +∞) to match JavaScript's
    /// `Math.round` and Kotlin's `roundToInt()` — Swift's default `.rounded()`
    /// is round-half-away-from-zero, which would round negative half-values the
    /// other way (e.g. -2.5 → -3 vs -2) and break sample-exact cross-platform
    /// parity. Audio samples rarely land on an exact half, but the DSP contract
    /// is "byte-identical across web / Android / iOS", so we pin the tie rule.
    fileprivate static func clamp16(_ x: Double) -> Int {
        if x > 32767 { return 32767 }
        if x < -32768 { return -32768 }
        return Int((x + 0.5).rounded(.down))
    }

    /// RBJ-cookbook biquad — direct-form-II transposed. Same math as the
    /// TS / Kotlin Biquad implementations so coefficients give the same
    /// audible response across all three platforms.
    struct Biquad {
        private let b0: Double
        private let b1: Double
        private let b2: Double
        private let a1: Double
        private let a2: Double
        private var z1: Double = 0
        private var z2: Double = 0

        private init(b0: Double, b1: Double, b2: Double, a1: Double, a2: Double) {
            self.b0 = b0; self.b1 = b1; self.b2 = b2; self.a1 = a1; self.a2 = a2
        }

        mutating func reset() {
            z1 = 0
            z2 = 0
        }

        mutating func processInPlace(_ pcm: inout [Int16]) {
            for i in 0..<pcm.count {
                let x = Double(pcm[i])
                let y = b0 * x + z1
                z1 = b1 * x - a1 * y + z2
                z2 = b2 * x - a2 * y
                pcm[i] = Int16(PostDecodeChain.clamp16(y))
            }
        }

        static func highpass(fc: Double, q: Double, fs: Double) -> Biquad {
            let w0 = 2 * .pi * fc / fs
            let cw = cos(w0); let sw = sin(w0)
            let alpha = sw / (2 * q)
            let a0 = 1 + alpha
            return Biquad(
                b0: (1 + cw) / 2 / a0,
                b1: -(1 + cw) / a0,
                b2: (1 + cw) / 2 / a0,
                a1: -2 * cw / a0,
                a2: (1 - alpha) / a0
            )
        }

        static func lowpass(fc: Double, q: Double, fs: Double) -> Biquad {
            let w0 = 2 * .pi * fc / fs
            let cw = cos(w0); let sw = sin(w0)
            let alpha = sw / (2 * q)
            let a0 = 1 + alpha
            return Biquad(
                b0: (1 - cw) / 2 / a0,
                b1: (1 - cw) / a0,
                b2: (1 - cw) / 2 / a0,
                a1: -2 * cw / a0,
                a2: (1 - alpha) / a0
            )
        }

        static func lowShelf(fc: Double, gainDb: Double, fs: Double) -> Biquad {
            let A = pow(10, gainDb / 40)
            let w0 = 2 * .pi * fc / fs
            let cw = cos(w0); let sw = sin(w0)
            let beta = sqrt(A)
            let a0 = A + 1 + (A - 1) * cw + beta * sw
            return Biquad(
                b0: (A * (A + 1 - (A - 1) * cw + beta * sw)) / a0,
                b1: (2 * A * (A - 1 - (A + 1) * cw)) / a0,
                b2: (A * (A + 1 - (A - 1) * cw - beta * sw)) / a0,
                a1: (-2 * (A - 1 + (A + 1) * cw)) / a0,
                a2: (A + 1 + (A - 1) * cw - beta * sw) / a0
            )
        }

        static func highShelf(fc: Double, gainDb: Double, fs: Double) -> Biquad {
            let A = pow(10, gainDb / 40)
            let w0 = 2 * .pi * fc / fs
            let cw = cos(w0); let sw = sin(w0)
            let beta = sqrt(A)
            let a0 = A + 1 - (A - 1) * cw + beta * sw
            return Biquad(
                b0: (A * (A + 1 + (A - 1) * cw + beta * sw)) / a0,
                b1: (-2 * A * (A - 1 + (A + 1) * cw)) / a0,
                b2: (A * (A + 1 + (A - 1) * cw - beta * sw)) / a0,
                a1: (2 * (A - 1 - (A + 1) * cw)) / a0,
                a2: (A + 1 - (A - 1) * cw - beta * sw) / a0
            )
        }

        static func peak(fc: Double, gainDb: Double, q: Double, fs: Double) -> Biquad {
            let A = pow(10, gainDb / 40)
            let w0 = 2 * .pi * fc / fs
            let cw = cos(w0); let sw = sin(w0)
            let alpha = sw / (2 * q)
            let a0 = 1 + alpha / A
            return Biquad(
                b0: (1 + alpha * A) / a0,
                b1: -2 * cw / a0,
                b2: (1 - alpha * A) / a0,
                a1: -2 * cw / a0,
                a2: (1 - alpha / A) / a0
            )
        }
    }

    /// Feed-forward (peak-sensing) compressor with a hard knee. Mirrors the
    /// `Biquad` struct shape: coefficients computed once at construction, only
    /// `envDb` evolves per sample. Identical arithmetic to the web reference
    /// `Compressor` (postDecodeChain.ts) and the Android `Compressor` so a
    /// channel sounds the same everywhere. All math in Double. Runs at 16 kHz,
    /// after the biquads and before saturation.
    struct Compressor {
        private static let ref = 32768.0
        private let attackCoef: Double
        private let releaseCoef: Double
        private let slope: Double
        private let makeupLin: Double
        private let thresholdDb: Double
        /// Gain-reduction envelope in dB; always <= 0. Zeroed in `reset()`.
        private var envDb: Double = 0

        init(thresholdDb: Double, ratio: Double, attackMs: Double,
             releaseMs: Double, makeupDb: Double, fs: Double) {
            self.thresholdDb = thresholdDb
            self.attackCoef = exp(-1.0 / (attackMs * 0.001 * fs))
            self.releaseCoef = exp(-1.0 / (releaseMs * 0.001 * fs))
            self.slope = 1.0 / ratio - 1.0
            self.makeupLin = pow(10.0, makeupDb / 20.0)
        }

        mutating func reset() {
            envDb = 0
        }

        mutating func processInPlace(_ pcm: inout [Int16]) {
            for i in 0..<pcm.count {
                let x = Double(pcm[i])
                let ax = abs(x) / Compressor.ref
                let xDb = ax < 1e-9 ? -120.0 : 20.0 * log10(ax)
                let overDb = xDb - thresholdDb
                let grDb = overDb > 0.0 ? overDb * slope : 0.0
                let coef = grDb < envDb ? attackCoef : releaseCoef
                envDb = coef * envDb + (1.0 - coef) * grDb
                let g = pow(10.0, envDb / 20.0) * makeupLin
                pcm[i] = Int16(PostDecodeChain.clamp16(x * g))
            }
        }
    }

    // ----- end-of-transmission cue (roger beep + comfort-noise tail) -----

    /// Deterministic LCG for the comfort-noise tail — `arc4random` / `Double.random`
    /// diverge across platforms, so the noise MUST come from this fixed-seed
    /// generator with the same constants on web / Android / iOS. `seed` is a
    /// `UInt32` so the multiply overflows mod 2^32 (with `&*` / `&+`) exactly
    /// like the web's Math.imul/>>>0 form.
    private struct CueNoise {
        private var seed: UInt32 = 0x6d2b79f5

        mutating func next() -> Double {
            seed = seed &* 1664525 &+ 1013904223
            return (Double(seed) / 4294967295.0) * 2.0 - 1.0
        }
    }

    /// Synthesize the close-side end-of-transmission cue as 16 kHz mono LE
    /// PCM-16 `Data`. The cue is `[roger beep][comfort-noise tail]` concatenated;
    /// each segment is included only when its flag is on. Returns empty `Data`
    /// when neither flag is enabled. Pinned + identical to the web / Android cue.
    static func endOfTxCue(_ cfg: Config) -> Data {
        let fs = 16_000.0
        let fade = Int((fs * 0.006).rounded()) // 6 ms raised-cosine fade in/out
        let beep = cfg.rogerBeepEnabled
        let tail = cfg.squelchTailEnabled

        let beepN = beep ? Int((fs * cfg.rogerBeepMs / 1000.0).rounded()) : 0
        let tailN = tail ? Int((fs * cfg.squelchTailMs / 1000.0).rounded()) : 0
        var out = [Int16](repeating: 0, count: beepN + tailN)

        let beepHz = cfg.rogerBeepHz
        if beepN > 0 {
            for i in 0..<beepN {
                var g = 0.5
                if i < fade { g *= Double(i) / Double(fade) }
                else if i > beepN - fade { g *= Double(beepN - i) / Double(fade) }
                out[i] = Int16(PostDecodeChain.clamp16(sin(2 * .pi * beepHz * Double(i) / fs) * g * 32767.0))
            }
        }

        let level = cfg.squelchTailLevel
        var noise = CueNoise()
        if tailN > 0 {
            for i in 0..<tailN {
                var faded = 1.0
                if i < fade { faded *= Double(i) / Double(fade) }
                else if i > tailN - fade { faded *= Double(tailN - i) / Double(fade) }
                out[beepN + i] = Int16(PostDecodeChain.clamp16(noise.next() * level * faded * 32767.0))
            }
        }

        var data = Data(count: out.count * 2)
        data.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: Int16.self)
            for i in 0..<out.count {
                dst[i] = out[i].littleEndian
            }
        }
        return data
    }
}
