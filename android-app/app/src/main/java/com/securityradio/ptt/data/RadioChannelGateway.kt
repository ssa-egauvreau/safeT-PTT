package com.securityradio.ptt.data

import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.device.ServerReachabilityMonitor
import com.securityradio.ptt.domain.ChannelCatalogOrigin
import com.securityradio.ptt.domain.ChannelPermission
import com.securityradio.ptt.domain.ChannelRepository
import com.securityradio.ptt.domain.RadioChannelCatalog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Tries the network catalog first, then falls back to [localFallback] while
 * preserving the error for UI. Also reports each attempt to
 * [serverReachabilityMonitor] so the rest of the app learns when the backend
 * is unreachable even though the OS still says we have internet.
 */
class RadioChannelGateway(
    private val api: ChannelsApi,
    private val localFallback: ChannelRepository,
    private val serverReachabilityMonitor: ServerReachabilityMonitor,
) : ChannelRepository {

    override suspend fun loadCatalog(): RadioChannelCatalog = withContext(Dispatchers.IO) {
        try {
            val body = api.channels()
            val rows = body.channels.filter { it.name.isNotBlank() }
            if (rows.isEmpty()) {
                error("Server returned an empty channel list.")
            }
            val names = rows.map { it.name }
            val permissions = rows.associate {
                it.name.lowercase() to ChannelPermission.fromWire(it.permission)
            }
            val zones = buildMap {
                for (row in rows) {
                    val zone = row.zone?.trim().orEmpty()
                    if (zone.isNotEmpty()) put(row.name.lowercase(), zone)
                }
            }
            serverReachabilityMonitor.reportSuccess()
            RadioChannelCatalog(
                channels = names,
                permissions = permissions,
                zones = zones,
                origin = ChannelCatalogOrigin.NETWORK,
                errorMessage = null,
            )
        } catch (e: Exception) {
            serverReachabilityMonitor.reportFailure()
            val local = localFallback.loadCatalog()
            RadioChannelCatalog(
                channels = local.channels,
                permissions = local.permissions,
                zones = local.zones,
                origin = ChannelCatalogOrigin.LOCAL_FALLBACK,
                errorMessage = e.message ?: e::class.java.simpleName,
            )
        }
    }
}
