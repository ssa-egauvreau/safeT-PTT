package com.securityradio.ptt.device

import android.media.AudioTrack
import android.os.SystemClock
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Adaptive software jitter buffer + PLC (packet-loss concealment) for inbound voice.
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
 * Adaptive cushion: playout starts (and, after an underrun, resumes) only once
 * [targetFrames] of audio are queued. The target starts at
 * [MIN_TARGET_FRAMES] (~80 ms) and grows by [TARGET_STEP_FRAMES] on every
 * underrun up to [MAX_TARGET_FRAMES] (~240 ms), so a link that keeps stalling
 * automatically trades a little latency for stability — the same strategy
 * commercial PTT apps use to stay smooth on jittery cellular. A talk-spurt
 * that completes without a single underrun decays the target by one frame, so
 * the buffer drifts back toward minimum latency once the link recovers.
 *
 * Re-buffering after an underrun matters as much as the cushion itself: the
 * old fixed-depth design drained every frame the instant it arrived after the
 * first stall, so one late frame became a machine-gun stutter of
 * PLC/late/PLC/late for the rest of the transmission. Now an underrun plays
 * the short PLC fade, then holds (feeding the HAL silence so OEM tracks never
 * starve) until the cushion is rebuilt — one clean gap instead of sustained
 * garble.
 *
 * Long pauses between transmissions ([TALK_SPURT_GAP_MS]) reset per-spurt
 * state so the next talker starts cleanly without inherited PLC bleed.
 *
 * Idle teardown: after [IDLE_RELEASE_MS] with no real inbound frames the playout
 * loop releases the AudioTrack and exits instead of streaming silence forever.
 * An always-on output keeps the audio route powered, which on accessories with a
 * built-in amplifier (e.g. amplified PTT earpieces) is heard as a constant buzz
 * between transmissions until the device reboots. Releasing the track lets that
 * route — and the accessory's amp — power down; the next [enqueue] lazily
 * recreates the track exactly as the first frame did. The threshold is held
 * well above [TALK_SPURT_GAP_MS]: a mid-transmission network stall must NOT
 * tear the track down, or the recovery pays track re-init on top of the stall.
 */
