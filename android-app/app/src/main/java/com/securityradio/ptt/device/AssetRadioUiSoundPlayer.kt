package com.securityradio.ptt.device

import android.app.Application
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Plays the radio's UI tones. An agency-custom tone cached by [CustomSoundStore]
 * is used when present; otherwise the bundled `assets/sounds/` default plays, so
 * the app is audible out of the box.
 *
 * Expected filenames (WAV recommended):
 * - channel_switch.wav
 * - ptt_permit.wav
 * - emergency.wav
 * - busy.wav (channel busy + listen-only; same media volume as permit/channel beep)
 */
class AssetRadioUiSoundPlayer(
    private val app: Application,
    private val customSounds: CustomSoundStore,
) : RadioUiSoundPlayer {

    private val main = Handler(Looper.getMainLooper())
    private val audioManager: AudioManager =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            app.getSystemService(AudioManager::class.java)!!
        } else {
            @Suppress("DEPRECATION")
            app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        }

    private var talkPermitPlayer: MediaPlayer? = null
    private var busyLoopPlayerA: MediaPlayer? = null
    private var busyLoopPlayerB: MediaPlayer? = null
    private var busyLoopSwapRunnable: Runnable? = null
    private var busyAlertPlayer: MediaPlayer? = null
    private var busyAlertCutoffRunnable: Runnable? = null
    private var volumeCheckPlayer: MediaPlayer? = null
    private var volumeCheckCutoffRunnable: Runnable? = null
    private var volumeLoopPlayerA: MediaPlayer? = null
    private var volumeLoopPlayerB: MediaPlayer? = null
    private var volumeLoopSwapRunnable: Runnable? = null

    /** Parsed WAV length per clip (key includes custom-file mtime when applicable). */
    private val clipDurationMsCache = mutableMapOf<String, Long>()

    /**
     * Strong reference to the emergency one-shot so the rugged-handset OS (e.g. IRC590) cannot
     * GC the wrapper while the WAV is still playing — the symptom was the emergency tone cutting
     * off after ~0.5-1s when triggered locally. Cleared in the completion/error listener.
     */
    private var emergencyPlayer: MediaPlayer? = null
    private var emergencyFocusRequest: AudioFocusRequest? = null

    @Suppress("DEPRECATION")
    private var emergencyFocusListener: AudioManager.OnAudioFocusChangeListener? = null

    private val uiAudioAttrs: AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

    /**
     * Audibility-enforced alarm attributes so the emergency tone is not ducked or paused by other
     * audio focus changes, and is loud regardless of the media volume slider.
     */
    private val emergencyAttrs: AudioAttributes = emergencyAudioAttributes()

    private fun emergencyAudioAttributes(): AudioAttributes {
        val b =
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            b.setFlags(AudioAttributes.FLAG_AUDIBILITY_ENFORCED)
        }
        return b.build()
    }

    private fun MediaPlayer.applyUiAudio(): MediaPlayer {
        setAudioAttributes(uiAudioAttrs)
        setVolume(1f, 1f)
        return this
    }

    private fun acquireEmergencyFocus() {
        abandonEmergencyFocus()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req =
                AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(emergencyAttrs)
                    .setWillPauseWhenDucked(false)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener { /* keep emergency audible until it ends */ }
                    .build()
            emergencyFocusRequest = req
            audioManager.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            val listener =
                AudioManager.OnAudioFocusChangeListener { /* keep emergency audible until it ends */ }
            emergencyFocusListener = listener
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                listener,
                AudioManager.STREAM_ALARM,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
            )
        }
    }

    private fun abandonEmergencyFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            emergencyFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            emergencyFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            emergencyFocusListener?.let { audioManager.abandonAudioFocus(it) }
            emergencyFocusListener = null
        }
    }

    override fun playChannelSwitch(onFinished: (() -> Unit)?) {
        playOneShot(FILE_CHANNEL_SWITCH, onFinished = onFinished)
    }

    override fun playTalkPermitThen(onFinished: () -> Unit, onStarted: (() -> Unit)?) {
        main.post {
            stopBusyLoopInternal()
            stopTalkPermitLoopInternal()
            val player = createTalkPermitOneShot(onFinished, onStarted) ?: run {
                onFinished()
                return@post
            }
            talkPermitPlayer = player
        }
    }

    override fun stopTalkPermitLoop() {
        main.post { stopTalkPermitLoopInternal() }
    }

    override fun startBusyLoop() {
        main.post {
            stopTalkPermitLoopInternal()
            stopBusyLoopInternal()
            // Same USAGE_MEDIA path as PTT permit, channel beep, and volume-check — follows the
            // handset media volume knob the operator already uses for UI tones.
            startGaplessPingPongLoop(
                fileName = FILE_BUSY,
                playerA = { busyLoopPlayerA },
                playerB = { busyLoopPlayerB },
                setPlayers = { a, b ->
                    busyLoopPlayerA = a
                    busyLoopPlayerB = b
                },
                cancelSwap = ::cancelBusyLoopSwap,
                setSwapRunnable = { busyLoopSwapRunnable = it },
                isActive = { busyLoopPlayerA != null && busyLoopPlayerB != null },
            )
        }
    }

    override fun stopBusyLoop() {
        main.post { stopBusyLoopInternal() }
    }

    override fun playBusyAlert() {
        main.post { playBusyAlertCapped(BUSY_ALERT_MAX_MS) }
    }

    override fun stopBusyAlert() {
        main.post { stopBusyAlertInternal() }
    }

    override fun playEmergencyAlert() {
        main.post {
            // Drop any prior emergency one-shot still in flight so a fast re-press restarts cleanly.
            stopEmergencyAlertInternal()
            acquireEmergencyFocus()
            val player = MediaPlayer()
            player.setAudioAttributes(emergencyAttrs)
            player.setVolume(1f, 1f)
            if (!applySource(player, FILE_EMERGENCY)) {
                player.release()
                abandonEmergencyFocus()
                return@post
            }
            emergencyPlayer = player
            try {
                player.setOnPreparedListener { prepared -> prepared.start() }
                player.setOnCompletionListener { completed ->
                    if (emergencyPlayer === completed) emergencyPlayer = null
                    completed.release()
                    abandonEmergencyFocus()
                }
                player.setOnErrorListener { mp, _, _ ->
                    if (emergencyPlayer === mp) emergencyPlayer = null
                    mp.release()
                    abandonEmergencyFocus()
                    true
                }
                player.prepareAsync()
            } catch (_: Exception) {
                emergencyPlayer = null
                player.release()
                abandonEmergencyFocus()
            }
        }
    }

    private fun stopEmergencyAlertInternal() {
        val player = emergencyPlayer
        emergencyPlayer = null
        if (player != null) {
            // stop() throws IllegalStateException when the player is still in the Preparing
            // state (which a fast re-press can hit before onPrepared has fired). Keep release()
            // in its own runCatching so a stop() throw does not leak the native resources or
            // leave its listeners alive.
            runCatching {
                player.setOnCompletionListener(null)
                player.setOnPreparedListener(null)
                player.setOnErrorListener(null)
            }
            runCatching { player.stop() }
            runCatching { player.release() }
        }
        abandonEmergencyFocus()
    }

    override fun playUpdateInstalled() {
        main.post {
            try {
                val tg = ToneGenerator(AudioManager.STREAM_MUSIC, UPDATE_INSTALLED_TONE_VOLUME)
                tg.startTone(ToneGenerator.TONE_PROP_ACK, UPDATE_INSTALLED_TONE_MS)
                main.postDelayed({ tg.release() }, (UPDATE_INSTALLED_TONE_MS + 200).toLong())
            } catch (_: RuntimeException) {
                // ToneGenerator throws on emulators / OEMs without the proprietary tone bank.
                // Falling back silently is better than crashing the post-install boot path.
            }
        }
    }

    override fun playPage() {
        playOneShot(FILE_PAGE)
    }

    override fun playSuccess() {
        playOneShot(FILE_SUCCESS)
    }

    override fun playError() {
        playOneShot(FILE_ERROR)
    }

    override fun playVolumeCheck() {
        playVolumeCheckCapped(VOLUME_CHECK_MAX_MS)
    }

    override fun startVolumeCheckLoop() {
        main.post {
            stopVolumeCheckLoopInternal()
            stopTalkPermitLoopInternal()
            startGaplessPingPongLoop(
                fileName = FILE_VOLUME_CHECK,
                playerA = { volumeLoopPlayerA },
                playerB = { volumeLoopPlayerB },
                setPlayers = { a, b ->
                    volumeLoopPlayerA = a
                    volumeLoopPlayerB = b
                },
                cancelSwap = ::cancelVolumeLoopSwap,
                setSwapRunnable = { volumeLoopSwapRunnable = it },
                isActive = { volumeLoopPlayerA != null && volumeLoopPlayerB != null },
            )
        }
    }

    override fun stopVolumeCheckLoop() {
        main.post { stopVolumeCheckLoopInternal() }
    }

    override fun release() {
        main.post {
            stopTalkPermitLoopInternal()
            stopBusyLoopInternal()
            stopBusyAlertInternal()
            stopVolumeCheckLoopInternal()
            stopEmergencyAlertInternal()
        }
    }

    private fun stopTalkPermitLoopInternal() {
        talkPermitPlayer?.runCatching {
            setOnCompletionListener(null)
            stop()
            release()
        }
        talkPermitPlayer = null
    }

    private fun cancelBusyLoopSwap() {
        busyLoopSwapRunnable?.let { main.removeCallbacks(it) }
        busyLoopSwapRunnable = null
    }

    private fun stopBusyLoopInternal() {
        cancelBusyLoopSwap()
        releaseLoopPlayer(busyLoopPlayerA)
        releaseLoopPlayer(busyLoopPlayerB)
        busyLoopPlayerA = null
        busyLoopPlayerB = null
    }

    private fun cancelBusyAlertCutoff() {
        busyAlertCutoffRunnable?.let { main.removeCallbacks(it) }
        busyAlertCutoffRunnable = null
    }

    private fun stopBusyAlertInternal() {
        cancelBusyAlertCutoff()
        busyAlertPlayer?.runCatching {
            setOnCompletionListener(null)
            if (isPlaying) {
                pause()
            }
            release()
        }
        busyAlertPlayer = null
    }

    /** Lost-link alert: same busy.wav, capped so it does not loop (re-triggered every 15s offline). */
    private fun playBusyAlertCapped(maxMs: Long) {
        stopBusyAlertInternal()
        val player = MediaPlayer().applyUiAudio()
        if (!applySource(player, FILE_BUSY)) {
            player.release()
            return
        }
        busyAlertPlayer = player
        try {
            player.setOnPreparedListener { prepared ->
                prepared.start()
                val cutoff = Runnable { stopBusyAlertInternal() }
                busyAlertCutoffRunnable = cutoff
                main.postDelayed(cutoff, maxMs)
            }
            player.setOnCompletionListener { completed ->
                cancelBusyAlertCutoff()
                if (busyAlertPlayer === completed) busyAlertPlayer = null
                completed.release()
            }
            player.setOnErrorListener { mp, _, _ ->
                cancelBusyAlertCutoff()
                if (busyAlertPlayer === mp) busyAlertPlayer = null
                mp.release()
                true
            }
            player.prepareAsync()
        } catch (_: Exception) {
            cancelBusyAlertCutoff()
            busyAlertPlayer = null
            player.release()
        }
    }

    private fun cancelVolumeCheckCutoff() {
        volumeCheckCutoffRunnable?.let { main.removeCallbacks(it) }
        volumeCheckCutoffRunnable = null
    }

    private fun cancelVolumeLoopSwap() {
        volumeLoopSwapRunnable?.let { main.removeCallbacks(it) }
        volumeLoopSwapRunnable = null
    }

    private fun stopVolumeCheckLoopInternal() {
        cancelVolumeCheckCutoff()
        cancelVolumeLoopSwap()
        releaseLoopPlayer(volumeLoopPlayerA)
        releaseLoopPlayer(volumeLoopPlayerB)
        volumeLoopPlayerA = null
        volumeLoopPlayerB = null
        volumeCheckPlayer?.runCatching {
            setOnCompletionListener(null)
            setOnSeekCompleteListener(null)
            if (isPlaying) {
                pause()
            }
            release()
        }
        volumeCheckPlayer = null
    }

    /** Plays the volume-check tone but stops after [maxMs] (TM7 volume knob / short beep). */
    private fun playVolumeCheckCapped(maxMs: Long) {
        main.post {
            stopVolumeCheckLoopInternal()
            val player = MediaPlayer().applyUiAudio()
            if (!applySource(player, FILE_VOLUME_CHECK)) {
                player.release()
                return@post
            }
            volumeCheckPlayer = player
            try {
                player.setOnPreparedListener { prepared ->
                    prepared.start()
                    val cutoff = Runnable { stopVolumeCheckLoopInternal() }
                    volumeCheckCutoffRunnable = cutoff
                    main.postDelayed(cutoff, maxMs)
                }
                player.setOnCompletionListener { completed ->
                    cancelVolumeCheckCutoff()
                    if (volumeCheckPlayer === completed) volumeCheckPlayer = null
                    completed.release()
                }
                player.setOnErrorListener { mp, _, _ ->
                    cancelVolumeCheckCutoff()
                    if (volumeCheckPlayer === mp) volumeCheckPlayer = null
                    mp.release()
                    true
                }
                player.prepareAsync()
            } catch (_: Exception) {
                cancelVolumeCheckCutoff()
                volumeCheckPlayer = null
                player.release()
            }
        }
    }

    private fun releaseLoopPlayer(player: MediaPlayer?) {
        player?.runCatching {
            setOnCompletionListener(null)
            setOnPreparedListener(null)
            setOnSeekCompleteListener(null)
            setOnErrorListener(null)
            if (isPlaying) {
                pause()
            }
            release()
        }
    }

    private fun createLoopMediaPlayer(
        fileName: String,
        applyAudio: MediaPlayer.() -> MediaPlayer = { applyUiAudio() },
    ): MediaPlayer? {
        val player = MediaPlayer().applyAudio()
        if (!applySource(player, fileName)) {
            player.release()
            return null
        }
        player.isLooping = false
        return player
    }

    private fun seekGaplessLoopStart(player: MediaPlayer) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                player.seekTo(GAPLESS_LOOP_START_MS, MediaPlayer.SEEK_CLOSEST_SYNC)
            } else {
                @Suppress("DEPRECATION")
                player.seekTo(GAPLESS_LOOP_START_MS.toInt())
            }
        } catch (_: IllegalStateException) {
        }
    }

    /**
     * Two [MediaPlayer] instances alternate with a short crossfade window so rugged handsets
     * never hit the clicky [isLooping] or seek-to-zero-at-EOF path.
     */
    private fun startGaplessPingPongLoop(
        fileName: String,
        playerA: () -> MediaPlayer?,
        playerB: () -> MediaPlayer?,
        setPlayers: (MediaPlayer?, MediaPlayer?) -> Unit,
        cancelSwap: () -> Unit,
        setSwapRunnable: (Runnable?) -> Unit,
        isActive: () -> Boolean,
        applyAudio: MediaPlayer.() -> MediaPlayer = { applyUiAudio() },
    ) {
        val a = createLoopMediaPlayer(fileName, applyAudio) ?: return
        val b = createLoopMediaPlayer(fileName, applyAudio) ?: run {
            a.release()
            return
        }
        setPlayers(a, b)
        var readyCount = 0
        fun onBothReady() {
            readyCount++
            if (readyCount < 2 || !isActive()) return
            try {
                seekGaplessLoopStart(a)
                a.start()
                scheduleGaplessPingPongSwap(
                    fileName = fileName,
                    clipDurationMs = resolveClipDurationMs(fileName),
                    current = a,
                    next = b,
                    cancelSwap = cancelSwap,
                    setSwapRunnable = setSwapRunnable,
                    isActive = isActive,
                )
            } catch (_: IllegalStateException) {
            }
        }
        a.setOnPreparedListener { onBothReady() }
        b.setOnPreparedListener { onBothReady() }
        a.setOnErrorListener { mp, _, _ ->
            if (playerA() === mp || playerB() === mp) {
                setPlayers(null, null)
                mp.release()
            }
            true
        }
        b.setOnErrorListener { mp, _, _ ->
            if (playerA() === mp || playerB() === mp) {
                setPlayers(null, null)
                mp.release()
            }
            true
        }
        a.prepareAsync()
        b.prepareAsync()
    }

    private fun scheduleGaplessPingPongSwap(
        fileName: String,
        clipDurationMs: Long?,
        current: MediaPlayer,
        next: MediaPlayer,
        cancelSwap: () -> Unit,
        setSwapRunnable: (Runnable?) -> Unit,
        isActive: () -> Boolean,
    ) {
        cancelSwap()
        val mediaDurationMs =
            try {
                current.duration.toLong()
            } catch (_: Exception) {
                -1L
            }
        val headerDurationMs = clipDurationMs ?: resolveClipDurationMs(fileName)
        // Some handsets report ~500ms for multi-second WAVs; prefer the RIFF header length.
        val durationMs =
            when {
                headerDurationMs != null && headerDurationMs >= 200L ->
                    maxOf(headerDurationMs, mediaDurationMs.coerceAtLeast(0L))
                mediaDurationMs >= 200L -> mediaDurationMs
                else -> return
            }
        val delayMs = (durationMs - GAPLESS_LOOP_LEAD_MS).coerceAtLeast(0L)
        val runnable = Runnable {
            setSwapRunnable(null)
            if (!isActive()) return@Runnable
            try {
                seekGaplessLoopStart(next)
                if (!next.isPlaying) {
                    next.start()
                }
                current.pause()
                seekGaplessLoopStart(current)
                scheduleGaplessPingPongSwap(
                    fileName = fileName,
                    clipDurationMs = headerDurationMs,
                    current = next,
                    next = current,
                    cancelSwap = cancelSwap,
                    setSwapRunnable = setSwapRunnable,
                    isActive = isActive,
                )
            } catch (_: IllegalStateException) {
            }
        }
        setSwapRunnable(runnable)
        main.postDelayed(runnable, delayMs)
    }

    private fun clipDurationCacheKey(fileName: String): String {
        val custom = customSounds.localFile(fileName) ?: return fileName
        return "${fileName}:${custom.lastModified()}"
    }

    /** Length from the WAV RIFF header (reliable on rugged handsets where [MediaPlayer.duration] lies). */
    private fun resolveClipDurationMs(fileName: String): Long? {
        val key = clipDurationCacheKey(fileName)
        clipDurationMsCache[key]?.let { return it }
        val bytes = loadWavHeaderBytes(fileName) ?: return null
        val ms = parseWavDurationMs(bytes) ?: return null
        clipDurationMsCache[key] = ms
        return ms
    }

    private fun loadWavHeaderBytes(fileName: String): ByteArray? {
        customSounds.localFile(fileName)?.let { file ->
            return try {
                file.inputStream().use { input ->
                    val buf = ByteArray(WAV_HEADER_READ_MAX_BYTES)
                    val read = input.read(buf)
                    if (read <= 0) null else buf.copyOf(read)
                }
            } catch (_: Exception) {
                null
            }
        }
        return try {
            app.assets.open("$SOUNDS_DIR/$fileName").use { input ->
                val buf = ByteArray(WAV_HEADER_READ_MAX_BYTES)
                val read = input.read(buf)
                if (read <= 0) null else buf.copyOf(read)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun parseWavDurationMs(bytes: ByteArray): Long? {
        if (bytes.size < 44) return null
        if (!bytes.copyOfRange(0, 4).contentEquals(RIFF_MAGIC) ||
            !bytes.copyOfRange(8, 12).contentEquals(WAVE_MAGIC)
        ) {
            return null
        }
        var pos = 12
        var sampleRate = 0
        var channels = 0
        var bitsPerSample = 0
        var dataSize = 0
        while (pos + 8 <= bytes.size) {
            val chunkId = String(bytes, pos, pos + 4)
            val chunkSize =
                ByteBuffer.wrap(bytes, pos + 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
            pos += 8
            if (chunkSize < 0 || pos + chunkSize > bytes.size) break
            when (chunkId) {
                "fmt " ->
                    if (chunkSize >= 16) {
                        channels =
                            ByteBuffer.wrap(bytes, pos + 2, 2)
                                .order(ByteOrder.LITTLE_ENDIAN)
                                .short
                                .toInt() and 0xffff
                        sampleRate =
                            ByteBuffer.wrap(bytes, pos + 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
                        bitsPerSample =
                            ByteBuffer.wrap(bytes, pos + 14, 2)
                                .order(ByteOrder.LITTLE_ENDIAN)
                                .short
                                .toInt() and 0xffff
                    }
                "data" -> dataSize = chunkSize
            }
            pos += chunkSize + (chunkSize and 1)
        }
        if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0 || dataSize <= 0) return null
        val bytesPerFrame = channels * (bitsPerSample / 8)
        if (bytesPerFrame <= 0) return null
        return (dataSize.toLong() * 1000L) / (sampleRate.toLong() * bytesPerFrame)
    }

    /** Points [player] at the agency-custom tone when one is cached, else the bundled asset. */
    private fun applySource(player: MediaPlayer, fileName: String): Boolean {
        customSounds.localFile(fileName)?.let { file ->
            return try {
                player.setDataSource(file.path)
                true
            } catch (_: Exception) {
                false
            }
        }
        return try {
            app.assets.openFd("$SOUNDS_DIR/$fileName").use { afd ->
                player.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun playOneShot(
        fileName: String,
        attrs: AudioAttributes = uiAudioAttrs,
        onFinished: (() -> Unit)? = null,
    ) {
        main.post {
            val player = MediaPlayer()
            player.setAudioAttributes(attrs)
            player.setVolume(1f, 1f)
            if (!applySource(player, fileName)) {
                player.release()
                onFinished?.let { main.post(it) }
                return@post
            }
            try {
                player.setOnPreparedListener { prepared ->
                    prepared.start()
                }
                player.setOnCompletionListener { completed ->
                    completed.release()
                    onFinished?.let { main.post(it) }
                }
                player.setOnErrorListener { mp, _, _ ->
                    mp.release()
                    onFinished?.let { main.post(it) }
                    true
                }
                player.prepareAsync()
            } catch (_: Exception) {
                player.release()
                onFinished?.let { main.post(it) }
            }
        }
    }

    private fun createTalkPermitOneShot(onFinished: () -> Unit, onStarted: (() -> Unit)?): MediaPlayer? {
        val player = MediaPlayer().applyUiAudio()
        if (!applySource(player, FILE_TALK_PERMIT)) {
            player.release()
            return null
        }
        return try {
            player.apply {
                isLooping = false
                setOnPreparedListener { prepared ->
                    onStarted?.invoke()
                    prepared.start()
                }
                setOnCompletionListener { completed ->
                    completed.release()
                    if (talkPermitPlayer === completed) {
                        talkPermitPlayer = null
                    }
                    main.post { onFinished() }
                }
                setOnErrorListener { mp, _, _ ->
                    if (talkPermitPlayer === mp) {
                        talkPermitPlayer = null
                    }
                    mp.release()
                    main.post { onFinished() }
                    true
                }
                prepareAsync()
            }
        } catch (_: Exception) {
            player.release()
            null
        }
    }

    companion object {
        const val SOUNDS_DIR = "sounds"
        const val FILE_CHANNEL_SWITCH = "channel_switch.wav"
        const val FILE_TALK_PERMIT = "ptt_permit.wav"
        const val FILE_EMERGENCY = "emergency.wav"
        const val FILE_BUSY = "busy.wav"
        /** No-connection / lost-link: play this much of busy.wav, then silence until the next alert. */
        const val BUSY_ALERT_MAX_MS = 2_000L
        const val FILE_VOLUME_CHECK = "volume.wav"
        const val FILE_PAGE = "page.wav"
        const val FILE_SUCCESS = "success.wav"
        const val FILE_ERROR = "error.wav"
        /** TM7 volume knob: one short beep, not the entire WAV. */
        const val VOLUME_CHECK_MAX_MS = 1_000L
        /** Skip the first few ms on each loop leg (reduces boundary click on some handsets). */
        const val GAPLESS_LOOP_START_MS = 12L
        /** Crossfade window: start the standby player this many ms before the active clip ends. */
        const val GAPLESS_LOOP_LEAD_MS = 72L
        /** ToneGenerator ack — 0–100 volume scale; loud enough on a noisy radio without ducking media. */
        const val UPDATE_INSTALLED_TONE_VOLUME = 90
        /** Hold the proprietary ack for the full chirp so it does not get cut off mid-second-note. */
        const val UPDATE_INSTALLED_TONE_MS = 500
        private const val WAV_HEADER_READ_MAX_BYTES = 512 * 1024
        private val RIFF_MAGIC = "RIFF".toByteArray(Charsets.US_ASCII)
        private val WAVE_MAGIC = "WAVE".toByteArray(Charsets.US_ASCII)
    }
}
