package com.securityradio.ptt.di

import android.app.Application
import android.util.Log
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.data.RadioChannelGateway
import com.securityradio.ptt.data.StubChannelRepository
import com.securityradio.ptt.data.remote.AuthApi
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.data.remote.NetworkModule
import com.securityradio.ptt.data.remote.RadioApi
import com.securityradio.ptt.device.AppUpdater
import com.securityradio.ptt.device.AssetRadioUiSoundPlayer
import com.securityradio.ptt.device.AudioRecordPttCapture
import com.securityradio.ptt.device.MicCaptureConfig
import com.securityradio.ptt.device.ChannelSpeechHelper
import com.securityradio.ptt.device.ConnectivityMonitor
import com.securityradio.ptt.device.ExternalMicMonitor
import com.securityradio.ptt.device.CustomSoundDownloader
import com.securityradio.ptt.device.CustomSoundStore
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.InboundVoicePlayer
import com.securityradio.ptt.device.LastRxAudioRecorder
import com.securityradio.ptt.device.RxMessageHistory
import com.securityradio.ptt.device.LocalUnitIdentifier
import com.securityradio.ptt.device.LocationReporter
import com.securityradio.ptt.device.P25ImbeNative
import com.securityradio.ptt.device.PttHapticFeedback
import com.securityradio.ptt.device.PttMicCapture
import com.securityradio.ptt.device.RadioPreferences
import com.securityradio.ptt.device.RadioUiSoundPlayer
import com.securityradio.ptt.device.ScanVoiceListenTransport
import com.securityradio.ptt.device.ServerReachabilityMonitor
import com.securityradio.ptt.device.VoiceRelayTransport
import com.securityradio.ptt.domain.ChannelRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

class RadioAppGraph(val application: Application) {

    init {
        P25ImbeNative.tryLoadLibrary()
    }

    val radioPreferences = RadioPreferences(application)

    /** Background scope for fire-and-forget network tasks (audio config refresh, etc.). */
    private val bgScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Over-the-air APK self-updater for the sideloaded fleet. */
    val appUpdater: AppUpdater = AppUpdater(
        context = application,
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        currentVersionCode = BuildConfig.VERSION_CODE.toLong(),
    )

    val pttHapticFeedback = PttHapticFeedback(application)

    val speechHelper = ChannelSpeechHelper(application, radioPreferences)

    val hardwareMappingRepository = HardwareMappingRepository(application, radioPreferences)

    val customSoundStore = CustomSoundStore(application)

    val soundPlayer: RadioUiSoundPlayer = AssetRadioUiSoundPlayer(application, customSoundStore)

    val localUnitIdentifier: LocalUnitIdentifier = LocalUnitIdentifier(application)

    /** Device internet up/down feed for the lost-link alert. */
    val connectivityMonitor: ConnectivityMonitor = ConnectivityMonitor(application).also { it.start() }

    /** Backend reachability feed; trips when API calls keep failing even though the OS says we're online. */
    val serverReachabilityMonitor: ServerReachabilityMonitor = ServerReachabilityMonitor()

    val externalMicMonitor: ExternalMicMonitor = ExternalMicMonitor(application).also { it.start() }

    val rxMessageHistory = RxMessageHistory()

    val lastRxAudioRecorder = LastRxAudioRecorder(messageHistory = rxMessageHistory)

    private val _scanRxActivity = MutableSharedFlow<String>(extraBufferCapacity = 16)

    /** Emits the scan channel label whenever scan listen sockets deliver voice. */
    val scanRxActivity: SharedFlow<String> = _scanRxActivity.asSharedFlow()

    private val inboundVoicePlayer = InboundVoicePlayer(
        lastRxRecorder = lastRxAudioRecorder,
        onScanRxActivity = { channel -> _scanRxActivity.tryEmit(channel) },
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
        bypassMicProcessingProvider = {
            radioPreferences.hasServerAudioConfig() &&
                radioPreferences.getServerBypassMicProcessing()
        },
    )

