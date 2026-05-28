package com.securityradio.ptt.device

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Opus encoder + decoder backed by Android's built-in `MediaCodec`. Opus
 * encode + decode are mandatory MediaCodec types as of Android 10
 * (API 29); on older devices `createDecoderByType("audio/opus")` throws
 * and both wrappers report `isReady = false` — the registry then falls
 * back to IMBE on TX and inbound Opus frames drop with a log instead of
 * being played as garbage.
 *
 * Voice profile (matches iOS AudioToolbox and web WebCodecs):
 *  - sample rate: 16 000 Hz
 *  - channels: 1 (mono)
 *  - frame size: 20 ms (320 samples)
 *  - bitrate: 20 kbps
 *
 * Wire format: 2-byte magic (0x4F 0x70) + opaque Opus packet. Packet
 * size varies per frame (DTX, complexity), so receivers identify the
 * codec by magic, not by length.
 *
 * Why MediaCodec instead of a vendored libopus: zero new dependencies,
 * works on the system codec service that ships on every modern Android
 * handset, no NDK build to maintain, and the failure mode (graceful
 * fallback to IMBE) is the same behavior the registry already handles.
 */

private const val TAG = "OpusVoiceCodec"
private const val MIME_TYPE = "audio/opus"
private const val SAMPLE_RATE = 16_000
private const val CHANNELS = 1
private const val FRAME_SAMPLES = 320            // 20 ms @ 16 kHz
private const val FRAME_BYTES = FRAME_SAMPLES * 2 // PCM-16
private const val BITRATE = 20_000
private const val DEQUEUE_TIMEOUT_US = 20_000L   // 20 ms — one frame period

/** Build the OpusHead identification header MediaCodec expects as csd-0
 *  for the decoder. We have to construct it locally because the wire
 *  format only carries raw Opus packets — peers don't ship the header.
 *  Layout: RFC 7845 §5.1. */
private fun buildOpusHead(channels: Int, preSkip: Int, inputSampleRate: Int): ByteArray {
    val buf = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
    buf.put("OpusHead".toByteArray(Charsets.US_ASCII))   // 8 bytes
    buf.put(1.toByte())                                  // version
    buf.put(channels.toByte())                           // channel count
    buf.putShort(preSkip.toShort())                      // pre-skip samples
    buf.putInt(inputSampleRate)                          // original sample rate
    buf.putShort(0)                                      // output gain Q7.8
    buf.put(0.toByte())                                  // channel mapping family
    return buf.array()
}

private fun longLeBuffer(value: Long): ByteBuffer {
    val buf = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
    buf.putLong(value)
    buf.flip()
    return buf
}

class OpusEncoder : VoiceEncoder {
    override val codec: VoiceCodec = VoiceCodec.OPUS

    private val lock = Any()
    private var mediaCodec: MediaCodec? = null
    private val bufferInfo = MediaCodec.BufferInfo()
    private var presentationTimeUs: Long = 0

    init {
        try {
            val format = MediaFormat.createAudioFormat(MIME_TYPE, SAMPLE_RATE, CHANNELS)
            format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
            val mc = MediaCodec.createEncoderByType(MIME_TYPE)
            mc.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            mc.start()
            mediaCodec = mc
        } catch (t: Throwable) {
            // Most commonly: Opus encode isn't on this device (Android < 10
            // or a stripped vendor image). Registry falls back to IMBE.
            Log.w(TAG, "Opus encoder unavailable — falling back to IMBE on TX", t)
            mediaCodec = null
        }
    }

    override val isReady: Boolean get() = mediaCodec != null

    override fun resetForTalkSpurt() {
        synchronized(lock) {
            val mc = mediaCodec ?: return
            try {
                mc.flush()
                presentationTimeUs = 0
            } catch (t: Throwable) {
                Log.w(TAG, "Opus encoder flush failed", t)
            }
        }
    }

