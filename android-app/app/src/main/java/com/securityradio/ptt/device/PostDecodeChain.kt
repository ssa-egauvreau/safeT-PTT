package com.securityradio.ptt.device

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Live RX post-decode chain — what the handset applies to every IMBE-decoded
 * frame before handing the PCM bytes to [InboundVoicePlayer]. Mirrors the
 * Audio Lab's `processClip` shaping (`server/web-console/src/pages/admin/
 * audioLab/pipeline.ts`) and the web voice client's `postDecodeChain.ts` so
 * one tuned admin preset sounds the same across web, Android, and iOS.
 *
 * Note: [InboundVoicePlayer] runs the AudioTrack at a fixed
 * [VoiceAudioSpecs.SAMPLE_RATE_HZ] = 16 000 Hz. The Audio Lab's `polyphase24`
 * upsample mode is a 24 kHz path — on Android we treat it identically to
 * `polyphase` (16 kHz) so the biquads still run at 16 kHz against the
 * AudioTrack's native rate. The audible difference is negligible (~1 dB
 * around the device's own resample artefact, well below the changes the
 * presence bell and saturation introduce).
 */
object PostDecodeChain {

    /**
     * Subset of `AudioLabConfig.postDecode` the live RX path consumes. Any
     * unknown field is ignored. The companion JSON parser tolerates missing
     * fields so an older server (no post-decode wired) lands at the
     * no-shaping fast path.
     */
    data class Config(
        val upsampleMode: UpsampleMode,
        val hpfEnabled: Boolean = false,
        val hpfHz: Float = 250f,
        val lpfEnabled: Boolean = false,
        val lpfHz: Float = 3300f,
        val lowShelfEnabled: Boolean = false,
        val lowShelfHz: Float = 200f,
        val lowShelfDb: Float = 0f,
        val highShelfEnabled: Boolean = false,
        val highShelfHz: Float = 2500f,
        val highShelfDb: Float = 0f,
        val presenceEnabled: Boolean = false,
        val presenceHz: Float = 2200f,
        val presenceDb: Float = 0f,
        val presenceQ: Float = 1.0f,
        val saturationAmount: Float = 0f,
    ) {
        /** True when no biquad / saturation is engaged AND the upsample is the
         *  legacy duplicate — caller should skip the chain entirely. Mirrors
         *  the server's `derivePostDecodeBlock` short-circuit. */
        fun isNoOp(): Boolean =
            upsampleMode == UpsampleMode.DUPLICATE &&
                !hpfEnabled &&
                !lpfEnabled &&
                !lowShelfEnabled &&
                !highShelfEnabled &&
                !presenceEnabled &&
                saturationAmount <= 0f
    }

    enum class UpsampleMode {
        DUPLICATE,
        LINEAR,
        POLYPHASE,
        POLYPHASE24,
        ;

        companion object {
            fun fromString(s: String?): UpsampleMode =
                when (s?.trim()?.lowercase()) {
                    "linear" -> LINEAR
                    "polyphase" -> POLYPHASE
                    "polyphase24" -> POLYPHASE24
                    else -> DUPLICATE
                }
        }
    }

    /**
     * Per-channel processor. Biquad state persists across the 20 ms IMBE
     * frames within a single talk-spurt so filters don't "open" each hop.
     * Call [reset] at talk-spurt boundaries so a previous talker's filter
     * ring can't bleed into the next talker's first frame.
     */
    class Processor(cfg: Config) {
        private val stages: List<Biquad> = buildStages(cfg)
        private val saturationAmount: Float = cfg.saturationAmount.coerceIn(0f, 1f)
        private val upsampleMode: UpsampleMode = cfg.upsampleMode
        private val linearCarry = FloatArray(1) // size-1 so process() can mutate it

        /** Reset filter state so the next frame opens from silence. */
        fun reset() {
            for (stage in stages) stage.reset()
            linearCarry[0] = 0f
        }

        /**
         * 160 8-kHz samples in → 320 16-kHz LE PCM bytes out. Same byte
         * shape as [P25ImbeNative.Frames.upsampleDup8kToLe16Mono] so the
         * downstream [InboundVoicePlayer.writePcmFromMain] is happy.
         */
        fun process(pcm8k160: ShortArray): ByteArray {
            val pcm16k = upsampleTo16k(pcm8k160)
            for (stage in stages) {
                stage.processInPlace(pcm16k)
            }
            if (saturationAmount > 0f) {
                applySoftSaturation(pcm16k, saturationAmount)
            }
            // Encode to LE PCM-16 bytes for the AudioTrack.
            val out = ByteArray(pcm16k.size * 2)
            val bb = ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
            for (s in pcm16k) bb.putShort(s)
            return out
        }

        private fun upsampleTo16k(pcm8k160: ShortArray): ShortArray {
            return when (upsampleMode) {
                UpsampleMode.DUPLICATE -> upsampleDup(pcm8k160)
                UpsampleMode.LINEAR -> upsampleLinear(pcm8k160, linearCarry)
                // POLYPHASE24 in the lab maps to a 24 kHz output; the
                // AudioTrack is hard-locked to 16 kHz so we treat it as
                // polyphase (16 kHz) here. See the file-level note.
                UpsampleMode.POLYPHASE, UpsampleMode.POLYPHASE24 -> upsamplePolyphase(pcm8k160)
            }
        }
    }

    // --- Biquad (RBJ cookbook, direct-form-II transposed) -----------------

    private class Biquad private constructor(
        private val b0: Double,
        private val b1: Double,
        private val b2: Double,
        private val a1: Double,
        private val a2: Double,
    ) {
        private var z1 = 0.0
        private var z2 = 0.0

        fun reset() {
            z1 = 0.0
            z2 = 0.0
        }

        fun processInPlace(pcm: ShortArray) {
            for (i in pcm.indices) {
                val x = pcm[i].toDouble()
                val y = b0 * x + z1
                z1 = b1 * x - a1 * y + z2
                z2 = b2 * x - a2 * y
                pcm[i] = clamp16(y).toShort()
            }
        }

        companion object {
            fun highpass(fc: Double, q: Double, fs: Double): Biquad {
                val w0 = 2.0 * PI * fc / fs
                val cw = cos(w0)
                val sw = sin(w0)
                val alpha = sw / (2.0 * q)
                val a0 = 1.0 + alpha
                return Biquad(
                    (1.0 + cw) / 2.0 / a0,
                    -(1.0 + cw) / a0,
                    (1.0 + cw) / 2.0 / a0,
                    (-2.0 * cw) / a0,
                    (1.0 - alpha) / a0,
                )
            }

            fun lowpass(fc: Double, q: Double, fs: Double): Biquad {
                val w0 = 2.0 * PI * fc / fs
                val cw = cos(w0)
                val sw = sin(w0)
                val alpha = sw / (2.0 * q)
                val a0 = 1.0 + alpha
                return Biquad(
                    (1.0 - cw) / 2.0 / a0,
                    (1.0 - cw) / a0,
                    (1.0 - cw) / 2.0 / a0,
                    (-2.0 * cw) / a0,
                    (1.0 - alpha) / a0,
                )
            }

            fun lowShelf(fc: Double, gainDb: Double, fs: Double): Biquad {
                val A = 10.0.pow(gainDb / 40.0)
                val w0 = 2.0 * PI * fc / fs
                val cw = cos(w0)
                val sw = sin(w0)
                val beta = sqrt(A)
                val a0 = A + 1.0 + (A - 1.0) * cw + beta * sw
                return Biquad(
                    (A * (A + 1.0 - (A - 1.0) * cw + beta * sw)) / a0,
                    (2.0 * A * (A - 1.0 - (A + 1.0) * cw)) / a0,
                    (A * (A + 1.0 - (A - 1.0) * cw - beta * sw)) / a0,
                    (-2.0 * (A - 1.0 + (A + 1.0) * cw)) / a0,
                    (A + 1.0 + (A - 1.0) * cw - beta * sw) / a0,
                )
            }

            fun highShelf(fc: Double, gainDb: Double, fs: Double): Biquad {
                val A = 10.0.pow(gainDb / 40.0)
                val w0 = 2.0 * PI * fc / fs
                val cw = cos(w0)
                val sw = sin(w0)
                val beta = sqrt(A)
                val a0 = A + 1.0 - (A - 1.0) * cw + beta * sw
                return Biquad(
                    (A * (A + 1.0 + (A - 1.0) * cw + beta * sw)) / a0,
                    (-2.0 * A * (A - 1.0 + (A + 1.0) * cw)) / a0,
                    (A * (A + 1.0 + (A - 1.0) * cw - beta * sw)) / a0,
                    (2.0 * (A - 1.0 - (A + 1.0) * cw)) / a0,
                    (A + 1.0 - (A - 1.0) * cw - beta * sw) / a0,
                )
            }

            fun peak(fc: Double, gainDb: Double, q: Double, fs: Double): Biquad {
                val A = 10.0.pow(gainDb / 40.0)
                val w0 = 2.0 * PI * fc / fs
                val cw = cos(w0)
                val sw = sin(w0)
                val alpha = sw / (2.0 * q)
                val a0 = 1.0 + alpha / A
                return Biquad(
                    (1.0 + alpha * A) / a0,
                    (-2.0 * cw) / a0,
                    (1.0 - alpha * A) / a0,
                    (-2.0 * cw) / a0,
                    (1.0 - alpha / A) / a0,
                )
            }
        }
    }

    // --- upsamplers -------------------------------------------------------

    private const val FS_16K = 16_000.0

    private fun upsampleDup(pcm8k: ShortArray): ShortArray {
        val out = ShortArray(pcm8k.size * 2)
        for (i in pcm8k.indices) {
            out[i * 2] = pcm8k[i]
            out[i * 2 + 1] = pcm8k[i]
        }
        return out
    }

    /** Linear-interpolation upsample with one-sample carryover across frames. */
    private fun upsampleLinear(pcm8k: ShortArray, carry: FloatArray): ShortArray {
        val out = ShortArray(pcm8k.size * 2)
        var prev = carry[0]
        for (i in pcm8k.indices) {
            val curr = pcm8k[i].toFloat()
            out[i * 2] = clamp16(((prev + curr) / 2.0).toDouble()).toShort()
            out[i * 2 + 1] = pcm8k[i]
            prev = curr
        }
        carry[0] = prev
        return out
    }

    private val polyphase16Kernel: FloatArray by lazy { buildPolyphase16Kernel() }

    private fun buildPolyphase16Kernel(): FloatArray {
        val n = 33
        val half = (n - 1) / 2
        val fc = 0.25
        val k = FloatArray(n)
        var norm = 0f
        for (i in 0 until n) {
            val x = (i - half).toDouble()
            val h = if (x == 0.0) 2.0 * fc else sin(2.0 * PI * fc * x) / (PI * x)
            val w = 0.5 * (1.0 - cos(2.0 * PI * i / (n - 1)))
            k[i] = (h * w).toFloat()
            norm += k[i]
        }
        if (norm != 0f) {
            for (i in 0 until n) k[i] = k[i] / norm
        }
        return k
    }

    /** 33-tap Hann-windowed sinc 8 → 16 kHz polyphase upsample. Same kernel
     *  shape as the web's `upsamplePolyphase8To16` so the response matches. */
    private fun upsamplePolyphase(pcm8k: ShortArray): ShortArray {
        val kernel = polyphase16Kernel
        val half = (kernel.size - 1) / 2
        val out = ShortArray(pcm8k.size * 2)
        for (n in out.indices) {
            val phase = n and 1
            val centreIn = n shr 1
            if (phase == 0) {
                out[n] = if (centreIn in pcm8k.indices) pcm8k[centreIn] else 0
            } else {
                var acc = 0.0
                for (k in -half..half) {
                    val inIdx = centreIn + k
                    val sample =
                        if (inIdx in pcm8k.indices) pcm8k[inIdx].toDouble() else 0.0
                    acc += sample * kernel[k + half]
                }
                out[n] = clamp16(acc).toShort()
            }
        }
        return out
    }

    // --- soft saturation --------------------------------------------------

    private fun applySoftSaturation(pcm: ShortArray, amount: Float) {
        val clamped = amount.coerceIn(0f, 1f)
        if (clamped == 0f) return
        val drive = 1.0 + clamped * 2.0
        val norm = 1.0 / tanh(drive)
        for (i in pcm.indices) {
            val x = pcm[i] / 32768.0
            pcm[i] = clamp16(tanh(x * drive) * norm * 32768.0).toShort()
        }
    }

    // --- helpers ----------------------------------------------------------

    private fun clamp16(x: Double): Int {
        if (x > 32767.0) return 32767
        if (x < -32768.0) return -32768
        return x.roundToInt()
    }

    private fun buildStages(cfg: Config): List<Biquad> {
        val stages = mutableListOf<Biquad>()
        if (cfg.hpfEnabled) {
            stages.add(Biquad.highpass(cfg.hpfHz.toDouble(), 0.707, FS_16K))
        }
        if (cfg.lpfEnabled) {
            stages.add(Biquad.lowpass(cfg.lpfHz.toDouble(), 0.707, FS_16K))
        }
        if (cfg.lowShelfEnabled) {
            stages.add(Biquad.lowShelf(cfg.lowShelfHz.toDouble(), cfg.lowShelfDb.toDouble(), FS_16K))
        }
        if (cfg.highShelfEnabled) {
            stages.add(
                Biquad.highShelf(cfg.highShelfHz.toDouble(), cfg.highShelfDb.toDouble(), FS_16K),
            )
        }
        if (cfg.presenceEnabled) {
            stages.add(
                Biquad.peak(
                    cfg.presenceHz.toDouble(),
                    cfg.presenceDb.toDouble(),
                    max(0.1, cfg.presenceQ.toDouble()),
                    FS_16K,
                ),
            )
        }
        return stages
    }
}
