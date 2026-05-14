package com.securityradio.ptt.data

import com.securityradio.ptt.domain.ChannelCatalogOrigin
import com.securityradio.ptt.domain.ChannelRepository
import com.securityradio.ptt.domain.RadioChannelCatalog

/**
 * Offline catalog used when the handset cannot reach the API.
 */
class StubChannelRepository : ChannelRepository {

    override suspend fun loadCatalog(): RadioChannelCatalog = RadioChannelCatalog(
        channels = DEFAULT_CHANNELS,
        origin = ChannelCatalogOrigin.LOCAL_FALLBACK,
        errorMessage = null,
    )

    companion object {
        val DEFAULT_CHANNELS: List<String> = (1..16).map { idx -> "CH %02d".format(idx) }
    }
}
