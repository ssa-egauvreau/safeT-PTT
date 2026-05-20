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
 * Reports whether a non-built-in microphone is connected (wired headset mic, USB audio, BT headset).
 */
class ExternalMicMonitor(context: Context) {

    private val audioManager =
        context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private val mainHandler = Handler(Looper.getMainLooper())

    private val _connected = MutableStateFlow(false)

    /** `true` when an external input device is present. */
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

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
            _connected.value = false
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
        _connected.value = hasExternalMicInput(manager)
    }

    companion object {
        fun hasExternalMicInput(audioManager: AudioManager): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
            return audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).any { device ->
                device.isSource && device.type != AudioDeviceInfo.TYPE_BUILTIN_MIC
            }
        }
    }
}