class InboundJitterBuffer(
    private val trackFactory: () -> AudioTrack?,
    /**
     * Output pan. [StereoPan.NONE] writes the queued mono PCM straight to a mono
     * AudioTrack (the default). [StereoPan.LEFT]/[StereoPan.RIGHT] expand each
     * mono frame to interleaved stereo just before it is written, placing the
     * audio in one ear and silence in the other — used by the optional
     * main-left / scan-right channel split. All queue, PLC and pacing logic
     * stays mono; only the final write is widened.
     */
    private val pan: StereoPan = StereoPan.NONE,
    /**
     * Returns `true` while a Bluetooth output is connected. It raises the per-spurt startup
     * cushion (see [effectiveTargetFrames]) so the A2DP link's cold-start ramp doesn't clip the
     * opening syllable. It does NOT keep the track alive: idle teardown still releases the track
     * after [IDLE_RELEASE_MS] so the route — and any amplified accessory's amp — powers down
     * instead of buzzing on an always-on output. The extra cushion is what covers the cold start
     * when the next spurt arrives on a route that has since slept.
     */
    private val bluetoothConnectedProvider: () -> Boolean = { false },
) {

    private val lock = ReentrantLock()
    private val queue = ArrayDeque<ByteArray>()
    private var lastGoodFrame: ByteArray? = null
    private var plcCount = 0
    private var lastEnqueueMs = 0L

    /** Adaptive playout cushion, in frames. Guarded by [lock]. */
    private var targetFrames = MIN_TARGET_FRAMES

    /** True while playout is held waiting for the cushion to (re)build. */
    private var buffering = true
    private var bufferingStartMs = 0L

    /** True once the current contiguous underrun event has been counted. */
    private var inUnderrun = false

    /** True when the current talk-spurt has had at least one underrun —
     *  drives the target decay decision at the next spurt boundary. */
    private var spurtHadUnderrun = false
    private var sawSpurt = false

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
                buffering = true
                bufferingStartMs = SystemClock.elapsedRealtime()
                thread = Thread({ playoutLoop(t) }, "voice-jitter-playout").apply {
                    isDaemon = true
                    start()
                }
            }
            val now = SystemClock.elapsedRealtime()
            if (lastEnqueueMs != 0L && now - lastEnqueueMs > TALK_SPURT_GAP_MS) {
                // A fresh talk-spurt — drop any stale tail so the new talker
                // is not preceded by a faded-out copy of the last one, and
                // rebuild the cushion so this spurt starts with full margin
                // instead of draining frame-for-frame from depth zero.
                queue.clear()
                lastGoodFrame = null
                plcCount = 0
                inUnderrun = false
                buffering = true
                bufferingStartMs = now
                // Adaptive decay: a previous spurt that never underran earns
                // one frame of latency back, down to the minimum cushion.
                if (sawSpurt && !spurtHadUnderrun && targetFrames > MIN_TARGET_FRAMES) {
                    targetFrames--
                }
                spurtHadUnderrun = false
            }
            sawSpurt = true
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
            buffering = true
            bufferingStartMs = 0L
            inUnderrun = false
            spurtHadUnderrun = false
            sawSpurt = false
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
        try {
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

                // null = stop or idle teardown: leave the loop and release the
                // track in the finally below so the audio route powers down.
                val frame = nextPlayoutFrame() ?: break

                // Widen to interleaved stereo for a panned buffer right before the
                // write; pacing below still uses the mono frame size so the
                // wall-clock cadence is unchanged.
                val outFrame = panToOutput(frame)
                try {
                    t.write(outFrame, 0, outFrame.size)
                } catch (_: IllegalStateException) {
                    break
                }

                // Pace by the real audio duration of the frame so variable-size
                // chunks (e.g. clear-PCM fallback when the JNI vocoder is missing)
                // still play out at the correct rate.
                nextDeadline += frameDurationMs(frame.size)
            }
        } finally {
            releaseTrackIfCurrent(t)
        }
    }

    /**
     * Release [t] iff it is still this buffer's current track. Whoever nulls
     * `track` under the lock owns the release, so this is safe to race against
     * [stop]: exactly one of them finds `track === t` and releases it, the
     * other no-ops — the AudioTrack is never double-released.
     */
    private fun releaseTrackIfCurrent(t: AudioTrack) {
        lock.withLock {
            if (track !== t) return
            running = false
            track = null
            thread = null
        }
        runCatching {
            if (t.playState == AudioTrack.PLAYSTATE_PLAYING) {
                t.pause()
                t.flush()
            }
        }
        runCatching { t.release() }
    }

    /** Pulls one frame for the pacer: queued audio once the cushion is built,
     *  a PLC fade frame on a fresh underrun, or silence while (re)buffering —
     *  the HAL keeps getting fed either way so OEM tracks never starve.
     *  Returns null when the pacer should exit — either the buffer has been
     *  stopped or it has been idle past [IDLE_RELEASE_MS] (in which case
     *  `running` is cleared here so the track is released and the route powers
     *  down). */
    private fun nextPlayoutFrame(): ByteArray? {
        lock.withLock {
            if (!running) return null
            val now = SystemClock.elapsedRealtime()

            if (queue.isNotEmpty()) {
                if (buffering && !cushionReady(now)) {
                    // Cushion still building; bridge with silence. Only the
                    // post-underrun rebuild counts as concealment — at spurt
                    // start nothing has been missed yet (the hold is latency,
                    // not loss), so counting it would charge every clean
                    // transmission ~4 phantom PLC frames.
                    if (inUnderrun && inActiveSpurt(now)) {
                        VoiceLinkTelemetryReporter.recordPlcSynthesized()
                    }
                    return SILENCE_FRAME
                }
                buffering = false
                val f = queue.removeFirst()
                lastGoodFrame = f
                plcCount = 0
                inUnderrun = false
                return f
            }

            // Queue empty. Once we've been idle past the release threshold,
            // stop the loop (return null) so the finally releases the track and
            // the audio route — and any amplified accessory's amp — powers down
            // instead of buzzing on an always-on output. The next enqueue()
            // lazily recreates the track, mirroring first-frame startup.
            // This now applies on Bluetooth too: holding the link warm forever
            // left the silent ear of a stereo split reproducing the head unit's
            // amp noise as a constant static buzz. The link is allowed to sleep;
            // the larger Bluetooth startup cushion ([effectiveTargetFrames])
            // masks the cold-start ramp on the next spurt instead.
            if (lastEnqueueMs != 0L && now - lastEnqueueMs >= IDLE_RELEASE_MS) {
                running = false
                return null
            }

            // Voice-link telemetry: only count concealment that happens DURING
            // an active talk-spurt (within TALK_SPURT_GAP_MS of the last
            // received frame). Between transmissions the queue is empty on
            // every tick too — counting that dead air would swamp the PLC
            // ratio with channel idle time and a merely-quiet unit would read
            // ~99% "loss" on the Link Health dashboard.
            if (inActiveSpurt(now)) {
                if (!inUnderrun) {
                    // First empty tick of a contiguous underrun event: count it
                    // once (outage frequency vs. concealment volume) and widen
                    // the cushion so the next stall has more margin.
                    inUnderrun = true
                    spurtHadUnderrun = true
                    targetFrames = minOf(targetFrames + TARGET_STEP_FRAMES, MAX_TARGET_FRAMES)
                    VoiceLinkTelemetryReporter.recordBufferUnderrun()
                }
                VoiceLinkTelemetryReporter.recordPlcSynthesized()
            }

            if (plcCount >= PLC_FADE_FRAMES && !buffering) {
                // Fade exhausted — stop free-running and hold for the cushion
                // to rebuild, so recovery is one clean gap instead of a
                // PLC/late/PLC/late stutter for the rest of the transmission.
                buffering = true
                bufferingStartMs = now
            }
            val plc = synthesizePlc()
            plcCount++
            return plc
        }
    }

    /** True when playout may leave the buffering hold: the cushion has hit the
     *  adaptive target, the producer has gone quiet with a short tail still
     *  queued (talker unkeyed — flush the final syllable instead of dropping
     *  it at idle teardown), or the safety cap on hold time expired. */
    private fun cushionReady(now: Long): Boolean {
        if (queue.size >= effectiveTargetFrames()) return true
        if (lastEnqueueMs != 0L && now - lastEnqueueMs >= TAIL_FLUSH_MS) return true
        if (bufferingStartMs != 0L && now - bufferingStartMs >= MAX_BUFFER_WAIT_MS) return true
        return false
    }

    private fun inActiveSpurt(now: Long): Boolean =
        lastEnqueueMs != 0L && now - lastEnqueueMs <= TALK_SPURT_GAP_MS

    /**
     * Cushion to build before a spurt starts playing. On a Bluetooth link
     * ([bluetoothConnectedProvider]) the floor is raised so each spurt buffers
     * extra lead-in: the A2DP pipeline has its inherent ramp-up latency, and
     * pre-rolling more silence before the first voice frame keeps that ramp from
     * eating the opening syllable — which matters more now that the link is left
     * to sleep between spurts. Wired/built-in routes keep the low-latency floor.
     */
    private fun effectiveTargetFrames(): Int =
        if (bluetoothConnectedProvider()) maxOf(targetFrames, BT_MIN_TARGET_FRAMES) else targetFrames

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

    /**
     * Expand a mono PCM16 frame to interleaved stereo for a panned buffer,
     * placing the samples in one channel and silence in the other. Returns the
     * frame untouched for [StereoPan.NONE] (the common mono path).
     */
    private fun panToOutput(monoFrame: ByteArray): ByteArray {
        if (pan == StereoPan.NONE) return monoFrame
        val out = ByteArray(monoFrame.size * 2)
        val rightChannel = pan == StereoPan.RIGHT
        var i = 0
        var o = 0
        while (i + 1 < monoFrame.size) {
            // Left pair is [o, o+1]; right pair is [o+2, o+3]. The silent
            // channel stays zero (out is zero-initialised).
            val dst = if (rightChannel) o + 2 else o
            out[dst] = monoFrame[i]
            out[dst + 1] = monoFrame[i + 1]
            i += 2
            o += 4
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

        // Adaptive cushion bounds. The floor (4 × 20 ms ≈ 80 ms) matches the
        // old fixed cushion; the ceiling (12 × 20 ms ≈ 240 ms) is what a
        // chronically jittery cellular link can earn — still well below the
        // ~400 ms a PTT operator perceives as lag. Each underrun widens the
        // target by TARGET_STEP_FRAMES; each clean spurt narrows it by one.
        const val MIN_TARGET_FRAMES = 4
        const val MAX_TARGET_FRAMES = 12
        const val TARGET_STEP_FRAMES = 2

        // Startup cushion floor on a Bluetooth link (16 × 20 ms ≈ 320 ms). The
        // A2DP pipeline can't start instantly, so each spurt pre-rolls this much
        // before the first voice frame to keep the link's ramp-up from clipping
        // the opening syllable. Raised from 160 ms — on rugged BT head units the
        // link still woke slowly enough to swallow the first word (e.g. the "27"
        // of "27-000"); the extra cushion trades ~160 ms of latency for the
        // opening syllable surviving. Only applies while a BT output is connected.
        const val BT_MIN_TARGET_FRAMES = 16

        // Worst-case buffered audio: 50 × 20 ms ≈ 1 s. Sized so a TCP
        // retransmit burst after a long stall is absorbed (and played out,
        // late) instead of dropping its oldest frames as garble. The added
        // latency lasts at most one transmission — the talk-spurt boundary
        // clears the queue.
        const val MAX_BUFFER_FRAMES = 50

        // Talk-spurt boundary; matches the relay air-claim window so an
        // operator gap between transmissions clears stale state cleanly.
        const val TALK_SPURT_GAP_MS = 300L

        // Idle teardown threshold. After this long with no real inbound frame
        // the playout loop releases the AudioTrack so the audio route — and any
        // amplified accessory's built-in amp — powers down instead of buzzing
        // on an always-on output. Held well ABOVE the talk-spurt gap: a
        // mid-transmission network stall in the 300 ms–1.5 s range must ride
        // through on the same track, because tearing it down adds track
        // re-init latency on top of the stall and turns a short dropout into
        // a long one (the old value equalled the spurt gap and did exactly
        // that). The cost is ~1.2 s more amp-buzz after the channel goes
        // quiet, which is the lesser evil.
        const val IDLE_RELEASE_MS = 1_500L

        // While re-buffering, a producer quiet for this long with frames still
        // queued means the talker unkeyed — flush the tail instead of holding
        // it (frames arrive every ~20 ms while a transmission is live).
        const val TAIL_FLUSH_MS = 150L

        // Safety cap on any single buffering hold, so playout can never sit
        // on queued audio indefinitely if arrival is somehow slower than
        // real time.
        const val MAX_BUFFER_WAIT_MS = 1_000L

        // Number of PLC frames synthesised before falling to silence.
        const val PLC_FADE_FRAMES = 3

        const val JOIN_TIMEOUT_MS = 200L
        const val FRAME_MS = 20L

        // 20 ms of silence at 16 kHz mono PCM16 = 640 bytes.
        val SILENCE_FRAME = ByteArray(640)
    }
}
