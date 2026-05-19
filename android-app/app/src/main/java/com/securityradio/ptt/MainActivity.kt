package com.securityradio.ptt

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.HardwareButtonEvent
import com.securityradio.ptt.device.HardwareButtonRelay
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.InricoHardwareService
import com.securityradio.ptt.device.RadioPresenceService
import com.securityradio.ptt.presentation.LoginViewModel
import com.securityradio.ptt.presentation.LoginViewModelFactory
import com.securityradio.ptt.presentation.RadioUiEvent
import com.securityradio.ptt.presentation.RadioViewModel
import com.securityradio.ptt.presentation.RadioViewModelFactory
import com.securityradio.ptt.ui.LoginScreen
import com.securityradio.ptt.ui.RadioShell
import com.securityradio.ptt.ui.theme.RadioTheme

class MainActivity : ComponentActivity() {

    private var radioViewModel: RadioViewModel? = null
    private lateinit var repository: HardwareMappingRepository
    private lateinit var appGraph: com.securityradio.ptt.di.RadioAppGraph

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        radioViewModel?.onMicPermissionResult(granted)
        checkAllPermissions()
    }

    private val notificationsPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        RadioPresenceService.start(this)
        checkAllPermissions()
    }

    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val granted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            result[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        radioViewModel?.onLocationPermissionResult(granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runCatching { enableEdgeToEdge() }.onFailure {
            Log.w("MainActivity", "enableEdgeToEdge unsupported; continuing without edge-to-edge", it)
        }
        appGraph = (application as RadioApplication).graph
        repository = appGraph.hardwareMappingRepository

        setContent {
            RadioTheme {
                var showRadio by remember { mutableStateOf(appGraph.radioPreferences.isLoggedIn()) }
                var sessionExpiredNotice by remember { mutableStateOf(false) }

                if (!showRadio) {
                    val loginVm: LoginViewModel = viewModel(factory = LoginViewModelFactory(appGraph))
                    LoginScreen(
                        viewModel = loginVm,
                        notice = if (sessionExpiredNotice) {
                            "Your session ended on the server. Please sign in again."
                        } else {
                            null
                        },
                        onSignedIn = {
                            sessionExpiredNotice = false
                            showRadio = true
                        },
                    )
                } else {
                    val radioVm: RadioViewModel = viewModel(factory = RadioViewModelFactory(appGraph))
                    LaunchedEffect(radioVm) {
                        radioViewModel = radioVm
                    }
                    val state by radioVm.uiState.collectAsStateWithLifecycle()

                    LaunchedEffect(Unit) {
                        checkAllPermissions()
                    }

                    LaunchedEffect(radioVm) {
                        radioVm.wakeUiSignals.collect {
                            bringRadioToForeground()
                        }
                    }

                    LaunchedEffect(Unit) {
                        appGraph.authExpired.collect {
                            appGraph.signOut()
                            radioViewModel = null
                            sessionExpiredNotice = true
                            showRadio = false
                        }
                    }

                    RadioShell(
                        state = state,
                        onEvent = { event ->
                            when (event) {
                                RadioUiEvent.RequestAudioPermission -> {
                                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                                RadioUiEvent.RequestIgnoreBatteryOptimizations -> requestIgnoreBatteryOptimizations()
                                RadioUiEvent.OpenAccessibilitySettings -> {
                                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                                    startActivity(intent)
                                }
                                RadioUiEvent.RequestOverlayPermission -> requestOverlayPermission()
                                RadioUiEvent.SignOut -> {
                                    appGraph.signOut()
                                    radioViewModel = null
                                    showRadio = false
                                }
                                else -> radioVm.onEvent(event)
                            }
                        },
                        onRequestMicPermission = {
                            radioVm.playUiMenuSound()
                            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        },
                    )
                }
            }
        }

        RadioPresenceService.start(this)
    }

    override fun onStart() {
        super.onStart()
        radioViewModel?.setMainRadioScreenVisible(true)
    }

    override fun onStop() {
        radioViewModel?.setMainRadioScreenVisible(false)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        checkAllPermissions()
        radioViewModel?.onOverlayPermissionResult(canDrawOverlays())
    }

    private fun bringRadioToForeground() {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
        }
        startActivity(intent)
    }

    private fun requestIgnoreBatteryOptimizations() {
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${packageName}")
            }
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: ActivityNotFoundException) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                })
            }
        }
    }

    private fun checkAllPermissions() {
        val audioGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED

        val accessibilityEnabled = isAccessibilityServiceEnabled(this, InricoHardwareService::class.java)

        radioViewModel?.onMicPermissionResult(audioGranted)
        radioViewModel?.onEvent(
            RadioUiEvent.UpdatePermissionState(
                needsAudio = !audioGranted,
                needsAccessibility = !accessibilityEnabled,
            ),
        )

        if (Build.VERSION.SDK_INT >= 33) {
            val notifGranted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!notifGranted) {
                val prefs = getSharedPreferences("radio_startup_prefs", MODE_PRIVATE)
                val key = "requested_post_notifications_v1"
                if (!prefs.getBoolean(key, false)) {
                    prefs.edit().putBoolean(key, true).apply()
                    notificationsPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
        }

        val locationGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED
        radioViewModel?.onLocationPermissionResult(locationGranted)
        if (!locationGranted) {
            val prefs = getSharedPreferences("radio_startup_prefs", MODE_PRIVATE)
            val key = "requested_location_v1"
            if (!prefs.getBoolean(key, false)) {
                prefs.edit().putBoolean(key, true).apply()
                locationPermissionLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                    ),
                )
            }
        }

        val overlayGranted = canDrawOverlays()
        radioViewModel?.onOverlayPermissionResult(overlayGranted)
        if (!overlayGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val prefs = getSharedPreferences("radio_startup_prefs", MODE_PRIVATE)
            val key = "requested_overlay_v1"
            if (!prefs.getBoolean(key, false)) {
                prefs.edit().putBoolean(key, true).apply()
                requestOverlayPermission()
            }
        }

        RadioPresenceService.start(this)
    }

    private fun canDrawOverlays(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return Settings.canDrawOverlays(this)
    }

    private fun requestOverlayPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName"),
            )
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", packageName, null)
            })
        }
    }

    private fun isAccessibilityServiceEnabled(context: Context, service: Class<*>): Boolean {
        val expectedComponentName = android.content.ComponentName(context, service)
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        val colonSplitter = android.text.TextUtils.SimpleStringSplitter(':')
        colonSplitter.setString(enabledServices)
        while (colonSplitter.hasNext()) {
            val componentNameString = colonSplitter.next()
            val enabledService = android.content.ComponentName.unflattenFromString(componentNameString)
            if (enabledService != null && enabledService == expectedComponentName) {
                return true
            }
        }
        return false
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (event?.repeatCount == 0) {
            HardwareButtonRelay.sendRawKeyCode(keyCode)
        }

        val isPtt = repository.getMapping(HardwareAction.PTT).contains(keyCode)
        val isEmergency = repository.getMapping(HardwareAction.EMERGENCY).contains(keyCode)
        val isChanUp = repository.getMapping(HardwareAction.CHANNEL_UP).contains(keyCode)
        val isChanDown = repository.getMapping(HardwareAction.CHANNEL_DOWN).contains(keyCode)
        val isScanToggle = repository.getMapping(HardwareAction.SCAN_TOGGLE).contains(keyCode)
        val isPlayLast = repository.getMapping(HardwareAction.PLAY_LAST_TRANSMISSION).contains(keyCode)
        val isVolumeCheck = repository.getMapping(HardwareAction.VOLUME_CHECK).contains(keyCode)
        val isToggleDayNight = repository.getMapping(HardwareAction.TOGGLE_DAY_NIGHT).contains(keyCode)

        if (isPtt || isEmergency || isChanUp || isChanDown || isScanToggle || isPlayLast || isVolumeCheck ||
            isToggleDayNight
        ) {
            if (event?.repeatCount == 0) {
                when {
                    isPtt -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttPressed)
                    isEmergency -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.EmergencyPressed)
                    isChanUp -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelUpPressed)
                    isChanDown -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelDownPressed)
                    isScanToggle -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ScanTogglePressed)
                    isPlayLast -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PlayLastTransmissionPressed)
                    isVolumeCheck -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckPressed)
                    isToggleDayNight -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ToggleDayNightPressed)
                }
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        when {
            repository.getMapping(HardwareAction.PTT).contains(keyCode) -> {
                HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttReleased)
                return true
            }
            repository.getMapping(HardwareAction.VOLUME_CHECK).contains(keyCode) -> {
                HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckReleased)
                return true
            }
        }
        return super.onKeyUp(keyCode, event)
    }
}
