package com.securityradio.ptt.device

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Tracks whether the device currently has an internet-capable network.
 *
 * Event-driven via [ConnectivityManager.NetworkCallback] so the radio reacts the
 * instant Wi-Fi / LTE drops or returns, with no polling. Call [start] once.
 */
class ConnectivityMonitor(context: Context) {

    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
            as ConnectivityManager

    /** Networks the OS currently reports as usable; online == this set is non-empty. */
    private val liveNetworks = mutableSetOf<Network>()

    private val _online = MutableStateFlow(queryActiveNetworkOnline())

    /** `true` while at least one internet-capable network is up. */
    val online: StateFlow<Boolean> = _online.asStateFlow()

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = publish { liveNetworks.add(network) }
        override fun onLost(network: Network) = publish { liveNetworks.remove(network) }
    }

    /** Registers the OS callback. Safe to call once after construction. */
    fun start() {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching { connectivityManager.registerNetworkCallback(request, callback) }
    }

    private fun publish(mutate: () -> Unit) {
        synchronized(liveNetworks) {
            mutate()
            _online.value = liveNetworks.isNotEmpty()
        }
    }

    @Suppress("DEPRECATION")
    private fun queryActiveNetworkOnline(): Boolean =
        runCatching { connectivityManager.activeNetworkInfo?.isConnected == true }
            .getOrDefault(false)
}
