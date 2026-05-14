package com.securityradio.ptt.device

import com.securityradio.ptt.presentation.RadioUiEvent

/**
 * Maps platform hardware keys to [RadioUiEvent]. The UI shell stays unaware of scan codes.
 */
fun interface HardwarePttAdapter {
    fun mapKeyToEvent(keyCode: Int): RadioUiEvent?
}

/**
 * No-op mapper for the prototype; real builds register volume rocker / accessory PTT codes here.
 */
class NoOpHardwarePttAdapter : HardwarePttAdapter {
    override fun mapKeyToEvent(keyCode: Int): RadioUiEvent? = null
}
