package com.securityradio.ptt.device

import android.app.Application
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Plays the radio's UI tones. An agency-custom tone cached by [CustomSoundStore]
 * is used when present; otherwise the bundled `assets/sounds/` default plays, so
 * the app is audible out of the box.
 *
 * Expected filenames (WAV recommended):
 * - channel_switch.wav
 * - ptt_permit.wav
 * - emergency.wav
 * - busy.wav (repeater busy / no path to air; looped while PTT is held and air is busy)
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
    private var busyTonePlayer: MediaPlayer? = null
    private var volumeCheckPlayer: MediaPlayer? = null
    private var volumeCheckCutoffRunnable: Runnable? = null
    private var volumeCheckLoopRestartRunnable: Runnable? = null

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
            val player = createBusyLoopMediaPlayer(FILE_BUSY) ?: return@post
            busyTonePlayer = player
        }
    }

    override fun stopBusyLoop() {
        main.post { stopBusyLoopInternal() }
    }

    override fun playBusyTone() {
        // One-shot lost-link alert: same UI stream as every other tone so the volume slider
        // controls all of them together. (Earlier this used USAGE_ALARM, which is on a different
        // volume slider — and was the cause of the busy tone sounding quiet against the other tones.)
        playOneShot(FILE_BUSY)
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

    override fun playVolumeCheck() {
        playVolumeCheckCapped(VOLUME_CHECK_MAX_MS)
    }

    override fun startVolumeCheckLoop() {
        main.post {
            stopVolumeCheckLoopInternal()
            stopTalkPermitLoopInternal()
            val player = createVolumeCheckLoopMediaPlayer() ?: return@post
            volumeCheckPlayer = player
        }
    }

    override fun stopVolumeCheckLoop() {
        main.post { stopVolumeCheckLoopInternal() }
    }

    override fun release() {
        main.post {
            stopTalkPermitLoopInternal()
            stopBusyLoopInternal()
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

    private fun stopBusyLoopInternal() {
        busyTonePlayer?.runCatching {
            setOnCompletionListener(null)
            stop()
            release()
        }
        busyTonePlayer = null
    }

    private fun cancelVolumeCheckCutoff() {
        volumeCheckCutoffRunnable?.let { main.removeCallbacks(it) }
        volumeCheckCutoffRunnable = null
    }

    private fun cancelVolumeCheckLoopRestart() {
        volumeCheckLoopRestartRunnable?.let { main.removeCallbacks(it) }
        volumeCheckLoopRestartRunnable = null
    }

    private fun stopVolumeCheckLoopInternal() {
        cancelVolumeCheckCutoff()
        cancelVolumeCheckLoopRestart()
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

    private fun createVolumeCheckLoopMediaPlayer(): MediaPlayer? {
        val player = MediaPlayer().applyUiAudio()
        if (!applySource(player, FILE_VOLUME_CHECK)) {
            player.release()
            return null
        }
        return try {
            player.apply {
                // Gapless-style loop: [isLooping] clips on IRC590; restart slightly before the
                // file ends and re-seek to a sync point (WMP-style seamless loop).
                isLooping = false
                setOnPreparedListener { prepared ->
                    prepared.start()
                    scheduleVolumeCheckGaplessRestart(prepared)
                }
                setOnCompletionListener { mp ->
                    if (mp !== volumeCheckPlayer) return@setOnCompletionListener
                    restartVolumeCheckAtLoopPoint(mp)
                }
                setOnErrorListener { mp, _, _ ->
                    if (volumeCheckPlayer === mp) volumeCheckPlayer = null
                    mp.release()
                    true
                }
                prepareAsync()
            }
        } catch (_: Exception) {
            player.release()
            null
        }
    }

    /** Schedule a restart slightly before EOF so there is no audible gap between passes. */
    private fun scheduleVolumeCheckGaplessRestart(mp: MediaPlayer) {
        cancelVolumeCheckLoopRestart()
        val durationMs =
            try {
                mp.duration
            } catch (_: Exception) {
                -1
            }
        if (durationMs < 80) return
        val leadMs = VOLUME_CHECK_LOOP_LEAD_MS
        val delayMs = (durationMs - leadMs).coerceAtLeast(0L)
        val runnable = Runnable {
            volumeCheckLoopRestartRunnable = null
            if (mp !== volumeCheckPlayer) return@Runnable
            restartVolumeCheckAtLoopPoint(mp)
        }
        volumeCheckLoopRestartRunnable = runnable
        main.postDelayed(runnable, delayMs)
    }

    /** Re-seek to the loop start and play again without stop/release (avoids boundary clicks). */
    private fun restartVolumeCheckAtLoopPoint(mp: MediaPlayer) {
        cancelVolumeCheckLoopRestart()
        try {
            mp.setOnSeekCompleteListener(null)
            if (mp.isPlaying) {
                mp.pause()
            }
            val loopStartMs = VOLUME_CHECK_LOOP_START_MS
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                mp.seekTo(loopStartMs, MediaPlayer.SEEK_CLOSEST_SYNC)
            } else {
                @Suppress("DEPRECATION")
                mp.seekTo(loopStartMs.toInt())
            }
            mp.setOnSeekCompleteListener { player ->
                player.setOnSeekCompleteListener(null)
                if (player !== volumeCheckPlayer) return@setOnSeekCompleteListener
                try {
                    if (!player.isPlaying) {
                        player.start()
                    }
                    scheduleVolumeCheckGaplessRestart(player)
                } catch (_: IllegalStateException) {
                }
            }
        } catch (_: IllegalStateException) {
        }
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

    /**
     * Busy loop on the UI sonification path (same stream as channel-switch / talk-permit) so its
     * volume tracks the rest of the radio's tones. Manual seek+restart on completion because some
     * handset builds ignore [isLooping] for certain WAV PCM assets while emulators behave.
     */
    private fun createBusyLoopMediaPlayer(fileName: String): MediaPlayer? {
        val player = MediaPlayer()
        player.setAudioAttributes(uiAudioAttrs)
        player.setVolume(1f, 1f)
        if (!applySource(player, fileName)) {
            player.release()
            return null
        }
        return try {
            player.apply {
                isLooping = false
                setOnPreparedListener { it.start() }
                setOnCompletionListener { mp ->
                    if (mp !== busyTonePlayer) return@setOnCompletionListener
                    try {
                        mp.seekTo(0)
                        mp.start()
                    } catch (_: IllegalStateException) {
                    }
                }
                setOnErrorListener { mp, _, _ ->
                    if (busyTonePlayer === mp) busyTonePlayer = null
                    mp.release()
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
        const val FILE_VOLUME_CHECK = "volume.wav"
        /** TM7 volume knob: one short beep, not the entire WAV. */
        const val VOLUME_CHECK_MAX_MS = 1_000L
        /** Skip the first few ms on loop (reduces boundary click on some handsets). */
        const val VOLUME_CHECK_LOOP_START_MS = 20L
        /** Restart this many ms before EOF for gapless looping. */
        const val VOLUME_CHECK_LOOP_LEAD_MS = 35L
    }
}
