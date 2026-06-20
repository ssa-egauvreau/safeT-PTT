package com.securityradio.ptt.device

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Watches the audio OUTPUT route and reports two things the voice player cares
 * about:
 *
 *  - [bluetoothConnected]: a Bluetooth speaker/headset (A2DP or SCO) is the
 *    route. Bluetooth audio links have a high cold-start latency — waking the
 *    link swallows the first ~100–300 ms of a transmission (the PTT tone and
 *    the onset of speech). The player uses this to keep its AudioTrack warm so
 *    the link never goes to sleep between transmissions. (Wired/built-in
 *    routes are deliberately excluded: they have no wake-up cost, and an
 *    amplified wired earpiece relies on the idle teardown to stop buzzing.)
 *
 *  - [stereoCapable]: a true stereo output (Bluetooth A2DP or a wired headset)
 *    is present, so the optional left/right channel split has somewhere to
 *    pan. The built-in mono loudspeaker is not stereo-capable — splitting on
 *    it would drop one of the two channels into a dead ear.
 */
class ExternalAudioOutputMonitor(context: Context) {

    private val audioManager =
        context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private val mainHandler = Handler(Looper.getMainLooper())

    private val _bluetoothConnected = MutableStateFlow(false)

    /** `true` when a Bluetooth output (A2DP or SCO) is connected. */
    val bluetoothConnected: StateFlow<Boolean> = _bluetoothConnected.asStateFlow()

    private val _stereoCapable = MutableStateFlow(false)

    /** `true` when a stereo-capable output (BT A2DP or wired headset) is present. */
    val stereoCapable: StateFlow<Boolean> = _stereoCapable.asStateFlow()

    private var registered = false

    private val callback =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            object : android.media.AudioDeviceCallback() {
                override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh()

                override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh()
            }
        } else {
            null
        }

    fun start() {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || callback == null) {
            _bluetoothConnected.value = false
            _stereoCapable.value = false
            return
        }
        if (registered) return
        manager.registerAudioDeviceCallback(callback, mainHandler)
        registered = true
        refresh()
    }

    fun stop() {
        val manager = audioManager ?: return
        if (!registered || callback == null) return
        manager.unregisterAudioDeviceCallback(callback)
        registered = false
    }

    private fun refresh() {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            _bluetoothConnected.value = false
            _stereoCapable.value = false
            return
        }
        val outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        _bluetoothConnected.value = outputs.any { it.type in BLUETOOTH_OUTPUT_TYPES }
        _stereoCapable.value = outputs.any { it.type in STEREO_OUTPUT_TYPES }
    }

    private companion object {
        val BLUETOOTH_OUTPUT_TYPES = setOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        )

        // A2DP is true stereo; a wired headset/headphones carry independent L/R.
        // (SCO is mono, so it's left out of the stereo-split set on purpose.)
        val STEREO_OUTPUT_TYPES = setOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        )
    }
}
