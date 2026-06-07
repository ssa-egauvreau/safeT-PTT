package com.securityradio.ptt.device

import com.securityradio.ptt.data.remote.normalizeApiBaseUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.ByteString
import android.util.Log
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import org.json.JSONObject

fun httpApiBaseUrlToVoiceWebSocketUrl(httpBaseUrl: String): String {
    val u = normalizeApiBaseUrl(httpBaseUrl).trimEnd('/')
    val https = "https://"
    val http = "http://"
    val (scheme, remainder) = when {
        u.startsWith(https, ignoreCase = true) ->
            "wss://" to u.drop(https.length).trimStart('/')
        u.startsWith(http, ignoreCase = true) ->
            "ws://" to u.drop(http.length).trimStart('/')
        else -> "wss://" to u.trimStart('/')
    }
    return scheme + remainder + "/v1/voice/stream"
}

/**
 * Half-duplex voice path over the relay WebSocket.
 *
 * - Default transport: PCM 16-bit signed LE mono @ 16000 Hz (Android capture).
 * - Uplink path: encoded with the codec the channel's `joined` reply asks for
 *   (default IMBE), via [VoiceCodecRegistry]. The registry falls back to IMBE
 *   if the requested codec's native lib hasn't loaded; if even IMBE isn't
 *   available, the uplink ships clear PCM.
 * - Downlink: each inbound frame's first two bytes select the right decoder
 *   from the registry, so a channel can mix codecs mid-stream (e.g. during a
 *   `codec_change` roll-out) without any client-side signaling.
 *
 * Codec libs: IMBE via bundled dvmvocoder (GPL — see cpp/dvmvocoder).
 * Codec2 and Opus are registered in [VoiceCodecRegistry] when native libs load.
 */
sealed interface VoiceControlEvent {
    data class Joined(
        val channel: String,
        val permission: String,
        val aiDispatchListenPcm: Boolean = false,
        val recordListenPcm: Boolean = false,
        val codec: VoiceCodec = VoiceCodec.DEFAULT,
    ) : VoiceControlEvent
    /** AI dispatch on this channel — uplink clear PCM instead of IMBE vocoder. */
    data class AiDispatchPcm(val enabled: Boolean) : VoiceControlEvent
    data class Error(val code: String) : VoiceControlEvent
    data class Busy(val holderUnit: String?) : VoiceControlEvent
    /** Dispatcher live-moved this radio to another channel (Live Channel Control). */
    data class Moved(val channel: String, val by: String?) : VoiceControlEvent
    /** Admin flipped the channel's transmit codec; the encoder swaps on the next frame. */
    data class CodecChanged(val codec: VoiceCodec) : VoiceControlEvent
}

