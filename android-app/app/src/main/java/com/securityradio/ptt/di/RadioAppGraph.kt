package com.securityradio.ptt.di

import android.app.Application
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.data.RadioChannelGateway
import com.securityradio.ptt.data.StubChannelRepository
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.data.remote.NetworkModule
import com.securityradio.ptt.device.AssetRadioUiSoundPlayer
import com.securityradio.ptt.device.AudioRecordPttCapture
import com.securityradio.ptt.device.ChannelSpeechHelper
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.InboundVoicePlayer
import com.securityradio.ptt.device.P25ImbeNative
import com.securityradio.ptt.device.PttMicCapture
import com.securityradio.ptt.device.RadioPreferences
import com.securityradio.ptt.device.RadioUiSoundPlayer
import com.securityradio.ptt.device.VoiceRelayTransport
import com.securityradio.ptt.domain.ChannelRepository

class RadioAppGraph(application: Application) {

    init {
        P25ImbeNative.tryLoadLibrary()
    }

    val radioPreferences = RadioPreferences(application)

    val speechHelper = ChannelSpeechHelper(application, radioPreferences)

    val hardwareMappingRepository = HardwareMappingRepository(application)

    val soundPlayer: RadioUiSoundPlayer = AssetRadioUiSoundPlayer(application)

    val localUnitIdentifier: LocalUnitIdentifier = LocalUnitIdentifier(application)

    private val inboundVoicePlayer = InboundVoicePlayer()

    val voiceRelay: VoiceRelayTransport = VoiceRelayTransport(
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        apiKey = BuildConfig.RADIO_API_KEY,
        inbound = inboundVoicePlayer,
        radioPreferences = radioPreferences,
    )

    /** Sidetone off; PCM also flows to [voiceRelay]. */
    val pttMicCapture: PttMicCapture = AudioRecordPttCapture(
        enableSidetone = false,
        streamingSink = voiceRelay,
    )

    private val stubChannelRepository = StubChannelRepository()

    val channelsApi: ChannelsApi = NetworkModule.channelsApi(
        baseUrl = BuildConfig.API_BASE_URL,
        apiKey = BuildConfig.RADIO_API_KEY,
    )

    val channelRepository: ChannelRepository = RadioChannelGateway(
        api = channelsApi,
        localFallback = stubChannelRepository,
    )
}
