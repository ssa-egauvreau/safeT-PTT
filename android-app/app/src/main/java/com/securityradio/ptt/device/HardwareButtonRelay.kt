package com.securityradio.ptt.device

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch

/**
 * Relays hardware key events. Uses suspending [emit] (not [tryEmit]) so key codes are not dropped
 * when the UI is busy mapping or multiple collectors are active.
 */
object HardwareButtonRelay {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _events = MutableSharedFlow<HardwareButtonEvent>(extraBufferCapacity = 32)
    val events = _events.asSharedFlow()

    private val _rawKeyCodes = MutableSharedFlow<Int>(extraBufferCapacity = 256)
    val rawKeyCodes = _rawKeyCodes.asSharedFlow()

    fun sendEvent(event: HardwareButtonEvent) {
        scope.launch {
            _events.emit(event)
        }
    }

    fun sendRawKeyCode(keyCode: Int) {
        scope.launch {
            _rawKeyCodes.emit(keyCode)
        }
    }
}

sealed interface HardwareButtonEvent {
    data object PttPressed : HardwareButtonEvent
    data object PttReleased : HardwareButtonEvent
    data object EmergencyPressed : HardwareButtonEvent
    data object ChannelUpPressed : HardwareButtonEvent
    /** Key-up counterpart so TM-7 Plus can distinguish quick-press (channel step)
     *  from a ≥1 s hold (zone-select mode). Only the KeyEvent paths emit this;
     *  the Inrico intent broadcasts are discrete presses with no release. */
    data object ChannelUpReleased : HardwareButtonEvent
    data object ChannelDownPressed : HardwareButtonEvent
    /** Key-up counterpart so TM-7 Plus can distinguish quick-press (channel step) from a
     *  ≥1 s hold (zone step). Only the KeyEvent paths emit this; the Inrico intent broadcasts
     *  are discrete presses with no release. */
    data object ChannelDownReleased : HardwareButtonEvent
    data object ScanTogglePressed : HardwareButtonEvent
    data object PlayLastTransmissionPressed : HardwareButtonEvent
    data object PlayLastTransmissionReleased : HardwareButtonEvent
    data object VolumeCheckPressed : HardwareButtonEvent
    data object VolumeCheckReleased : HardwareButtonEvent
    /** Single volume-check tone for the volume knob (one beep per turn, no loop). */
    data object VolumeCheckTapped : HardwareButtonEvent
    data object ToggleDayNightPressed : HardwareButtonEvent
    data object ToggleDayNightReleased : HardwareButtonEvent
    /** Operator-mapped "force install pending OTA update" key. Single press;
     *  no Released counterpart because the action fires on key-down. */
    data object ForceInstallUpdatePressed : HardwareButtonEvent
}
