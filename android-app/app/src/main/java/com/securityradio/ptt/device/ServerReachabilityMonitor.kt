package com.securityradio.ptt.device

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Tracks whether our backend is reachable, independent of the OS-level Wi-Fi
 * or cellular state. A handset can have full signal yet still be unable to
 * reach the safeT-PTT server (server outage, DNS, captive portal, etc.), and
 * the OS-only [ConnectivityMonitor] cannot detect that case.
 *
 * Reporters call [reportSuccess] or [reportFailure] after each API attempt.
 * The flow trips to `false` only after [FAILURE_THRESHOLD] consecutive
 * failures so a single transient error doesn't flash the offline banner, and
 * recovers to `true` on the next success. Defaults to `true` to match
 * [ConnectivityMonitor]'s fail-safe philosophy: a missed outage beats a
 * stuck NO CONNECTION alert.
 */
class ServerReachabilityMonitor {

    private val _reachable = MutableStateFlow(true)
    val reachable: StateFlow<Boolean> = _reachable.asStateFlow()

    @Volatile private var consecutiveFailures = 0

    fun reportSuccess() {
        consecutiveFailures = 0
        _reachable.value = true
    }

    fun reportFailure() {
        consecutiveFailures += 1
        if (consecutiveFailures >= FAILURE_THRESHOLD) {
            _reachable.value = false
        }
    }

    private companion object {
        const val FAILURE_THRESHOLD = 2
    }
}
