package com.securityradio.ptt.device

import android.media.AudioTrack
import android.os.SystemClock
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Software jitter buffer + PLC (packet-loss concealment) for inbound voice.
 *
 * The voice relay forwards voice frames over WebSocket as soon as they
 * arrive, with no smoothing on either side. Network jitter therefore lands
 * directly on playout: bursts of frames followed by stalls. Without a
 * jitter buffer the handset AudioTrack drains during a stall, underruns,
 * and plays silence (or stale samples on some OEM HALs) — heard by the
 * operator as a hard cutout.
 *
 * This buffer sits between the codec decoder and AudioTrack:
 *   - Producer (WebSocket thread) calls [enqueue] as PCM frames arrive.
 *   - A dedicated playout thread drains the queue at a fixed wall-clock cadence
 *     and writes to AudioTrack.
 *   - When the queue is empty at playout time (a real underrun), the loop
 *     synthesises a concealment frame from the last good frame with a short
 *     linear fade to silence, instead of letting AudioTrack underrun.
 *
 * On a fresh talk-spurt the buffer waits for [INITIAL_TARGET_FRAMES] of audio
 * (~60 ms) before starting playout so a brief opening jitter spike does not
 * immediately trigger PLC. Long pauses between transmissions ([TALK_SPURT_GAP_MS])
 * reset state so the next talker starts cleanly without inherited PLC bleed.
 */
