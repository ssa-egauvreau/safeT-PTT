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
 * - Uplink path: encode with P25-style 88-bit IMBE whenever [P25ImbeNative.isAvailable].
 * - Downlink auto-detects IMBE (13-byte magic frame) whenever the JNI codec can load — peers stay
 *   audible on mixed builds; uplink stays clear PCM until the codec loads after startup.
 *
 * Codec: see [VoiceAudioSpecs] (PCM); IMBE via bundled dvmvocoder (GPL — see cpp/dvmvocoder).
 */
sealed interface VoiceControlEvent {
    data class Joined(
        val channel: String,
        val permission: String,
        val aiDispatchListenPcm: Boolean = false,
        val recordListenPcm: Boolean = false,
    ) : VoiceControlEvent
    /** AI dispatch on this channel — uplink clear PCM instead of IMBE vocoder. */
    data class AiDispatchPcm(val enabled: Boolean) : VoiceControlEvent
    data class Error(val code: String) : VoiceControlEvent
    data class Busy(val holderUnit: String?) : VoiceControlEvent
    /** Dispatcher live-moved this radio to another channel (Live Channel Control). */
    data class Moved(val channel: String, val by: String?) : VoiceControlEvent
}

class VoiceRelayTransport(
    httpApiBaseUrl: String,
    private val authTokenProvider: () -> String,
    private val apiKeyProvider: () -> String,
    private val inbound: InboundVoicePlayer,
) : StreamingPcmSink {

    private val _controlEvents = MutableSharedFlow<VoiceControlEvent>(extraBufferCapacity = 16)
    val controlEvents: SharedFlow<VoiceControlEvent> = _controlEvents.asSharedFlow()

    private val wsBaseUrl = httpApiBaseUrlToVoiceWebSocketUrl(httpApiBaseUrl)

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
    private var lastP25TxEnabled: Boolean? = null
    /** One-shot Logcat warning when our uplink falls back from IMBE to clear PCM. */
    private var warnedClearTx = false
    private val pcmFrameScratch = ByteArray(P25ImbeNative.Frames.PCM_16K_FRAME_BYTES)

    /** Speech conditioning for the IMBE uplink; reset at the start of each talk-spurt. */
    private val txConditioner = ImbeTxConditioner()
    private var lastConsumeNs = 0L

    /** Two-byte sentinel so random PCM blobs are unlikely to collide; followed by an 11-byte codeword. */
    private val imbeWsMagic = byteArrayOf(0xF5.toByte(), 0xAB.toByte())
    /** Recording / AI sideband — server records only; not broadcast on the channel. */
    private val listenPcmMagic = byteArrayOf(0xF6.toByte(), 0xAC.toByte())

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
                    _controlEvents.tryEmit(
                        VoiceControlEvent.Joined(
                            channel = json.optString("channel"),
                            permission = json.optString("permission", "talk"),
                            aiDispatchListenPcm = aiDispatchListenPcm,
                            recordListenPcm = recordListenPcm,
                        ),
                    )
                }
                "ai_dispatch_pcm" -> {
                    aiDispatchListenPcm = json.optBoolean("enabled", false)
                    _controlEvents.tryEmit(VoiceControlEvent.AiDispatchPcm(enabled = aiDispatchListenPcm))
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
            }
        } catch (e: Exception) {
            Log.w(TAG, "Unparsed voice control frame: ${e.message}")
        }
    }

    /** WebSocket inbound: IMBE frames (13-byte magic) decoded when native library is loadable; else PCM. */
    private fun dispatchInboundVoice(payload: ByteArray) {
        if (payload.size == 13 &&
            payload[0] == imbeWsMagic[0] &&
            payload[1] == imbeWsMagic[1]
        ) {
            if (!ensureImbeNativeLoadedForRx()) {
                Log.w(
                    TAG,
                    "IMBE frame discarded: JNI vocoder unavailable (receiver cannot unpack peer digital voice)",
                )
                return
            }
            val codeword = payload.copyOfRange(2, 13)
            val pcm8k160 =
                P25ImbeNative.decodeCodeword11(codeword)
                    ?: run {
                        Log.w(TAG, "IMBE decode returned null for one frame — check peer encoder alignment")
                        return
                    }
            val pcm16LittleEndian = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160)
            inbound.writePcmFromMain(pcm16LittleEndian)
            return
        }
        inbound.writePcmFromMain(payload)
    }

    /** One-shot load so mates' IMBE frames work even before user opens the PTT screen (RX path). */
    private fun ensureImbeNativeLoadedForRx(): Boolean =
        P25ImbeNative.isAvailable || P25ImbeNative.tryLoadLibrary()

    @Volatile
    private var aiDispatchListenPcm: Boolean = false

    @Volatile
    private var recordListenPcm: Boolean = false

    private fun p25UplinkEligible(): Boolean = P25ImbeNative.isAvailable

    private fun reconcileAccumulatorForModeToggle() {
        val cur = p25UplinkEligible()
        val prev = lastP25TxEnabled
        if (prev != null && prev != cur) {
            pcmAccLen = 0
        }
        lastP25TxEnabled = cur
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
     * Drop any fractional uplink PCM held for IMBE framing (preference toggles / disconnect).
     */
    fun discardPendingUplinkTail() {
        pcmAccLen = 0
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

        if (!wantOnline.get()) {
            disconnect()
            return
        }

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
        reconcileAccumulatorForModeToggle()

        val wsPrepared = acquireActiveSocketPrepared()
        val active = wsPrepared ?: return

        val p25 = p25UplinkEligible()
        if (!p25) {
            // Native vocoder didn't load → uplink is clear PCM, peers will hear non-vocoded
            // audio. Log once per process so this is visible in Logcat when troubleshooting
            // "everything sounds raw on the dispatch portal".
            if (!warnedClearTx) {
                warnedClearTx = true
                Log.w(
                    TAG,
                    "P25 IMBE encoder unavailable — transmitting clear PCM (peers will hear non-vocoded audio). " +
                        "Check libsecurityradiovocoder.so was packaged for this ABI.",
                )
            }
            pcmAccLen = 0
            sendBinaryWs(active, buffer.copyOfRange(0, length))
            return
        }

        // On-air is IMBE, which the relay never records (Whisper can't read vocoded speech), so
        // always pair every keyed talk-spurt with a clear-PCM sideband for the transmission log /
        // AI dispatch. The relay records it but never broadcasts it. This must NOT be gated on the
        // `record_listen_pcm` join ack: that arrives asynchronously, so a talk-spurt keyed before
        // (or right after a reconnect, before) the ack would ship IMBE only and the recorder would
        // store nothing — leaving the transmission silent in the log and invisible to AI dispatch.
        val side = ByteArray(2 + length)
        side[0] = listenPcmMagic[0]
        side[1] = listenPcmMagic[1]
        System.arraycopy(buffer, 0, side, 2, length)
        sendBinaryWs(active, side)

        // A gap between mic frames means a fresh key-up — re-learn the noise floor.
        val now = System.nanoTime()
        if (now - lastConsumeNs > TX_GAP_RESET_NS) {
            txConditioner.reset()
        }
        lastConsumeNs = now

        appendAccumulator(buffer, length)
        while (pcmAccLen >= pcmFrameScratch.size) {
            System.arraycopy(pcmAcc, 0, pcmFrameScratch, 0, pcmFrameScratch.size)
            System.arraycopy(pcmAcc, pcmFrameScratch.size, pcmAcc, 0, pcmAccLen - pcmFrameScratch.size)
            pcmAccLen -= pcmFrameScratch.size

            txConditioner.conditionLe16(pcmFrameScratch, pcmFrameScratch.size)
            val imbeIn = P25ImbeNative.Frames.downsampleAvg16kToImbe(pcmFrameScratch)
            val codeword11 = P25ImbeNative.encodeFrame(imbeIn) ?: continue
            val packet = ByteArray(2 + codeword11.size)
            packet[0] = imbeWsMagic[0]
            packet[1] = imbeWsMagic[1]
            System.arraycopy(codeword11, 0, packet, 2, codeword11.size)
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
        disconnect()
        reconnectExecutor.shutdownNow()
        inbound.release()
    }

    private fun sendJoin(ws: WebSocket) {
        val uid = escapeJsonFragment(pendingUnitId)
        val ch = escapeJsonFragment(pendingChannelRaw)
        val json = """{"type":"join","unit_id":"$uid","channel":"$ch","client":"android"}"""
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
    }
}
