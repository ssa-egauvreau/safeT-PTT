package com.securityradio.ptt.di

import android.app.Application
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.data.RadioChannelGateway
import com.securityradio.ptt.data.StubChannelRepository
import com.securityradio.ptt.data.remote.NetworkModule
import com.securityradio.ptt.device.AssetRadioUiSoundPlayer
import com.securityradio.ptt.device.RadioUiSoundPlayer
import com.securityradio.ptt.domain.ChannelRepository

class RadioAppGraph(application: Application) {

    val soundPlayer: RadioUiSoundPlayer = AssetRadioUiSoundPlayer(application)

    private val stubChannelRepository = StubChannelRepository()

    private val channelsApi = NetworkModule.channelsApi(BuildConfig.API_BASE_URL)

    val channelRepository: ChannelRepository = RadioChannelGateway(
        api = channelsApi,
        localFallback = stubChannelRepository,
    )
}