    val scanVoiceListen: ScanVoiceListenTransport = ScanVoiceListenTransport(
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        inbound = inboundVoicePlayer,
    )

    /** Sidetone off; PCM also flows to [voiceRelay]. */
    val pttMicCapture: PttMicCapture = AudioRecordPttCapture(
        enableSidetone = false,
        streamingSink = voiceRelay,
        // Server-pushed config (from Audio Lab → "Apply live") takes precedence over
        // per-device settings when an admin has set it.  Falls back to local user prefs
        // if no server config has been fetched yet.
        configProvider = {
            if (radioPreferences.hasServerAudioConfig()) {
                // bypassMicProcessing overrides the hardware DSP flags to off
                // regardless of agcEnabled / noiseSuppression — the bridge
                // sounds clean because nothing processes its mic input.
                val bypass = radioPreferences.getServerBypassMicProcessing()
                MicCaptureConfig(
                    noiseSuppression = !bypass && radioPreferences.getServerNoiseSuppression(),
                    autoGain = !bypass && radioPreferences.getServerAgcEnabled(),
                    gainMultiplier = radioPreferences.getServerGainMultiplier(),
                )
            } else {
                MicCaptureConfig(
                    noiseSuppression = radioPreferences.isNoiseSuppressionEnabled(),
                    autoGain = radioPreferences.isMicAutoGainEnabled(),
                    gainMultiplier = radioPreferences.getMicGainMultiplier(),
                )
            }
        },
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

    /**
     * Fetches the agency-wide audio config from the server and persists it so
     * [pttMicCapture]'s configProvider picks it up on the next PTT key-down.
     * Skips the call when there's no auth session yet — the endpoint requires an
     * agency member, so calling it pre-login would just produce a 401 we'd
     * silently swallow. Real failures (deserialization, server 5xx, persistent
     * network outages) are logged at warn level so they're visible in production
     * logcat.
     */
    fun refreshAudioConfigAsync() {
        if (!radioPreferences.isLoggedIn()) {
            return
        }
        bgScope.launch {
            try {
                val response = radioApi.audioConfig()
                val cfg = response.config
                if (cfg != null) {
                    radioPreferences.setServerAudioConfig(
                        agcEnabled = cfg.agcEnabled,
                        noiseSuppression = cfg.noiseSuppression,
                        gainMultiplier = cfg.gainMultiplier,
                        bypassMicProcessing = cfg.bypassMicProcessing,
                    )
                }
                // If the server has no config (cfg == null), leave whatever was cached — don't
                // clear it so the device keeps working if the server is momentarily unreachable.
            } catch (e: Exception) {
                Log.w("RadioAppGraph", "Audio config refresh failed: ${e.message}")
            }
        }
    }

    fun onAuthSessionChanged() {
        voiceRelay.reconnect()
        customSoundDownloader.refreshAsync()
        refreshAudioConfigAsync()
    }

    fun signOut() {
        radioPreferences.clearAuthSession()
        // Drop any agency-pushed audio config so a re-login under a different
        // agency doesn't transmit the previous agency's gain/noise settings on
        // the first PTT before refreshAudioConfigAsync() completes.
        radioPreferences.clearServerAudioConfig()
        voiceRelay.disconnect()
        scanVoiceListen.disconnect()
    }

    val locationReporter: LocationReporter = LocationReporter(application, radioApi)

    val channelRepository: ChannelRepository = RadioChannelGateway(
        api = channelsApi,
        localFallback = stubChannelRepository,
        serverReachabilityMonitor = serverReachabilityMonitor,
    )

    init {
        // Pull this agency's custom tones in the background on startup.
        customSoundDownloader.refreshAsync()
        // Pull the admin-pushed audio config (if any) so the next PTT uses it.
        refreshAudioConfigAsync()
    }
}
