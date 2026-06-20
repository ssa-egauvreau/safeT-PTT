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
                application = graph.application,
                channelRepository = graph.channelRepository,
                soundPlayer = graph.soundPlayer,
                pttMicCapture = graph.pttMicCapture,
                pttHapticFeedback = graph.pttHapticFeedback,
                channelsApi = graph.channelsApi,
                radioApi = graph.radioApi,
                localUnitIdentifier = graph.localUnitIdentifier,
                hardwareMappingRepository = graph.hardwareMappingRepository,
                radioPreferences = graph.radioPreferences,
                speechHelper = graph.speechHelper,
                voiceRelay = graph.voiceRelay,
                scanVoiceListen = graph.scanVoiceListen,
                scanRxActivity = graph.scanRxActivity,
                locationReporter = graph.locationReporter,
                customSoundDownloader = graph.customSoundDownloader,
                lastRxAudioRecorder = graph.lastRxAudioRecorder,
                rxMessageHistory = graph.rxMessageHistory,
                connectivityMonitor = graph.connectivityMonitor,
                serverReachabilityMonitor = graph.serverReachabilityMonitor,
                externalMicMonitor = graph.externalMicMonitor,
                externalAudioOutputMonitor = graph.externalAudioOutputMonitor,
                appUpdater = graph.appUpdater,
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel type ${modelClass.name}")
    }
}
