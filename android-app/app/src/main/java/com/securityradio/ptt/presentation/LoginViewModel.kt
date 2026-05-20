package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.Gson
import com.securityradio.ptt.data.remote.ApiErrorDto
import com.securityradio.ptt.data.remote.LoginRequestDto
import com.securityradio.ptt.di.RadioAppGraph
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import retrofit2.HttpException
import java.util.Locale

data class LoginUiState(
    val agencySlug: String = "",
    val username: String = "",
    val password: String = "",
    val busy: Boolean = false,
    val errorMessage: String? = null,
)

class LoginViewModel(
    private val graph: RadioAppGraph,
) : ViewModel() {

    private val prefs = graph.radioPreferences

    private val _uiState = MutableStateFlow(
        LoginUiState(
            agencySlug = prefs.getSessionAgencySlug(),
            username = prefs.getSessionUsername(),
        ),
    )
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    fun setAgencySlug(value: String) {
        _uiState.update { it.copy(agencySlug = value, errorMessage = null) }
    }

    fun setUsername(value: String) {
        _uiState.update { it.copy(username = value, errorMessage = null) }
    }

    fun setPassword(value: String) {
        _uiState.update { it.copy(password = value, errorMessage = null) }
    }

    fun signIn(onSuccess: () -> Unit) {
        val snapshot = _uiState.value
        val slug = snapshot.agencySlug.trim().lowercase()
        val username = snapshot.username.trim()
        val password = snapshot.password
        if (slug.isBlank() || username.isBlank() || password.isBlank()) {
            _uiState.update { it.copy(errorMessage = "Enter agency, username, and password.") }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(busy = true, errorMessage = null) }
            try {
                val res = graph.authApi.login(
                    LoginRequestDto(
                        username = username,
                        password = password,
                        agency_slug = slug,
                    ),
                )
                if (res.user.role == "owner") {
                    _uiState.update {
                        it.copy(
                            busy = false,
                            errorMessage = "Platform owner accounts use the web console, not the radio app.",
                        )
                    }
                    return@launch
                }
                prefs.setAuthToken(res.token)
                prefs.setSessionAgencySlug(slug)
                prefs.setSessionUsername(username)
                val accountUnit = res.user.unitId?.trim()?.takeIf { it.isNotEmpty() }
                    ?: username.uppercase(Locale.US)
                prefs.setSessionUnitId(accountUnit)
                prefs.setSessionDisplayName(res.user.displayName)
                graph.localUnitIdentifier.setShortUnitId(accountUnit)
                graph.onAuthSessionChanged()
                _uiState.update { it.copy(busy = false, password = "") }
                onSuccess()
            } catch (http: HttpException) {
                val code = parseApiError(http)
                val msg = when (code) {
                    "unknown_agency" ->
                        "Unknown agency code. In Platform → Agencies, copy the Slug column exactly (e.g. sunset-safety-agency)."
                    "agency_mismatch" ->
                        "That username belongs to a different agency. Use the slug from Platform for the agency that owns this account."
                    "invalid_login" ->
                        "Wrong username or password for this agency."
                    else -> when (http.code()) {
                        401 -> "Sign-in failed. Check agency code, username, and password."
                        403 -> "This account cannot use the radio app."
                        404 -> "Wrong server address (404). In android-app/local.properties set " +
                            "radio.api.base.url=https://safet.up.railway.app/ then Sync Gradle and rebuild."
                        else -> "Sign-in failed (${http.code()})."
                    }
                }
                _uiState.update { it.copy(busy = false, errorMessage = msg) }
            } catch (e: Exception) {
                val errorType = e.javaClass.simpleName
                val hint = if (android.os.Build.VERSION.SDK_INT <= 25) {
                    " (On Android 7, check if the device date/time is correct, or if the server uses a modern certificate the device doesn't trust)"
                } else ""
                _uiState.update {
                    it.copy(
                        busy = false,
                        errorMessage = "Cannot reach server: $errorType. $hint Set radio.api.base.url=https://safet.up.railway.app/ in local.properties and rebuild.",
                    )
                }
            }
        }
    }

    private fun parseApiError(http: HttpException): String? {
        return try {
            val raw = http.response()?.errorBody()?.string().orEmpty()
            Gson().fromJson(raw, ApiErrorDto::class.java)?.error
        } catch (_: Exception) {
            null
        }
    }
}
