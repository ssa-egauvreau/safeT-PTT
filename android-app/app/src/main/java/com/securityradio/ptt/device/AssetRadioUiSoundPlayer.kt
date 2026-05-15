package com.securityradio.ptt.device

import android.app.Application
import android.media.AudioAttributes
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
    private var talkPermitPlayer: MediaPlayer? = null
    private var busyTonePlayer: MediaPlayer? = null

    private val uiAudioAttrs: AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

    private fun MediaPlayer.applyUiAudio(): MediaPlayer {
        setAudioAttributes(uiAudioAttrs)
        setVolume(1f, 1f)
        return this
    }

    override fun playChannelSwitch() {
        playOneShot(FILE_CHANNEL_SWITCH)
    }

    override fun startTalkPermitLoop() {
        main.post {
            stopBusyLoopInternal()
            stopTalkPermitLoopInternal()
            // Talk permit is a cue when air is available — play once per transition, not a hold loop.
            val player = createTalkPermitOneShot() ?: return@post
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
            val player = createLoopingPlayer(FILE_BUSY) ?: return@post
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

    private fun createTalkPermitOneShot(): MediaPlayer? {
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
                }
                setOnErrorListener { mp, _, _ ->
                    if (talkPermitPlayer === mp) {
                        talkPermitPlayer = null
                    }
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

    private fun createLoopingPlayer(fileName: String): MediaPlayer? {
        val afd = try {
            app.assets.openFd("$SOUNDS_DIR/$fileName")
        } catch (_: IOException) {
            return null
        }
        return try {
            MediaPlayer().applyUiAudio().apply {
                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
                isLooping = true
                setOnPreparedListener { it.start() }
                setOnErrorListener { mp, _, _ ->
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
