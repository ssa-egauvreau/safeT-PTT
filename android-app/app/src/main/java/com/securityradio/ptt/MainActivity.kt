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
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.HardwareButtonEvent
import com.securityradio.ptt.device.HardwareButtonRelay
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.InricoHardwareService
import com.securityradio.ptt.device.RadioPresenceService
import com.securityradio.ptt.presentation.RadioUiEvent
import com.securityradio.ptt.presentation.RadioViewModel
import com.securityradio.ptt.presentation.RadioViewModelFactory
import com.securityradio.ptt.ui.RadioShell
import com.securityradio.ptt.ui.theme.RadioTheme

class MainActivity : ComponentActivity() {

    private lateinit var radioViewModel: RadioViewModel
    private lateinit var repository: HardwareMappingRepository

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        radioViewModel.onMicPermissionResult(granted)
        checkAllPermissions()
    }

    private val notificationsPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        RadioPresenceService.start(this)
        checkAllPermissions()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as RadioApplication).graph
        repository = graph.hardwareMappingRepository
        val factory = RadioViewModelFactory(graph)
        radioViewModel = ViewModelProvider(this, factory)[RadioViewModel::class.java]

        setContent {
            RadioTheme {
                val state by radioViewModel.uiState.collectAsStateWithLifecycle()

                LaunchedEffect(Unit) {
                    checkAllPermissions()
                }

                LaunchedEffect(radioViewModel) {
                    radioViewModel.wakeUiSignals.collect {
                        bringRadioToForeground()
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
                            else -> radioViewModel.onEvent(event)
                        }
                    },
                    onRequestMicPermission = {
                        radioViewModel.playUiMenuSound()
                        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    },
                )
            }
        }

        RadioPresenceService.start(this)
    }

    override fun onStart() {
        super.onStart()
        if (::radioViewModel.isInitialized) {
            radioViewModel.setMainRadioScreenVisible(true)
        }
    }

    override fun onStop() {
        if (::radioViewModel.isInitialized) {
            radioViewModel.setMainRadioScreenVisible(false)
        }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        checkAllPermissions()
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

        radioViewModel.onMicPermissionResult(audioGranted)
        radioViewModel.onEvent(
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

        RadioPresenceService.start(this)
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

        if (isPtt || isEmergency || isChanUp || isChanDown || isScanToggle || isPlayLast) {
            if (event?.repeatCount == 0) {
                when {
                    isPtt -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttPressed)
                    isEmergency -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.EmergencyPressed)
                    isChanUp -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelUpPressed)
                    isChanDown -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelDownPressed)
                    isScanToggle -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ScanTogglePressed)
                    isPlayLast -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PlayLastTransmissionPressed)
                }
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (repository.getMapping(HardwareAction.PTT).contains(keyCode)) {
            HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttReleased)
            return true
        }
        return super.onKeyUp(keyCode, event)
    }
}
