package com.securityradio.ptt.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.SystemClock

/**
 * Plays PCM16 mono 16 kHz streamed from peers through the relay.
 *
 * Two playout modes:
 *
 *  - **Mono (default):** home-channel RX takes priority over scan listen sockets
 *    so two WebSockets cannot interleave samples into one [AudioTrack] (which
 *    causes harsh clipping). One shared [InboundJitterBuffer] paces everything.
 *
 *  - **Stereo split (opt-in, [stereoSplitProvider]):** the home channel plays in
 *    the LEFT ear and scan channels in the RIGHT ear, simultaneously, through
 *    two independent stereo jitter buffers. There is no priority suppression in
 *    this mode — the two streams never share a channel, so they cannot clip each
 *    other. Only enabled when the user setting is on AND the provider says a
 *    stereo-capable output is connected (a mono speaker has no right ear).
 *
 * Inbound PCM is handed to an [InboundJitterBuffer] rather than written directly
 * to AudioTrack so bursty arrival is paced out at a steady cadence and isolated
 * network stalls produce a short fade-to-silence via PLC instead of a hard
 * cutout.
 *
 * [bluetoothConnectedProvider] is forwarded to the jitter buffers: when a
 * Bluetooth output is connected they pre-roll a larger startup cushion so the
 * A2DP link's cold-start ramp doesn't clip the opening syllable of a spurt. (The
 * route is no longer held warm between transmissions — it's allowed to sleep so
 * the silent ear of a stereo split doesn't buzz; the cushion masks the wake-up.)
 */
