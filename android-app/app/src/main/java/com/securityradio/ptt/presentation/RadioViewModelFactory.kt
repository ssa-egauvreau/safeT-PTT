package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.securityradio.ptt.di.RadioAppGraph

class RadioViewModelFactory(
    private val graph: RadioAppGraph,
) : ViewModelProvider.Factory {

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(RadioViewModel::class.java)) {
            return RadioViewModel(
                channelRepository = graph.channelRepository,
                soundPlayer = graph.soundPlayer,
                pttMicCapture = graph.pttMicCapture,
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel type ${modelClass.name}")
    }
}
