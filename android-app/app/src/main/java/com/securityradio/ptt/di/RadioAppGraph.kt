package com.securityradio.ptt.di

import android.app.Application
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.data.RadioChannelGateway
import com.securityradio.ptt.data.StubChannelRepository
import com.securityradio.ptt.data.remote.AuthApi
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.data.remote.NetworkModule
import com.securityradio.ptt.data.remote.RadioApi
import com.securityradio.ptt.device.AssetRadioUiSoundPlayer
import com.securityradio.ptt.device.AudioRecordPttCapture
import com.securityradio.ptt.device.ChannelSpeechHelper
import com.securityradio.ptt.device.ConnectivityMonitor
import com.securityradio.ptt.device.CustomSoundDownloader
import com.securityradio.ptt.device.CustomSoundStore
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.InboundVoicePlayer
import com.securityradio.ptt.device.LastRxAudioRecorder
import com.securityradio.ptt.device.LocalUnitIdentifier
import com.securityradio.ptt.device.LocationReporter
import com.securityradio.ptt.device.P25ImbeNative
import com.securityradio.ptt.device.PttMicCapture
import com.securityradio.ptt.device.RadioPreferences
import com.securityradio.ptt.device.RadioUiSoundPlayer
import com.securityradio.ptt.device.VoiceRelayTransport
import com.securityradio.ptt.domain.ChannelRepository
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

class RadioAppGraph(val application: Application) {

    init {
        P25ImbeNative.tryLoadLibrary()
    }

    val radioPreferences = RadioPreferences(application)

    val speechHelper = ChannelSpeechHelper(application, radioPreferences)

    val hardwareMappingRepository = HardwareMappingRepository(application, radioPreferences)

    val customSoundStore = CustomSoundStore(application)

    val soundPlayer: RadioUiSoundPlayer = AssetRadioUiSoundPlayer(application, customSoundStore)

    val localUnitIdentifier: LocalUnitIdentifier = LocalUnitIdentifier(application)

    /** Device internet up/down feed for the lost-link alert. */
    val connectivityMonitor: ConnectivityMonitor = ConnectivityMonitor(application).also { it.start() }

    val lastRxAudioRecorder = LastRxAudioRecorder()

    private val inboundVoicePlayer = InboundVoicePlayer(
        lastRxRecorder = lastRxAudioRecorder,
        listenGainProvider = {
            if (radioPreferences.isListenVolumeMuted()) 0f else 1f
        },
    )

    private val authTokenProvider: () -> String = { radioPreferences.getAuthToken() }

    /**
     * Legacy handset key when not signed in. After login, [authTokenProvider] is used instead.
     */
    private val radioApiKeyProvider: () -> String = {
        if (radioPreferences.getAuthToken().isNotBlank()) {
            ""
        } else {
            radioPreferences.getAgencyRadioKey().ifBlank { BuildConfig.RADIO_API_KEY }
        }
    }

    private val _authExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /**
     * Emits when the server rejects the stored token (HTTP 401). The UI should
     * sign out and return to the login screen instead of failing silently.
     */
    val authExpired: SharedFlow<Unit> = _authExpired.asSharedFlow()

    val authApi: AuthApi = NetworkModule.authApi(BuildConfig.API_BASE_URL)

    /** Pulls the agency's custom radio tones; refreshed at startup and on key change. */
    val customSoundDownloader = CustomSoundDownloader(
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        store = customSoundStore,
    )

    val voiceRelay: VoiceRelayTransport = VoiceRelayTransport(
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        inbound = inboundVoicePlayer,
    )

    /** Sidetone off; PCM also flows to [voiceRelay]. */
    val pttMicCapture: PttMicCapture = AudioRecordPttCapture(
        enableSidetone = false,
        streamingSink = voiceRelay,
    )

    private val stubChannelRepository = StubChannelRepository()

    val channelsApi: ChannelsApi = NetworkModule.channelsApi(
        baseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        onUnauthorized = { _authExpired.tryEmit(Unit) },
    )

    val radioApi: RadioApi = NetworkModule.radioApi(
        baseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        onUnauthorized = { _authExpired.tryEmit(Unit) },
    )

    fun onAuthSessionChanged() {
        voiceRelay.reconnect()
        customSoundDownloader.refreshAsync()
    }

    fun signOut() {
        radioPreferences.clearAuthSession()
        voiceRelay.disconnect()
    }

    val locationReporter: LocationReporter = LocationReporter(application, radioApi)

    val channelRepository: ChannelRepository = RadioChannelGateway(
        api = channelsApi,
        localFallback = stubChannelRepository,
    )

    init {
        // Pull this agency's custom tones in the background on startup.
        customSoundDownloader.refreshAsync()
    }
}