class InboundVoicePlayer(
    private val lastRxRecorder: LastRxAudioRecorder? = null,
    private val listenGainProvider: () -> Float = { 1f },
    private val onScanRxActivity: ((channelName: String) -> Unit)? = null,
    private val stereoSplitProvider: () -> Boolean = { false },
    private val bluetoothConnectedProvider: () -> Boolean = { false },
    /** Per-ear volume multipliers, applied only in stereo-split mode. 1.0 = unchanged. */
    private val leftVolumeProvider: () -> Float = { 1f },
    private val rightVolumeProvider: () -> Float = { 1f },
) {

    @Volatile
    private var released: Boolean = false

    @Volatile
    private var mainRxHoldUntilMs: Long = 0L

    /** Wall-clock ([SystemClock.elapsedRealtime]) of the last inbound voice frame actually played,
     *  from either the home or scan path. Used to tell the UI sound player the route is already
     *  awake so it can skip the pre-tone Bluetooth wake burst. */
    @Volatile
    private var lastInboundActivityMs: Long = 0L

    /**
     * True when inbound radio voice (home or scan) played within the last [INBOUND_AWAKE_WINDOW_MS],
     * i.e. the audio route is currently being kept awake by live traffic. Lets callers skip waking
     * a route that doesn't need it.
     */
    fun isInboundRecentlyActive(): Boolean {
        val last = lastInboundActivityMs
        return last != 0L && SystemClock.elapsedRealtime() - last <= INBOUND_AWAKE_WINDOW_MS
    }

    /**
     * Store-and-forward queue for scan audio: one scan transmission plays at a
     * time and overlapping ones are buffered and played in arrival order, instead
     * of being dropped. Home channel still preempts in mono mode (it shares the
     * single track); in stereo split, scan has its own ear so home never holds it.
     */
    private val scanQueue = ScanForwardQueue(
        homeHoldUntilProvider = { if (stereoSplitProvider()) 0L else mainRxHoldUntilMs },
        playChunk = { channel, chunk -> playScanChunkNow(channel, chunk) },
        onForwarding = { ch -> onScanRxActivity?.invoke(ch) },
    )

    /** Mono, priority-mixed path (both channels share one track). */
    private val monoBuffer = InboundJitterBuffer(
        trackFactory = { createTrack(AudioFormat.CHANNEL_OUT_MONO) },
        pan = StereoPan.NONE,
        bluetoothConnectedProvider = bluetoothConnectedProvider,
    )

    /** Stereo-split path: home channel in the left ear. */
    private val mainLeftBuffer = InboundJitterBuffer(
        trackFactory = { createTrack(AudioFormat.CHANNEL_OUT_STEREO) },
        pan = StereoPan.LEFT,
        bluetoothConnectedProvider = bluetoothConnectedProvider,
    )

    /** Stereo-split path: scan channels in the right ear. */
    private val scanRightBuffer = InboundJitterBuffer(
        trackFactory = { createTrack(AudioFormat.CHANNEL_OUT_STEREO) },
        pan = StereoPan.RIGHT,
        bluetoothConnectedProvider = bluetoothConnectedProvider,
    )

    @Volatile
    private var stereoActive = false

    /**
     * Switch playout modes, tearing down the tracks the other mode owns so we
     * never run a mono track and the split tracks at the same time. Synchronized
     * because main and scan PCM arrive on separate WebSocket threads.
     */
    @Synchronized
    private fun ensureMode(stereo: Boolean) {
        if (stereo == stereoActive) return
        if (stereo) {
            monoBuffer.stop()
        } else {
            mainLeftBuffer.stop()
            scanRightBuffer.stop()
        }
        stereoActive = stereo
    }

    /** PCM from the tuned (home) channel WebSocket. */
    fun writePcmFromMain(chunk: ByteArray) {
        if (released || chunk.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        mainRxHoldUntilMs = now + MAIN_RX_HOLD_MS
        lastInboundActivityMs = now
        lastRxRecorder?.onInboundPcm(chunk)
        val stereo = stereoSplitProvider()
        val out = applyGain(chunk, if (stereo) leftVolumeProvider() else 1f) ?: return
        ensureMode(stereo)
        if (stereo) mainLeftBuffer.enqueue(out) else monoBuffer.enqueue(out)
    }

    /**
     * PCM from a scan listen socket. Buffered by [scanQueue] (store-and-forward)
     * rather than played immediately, so overlapping scan channels are queued and
     * played one at a time in arrival order instead of fighting / being dropped.
     */
    fun writePcmFromScan(channelName: String, chunk: ByteArray) {
        if (released || chunk.isEmpty()) return
        scanQueue.submit(channelName, chunk)
    }

    /** Play a single scan frame now — invoked by [scanQueue]'s pacer thread once it
     *  reaches this frame's turn. Home-channel priority is enforced by the queue. */
    private fun playScanChunkNow(channelName: String, chunk: ByteArray) {
        if (released || chunk.isEmpty()) return
        lastInboundActivityMs = SystemClock.elapsedRealtime()
        val stereo = stereoSplitProvider()
        val out = applyGain(chunk, if (stereo) rightVolumeProvider() else 1f) ?: return
        ensureMode(stereo)
        if (stereo) scanRightBuffer.enqueue(out) else monoBuffer.enqueue(out)
    }

    /**
     * Apply the listen gain (times an optional per-ear multiplier), returning
     * null when fully muted. [extra] carries the stereo-split left/right volume.
     */
    private fun applyGain(chunk: ByteArray, extra: Float = 1f): ByteArray? {
        // Gain may attenuate (<1) or boost (>1) — a "far away" radio is leveled up
        // over the air. Samples are hard-clamped to int16 in scalePcm16 so a high
        // boost saturates rather than wraps.
        val gain = (listenGainProvider() * extra).coerceIn(0f, 4f)
        if (gain <= 0f) return null
        return if (gain in 0.999f..1.001f) chunk else scalePcm16(chunk, gain)
    }

    private fun scalePcm16(chunk: ByteArray, gain: Float): ByteArray {
        val out = ByteArray(chunk.size)
        var i = 0
        while (i + 1 < chunk.size) {
            val sample = (chunk[i].toInt() and 0xFF) or (chunk[i + 1].toInt() shl 8)
            val scaled = (sample.toShort() * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[i] = (scaled and 0xFF).toByte()
            out[i + 1] = ((scaled shr 8) and 0xFF).toByte()
            i += 2
        }
        return out
    }

    private fun createTrack(channelMask: Int): AudioTrack? {
        val minBuf = AudioTrack.getMinBufferSize(
            VoiceAudioSpecs.SAMPLE_RATE_HZ,
            channelMask,
            VoiceAudioSpecs.PCM_ENCODING,
        )
        if (minBuf <= 0) return null
        /** Extra slack reduces underruns on handset speaker routing with bursty decode output. */
        val bufBytes = maxOf(minBuf * 4, minBuf + 8192)
        val t =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioTrack.Builder()
                    .setAudioAttributes(
                        // USAGE_MEDIA, not USAGE_VOICE_COMMUNICATION: the voice-communication
                        // route is inaudible on the loudspeaker of many rugged LTE handsets,
                        // which left received voice silent. The media path is reliably audible.
                        //
                        // CONTENT_TYPE_MUSIC, not _SPEECH: a SPEECH content type makes some OEM
                        // audio HALs run speech post-processing (noise reduction) on the OUTPUT,
                        // which mangled received radio audio. MUSIC opts the received stream out of
                        // that device-side enhancement; the mic-side NoiseSuppressor is unaffected.
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build(),
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setSampleRate(VoiceAudioSpecs.SAMPLE_RATE_HZ)
                            .setEncoding(VoiceAudioSpecs.PCM_ENCODING)
                            .setChannelMask(channelMask)
                            .build(),
                    )
                    .setBufferSizeInBytes(bufBytes)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build()
            } else {
                @Suppress("DEPRECATION")
                AudioTrack(
                    VoiceAudioSpecs.LEGACY_STREAM_MUSIC,
                    VoiceAudioSpecs.SAMPLE_RATE_HZ,
                    channelMask,
                    VoiceAudioSpecs.PCM_ENCODING,
                    bufBytes,
                    AudioTrack.MODE_STREAM,
                )
            }
        if (t.state != AudioTrack.STATE_INITIALIZED) {
            t.release()
            return null
        }
        t.play()
        return t
    }

    fun stop() {
        scanQueue.stop()
        monoBuffer.stop()
        mainLeftBuffer.stop()
        scanRightBuffer.stop()
        mainRxHoldUntilMs = 0L
    }

    /** Permanently stop playback; instance must not be used after release. */
    fun release() {
        released = true
        scanQueue.release()
        monoBuffer.release()
        mainLeftBuffer.release()
        scanRightBuffer.release()
    }

    private companion object {
        const val MAIN_RX_HOLD_MS = 400L

        /** Inbound voice within this window means the route is still awake from live traffic.
         *  Matches the UI sound player's cold-route idle threshold so the two agree on "awake". */
        const val INBOUND_AWAKE_WINDOW_MS = 700L
    }
}
