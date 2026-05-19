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
    private var busyFocusRequest: AudioFocusRequest? = null

    /** Pre-O [AudioFocusRequest] equivalent; must abandon with same instance. */
    @Suppress("DEPRECATION")
    private var busyFocusListener: AudioManager.OnAudioFocusChangeListener? = null

    @Suppress("DEPRECATION")
    private var busySpeakerphoneRestore: Boolean? = null
    private var busyAudioModeRestore: Int? = null

    private val uiAudioAttrs: AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

    /** Rugged LTE handsets often leave [USAGE_VOICE_COMMUNICATION] inaudible on the loudspeaker. */
    private val busyAlarmAttrs: AudioAttributes = busyAlarmAudioAttributes()

    private fun busyAlarmAudioAttributes(): AudioAttributes {
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

    @Suppress("DEPRECATION")
    private fun activateBusySpeakerRouting() {
        runCatching {
            if (busyAudioModeRestore != null || busySpeakerphoneRestore != null) return
            busyAudioModeRestore = audioManager.mode
            busySpeakerphoneRestore = audioManager.isSpeakerphoneOn
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioManager.isSpeakerphoneOn = true
        }
    }

    @Suppress("DEPRECATION")
    private fun deactivateBusySpeakerRouting() {
        runCatching {
            busySpeakerphoneRestore?.let { audioManager.isSpeakerphoneOn = it }
        }
        busySpeakerphoneRestore = null
        runCatching {
            busyAudioModeRestore?.let { audioManager.mode = it }
        }
        busyAudioModeRestore = null
    }

    private fun acquireBusyToneFocus() {
        abandonBusyToneFocusInternal()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req =
                AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(busyAlarmAttrs)
                    .setWillPauseWhenDucked(false)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener { /* hold until busy loop stops */ }
                    .build()
            busyFocusRequest = req
            audioManager.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            val listener =
                AudioManager.OnAudioFocusChangeListener { /* hold until busy loop stops */ }
            busyFocusListener = listener
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                listener,
                AudioManager.STREAM_ALARM,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
            )
        }
    }

    private fun abandonBusyToneFocusInternal() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            busyFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            busyFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            busyFocusListener?.let { audioManager.abandonAudioFocus(it) }
            busyFocusListener = null
        }
    }

    override fun playChannelSwitch() {
        playOneShot(FILE_CHANNEL_SWITCH)
    }

    override fun playTalkPermitThen(onFinished: () -> Unit) {
        main.post {
            stopBusyLoopInternal()
            stopTalkPermitLoopInternal()
            val player = createTalkPermitOneShot(onFinished) ?: run {
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
            activateBusySpeakerRouting()
            acquireBusyToneFocus()
            val player = createBusyLoopMediaPlayer(FILE_BUSY) ?: run {
                abandonBusyToneFocusInternal()
                deactivateBusySpeakerRouting()
                return@post
            }
            busyTonePlayer = player
        }
    }

    override fun stopBusyLoop() {
        main.post { stopBusyLoopInternal() }
    }

    override fun playBusyTone() {
        // Alarm routing keeps the lost-link alert audible on rugged loudspeakers.
        playOneShot(FILE_BUSY, busyAlarmAttrs)
    }

    override fun playEmergencyAlert() {
        playOneShot(FILE_EMERGENCY)
    }

    override fun playVolumeCheck() {
        playOneShot(FILE_VOLUME_CHECK)
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
        abandonBusyToneFocusInternal()
        busyTonePlayer?.runCatching {
            setOnCompletionListener(null)
            stop()
            release()
        }
        busyTonePlayer = null
        deactivateBusySpeakerRouting()
    }

    private fun stopVolumeCheckLoopInternal() {
        volumeCheckPlayer?.runCatching {
            setOnCompletionListener(null)
            stop()
            release()
        }
        volumeCheckPlayer = null
    }

    private fun createVolumeCheckLoopMediaPlayer(): MediaPlayer? {
        val player = MediaPlayer().applyUiAudio()
        if (!applySource(player, FILE_VOLUME_CHECK)) {
            player.release()
            return null
        }
        return try {
            player.apply {
                isLooping = true
                setOnPreparedListener { it.start() }
                setOnCompletionListener { mp ->
                    if (mp !== volumeCheckPlayer) return@setOnCompletionListener
                    try {
                        mp.seekTo(0)
                        mp.start()
                    } catch (_: IllegalStateException) {
                    }
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

    private fun playOneShot(fileName: String, attrs: AudioAttributes = uiAudioAttrs) {
        main.post {
            val player = MediaPlayer()
            player.setAudioAttributes(attrs)
            player.setVolume(1f, 1f)
            if (!applySource(player, fileName)) {
                player.release()
                return@post
            }
            try {
                player.setOnPreparedListener { prepared ->
                    prepared.start()
                }
                player.setOnCompletionListener { completed ->
                    completed.release()
                }
                player.setOnErrorListener { mp, _, _ ->
                    mp.release()
                    true
                }
                player.prepareAsync()
            } catch (_: Exception) {
                player.release()
            }
        }
    }

    private fun createTalkPermitOneShot(onFinished: () -> Unit): MediaPlayer? {
        val player = MediaPlayer().applyUiAudio()
        if (!applySource(player, FILE_TALK_PERMIT)) {
            player.release()
            return null
        }
        return try {
            player.apply {
                isLooping = false
                setOnPreparedListener { it.start() }
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
     * Busy loop uses the alarm/sonification path + manual restart: some handset builds ignore
     * [isLooping] for certain WAV PCM assets while emulators behave.
     */
    private fun createBusyLoopMediaPlayer(fileName: String): MediaPlayer? {
        val player = MediaPlayer()
        player.setAudioAttributes(busyAlarmAttrs)
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
    }
}
