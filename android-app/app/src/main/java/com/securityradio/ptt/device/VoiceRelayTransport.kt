package com.securityradio.ptt.device

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.ByteString
import android.util.Log
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

fun httpApiBaseUrlToVoiceWebSocketUrl(httpBaseUrl: String): String {
    val u = httpBaseUrl.trim().trimEnd('/')
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
class VoiceRelayTransport(
    httpApiBaseUrl: String,
    private val apiKeyProvider: () -> String,
    private val inbound: InboundVoicePlayer,
) : StreamingPcmSink {

    private val wsUrl = httpApiBaseUrlToVoiceWebSocketUrl(httpApiBaseUrl)

    private val client = OkHttpClient.Builder()
        .pingInterval(25L, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val connectionLock = Any()
    private val webSocketRef = AtomicReference<WebSocket?>(null)
    private val socketReady = AtomicBoolean(false)

    private val wantOnline = AtomicBoolean(false)

    private var pcmAcc = ByteArray(2048)
    private var pcmAccLen = 0
    private var lastP25TxEnabled: Boolean? = null
    private val pcmFrameScratch = ByteArray(P25ImbeNative.Frames.PCM_16K_FRAME_BYTES)

    /** Two-byte sentinel so random PCM blobs are unlikely to collide; followed by an 11-byte codeword. */
    private val imbeWsMagic = byteArrayOf(0xF5.toByte(), 0xAB.toByte())

    private var pendingUnitId: String = ""
    private var pendingChannelRaw: String = ""

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            socketReady.set(true)
            sendJoin(webSocket)
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
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socketReady.set(false)
            webSocketRef.compareAndSet(webSocket, null)
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
            inbound.writePcm(pcm16LittleEndian)
            return
        }
        inbound.writePcm(payload)
    }

    /** One-shot load so mates' IMBE frames work even before user opens the PTT screen (RX path). */
    private fun ensureImbeNativeLoadedForRx(): Boolean =
        P25ImbeNative.isAvailable || P25ImbeNative.tryLoadLibrary()

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
            pcmAccLen = 0
            sendBinaryWs(active, buffer.copyOfRange(0, length))
            return
        }

        appendAccumulator(buffer, length)
        while (pcmAccLen >= pcmFrameScratch.size) {
            System.arraycopy(pcmAcc, 0, pcmFrameScratch, 0, pcmFrameScratch.size)
            System.arraycopy(pcmAcc, pcmFrameScratch.size, pcmAcc, 0, pcmAccLen - pcmFrameScratch.size)
            pcmAccLen -= pcmFrameScratch.size

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
        inbound.release()
    }

    private fun sendJoin(ws: WebSocket) {
        val uid = escapeJsonFragment(pendingUnitId)
        val ch = escapeJsonFragment(pendingChannelRaw)
        val json = """{"type":"join","unit_id":"$uid","channel":"$ch"}"""
        try {
            ws.send(json)
        } catch (_: Exception) {
        }
    }

    private fun openSocketLocked() {
        val rb = Request.Builder().url(wsUrl)
        // Resolved per connection so an agency key change applies on the next reconnect.
        val key = apiKeyProvider().trim()
        if (key.isNotEmpty()) {
            rb.header("X-Radio-Key", key)
        }
        val ws = client.newWebSocket(rb.build(), listener)
        webSocketRef.set(ws)
        socketReady.set(false)
    }

    private fun escapeJsonFragment(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")

    private companion object {
        private const val TAG = "VoiceRelay"
    }
}
