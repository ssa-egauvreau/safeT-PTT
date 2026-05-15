package com.securityradio.ptt

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.securityradio.ptt.presentation.RadioViewModel
import com.securityradio.ptt.presentation.RadioViewModelFactory
import com.securityradio.ptt.ui.RadioShell
import com.securityradio.ptt.ui.theme.RadioTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as RadioApplication).graph
        val factory = RadioViewModelFactory(graph)
        setContent {
            RadioTheme {
                val viewModel: RadioViewModel = viewModel(factory = factory)
                val state by viewModel.uiState.collectAsStateWithLifecycle()

                val micPermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) { granted ->
                    viewModel.onMicPermissionResult(granted)
                }

                LaunchedEffect(Unit) {
                    val granted = ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        Manifest.permission.RECORD_AUDIO,
                    ) == PackageManager.PERMISSION_GRANTED
                    viewModel.onMicPermissionResult(granted)
                }

                RadioShell(
                    state = state,
                    onEvent = viewModel::onEvent,
                    onRequestMicPermission = {
                        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    },
                )
            }
        }
    }
}