class VoiceRelayTransport(
    httpApiBaseUrl: String,
    private val authTokenProvider: () -> String,
    private val apiKeyProvider: () -> String,
    private val inbound: InboundVoicePlayer,
    /** Read on every key-up: when true, txConditioner skips expander + makeup
     *  AGC so handset audio matches the radio-bridge mic chain. Defaults to
     *  false for current behaviour when an admin hasn't pushed otherwise. */
    private val bypassMicProcessingProvider: () -> Boolean = { false },
    /** Read on every inbound 8 kHz vocoded frame (IMBE, Codec2). When non-null,
     *  the decoded PCM runs through the shared post-decode chain (presence
     *  bell / soft saturation / shelves / polyphase upsample) before reaching
     *  the player. Null = legacy duplicate-upsample fast path. 16 kHz Opus runs
     *  through the same processor's wideband entry point (no upsample) when the
     *  agency enabled `wideband`; otherwise Opus plays unshaped. */
    private val postDecodeProcessorProvider: () -> PostDecodeChain.Processor? = { null },
    /** Read on `air_released` (cue synthesis) and on every inbound Opus frame
     *  (wideband routing decision). Null when no shaping/cue is configured.
     *  Held separately from the processor because the cue path needs the config
     *  even when there is no DSP processor (e.g. a roger-beep-only config). */
    private val postDecodeConfigProvider: () -> PostDecodeChain.Config? = { null },
) : StreamingPcmSink {

    private val _controlEvents = MutableSharedFlow<VoiceControlEvent>(extraBufferCapacity = 16)
    val controlEvents: SharedFlow<VoiceControlEvent> = _controlEvents.asSharedFlow()

    private val wsBaseUrl = httpApiBaseUrlToVoiceWebSocketUrl(httpApiBaseUrl)
    /** Cached HTTP base URL passed to [VoiceLinkTelemetryReporter] so its
     *  30 s POSTs go to the same backend as this transport. */
    private val telemetryHttpBaseUrl = httpApiBaseUrl

    private val client = OkHttpClient.Builder()
        .pingInterval(25L, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val connectionLock = Any()
    private val webSocketRef = AtomicReference<WebSocket?>(null)
    private val socketReady = AtomicBoolean(false)

    private val wantOnline = AtomicBoolean(false)

    /** Background reconnector so an idle (listening-only) radio recovers RX after a drop. */
    private val reconnectExecutor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "voice-relay-reconnect").apply { isDaemon = true }
        }
    private val reconnectAttempt = AtomicInteger(0)
    private val reconnectPending = AtomicBoolean(false)

    private var pcmAcc = ByteArray(2048)
    private var pcmAccLen = 0
    /** Tracks the codec the last frame was encoded with so a mid-stream codec
     *  change can drop any fractional PCM in the accumulator (the next encoder
     *  expects a fresh frame boundary, possibly at a different frame size). */
    private var lastTxCodec: VoiceCodec? = null
    /** One-shot Logcat warning when no encoder is available and uplink falls back to clear PCM. */
    private var warnedClearTx = false
    private val pcmFrameScratch = ByteArray(P25ImbeNative.Frames.PCM_16K_FRAME_BYTES)

    /** Speech conditioning for the vocoder uplink; reset at the start of each talk-spurt. */
    private val txConditioner = ImbeTxConditioner()
    private var lastConsumeNs = 0L

    /** Registry of every voice codec this client can encode + decode. IMBE is
     *  always present (its native lib is the existing dvmvocoder JNI build);
     *  Codec2 + Opus are present as registry slots but report isReady = false
     *  until their native libs land. */
    private val codecRegistry: VoiceCodecRegistry = VoiceCodecRegistry()
        .registerEncoder(ImbeEncoder())
        .registerDecoder(ImbeDecoder())
        .registerEncoder(Codec2Encoder())
        .registerDecoder(Codec2Decoder())
        .registerEncoder(OpusEncoder())
        .registerDecoder(OpusDecoder())

    /** Codec the channel asked us to TX with. Updated by the joined reply and
     *  by codec_change push messages; the registry resolves it to an actual
     *  ready encoder (falling back to IMBE if the requested lib is missing). */
    @Volatile
    private var currentTxCodec: VoiceCodec = VoiceCodec.DEFAULT

    /** Recording / AI sideband — server records only; not broadcast on the channel.
     *  0xAD marks an 8 kHz body: we downsample the sideband to halve its cellular
     *  uplink, and the relay upsamples it back to 16 kHz for storage. 0xAC (16 kHz)
     *  stays in use by iOS / web clients; the relay accepts both. */
    private val listenPcmMagic = byteArrayOf(0xF6.toByte(), 0xAD.toByte())

    private var pendingUnitId: String = ""
    private var pendingChannelRaw: String = ""

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            socketReady.set(true)
            reconnectAttempt.set(0)
            sendJoin(webSocket)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            dispatchControlMessage(text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            dispatchInboundVoice(bytes.toByteArray())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            socketReady.set(false)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            socketReady.set(false)
            webSocketRef.compareAndSet(webSocket, null)
            scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socketReady.set(false)
            webSocketRef.compareAndSet(webSocket, null)
            scheduleReconnect()
        }
    }

    private fun dispatchControlMessage(text: String) {
        try {
            val json = JSONObject(text)
            when (json.optString("type")) {
                "joined" -> {
                    recordListenPcm = json.optBoolean("record_listen_pcm", false)
                    aiDispatchListenPcm = json.optBoolean("ai_dispatch_listen_pcm", false)
                    val codec = VoiceCodec.fromWireId(json.optString("codec", null)) ?: VoiceCodec.DEFAULT
                    currentTxCodec = codec
                    _controlEvents.tryEmit(
                        VoiceControlEvent.Joined(
                            channel = json.optString("channel"),
                            permission = json.optString("permission", "talk"),
                            aiDispatchListenPcm = aiDispatchListenPcm,
                            recordListenPcm = recordListenPcm,
                            codec = codec,
                        ),
                    )
                }
                "ai_dispatch_pcm" -> {
                    aiDispatchListenPcm = json.optBoolean("enabled", false)
                    _controlEvents.tryEmit(VoiceControlEvent.AiDispatchPcm(enabled = aiDispatchListenPcm))
                }
                "codec_change" -> {
                    // Admin flipped this channel's codec while we were connected. The next
                    // encoded frame goes through the new codec; the inbound path picks the
                    // right decoder per frame from magic bytes so it needs no signaling.
                    val codec = VoiceCodec.fromWireId(json.optString("codec", null))
                    if (codec != null) {
                        currentTxCodec = codec
                        codecRegistry.encoderFor(codec)?.resetForTalkSpurt()
                        _controlEvents.tryEmit(VoiceControlEvent.CodecChanged(codec = codec))
                    } else {
                        Log.w(TAG, "codec_change frame with unknown codec: ${json.optString("codec")}")
                    }
                }
                "error" -> {
                    _controlEvents.tryEmit(
                        VoiceControlEvent.Error(code = json.optString("code", "voice_error")),
                    )
                }
                "busy" -> {
                    val holder = json.optString("unit_id").trim().takeIf { it.isNotEmpty() }
                    _controlEvents.tryEmit(VoiceControlEvent.Busy(holderUnit = holder))
                }
                "move" -> {
                    val channel = json.optString("channel").trim()
                    if (channel.isNotEmpty()) {
                        val by = json.optString("by").trim().takeIf { it.isNotEmpty() }
                        _controlEvents.tryEmit(VoiceControlEvent.Moved(channel = channel, by = by))
                    }
                }
                "air_released" -> {
                    // Another unit on this channel just unkeyed. Synthesize the
                    // close-side end-of-TX cue (roger beep / squelch tail)
                    // locally and inject it into playout. No-op unless the
                    // agency enabled at least one of the cue flags.
                    playEndOfTxCue(json.optString("channel").trim())
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Unparsed voice control frame: ${e.message}")
        }
    }

    /** Build + play the close-side end-of-TX cue when the relay reports another
     *  unit unkeyed. Pinned + identical to the web/iOS cue. No-op unless the
     *  agency enabled the roger beep and/or squelch tail. */
    private fun playEndOfTxCue(messageChannel: String? = null) {
        val cfg = postDecodeConfigProvider() ?: return
        if (!cfg.rogerBeepEnabled && !cfg.squelchTailEnabled) return
        // Defense-in-depth: if a dispatcher "move" raced the release, an
        // air_released for the channel we just left could arrive after we
        // re-joined elsewhere. The relay personalises the message with the
        // recipient's own channel name, so a mismatch means it's stale — skip
        // it. Fail open: only skip on a clear non-empty mismatch so a
        // normalisation difference can never mute a legitimate cue.
        if (!messageChannel.isNullOrEmpty() &&
            pendingChannelRaw.isNotEmpty() &&
            !messageChannel.equals(pendingChannelRaw, ignoreCase = true)
        ) {
            return
        }
        val cue = PostDecodeChain.endOfTxCue(cfg)
        if (cue.isEmpty()) return
        // Inject in <=20 ms (640-byte) frames, not as one ~210 ms entry:
        // a single large entry becomes the jitter buffer's lastGoodFrame and,
        // since it's the tail of the queue, the next playout tick underruns and
        // PLC re-emits a faded copy of the WHOLE cue — a stuttering echo that
        // also stalls the 20 ms cadence. Frame-sized chunks keep PLC + pacing
        // normal (mirrors the web track:true path bypassing PLC).
        var off = 0
        while (off < cue.size) {
            val end = minOf(off + CUE_FRAME_BYTES, cue.size)
            inbound.writePcmFromMain(cue.copyOfRange(off, end))
            off = end
        }
    }

    /**
     * WebSocket inbound dispatch. The first two bytes identify the codec via
     * [VoiceCodecRegistry.decoderForMagic]: known codecs route through the
     * matching decoder and are then upsampled / post-processed for playback;
     * anything else is treated as raw clear PCM (the legacy fallback for
     * pre-vocoder clients and the soundboard tone-out path).
     */
    private fun dispatchInboundVoice(payload: ByteArray) {
        val now = System.nanoTime()
        val newSpurt = lastInboundVoiceNs == 0L || now - lastInboundVoiceNs > talkSpurtGapNs
        lastInboundVoiceNs = now

        if (payload.size >= 2) {
            val decoder = codecRegistry.decoderForMagic(payload[0], payload[1])
            // Voice-link telemetry: count every inbound voice frame. The codec
            // wire id ("imbe" / "codec2_3200" / "opus" / "raw_pcm") feeds the
            // per-codec breakdown the admin dashboard renders. Decode success
            // / failure is counted on the success / null branches below.
            val telemetryCodec = decoder?.codec?.wireId ?: "raw_pcm"
            VoiceLinkTelemetryReporter.recordFrameReceived(telemetryCodec, payload.size)
            if (newSpurt) {
                VoiceLinkTelemetryReporter.recordTalkSpurtStart()
            }
            if (decoder != null) {
                if (newSpurt) {
                    decoder.resetForTalkSpurt()
                    // Reset the post-decode chain on every talk-spurt boundary,
                    // regardless of codec: the 8 kHz path and the Opus wideband
                    // path share the same biquad / compressor state on mobile,
                    // so a previous talker's filter ring must not bleed into the
                    // next talker's first frame on either path.
                    postDecodeProcessorProvider()?.reset()
                    opusVoiceProcessor?.reset()
                }
                if (decoder.codec == VoiceCodec.IMBE && !ensureImbeNativeLoadedForRx()) {
                    // Lazy-load the JNI lib on first IMBE frame so peers stay audible
                    // even before this radio opens the PTT screen. Other codecs load
                    // (or fail to load) eagerly with their own native libs.
                    Log.w(
                        TAG,
                        "IMBE frame discarded: JNI vocoder unavailable (receiver cannot unpack peer digital voice)",
                    )
                    return
                }
                if (!decoder.isReady) {
                    VoiceLinkTelemetryReporter.recordDecodeFailure()
                    Log.w(TAG, "Inbound ${decoder.codec.wireId} frame dropped — decoder native lib not loaded")
                    return
                }
                val samples = decoder.decodeFrame(payload) ?: run {
                    VoiceLinkTelemetryReporter.recordDecodeFailure()
                    Log.w(TAG, "${decoder.codec.wireId} decode returned null — check peer encoder alignment")
                    return
                }
                VoiceLinkTelemetryReporter.recordFrameDecoded(telemetryCodec)
                val pcm16LittleEndian = renderDecoded(samples, decoder.nativeSampleRate)
                inbound.writePcmFromMain(pcm16LittleEndian)
                return
            }
        }
        inbound.writePcmFromMain(payload)
    }

    /**
     * Brings a decoder's native-rate output to the playback rate (16 kHz mono
     * PCM-16 LE). 8 kHz output (IMBE, Codec2) runs through the existing
     * post-decode chain or duplicate-upsample fast path; 16 kHz output (Opus)
     * runs through the same chain's wideband entry point (no upsample) when the
     * agency enabled `wideband`, otherwise plays unshaped.
     */
    private fun renderDecoded(samples: ShortArray, nativeRate: Int): ByteArray {
        return when (nativeRate) {
            8000 -> applyPostDecodeOrDup(samples)
            16000 -> applyWidebandOrPassthrough(samples)
            else -> shortLeMonoBytes(samples)
        }
    }

    /**
     * Opus (16 kHz) RX shaping: when the agency enabled `wideband` AND a
     * processor exists, run the decoded frame through the same
     * biquad → compressor → saturation tail as the 8 kHz path but skipping the
     * upsample (the input is already 16 kHz). Otherwise play unshaped — today's
     * behaviour. Frame length is arbitrary (Opus frames are not 160 samples);
     * the wideband loop is length-agnostic.
     */
    private fun applyWidebandOrPassthrough(samples: ShortArray): ByteArray {
        val processor = postDecodeProcessorProvider()
        if (processor != null && postDecodeConfigProvider()?.wideband == true) {
            return processor.processWideband(samples)
        }
        // No agency wideband chain: apply the fixed "warm radio voice" Opus
        // shaping so Opus sounds full and clear rather than thin. Opus path
        // only — the 8 kHz vocoders (IMBE/Codec2) play raw via applyPostDecodeOrDup.
        val proc = opusVoiceProcessor
            ?: PostDecodeChain.Processor(PostDecodeChain.OPUS_VOICE_SHAPING).also { opusVoiceProcessor = it }
        return proc.processWideband(samples)
    }

    /** Fixed Opus-only voicing (see [PostDecodeChain.OPUS_VOICE_SHAPING]). Built
     *  on the first Opus frame so IMBE/Codec2-only channels never pay for it;
     *  reset at talk-spurt boundaries so a prior talker's biquad ring can't
     *  bleed into the next talker's first frame. */
    private var opusVoiceProcessor: PostDecodeChain.Processor? = null

    private fun shortLeMonoBytes(samples: ShortArray): ByteArray {
        val out = ByteArray(samples.size * 2)
        val bb = java.nio.ByteBuffer.wrap(out).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (s in samples) bb.putShort(s)
        return out
    }

    /**
     * Downsamples 16 kHz mono PCM-16 LE to 8 kHz by averaging adjacent sample
     * pairs (a cheap 2-tap low-pass + decimate). Used only for the clear-PCM
     * transcription sideband, halving its cellular uplink; the relay upsamples
     * the body back to 16 kHz for storage and Whisper transcribes 8 kHz speech
     * fine. A trailing odd sample (≤1 per frame) is dropped — inaudible.
     */
    private fun downsampleLe16kTo8k(src: ByteArray, length: Int): ByteArray {
        val inBuf = java.nio.ByteBuffer.wrap(src, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val outSamples = (length / 2) / 2
        val out = ByteArray(outSamples * 2)
        val outBuf = java.nio.ByteBuffer.wrap(out).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until outSamples) {
            val s0 = inBuf.short.toInt()
            val s1 = inBuf.short.toInt()
            outBuf.putShort(((s0 + s1) shr 1).toShort())
        }
        return out
    }

    /** Last inbound-voice frame timestamp (ns). Used purely to detect a
     *  talk-spurt boundary on the RX side so the post-decode chain can
     *  reset its biquad state before the next talker's first frame. */
    private var lastInboundVoiceNs = 0L

    /** Treat a > 300 ms gap between inbound voice frames as a new talk-spurt.
     *  Matches the relay's claim-air TTL window for the same reason: longer
     *  than worst-case framing jitter, shorter than the human gap between
     *  separate transmissions. */
    private val talkSpurtGapNs = 300_000_000L

    /**
     * Run the decoded 8 kHz frame through the agency's post-decode chain
     * when configured, otherwise fall back to the legacy sample-duplicate
     * upsample. Resets the processor's filter state at every talk-spurt
     * boundary so a previous talker's biquad ring can't bleed into the
     * next talker's first frame.
     */
    private fun applyPostDecodeOrDup(pcm8k160: ShortArray): ByteArray {
        val processor = postDecodeProcessorProvider()
        if (processor == null) {
            return P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160)
        }
        return processor.process(pcm8k160)
    }

    /** One-shot load so mates' IMBE frames work even before user opens the PTT screen (RX path). */
    private fun ensureImbeNativeLoadedForRx(): Boolean =
        P25ImbeNative.isAvailable || P25ImbeNative.tryLoadLibrary()

    @Volatile
    private var aiDispatchListenPcm: Boolean = false

    @Volatile
    private var recordListenPcm: Boolean = false

    /** Discard any fractional staged PCM on a mid-stream codec change so the
     *  next encoder sees a clean 20 ms boundary (frame sizes may differ).
     *  [cur] is null when the registry has no encoder ready and uplink is
     *  falling back to clear PCM. */
    private fun reconcileAccumulatorForCodecToggle(cur: VoiceCodec?) {
        val prev = lastTxCodec
        if (prev != null && prev != cur) {
            pcmAccLen = 0
        }
        lastTxCodec = cur
    }

    private fun appendAccumulator(fragment: ByteArray, len: Int) {
        val need = pcmAccLen + len
        if (need > pcmAcc.size) {
            pcmAcc = pcmAcc.copyOf(maxOf(pcmAcc.size * 2, need))
        }
        System.arraycopy(fragment, 0, pcmAcc, pcmAccLen, len)
        pcmAccLen = need
    }

    private fun sendBinaryWs(ws: WebSocket, payload: ByteArray) {
        val bs = Buffer()
            .write(payload, 0, payload.size)
            .readByteString(payload.size.toLong())
        ws.send(bs)
    }

    /**
     * Drop any fractional uplink PCM held for vocoder framing (preference
     * toggles / disconnect / mid-stream codec change cleanup).
     */
    fun discardPendingUplinkTail() {
        pcmAccLen = 0
    }

    /**
     * PTT released — tell the relay to clear `/v1/air` immediately instead of
     * waiting for the post-frame TTL (peers were seeing ~2–3s of stale "talking").
     */
    fun releaseTransmitHold() {
        discardPendingUplinkTail()
        codecRegistry.encoderFor(currentTxCodec)?.resetForTalkSpurt()
        val ws = webSocketRef.get() ?: return
        if (!socketReady.get()) return
        try {
            ws.send("""{"type":"release_air"}""")
        } catch (_: Exception) {
        }
    }

    /**
     * @param channelLabel current tuner label (must match REST channel names)
     */
    fun updateVoiceTarget(unitIdUpper: String, channelLabel: String, networkOnline: Boolean) {
        pendingUnitId = unitIdUpper.trim().uppercase(Locale.US)
        pendingChannelRaw = channelLabel.trim()
        wantOnline.set(
            networkOnline &&
                pendingChannelRaw.isNotEmpty() &&
                pendingChannelRaw != "----",
        )

        // Voice-link telemetry: keep the singleton's POST destination + auth
        // up to date and tell it which (unit, channel) the upcoming windows
        // are billed to. `configure` is idempotent — re-pointing at the same
        // URL is cheap.
        VoiceLinkTelemetryReporter.configure(
            httpBaseUrl = telemetryHttpBaseUrl,
            authTokenProvider = authTokenProvider,
            apiKeyProvider = apiKeyProvider,
        )
        VoiceLinkTelemetryReporter.setIdentity(
            unitId = pendingUnitId.takeIf { it.isNotBlank() },
            channel = pendingChannelRaw.takeIf { it.isNotBlank() },
        )

        if (!wantOnline.get()) {
            VoiceLinkTelemetryReporter.stop()
            disconnect()
            return
        }
        VoiceLinkTelemetryReporter.start()

        synchronized(connectionLock) {
            val existing = webSocketRef.get()
            if (existing != null) {
                sendJoin(existing)
            } else {
                openSocketLocked()
            }
        }
    }

    override fun consumePcm(buffer: ByteArray, length: Int) {
        if (!wantOnline.get() || length <= 0) return

        val encoder = codecRegistry.txEncoderFor(currentTxCodec)
        reconcileAccumulatorForCodecToggle(encoder?.codec)

        val wsPrepared = acquireActiveSocketPrepared()
        val active = wsPrepared ?: return

        if (encoder == null) {
            // No vocoder encoder is ready (e.g. JNI lib failed to package for this ABI),
            // and the registry has no fallback. Peers hear non-vocoded audio. Logged once
            // per process so the "everything sounds raw on the dispatch portal" case is
            // visible in Logcat without spamming on every frame.
            if (!warnedClearTx) {
                warnedClearTx = true
                Log.w(
                    TAG,
                    "No voice encoder available — transmitting clear PCM (peers hear non-vocoded audio). " +
                        "Check libsecurityradiovocoder.so was packaged for this ABI.",
                )
            }
            pcmAccLen = 0
            sendBinaryWs(active, buffer.copyOfRange(0, length))
            return
        }

        // Every vocoded talk-spurt also ships a clear-PCM sideband so the relay can
        // record + transcribe (Whisper can't read vocoded speech). The relay records
        // it but never broadcasts it. Sending it must NOT be gated on the
        // `record_listen_pcm` join ack — that arrives asynchronously, so a talk-spurt
        // keyed before the ack would ship vocoded only and the recorder would store
        // nothing, leaving the transmission silent in the log and invisible to AI dispatch.
        val side8k = downsampleLe16kTo8k(buffer, length)
        val side = ByteArray(2 + side8k.size)
        side[0] = listenPcmMagic[0]
        side[1] = listenPcmMagic[1]
        System.arraycopy(side8k, 0, side, 2, side8k.size)
        sendBinaryWs(active, side)

        // A gap between mic frames means a fresh key-up — re-learn the noise floor
        // and reset any per-spurt encoder state (Opus prediction, etc.).
        val now = System.nanoTime()
        if (now - lastConsumeNs > TX_GAP_RESET_NS) {
            txConditioner.reset()
            encoder.resetForTalkSpurt()
        }
        lastConsumeNs = now

        appendAccumulator(buffer, length)
        while (pcmAccLen >= pcmFrameScratch.size) {
            System.arraycopy(pcmAcc, 0, pcmFrameScratch, 0, pcmFrameScratch.size)
            System.arraycopy(pcmAcc, pcmFrameScratch.size, pcmAcc, 0, pcmAccLen - pcmFrameScratch.size)
            pcmAccLen -= pcmFrameScratch.size

            txConditioner.conditionLe16(
                pcmFrameScratch,
                pcmFrameScratch.size,
                bypassExpanderAgc = bypassMicProcessingProvider(),
            )
            val packet = encoder.encodeFrame(pcmFrameScratch) ?: continue
            sendBinaryWs(active, packet)
        }
    }

    private fun acquireActiveSocketPrepared(): WebSocket? {
        var ws = webSocketRef.get()
        if (ws == null || !socketReady.get()) {
            if (!wantOnline.get()) return null
            synchronized(connectionLock) {
                if (!wantOnline.get()) return null
                if (webSocketRef.get() == null) {
                    openSocketLocked()
                }
                ws = webSocketRef.get()
            }
            if (!socketReady.get()) return null
        }
        return ws
    }

    /** Stop outbound/inbound sockets and mute remote playback ([InboundVoicePlayer] stays reusable). */
    fun disconnect() {
        wantOnline.set(false)
        socketReady.set(false)
        pcmAccLen = 0
        webSocketRef.getAndSet(null)?.close(1001, "bye")
        inbound.stop()
    }

    /**
     * Drop and reopen the relay socket so a changed agency radio key takes
     * effect on live voice immediately, instead of staying on the old tenant
     * until the connection happens to drop.
     */
    fun reconnect() {
        synchronized(connectionLock) {
            socketReady.set(false)
            pcmAccLen = 0
            webSocketRef.getAndSet(null)?.close(1001, "reconnect")
            if (wantOnline.get()) {
                openSocketLocked()
            }
        }
    }

    /** Permanent teardown when discarding transport (normally unused — prefer [disconnect]). */
    fun shutdown() {
        VoiceLinkTelemetryReporter.stop()
        disconnect()
        reconnectExecutor.shutdownNow()
        inbound.release()
    }

    private fun sendJoin(ws: WebSocket) {
        val uid = escapeJsonFragment(pendingUnitId)
        val ch = escapeJsonFragment(pendingChannelRaw)
        // Re-check encodable codecs at every join (not just once at construction)
        // because the IMBE native lib may load lazily on first RX frame.
        val caps = codecRegistry.encodableCodecs()
            .joinToString(",") { "\"${it.wireId}\"" }
        val json =
            """{"type":"join","unit_id":"$uid","channel":"$ch","client":"android","caps":[$caps]}"""
        try {
            ws.send(json)
        } catch (_: Exception) {
        }
    }

    private fun openSocketLocked() {
        val token = authTokenProvider().trim()
        val url = if (token.isNotEmpty()) {
            val sep = if (wsBaseUrl.contains("?")) "&" else "?"
            "$wsBaseUrl${sep}token=${java.net.URLEncoder.encode(token, Charsets.UTF_8.name())}"
        } else {
            wsBaseUrl
        }
        val rb = Request.Builder().url(url)
        if (token.isEmpty()) {
            val key = apiKeyProvider().trim()
            if (key.isNotEmpty()) {
                rb.header("X-Radio-Key", key)
            }
        }
        val ws = client.newWebSocket(rb.build(), listener)
        webSocketRef.set(ws)
        socketReady.set(false)
    }

    /**
     * Reopen the relay socket after an unexpected drop, with exponential
     * backoff (1s → 30s), so a radio that is only listening recovers RX
     * without waiting for the operator to PTT or change channel.
     */
    private fun scheduleReconnect() {
        if (!wantOnline.get()) return
        if (!reconnectPending.compareAndSet(false, true)) return
        val attempt = reconnectAttempt.getAndIncrement()
        val delaySeconds = when {
            attempt <= 0 -> 1L
            attempt >= 5 -> 30L
            else -> 1L shl attempt
        }
        try {
            reconnectExecutor.schedule(
                {
                    reconnectPending.set(false)
                    if (wantOnline.get()) {
                        synchronized(connectionLock) {
                            if (wantOnline.get() && webSocketRef.get() == null) {
                                openSocketLocked()
                            }
                        }
                    }
                },
                delaySeconds,
                TimeUnit.SECONDS,
            )
        } catch (_: RejectedExecutionException) {
            reconnectPending.set(false)
        }
    }

    private fun escapeJsonFragment(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")

    private companion object {
        private const val TAG = "VoiceRelay"

        /** A pause this long between mic frames marks a new talk-spurt (≈300 ms). */
        private const val TX_GAP_RESET_NS = 300_000_000L

        /** End-of-TX cue injection chunk: 20 ms of 16 kHz mono PCM16 = 640 bytes.
         *  Keeps the cue flowing through the jitter buffer as normal-sized frames. */
        private const val CUE_FRAME_BYTES = 640
    }
}
