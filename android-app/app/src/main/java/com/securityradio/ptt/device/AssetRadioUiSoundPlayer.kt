package com.securityradio.ptt.device

import android.app.Application
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import java.io.IOException

/**
 * Plays packaged handset cues from `assets/sounds/` when files exist (formats supported by [MediaPlayer]).
 *
 * Expected filenames:
 * - channel_switch.mp3
 * - ptt_permit.mp3
 * - emergency.mp3
 */
class AssetRadioUiSoundPlayer(
    private val app: Application,
) : RadioUiSoundPlayer {

    private val main = Handler(Looper.getMainLooper())
    private var talkPermitPlayer: MediaPlayer? = null

    override fun playChannelSwitch() {
        playOneShot(FILE_CHANNEL_SWITCH)
    }

    override fun startTalkPermitLoop() {
        main.post {
            stopTalkPermitLoopInternal()
            val player = createLoopingPlayer(FILE_TALK_PERMIT) ?: return@post
            talkPermitPlayer = player
        }
    }

    override fun stopTalkPermitLoop() {
        main.post { stopTalkPermitLoopInternal() }
    }

    override fun playEmergencyAlert() {
        playOneShot(FILE_EMERGENCY)
    }

    override fun release() {
        main.post {
            stopTalkPermitLoopInternal()
        }
    }

    private fun stopTalkPermitLoopInternal() {
        talkPermitPlayer?.runCatching {
            stop()
            release()
        }
        talkPermitPlayer = null
    }

    private fun playOneShot(fileName: String) {
        main.post {
            val afd = try {
                app.assets.openFd("$SOUNDS_DIR/$fileName")
            } catch (_: IOException) {
                return@post
            }
            afd.use {
                val player = MediaPlayer()
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

    private fun createLoopingPlayer(fileName: String): MediaPlayer? {
        val afd = try {
            app.assets.openFd("$SOUNDS_DIR/$fileName")
        } catch (_: IOException) {
            return null
        }
        return try {
            MediaPlayer().apply {
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
        const val FILE_CHANNEL_SWITCH = "channel_switch.mp3"
        const val FILE_TALK_PERMIT = "ptt_permit.mp3"
        const val FILE_EMERGENCY = "emergency.mp3"
    }
}