class InboundJitterBuffer(
    private val trackFactory: () -> AudioTrack?,
) {

    private val lock = ReentrantLock()
    private val notEmpty = lock.newCondition()
    private val queue = ArrayDeque<ByteArray>()
    private var lastGoodFrame: ByteArray? = null
    private var plcCount = 0
    private var lastEnqueueMs = 0L

    private var track: AudioTrack? = null
    @Volatile
    private var running = false
    @Volatile
    private var released = false
    private var thread: Thread? = null

    fun enqueue(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        lock.withLock {
            if (released) return
            if (track == null) {
                val t = trackFactory() ?: return
                track = t
                running = true
                thread = Thread({ playoutLoop(t) }, "voice-jitter-playout").apply {
                    isDaemon = true
                    start()
                }
            }
            val now = SystemClock.elapsedRealtime()
            if (lastEnqueueMs != 0L && now - lastEnqueueMs > TALK_SPURT_GAP_MS) {
                // A fresh talk-spurt — drop any stale tail so the new talker
                // is not preceded by a faded-out copy of the last one.
                queue.clear()
                lastGoodFrame = null
                plcCount = 0
            }
            lastEnqueueMs = now
            queue.addLast(pcm)
            // Voice-link telemetry: track the peak buffer depth this window so
            // the dashboard can flag a unit that's been driving the queue
            // toward the MAX_BUFFER_FRAMES cap (chronic upstream burstiness).
            VoiceLinkTelemetryReporter.recordBufferDepth(queue.size)
            // Hard cap on accumulated latency. If the producer outpaces the
            // playout (sustained burst with no drain), drop the oldest frame
            // rather than letting the buffer grow without bound.
            while (queue.size > MAX_BUFFER_FRAMES) {
                queue.removeFirst()
            }
            notEmpty.signalAll()
        }
    }

    /** Stop playout and release the AudioTrack. Buffer is reusable after this. */
    fun stop() {
        val t: AudioTrack?
        val th: Thread?
        lock.withLock {
            running = false
            t = track
            th = thread
            track = null
            thread = null
            queue.clear()
            lastGoodFrame = null
            plcCount = 0
            lastEnqueueMs = 0L
            notEmpty.signalAll()
        }
        th?.interrupt()
        try {
            th?.join(JOIN_TIMEOUT_MS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        t?.run {
            try {
                if (playState == AudioTrack.PLAYSTATE_PLAYING) {
                    pause()
                    flush()
                }
            } catch (_: Exception) {
            }
            release()
        }
    }

    /** Permanent teardown; further [enqueue] calls are no-ops. */
    fun release() {
        released = true
        stop()
    }

    private fun playoutLoop(t: AudioTrack) {
        // Initial cushion: wait for a small target depth before the first
        // write so an opening burst-then-stall does not immediately PLC.
        lock.withLock {
            val waitStart = SystemClock.elapsedRealtime()
            while (running && queue.size < INITIAL_TARGET_FRAMES &&
                SystemClock.elapsedRealtime() - waitStart < INITIAL_TIMEOUT_MS
            ) {
                try {
                    notEmpty.await(WAKE_POLL_MS, TimeUnit.MILLISECONDS)
                } catch (_: InterruptedException) {
                    return
                }
            }
        }

        // Wall-clock pacing keeps playout cadence independent of how AudioTrack's
        // internal buffer happens to be sized on this OEM; the AudioTrack
        // hardware buffer still absorbs sub-frame jitter on top of that.
        var nextDeadline = SystemClock.elapsedRealtime()
        while (running) {
            val sleepMs = nextDeadline - SystemClock.elapsedRealtime()
            if (sleepMs > 0) {
                try {
                    Thread.sleep(sleepMs)
                } catch (_: InterruptedException) {
                    break
                }
            }

            val frame = nextPlayoutFrame() ?: return

            try {
                t.write(frame, 0, frame.size)
            } catch (_: IllegalStateException) {
                break
            }

            // Pace by the real audio duration of the frame so variable-size
            // chunks (e.g. clear-PCM fallback when the JNI vocoder is missing)
            // still play out at the correct rate.
            nextDeadline += frameDurationMs(frame.size)
        }
    }

    /** Pulls one frame from the queue (real audio) or synthesises a PLC
     *  frame when the queue is empty at playout time. Returns null when the
     *  pacer should exit (the buffer has been stopped). Split out of
     *  [playoutLoop] so the synchronized section has a clear scope and the
     *  control-flow stays linear. */
    private fun nextPlayoutFrame(): ByteArray? {
        lock.withLock {
            if (!running) return null
            return if (queue.isNotEmpty()) {
                val f = queue.removeFirst()
                lastGoodFrame = f
                plcCount = 0
                f
            } else {
                val plc = synthesizePlc()
                // Voice-link telemetry: only count concealment that happens
                // DURING an active talk-spurt (within TALK_SPURT_GAP_MS of the
                // last received frame). The playout loop runs continuously for
                // the whole session, so between transmissions the queue is
                // empty on every tick too — counting that dead air would swamp
                // the PLC ratio with channel idle time and a merely-quiet unit
                // would read ~99% "loss" on the Link Health dashboard. The PLC
                // fade itself still runs unconditionally so audio is unchanged;
                // only the counters are gated.
                val now = SystemClock.elapsedRealtime()
                val inActiveSpurt = lastEnqueueMs != 0L && now - lastEnqueueMs <= TALK_SPURT_GAP_MS
                if (inActiveSpurt) {
                    // First PLC frame in a contiguous underrun event is also
                    // counted as one "buffer underrun" so the dashboard can
                    // distinguish outage frequency (underruns) from concealment
                    // volume (plc frames).
                    if (plcCount == 0) {
                        VoiceLinkTelemetryReporter.recordBufferUnderrun()
                    }
                    VoiceLinkTelemetryReporter.recordPlcSynthesized()
                }
                plcCount++
                plc
            }
        }
    }

    /**
     * Conceal an underrun by re-emitting the most recent frame with a linear
     * fade across [PLC_FADE_FRAMES] iterations, then silence. A short fade
     * masks an isolated late frame; the silence floor prevents a long stall
     * from looping a stuck note.
     */
    private fun synthesizePlc(): ByteArray {
        val last = lastGoodFrame ?: return SILENCE_FRAME
        if (plcCount >= PLC_FADE_FRAMES) return ByteArray(last.size)
        val gain = 1f - (plcCount + 1f) / (PLC_FADE_FRAMES + 1f)
        return scalePcm16(last, gain)
    }

    private fun scalePcm16(chunk: ByteArray, gain: Float): ByteArray {
        val out = ByteArray(chunk.size)
        var i = 0
        while (i + 1 < chunk.size) {
            val sample = (chunk[i].toInt() and 0xFF) or (chunk[i + 1].toInt() shl 8)
            val scaled = (sample.toShort() * gain).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[i] = (scaled and 0xFF).toByte()
            out[i + 1] = ((scaled shr 8) and 0xFF).toByte()
            i += 2
        }
        return out
    }

    private fun frameDurationMs(byteCount: Int): Long {
        if (byteCount <= 0) return FRAME_MS
        return (byteCount.toLong() * 1000L) / BYTES_PER_SECOND
    }

    private companion object {
        // 16 kHz mono PCM16 — 2 bytes per sample.
        const val BYTES_PER_SECOND = 16_000 * 2

        // Initial cushion: 4 frames × 20 ms ≈ 80 ms before draining. A small
        // step up from the 60 ms minimum to absorb brief cellular retransmit
        // stalls before the playout underruns into PLC, at ~+20 ms latency
        // (still far below the ~400 ms a PTT operator perceives as lag).
        const val INITIAL_TARGET_FRAMES = 4
        const val INITIAL_TIMEOUT_MS = 250L

        // Worst-case buffered audio. 16 × 20 ms ≈ 320 ms.
        const val MAX_BUFFER_FRAMES = 16

        // Talk-spurt boundary; matches the relay air-claim window so an
        // operator gap between transmissions clears stale state cleanly.
        const val TALK_SPURT_GAP_MS = 300L

        // Number of PLC frames synthesised before falling to silence.
        const val PLC_FADE_FRAMES = 3

        const val WAKE_POLL_MS = 20L
        const val JOIN_TIMEOUT_MS = 200L
        const val FRAME_MS = 20L

        // 20 ms of silence at 16 kHz mono PCM16 = 640 bytes.
        val SILENCE_FRAME = ByteArray(640)
    }
}
