import AVFoundation
import Foundation

/// Software jitter buffer + PLC (packet-loss concealment) for inbound voice.
///
/// Mirrors the Android `InboundJitterBuffer` so the cutout behaviour stays
/// consistent across handset platforms. The voice relay forwards frames the
/// instant they arrive over WebSocket with no smoothing on either side, so
/// network jitter therefore lands directly on playout — without a jitter
/// buffer the AVAudioPlayerNode runs out of scheduled buffers during a stall
/// and the handset goes silent, heard by the operator as a hard cutout.
///
/// This buffer sits between IMBE/Codec2/Opus decode and AVAudioPlayerNode:
///   - Producer calls `enqueue` as decoded PCM frames arrive.
///   - A dedicated pacer thread drains the queue at a fixed wall-clock cadence
///     and calls `scheduleBuffer` on the player.
///   - When the queue is empty at pacer time (a real underrun), the loop
///     synthesises a concealment frame from the last good frame with a short
///     linear fade to silence, instead of letting the player underrun.
///
/// On a fresh talk-spurt the buffer waits for ~60 ms of audio before starting
/// playout so a brief opening jitter spike does not immediately trigger PLC.
/// Long pauses between transmissions (`>300 ms`) reset state so the next
/// talker starts cleanly without inherited PLC bleed.
final class InboundJitterBuffer {

    /// Frame the player consumes — float32 mono at the playback sample rate.
    private let playerFormat: AVAudioFormat
    private let player: AVAudioPlayerNode

    private let lock = NSLock()
    /// FIFO of 16 kHz mono PCM16 LE frames (raw Data as the decoder produces).
    private var queue: [Data] = []
    private var lastGoodFrame: Data?
    private var plcCount: Int = 0
    private var lastEnqueueAt: TimeInterval = 0
    private var running = false
    private var released = false
    private var thread: Thread?

    /// Wall-clock pacing keeps playout cadence independent of how the audio
    /// engine's render loop happens to be aligned; the engine still absorbs
    /// sub-frame jitter on top of that.
    private let frameMs: Double = 20.0

    /// Initial cushion: 6 × 20 ms ≈ 120 ms before the first scheduleBuffer call. Bumped from
    /// 60 ms after field reports of cutting-out on cellular — WebSocket runs over TCP, so a
    /// single upstream loss triggers a retransmission burst that can stall arrival for
    /// 100–200 ms. 120 ms of cushion absorbs typical retransmit windows without underrunning.
    /// Trade-off: +60 ms steady-state mouth-to-ear latency. Still well under PTT perceptual
    /// expectation (~400 ms before operators notice "lag").
    private let initialTargetFrames: Int = 6
    private let initialTimeoutMs: Double = 300.0

    /// Worst-case buffered audio. 30 × 20 ms ≈ 600 ms — bumped from 320 ms so a longer
    /// retransmission stall accumulates instead of dropping frames. Steady-state latency is
    /// still governed by `initialTargetFrames` and the playout drain rate.
    private let maxBufferFrames: Int = 30

    /// Talk-spurt boundary; matches the relay air-claim window so an operator
    /// gap between transmissions clears stale state cleanly.
    private let talkSpurtGapSeconds: TimeInterval = 0.3

    /// Number of PLC frames synthesised before falling to silence.
    private let plcFadeFrames: Int = 3

    /// 20 ms of silence at 16 kHz mono PCM16 = 640 bytes.
    private let silenceFrame = Data(count: 640)

    init(player: AVAudioPlayerNode, playerFormat: AVAudioFormat) {
        self.player = player
        self.playerFormat = playerFormat
    }

    deinit {
        // Best-effort shutdown if the owner forgot to call stop.
        release()
    }

    /// Enqueue one decoded PCM16 LE frame. Non-blocking; the producer never
    /// waits on the player.
    func enqueue(_ pcm16: Data) {
        guard !pcm16.isEmpty else { return }
        var startThread = false
        lock.lock()
        if released { lock.unlock(); return }
        if thread == nil {
            running = true
            startThread = true
        }
        let now = ProcessInfo.processInfo.systemUptime
        if lastEnqueueAt != 0, now - lastEnqueueAt > talkSpurtGapSeconds {
            // Fresh talk-spurt — drop any stale tail so the new talker is not
            // preceded by a faded-out copy of the last one.
            queue.removeAll(keepingCapacity: true)
            lastGoodFrame = nil
            plcCount = 0
        }
        lastEnqueueAt = now
        queue.append(pcm16)
        // Hard cap on accumulated latency.
        while queue.count > maxBufferFrames {
            queue.removeFirst()
        }
        lock.unlock()

        if startThread {
            // Spin up the pacer outside the lock so the new thread's first
            // acquisition isn't fighting our own release.
            let t = Thread { [weak self] in self?.playoutLoop() }
            t.name = "voice-jitter-playout"
            t.qualityOfService = .userInteractive
            // Hold a reference inside the lock so stop() can reach it.
            lock.lock()
            if released {
                lock.unlock()
                return
            }
            thread = t
            lock.unlock()
            t.start()
        }
    }

