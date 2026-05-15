package com.securityradio.ptt.domain

/**
 * Loads the channel catalog. Network-first implementations may fall back to local defaults.
 */
fun interface ChannelRepository {
    suspend fun loadCatalog(): RadioChannelCatalog
}
