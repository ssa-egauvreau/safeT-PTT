package com.securityradio.ptt.data

import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.domain.ChannelCatalogOrigin
import com.securityradio.ptt.domain.ChannelRepository
import com.securityradio.ptt.domain.RadioChannelCatalog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Tries the network catalog first, then falls back to [localFallback] while preserving the error for UI.
 */
class RadioChannelGateway(
    private val api: ChannelsApi,
    private val localFallback: ChannelRepository,
) : ChannelRepository {

    override suspend fun loadCatalog(): RadioChannelCatalog = withContext(Dispatchers.IO) {
        try {
            val body = api.channels()
            val names = body.channels.map { it.name }.filter { it.isNotBlank() }
            if (names.isEmpty()) {
                error("Server returned an empty channel list.")
            }
            RadioChannelCatalog(
                channels = names,
                origin = ChannelCatalogOrigin.NETWORK,
                errorMessage = null,
            )
        } catch (e: Exception) {
            val local = localFallback.loadCatalog()
            RadioChannelCatalog(
                channels = local.channels,
                origin = ChannelCatalogOrigin.LOCAL_FALLBACK,
                errorMessage = e.message ?: e::class.java.simpleName,
            )
        }
    }
}