    /// Stop the pacer. The buffer is reusable after this; the next enqueue
    /// spins a fresh pacer.
    func stop() {
        let captured: Thread?
        lock.lock()
        running = false
        captured = thread
        thread = nil
        queue.removeAll(keepingCapacity: true)
        lastGoodFrame = nil
        plcCount = 0
        lastEnqueueAt = 0
        lock.unlock()
        captured?.cancel()
    }

    /// Permanent teardown; further `enqueue` calls are no-ops.
    func release() {
        lock.lock()
        released = true
        lock.unlock()
        stop()
    }

    // MARK: - private

    private func playoutLoop() {
        // Initial cushion: wait for a small target depth before the first
        // scheduleBuffer call so an opening burst-then-stall does not
        // immediately PLC.
        let waitStart = ProcessInfo.processInfo.systemUptime
        while !Thread.current.isCancelled {
            lock.lock()
            let go = !running || queue.count >= initialTargetFrames
            lock.unlock()
            if go { break }
            if (ProcessInfo.processInfo.systemUptime - waitStart) * 1000 >= initialTimeoutMs { break }
            Thread.sleep(forTimeInterval: 0.020)
        }

        var nextDeadline = ProcessInfo.processInfo.systemUptime
        while !Thread.current.isCancelled {
            let sleepSec = nextDeadline - ProcessInfo.processInfo.systemUptime
            if sleepSec > 0 {
                Thread.sleep(forTimeInterval: sleepSec)
            }

            lock.lock()
            if !running {
                lock.unlock()
                return
            }
            let frame: Data
            if !queue.isEmpty {
                frame = queue.removeFirst()
                lastGoodFrame = frame
                plcCount = 0
            } else {
                frame = synthesizePlc()
                plcCount += 1
            }
            lock.unlock()

            scheduleFrame(frame)

            // Pace by the real audio duration of the frame so variable-size
            // chunks (e.g. clear-PCM fallback when no vocoder is loaded) still
            // play out at the correct rate.
            let frameSec = Double(frame.count) / (Double(playerFormat.sampleRate) * 2.0)
            nextDeadline += max(frameSec, 0.001)
        }
    }

    /// Conceal an underrun by re-emitting the most recent frame with a linear
    /// fade across `plcFadeFrames` iterations, then silence. A short fade
    /// masks an isolated late frame; the silence floor prevents a long stall
    /// from looping a stuck note. Must be called with the lock held.
    private func synthesizePlc() -> Data {
        guard let last = lastGoodFrame else { return silenceFrame }
        if plcCount >= plcFadeFrames { return Data(count: last.count) }
        let gain = Float(1.0 - Double(plcCount + 1) / Double(plcFadeFrames + 1))
        return scalePcm16(last, gain: gain)
    }

    private func scalePcm16(_ chunk: Data, gain: Float) -> Data {
        var out = Data(count: chunk.count)
        out.withUnsafeMutableBytes { rawOut in
            chunk.withUnsafeBytes { rawIn in
                guard let outBase = rawOut.baseAddress, let inBase = rawIn.baseAddress else { return }
                let inPtr = inBase.assumingMemoryBound(to: Int16.self)
                let outPtr = outBase.assumingMemoryBound(to: Int16.self)
                let count = chunk.count / 2
                for i in 0..<count {
                    let scaled = Int32(Float(inPtr[i]) * gain)
                    outPtr[i] = Int16(clamping: scaled)
                }
            }
        }
        return out
    }

    private func scheduleFrame(_ pcm16: Data) {
        guard pcm16.count >= 2 else { return }
        let frames = AVAudioFrameCount(pcm16.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: frames) else { return }
        buffer.frameLength = frames

        guard let floatChannel = buffer.floatChannelData?[0] else { return }
        pcm16.withUnsafeBytes { raw in
            let int16Ptr = raw.bindMemory(to: Int16.self)
            for i in 0..<Int(frames) {
                floatChannel[i] = Float(int16Ptr[i]) / 32_768.0
            }
        }
        player.scheduleBuffer(buffer, completionHandler: nil)
    }
}
