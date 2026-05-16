package com.securityradio.ptt.device

import android.app.Application
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import java.io.IOException

/**
 * Default short synthetic tones are bundled under `assets/sounds/` so the app is audible out of the box;
 * replace them with your own WAV files anytime (same filenames).
 *
 * Expected filenames (WAV recommended):
 * - channel_switch.wav
 * - ptt_permit.wav
 * - emergency.wav
 * - busy.wav (repeater busy / no path to air; looped while PTT is held and air is busy)
 */
class AssetRadioUiSoundPlayer(
    private val app: Application,
) : RadioUiSoundPlayer {

    private val main = Handler(Looper.getMainLooper())
    private val audioManager = app.getSystemService(AudioManager::class.java)

    private var talkPermitPlayer: MediaPlayer? = null
    private var busyTonePlayer: MediaPlayer? = null
    private var busyFocusRequest: AudioFocusRequest? = null

    private val uiAudioAttrs: AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

    /**
     * Busy must share the communications audio path — rugged handsets often duck [USAGE_MEDIA]
     * to silence when VOIP/inbound PCM is routed to the tactical speaker/emulator behaves loosely.
     */
    private val busyAudioAttrs: AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

    private fun MediaPlayer.applyUiAudio(): MediaPlayer {
        setAudioAttributes(uiAudioAttrs)
        setVolume(1f, 1f)
        return this
    }

    private fun acquireBusyToneFocus() {
        abandonBusyToneFocusInternal()
        /** Non-exclusive so some OEM stacks still route the loop while voice RX holds the comm stack. */
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(busyAudioAttrs)
            .setWillPauseWhenDucked(false)
            .setAcceptsDelayedFocusGain(false)
            .setOnAudioFocusChangeListener { /* hold until busy loop stops */ }
            .build()
        busyFocusRequest = req
        audioManager.requestAudioFocus(req)
    }

    private fun abandonBusyToneFocusInternal() {
        busyFocusRequest?.let {
            audioManager.abandonAudioFocusRequest(it)
        }
        busyFocusRequest = null
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
            acquireBusyToneFocus()
            val player = createBusyLoopMediaPlayer(FILE_BUSY) ?: run {
                abandonBusyToneFocusInternal()
                return@post
            }
            busyTonePlayer = player
        }
    }

    override fun stopBusyLoop() {
        main.post { stopBusyLoopInternal() }
    }

    override fun playEmergencyAlert() {
        playOneShot(FILE_EMERGENCY)
    }

    override fun release() {
        main.post {
            stopTalkPermitLoopInternal()
            stopBusyLoopInternal()
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
    }

    private fun playOneShot(fileName: String) {
        main.post {
            val afd = try {
                app.assets.openFd("$SOUNDS_DIR/$fileName")
            } catch (_: IOException) {
                return@post
            }
            afd.use {
                val player = MediaPlayer().applyUiAudio()
                try {
                    player.setDataSource(it.fileDescriptor, it.startOffset, it.length)
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
    }

    private fun createTalkPermitOneShot(onFinished: () -> Unit): MediaPlayer? {
        val afd = try {
            app.assets.openFd("$SOUNDS_DIR/$FILE_TALK_PERMIT")
        } catch (_: IOException) {
            return null
        }
        return try {
            MediaPlayer().applyUiAudio().apply {
                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
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
            afd.close()
            null
        }
    }

    /**
     * Busy loop uses the voice path + manual restart: some handset builds ignore or fail [isLooping]
     * for certain WAV PCM assets while emulators behave.
     */
    private fun createBusyLoopMediaPlayer(fileName: String): MediaPlayer? {
        val afd = try {
            app.assets.openFd("$SOUNDS_DIR/$fileName")
        } catch (_: IOException) {
            return null
        }
        return try {
            MediaPlayer().apply {
                setAudioAttributes(busyAudioAttrs)
                setVolume(1f, 1f)
                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
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
            afd.close()
            null
        }
    }

    companion object {
        const val SOUNDS_DIR = "sounds"
        const val FILE_CHANNEL_SWITCH = "channel_switch.wav"
        const val FILE_TALK_PERMIT = "ptt_permit.wav"
        const val FILE_EMERGENCY = "emergency.wav"
        const val FILE_BUSY = "busy.wav"
    }
}