    override fun encodeFrame(pcm16kLe640: ByteArray): ByteArray? {
        if (pcm16kLe640.size != FRAME_BYTES) return null
        synchronized(lock) {
            val mc = mediaCodec ?: return null

            val inputId = try {
                mc.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
            } catch (t: Throwable) {
                Log.w(TAG, "Opus encoder dequeueInputBuffer threw", t)
                return null
            }
            if (inputId < 0) {
                // The encoder's input ring is full — drop this frame rather
                // than wait. The wall-clock pacing on the capture side
                // means there'll be another input opportunity in 20 ms.
                return null
            }
            val inBuf = mc.getInputBuffer(inputId) ?: return null
            inBuf.clear()
            inBuf.put(pcm16kLe640)
            mc.queueInputBuffer(inputId, 0, FRAME_BYTES, presentationTimeUs, 0)
            presentationTimeUs += 20_000L

            // Drain output. The encoder may emit a CODEC_CONFIG buffer
            // (CSD) first; we skip it because the wire format doesn't
            // carry headers — peers reconstruct CSD locally from known
            // codec params.
            while (true) {
                val outputId = try {
                    mc.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
                } catch (t: Throwable) {
                    Log.w(TAG, "Opus encoder dequeueOutputBuffer threw", t)
                    return null
                }
                when {
                    outputId == MediaCodec.INFO_TRY_AGAIN_LATER -> return null
                    outputId == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> continue
                    outputId == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> continue
                    outputId < 0 -> return null
                    else -> {
                        val isCodecConfig =
                            (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                        if (isCodecConfig) {
                            mc.releaseOutputBuffer(outputId, false)
                            continue
                        }
                        val outBuf = mc.getOutputBuffer(outputId)
                        if (outBuf == null || bufferInfo.size <= 0) {
                            mc.releaseOutputBuffer(outputId, false)
                            return null
                        }
                        val opusBytes = ByteArray(bufferInfo.size)
                        outBuf.position(bufferInfo.offset)
                        outBuf.limit(bufferInfo.offset + bufferInfo.size)
                        outBuf.get(opusBytes)
                        mc.releaseOutputBuffer(outputId, false)

                        val packet = ByteArray(2 + opusBytes.size)
                        packet[0] = codec.magic0
                        packet[1] = codec.magic1
                        System.arraycopy(opusBytes, 0, packet, 2, opusBytes.size)
                        return packet
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            return null
        }
    }

    /** Release MediaCodec resources. Should be called when the codec is
     *  no longer needed (e.g. transport disconnect). Idempotent. */
    fun close() {
        synchronized(lock) {
            val mc = mediaCodec ?: return
            mediaCodec = null
            try { mc.stop() } catch (_: Throwable) {}
            try { mc.release() } catch (_: Throwable) {}
        }
    }
}

class OpusDecoder : VoiceDecoder {
    override val codec: VoiceCodec = VoiceCodec.OPUS
    override val nativeSampleRate: Int = SAMPLE_RATE

    private val lock = Any()
    private var mediaCodec: MediaCodec? = null
    private val bufferInfo = MediaCodec.BufferInfo()
    private var presentationTimeUs: Long = 0

    init {
        try {
            val format = MediaFormat.createAudioFormat(MIME_TYPE, SAMPLE_RATE, CHANNELS)
            // MediaCodec's Opus decoder needs three codec-specific buffers
            // before it'll accept data — RFC-derived header + two timing hints.
            // Pre-skip = 312 samples is libopus's default SILK warmup; codec
            // delay reports the same as nanoseconds. Seek pre-roll is the
            // platform's default (80 ms) — irrelevant for live streaming
            // since we never seek.
            format.setByteBuffer("csd-0", ByteBuffer.wrap(buildOpusHead(CHANNELS, 312, SAMPLE_RATE)))
            format.setByteBuffer("csd-1", longLeBuffer(312L * 1_000_000_000L / 48_000L))
            format.setByteBuffer("csd-2", longLeBuffer(80_000_000L))
            val mc = MediaCodec.createDecoderByType(MIME_TYPE)
            mc.configure(format, null, null, 0)
            mc.start()
            mediaCodec = mc
        } catch (t: Throwable) {
            Log.w(TAG, "Opus decoder unavailable — inbound Opus frames will drop", t)
            mediaCodec = null
        }
    }

    override val isReady: Boolean get() = mediaCodec != null

    override fun resetForTalkSpurt() {
        synchronized(lock) {
            val mc = mediaCodec ?: return
            try {
                mc.flush()
                presentationTimeUs = 0
            } catch (t: Throwable) {
                Log.w(TAG, "Opus decoder flush failed", t)
            }
        }
    }

    override fun decodeFrame(framedBytes: ByteArray): ShortArray? {
        if (framedBytes.size < 3) return null
        if (framedBytes[0] != codec.magic0 || framedBytes[1] != codec.magic1) return null
        synchronized(lock) {
            val mc = mediaCodec ?: return null
            val payloadSize = framedBytes.size - 2

            val inputId = try {
                mc.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
            } catch (t: Throwable) {
                Log.w(TAG, "Opus decoder dequeueInputBuffer threw", t)
                return null
            }
            if (inputId < 0) return null
            val inBuf = mc.getInputBuffer(inputId) ?: return null
            inBuf.clear()
            inBuf.put(framedBytes, 2, payloadSize)
            mc.queueInputBuffer(inputId, 0, payloadSize, presentationTimeUs, 0)
            presentationTimeUs += 20_000L

            while (true) {
                val outputId = try {
                    mc.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
                } catch (t: Throwable) {
                    Log.w(TAG, "Opus decoder dequeueOutputBuffer threw", t)
                    return null
                }
                when {
                    outputId == MediaCodec.INFO_TRY_AGAIN_LATER -> return null
                    outputId == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> continue
                    outputId == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> continue
                    outputId < 0 -> return null
                    else -> {
                        val isCodecConfig =
                            (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                        if (isCodecConfig) {
                            mc.releaseOutputBuffer(outputId, false)
                            continue
                        }
                        val outBuf = mc.getOutputBuffer(outputId)
                        if (outBuf == null || bufferInfo.size <= 0) {
                            mc.releaseOutputBuffer(outputId, false)
                            return null
                        }
                        outBuf.position(bufferInfo.offset)
                        outBuf.limit(bufferInfo.offset + bufferInfo.size)
                        val shorts = outBuf.order(ByteOrder.nativeOrder()).asShortBuffer()
                        val samples = ShortArray(shorts.remaining())
                        shorts.get(samples)
                        mc.releaseOutputBuffer(outputId, false)
                        return normalizeFrame(samples)
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            return null
        }
    }

    /** Release MediaCodec resources. Idempotent. */
    fun close() {
        synchronized(lock) {
            val mc = mediaCodec ?: return
            mediaCodec = null
            try { mc.stop() } catch (_: Throwable) {}
            try { mc.release() } catch (_: Throwable) {}
        }
    }

    /** WebCodecs packets occasionally decode to slightly off-size buffers;
     *  resample to exactly 20 ms @ 16 kHz so playout pacing stays correct. */
    private fun normalizeFrame(samples: ShortArray): ShortArray {
        if (samples.size == FRAME_SAMPLES) return samples
        if (samples.isEmpty()) return samples
        val out = ShortArray(FRAME_SAMPLES)
        val last = samples.lastIndex
        for (i in 0 until FRAME_SAMPLES) {
            val srcPos = i.toFloat() * last / (FRAME_SAMPLES - 1).coerceAtLeast(1)
            val idx = srcPos.toInt().coerceIn(0, last)
            val frac = srcPos - idx
            val a = samples[idx].toInt()
            val b = samples[minOf(idx + 1, last)].toInt()
            val v = (a + (b - a) * frac).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[i] = v.toShort()
        }
        return out
    }
}
